/**
 * RsbWebviewBackend — controls the RSB sidebar's embedded `<webview>` tabs.
 *
 * Implements `BrowserBackend.call` by routing each MCP `browser` action to
 * either:
 *   - Electron native API on the guest `WebContents` (navigate / screenshot /
 *     pdf / console)
 *   - a bounded CDP session on the guest `WebContents` (snapshot / act)
 *   - the renderer's RSB store via the request/response bridge (open /
 *     focus / close)
 *   - the `TabRegistry` for status / tabs / profiles / doctor
 *
 * Actions outside the sidebar browser's current capability set respond with
 * `BROWSER_RUNTIME_ACTION_FAILED` + a clear explanation, so the MCP layer still
 * surfaces a structured error.
 *
 * Why this lives in main: the `WebContents` handles + CDP debugger access are
 * main-only; the backend has no business in the renderer. The renderer owns
 * the store / pool / `<webview>` DOM and gets driven via the bridge.
 */

import type {
  BrowserActRequest,
  BrowserControlRequest,
  BrowserControlResult,
} from '@cindy/browser-control-runtime';
import { isPublicHttpResourceUrl } from '@cindy/browser-control-runtime';
import type { WebContents } from 'electron';

import type { TabRegistry } from '../../rsb-browser-bridge/registry.js';
import { dispatchTabOp } from '../../rsb-browser-bridge/renderer-bridge.js';
import type { RendererBridgeOptions } from '../../rsb-browser-bridge/renderer-bridge.js';
import type {
  BackendRequest,
  BackendResult,
  BrowserBackend,
} from './types.js';
import { RsbWebviewAutomation } from './rsb-webview-automation.js';
import { artifactSessionRoot, RsbWebviewArtifacts } from './rsb-webview-artifacts.js';
import { RsbWebviewDialogs } from './rsb-webview-dialogs.js';
import { RsbWebviewNetwork } from './rsb-webview-network.js';
import { resolveUploadFiles } from './rsb-webview-upload-policy.js';

interface BackendLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

interface BrowserActivity {
  action: BrowserControlRequest['action'];
  finishedAt: string;
  ok: boolean;
  targetId?: string;
}

export interface RsbWebviewBackendOptions {
  registry: TabRegistry;
  /**
   * Fallback session-id resolver for paths that DON'T originate from an MCP
   * tool call (Settings UI status probe, dev diagnostics). MCP-driven actions
   * carry the authoritative session in `req.__mcpSessionId` injected by the
   * @cindy/mcps provider wrap; the backend prefers that and only falls back to
   * this resolver when the field is absent.
   *
   * Why this distinction matters: the previous design used UI-focus inference
   * as the only source of truth, which caused cross-session bugs (user submits
   * a prompt in session A, immediately switches to B, agent still runs in A
   * but the backend reads "UI focus = B" → tab ends up in B's bucket and B's
   * sidebar pops open). Returning null from this resolver is fine — tab-scoped
   * actions will fail with a clear "no active session" message in that case.
   */
  getActiveSessionId: () => string | null;
  /** Bridge config — same shape `registerTabOpResultHandler` uses. */
  bridge: RendererBridgeOptions;
  logger: BackendLogger;
  artifactRoot?: () => string;
  /**
   * Download-start grace override for deterministic tests. Production keeps
   * RsbWebviewArtifacts' bounded two-second default.
   */
  artifactDownloadGraceMs?: number;
  /** Maximum time a backend switch waits for owned cleanup + in-flight calls. */
  disposeGraceMs?: number;
  resolveUploadRoots?: (sessionId: string) => Promise<string[]>;
  /**
   * Timing overrides for the detached-window tab re-registration wait (tests
   * only — production uses the defaults below).
   */
  reattachWait?: { totalMs: number; pollMs: number };
}

/**
 * How long a direct WebContents action (navigate / screenshot / pdf / console
 * / act) waits for the renderer to re-register the target tab after
 * `ensureHost` pulled the detached sidebar window back up. Reopening the
 * window is not enough by itself: the fresh renderer must hydrate the session
 * bucket, mount the active tab's `<webview>`, wait for dom-ready and report
 * (sessionId, tabId, webContentsId) to main before the registry can resolve
 * the tab again — that chain takes network-bound time, hence a bounded poll
 * rather than a single re-check.
 */
const TAB_REATTACH_TOTAL_MS = 5000;
const TAB_REATTACH_POLL_MS = 250;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_DISPOSE_GRACE_MS = 1_500;
const RESTARTING_MESSAGE =
  'embedded browser control is restarting; retry shortly. If this persists, open Settings > Automation and choose one-click recovery';

/**
 * Standard error payload for an action we can't service. Keeps the shape
 * aligned with the vendored runtime's `BROWSER_RUNTIME_ACTION_FAILED` code so
 * existing MCP error handling works unchanged.
 */
function actionFailed(
  action: BrowserControlRequest['action'],
  message: string,
  errorCode: BrowserControlResult['errorCode'] = 'BROWSER_RUNTIME_ACTION_FAILED',
): BrowserControlResult {
  return {
    ok: false,
    action,
    errorCode,
    message,
  };
}

function actionOk<T>(
  action: BrowserControlRequest['action'],
  data: T,
): BrowserControlResult {
  return { ok: true, action, status: 200, data };
}

/**
 * Try to read a tab's current URL / title from its guest WebContents. Either
 * may throw on a webview that hasn't fully attached yet — callers fall back
 * to empty strings.
 */
function safeTabMeta(wc: WebContents): { url: string; title: string } {
  let url = '';
  let title = '';
  try {
    url = wc.getURL?.() ?? '';
  } catch {
    /* not attached */
  }
  try {
    title = wc.getTitle?.() ?? '';
  } catch {
    /* not attached */
  }
  return { url, title };
}

function mayStartDownload(request: BrowserActRequest): boolean {
  return request.kind === 'click'
    || request.kind === 'clickCoords'
    || request.kind === 'press'
    || request.kind === 'select'
    || (
      (request.kind === 'type' || request.kind === 'fill')
      && request.submit === true
    );
}

async function loadUrlWithTimeout(
  wc: WebContents,
  url: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error('embedded browser control generation was replaced');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopNavigation = () => {
    try {
      wc.stop();
    } catch {
      // The guest may already be gone.
    }
  };
  let rejectAbort: ((err: Error) => void) | undefined;
  const abort = () => {
    stopNavigation();
    rejectAbort?.(new Error('embedded browser control generation was replaced'));
  };
  try {
    await Promise.race([
      wc.loadURL(url),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          stopNavigation();
          reject(new Error(`navigation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export class RsbWebviewBackend implements BrowserBackend {
  readonly kind = 'rsb-webview' as const;
  private readonly automation: RsbWebviewAutomation;
  private readonly artifacts?: RsbWebviewArtifacts;
  private readonly dialogs: RsbWebviewDialogs;
  private readonly network: RsbWebviewNetwork;
  private readonly activity: BrowserActivity[] = [];
  private readonly activeCalls = new Set<Promise<BackendResult>>();
  private readonly backgroundCalls = new Set<Promise<unknown>>();
  private readonly pinLeases = new Set<() => void>();
  private readonly lifecycleAbort = new AbortController();
  private disposing = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly opts: RsbWebviewBackendOptions) {
    this.automation = new RsbWebviewAutomation(opts.logger);
    this.artifacts = opts.artifactRoot
      ? new RsbWebviewArtifacts(
        opts.artifactRoot,
        opts.logger,
        opts.artifactDownloadGraceMs,
      )
      : undefined;
    this.dialogs = new RsbWebviewDialogs(opts.logger);
    this.network = new RsbWebviewNetwork(opts.logger);
  }

  /**
   * Read the agent session id from an MCP-injected request, or fall back to
   * the UI-focus resolver. Always prefer the explicit field — that's the
   * agent's owning session, not the user's current focus.
   */
  private resolveSessionId(req: BackendRequest): string | null {
    const fromReq = (req as { __mcpSessionId?: unknown }).__mcpSessionId;
    if (typeof fromReq === 'string' && fromReq !== '') return fromReq;
    return this.opts.getActiveSessionId();
  }

  async call(request: BackendRequest): Promise<BackendResult> {
    if (this.disposing) {
      return actionFailed(
        request.action,
        RESTARTING_MESSAGE,
        'BROWSER_RUNTIME_UNAVAILABLE',
      );
    }
    const operation = (async (): Promise<BackendResult> => {
      try {
        const result = await this.dispatch(request);
        this.assertActive();
        this.recordActivity(request, result.ok);
        return result;
      } catch (err) {
        this.opts.logger.warn('rsb-webview backend.call threw', {
          action: request.action,
          err,
        });
        const result = actionFailed(
          request.action,
          this.disposing
            ? RESTARTING_MESSAGE
            : err instanceof Error
              ? err.message
              : String(err),
          this.disposing
            ? 'BROWSER_RUNTIME_UNAVAILABLE'
            : 'BROWSER_RUNTIME_ACTION_FAILED',
        );
        this.recordActivity(request, false);
        return result;
      }
    })();
    this.activeCalls.add(operation);
    try {
      return await operation;
    } finally {
      this.activeCalls.delete(operation);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.lifecycleAbort.abort();
    this.disposePromise = this.performDispose();
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    // Switching backends never closes the user's tabs. Only listeners,
    // captures and debugger attachments owned by this backend are released.
    // Clean them first so bounded dialog/network/download waits are nudged to
    // settle; helper instances are terminal and refuse to re-observe after it.
    const shutdown = (async () => {
      const cleanup = await Promise.allSettled([
        Promise.resolve().then(() => this.automation.dispose()),
        Promise.resolve().then(() => this.artifacts?.dispose()),
        Promise.resolve().then(() => this.dialogs.dispose()),
        Promise.resolve().then(() => this.network.dispose()),
        Promise.resolve().then(() => this.releasePinLeases()),
      ]);
      for (const result of cleanup) {
        if (result.status === 'rejected') {
          this.opts.logger.warn('rsb-webview backend cleanup failed during dispose', result.reason);
        }
      }
      await Promise.allSettled([
        ...this.activeCalls,
        ...this.backgroundCalls,
      ]);
    })();

    const graceMs = Math.max(0, this.opts.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      shutdown.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!completed) {
      this.opts.logger.warn('rsb-webview backend dispose grace elapsed; replacement may continue', {
        graceMs,
        activeCalls: this.activeCalls.size,
        backgroundCalls: this.backgroundCalls.size,
      });
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  /** Health handshake across main → preload → renderer. */
  async probeControl(options: { ensureHost?: boolean } = {}): Promise<void> {
    this.assertActive();
    const result = await dispatchTabOp(
      { op: 'probe' },
      this.opts.bridge,
      () => this.assertActive(),
      { ensureHost: options.ensureHost === true },
    );
    this.assertActive();
    if (!result.ok) throw new Error(result.error);
  }

  private assertActive(): void {
    if (this.disposing) {
      throw new Error('embedded browser control generation was replaced');
    }
  }

  private async dispatch(request: BackendRequest): Promise<BackendResult> {
    switch (request.action) {
      case 'status':
        return this.handleStatus(request);
      case 'doctor':
        return this.handleDoctor(request);
      case 'start':
      case 'stop':
        // Webview lifecycle is owned by the RSB itself — these are no-ops.
        return actionOk(request.action, { ready: true });
      case 'profiles':
        return this.handleProfiles(request);
      case 'tabs':
        return this.handleTabs(request);
      case 'open':
        return this.handleOpen(request);
      case 'focus':
        return this.handleFocus(request);
      case 'close':
        return this.handleClose(request);
      case 'navigate':
        return this.handleNavigate(request);
      case 'snapshot':
        return this.handleSnapshot(request);
      case 'screenshot':
        return this.handleScreenshot(request);
      case 'pdf':
        return this.handlePdf(request);
      case 'console':
        return this.handleConsole(request);
      case 'act':
        return this.handleAct(request);
      case 'upload':
        return this.handleUpload(request);
      case 'dialog':
        return this.handleDialog(request);
      case 'requests':
        return this.handleRequests(request);
      case 'responseBody':
        return this.handleResponseBody(request);
      default:
        return actionFailed(
          request.action,
          `action '${request.action}' not yet supported in rsb-webview backend`,
        );
    }
  }

  // ── individual action handlers ────────────────────────────────────────────

  private handleStatus(req: BackendRequest): BrowserControlResult {
    const sessionId = this.resolveSessionId(req);
    return actionOk(req.action, {
      ready: true,
      backend: 'rsb-webview',
      sessionId,
      tabCount: sessionId ? this.opts.registry.listBySession(sessionId).length : 0,
    });
  }

  private handleDoctor(req: BackendRequest): BrowserControlResult {
    const sessionId = this.resolveSessionId(req);
    return actionOk(req.action, {
      backend: 'rsb-webview',
      ok: true,
      activeSessionId: sessionId,
      totalRegisteredTabs: this.opts.registry.listAll().length,
      pinnedTabs: this.opts.registry.listPinned(),
      dialogs: this.dialogs.diagnostics(),
      ...(this.artifacts ? { artifacts: this.artifacts.diagnostics(sessionId ?? undefined) } : {}),
      network: this.network.diagnostics(),
      recentActivity: this.activity.slice(-20),
    });
  }

  private handleProfiles(req: BackendRequest): BrowserControlResult {
    // RSB has exactly one profile (the BROWSER_PARTITION); login state lives
    // in cookies inside that partition. We surface it as a single entry to
    // match the external Chrome backend's shape — the MCP layer expects a
    // `profiles` array.
    return actionOk(req.action, {
      profiles: [
        {
          name: 'rsb',
          displayName: 'RSB Sidebar Browser',
          managed: false,
          default: true,
        },
      ],
    });
  }

  private handleTabs(req: BackendRequest): BrowserControlResult {
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) {
      return actionFailed(req.action, 'no active RSB session');
    }
    const records = this.opts.registry.listBySession(sessionId);
    const tabs = records.map((record) => {
      const wc = this.opts.registry.getWebContentsByTabId(record.tabId);
      const meta = wc ? safeTabMeta(wc) : { url: '', title: '' };
      return {
        targetId: record.tabId,
        suggestedTargetId: record.tabId,
        tabId: record.tabId,
        url: meta.url,
        title: meta.title,
        pinned: this.opts.registry.isPinned(record.tabId),
      };
    });
    return actionOk(req.action, { tabs });
  }

  private async handleOpen(req: BackendRequest): Promise<BackendResult> {
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) {
      return actionFailed(req.action, 'no active RSB session');
    }
    const url = (req as { url?: string }).url;
    const result = await dispatchTabOp(
      { op: 'open', sessionId, url },
      this.opts.bridge,
      () => this.assertActive(),
    );
    if (!result.ok) {
      return actionFailed(req.action, result.error);
    }
    if (result.tabId) this.trackBackground(this.observeOpenedTab(result.tabId));
    return actionOk(req.action, {
      targetId: result.tabId,
      tabId: result.tabId,
    });
  }

  private async handleFocus(req: BackendRequest): Promise<BackendResult> {
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) {
      return actionFailed(req.action, 'no active RSB session');
    }
    const tabId = this.extractTargetId(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const result = await dispatchTabOp(
      { op: 'focus', sessionId, tabId },
      this.opts.bridge,
      () => this.assertActive(),
    );
    if (!result.ok) return actionFailed(req.action, result.error);
    return actionOk(req.action, { tabId });
  }

  private async handleClose(req: BackendRequest): Promise<BackendResult> {
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) {
      return actionFailed(req.action, 'no active RSB session');
    }
    const tabId = this.extractTargetId(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const result = await dispatchTabOp(
      { op: 'close', sessionId, tabId },
      this.opts.bridge,
      () => this.assertActive(),
    );
    if (!result.ok) return actionFailed(req.action, result.error);
    this.automation.forgetTab(tabId);
    return actionOk(req.action, { tabId });
  }

  private async handleNavigate(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const url = (req as { url?: string }).url;
    if (typeof url !== 'string' || url === '') {
      return actionFailed(req.action, 'url required');
    }
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      this.automation.forgetTab(tabId);
      await this.tryObservePageSignals(resolved.wc, tabId);
      this.assertActive();
      await loadUrlWithTimeout(
        resolved.wc,
        url,
        req.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
        this.lifecycleAbort.signal,
      );
      return actionOk(req.action, { tabId, url });
    });
  }

  private async handleSnapshot(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      await this.tryObservePageSignals(resolved.wc, tabId);
      const dialog = this.dialogs.pending(resolved.wc);
      if (dialog) {
        return actionOk(req.action, {
          format: req.snapshotFormat ?? 'ai',
          targetId: tabId,
          url: resolved.wc.getURL(),
          barrier: { kind: 'page-dialog', dialog },
          stats: { lines: 0, chars: 0, refs: 0, interactive: 0 },
        });
      }
      const data = await this.automation.snapshot(tabId, resolved.wc, req);
      return actionOk(req.action, data);
    });
  }

  private async handleScreenshot(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    if (req.fullPage) {
      // The RSB webview backend captures the guest WebContents viewport only;
      // full-page capture is not implemented here. Reject explicitly instead of
      // silently returning a viewport crop (matches the vendored runtime's
      // "explicitly reject unsupported params" contract).
      return actionFailed(
        req.action,
        'fullPage is not supported by the RSB webview backend (captures the visible viewport only)',
      );
    }
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      const image = await resolved.wc.capturePage();
      // Honor `type` instead of always encoding PNG: JPEG via toJPEG(85),
      // matching the CDP path's default quality. MIME/bytes follow the buffer.
      const type = req.type === 'jpeg' ? 'jpeg' : 'png';
      const buffer = type === 'jpeg' ? image.toJPEG(85) : image.toPNG();
      return actionOk(req.action, {
        tabId,
        mimeType: type === 'jpeg' ? 'image/jpeg' : 'image/png',
        // Base64-encoded image — same shape the vendored runtime returns for
        // `screenshot` so MCP callers don't need to know which backend ran.
        data: buffer.toString('base64'),
        bytes: buffer.length,
      });
    });
  }

  private async handlePdf(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      const pdf = await resolved.wc.printToPDF({});
      return actionOk(req.action, {
        tabId,
        mimeType: 'application/pdf',
        data: pdf.toString('base64'),
        bytes: pdf.length,
      });
    });
  }

  private async handleAct(req: BackendRequest): Promise<BackendResult> {
    const inner = (req as { request?: BrowserActRequest & { as?: string } }).request;
    if (!inner || typeof inner !== 'object') {
      return actionFailed(req.action, 'request body required');
    }
    if (
      typeof req.targetId === 'string'
      && typeof inner.targetId === 'string'
      && req.targetId !== inner.targetId
    ) {
      return actionFailed(req.action, 'targetId mismatch between act request and nested request');
    }
    const automationRequest = inner.timeoutMs === undefined && req.timeoutMs !== undefined
      ? { ...inner, timeoutMs: req.timeoutMs }
      : inner;
    const requestWithInnerTarget = {
      ...req,
      ...(typeof req.targetId === 'string'
        ? {}
        : typeof inner.targetId === 'string'
          ? { targetId: inner.targetId }
          : {}),
    } as BackendRequest;
    if (inner.kind === 'close') {
      const result = await this.handleClose(requestWithInnerTarget);
      if (!result.ok || !result.data || typeof result.data !== 'object') return result;
      return {
        ...result,
        data: { ...(result.data as Record<string, unknown>), kind: 'close' },
      };
    }

    const tabId = await this.resolveDirectActionTarget(requestWithInnerTarget);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(requestWithInnerTarget, tabId);
    if (!resolved.ok) return resolved.result;
    const wc = resolved.wc;
    const humanVerification = this.automation.getHumanVerificationBarrier(tabId);
    if (humanVerification) {
      return actionOk(req.action, {
        tabId,
        kind: inner.kind,
        barrier: humanVerification,
      });
    }

    if (inner.kind === 'saveResource') {
      if (!this.artifacts) return actionFailed(req.action, 'managed downloads are unavailable');
      if (typeof inner.url !== 'string' || !isPublicHttpResourceUrl(inner.url)) {
        return actionFailed(req.action, 'saveResource.url must be an http(s) URL from snapshot(urls:true)');
      }
      this.automation.assertResource(tabId, inner.url);
      const sessionId = this.resolveSessionId(requestWithInnerTarget);
      if (!sessionId) return actionFailed(req.action, 'no active RSB session');
      return this.withTabPin(tabId, async () => {
        await this.tryObservePageSignals(wc, tabId);
        const captured = await this.artifacts!.capture(
          wc,
          { sessionId, timeoutMs: inner.timeoutMs ?? req.timeoutMs },
          async () => {
            wc.downloadURL(inner.url!);
            return undefined;
          },
        );
        if (!captured.downloads.some((artifact) => artifact.state === 'completed')) {
          return actionFailed(req.action, 'resource download did not complete');
        }
        return actionOk(req.action, {
          tabId,
          kind: inner.kind,
          url: inner.url,
          downloads: captured.downloads,
        });
      });
    }

    if (inner.kind === 'evaluate') {
      if (typeof inner.fn !== 'string' || inner.fn === '') {
        return actionFailed(req.action, 'evaluate.fn (JS expression source) required');
      }
      return this.withTabPin(tabId, async () => {
        await this.tryObservePageSignals(wc, tabId);
        let value: unknown;
        try {
          value = await this.automation.evaluate(tabId, wc, automationRequest);
        } catch (err) {
          return actionFailed(
            req.action,
            err instanceof Error ? err.message : String(err),
          );
        }
        return actionOk(req.action, {
          tabId,
          kind: 'evaluate',
          ...(typeof inner.as === 'string' ? { as: inner.as } : {}),
          result: value,
        });
      });
    }

    return this.withTabPin(tabId, async (retainTabPin) => {
      await this.tryObserveNetwork(wc, tabId);
      const opening = await this.tryWatchPageDialog(wc, tabId);
      const pendingDialog = opening ? this.dialogs.pending(wc) : undefined;
      if (pendingDialog) {
        opening?.cancel();
        return actionOk(req.action, {
          tabId,
          kind: inner.kind,
          barrier: { kind: 'page-dialog', dialog: pendingDialog },
        });
      }

      const actionStartedAt = Date.now();
      const runAction = async () => {
        const dialogBeforeStart = opening ? this.dialogs.pending(wc) : undefined;
        if (dialogBeforeStart) {
          opening?.cancel();
          return {
            tabId,
            kind: inner.kind,
            barrier: { kind: 'page-dialog', dialog: dialogBeforeStart },
          };
        }
        const actionPromise = this.automation.act(tabId, wc, automationRequest, {
          nativeKeyDispatch: async (type, keyCode, modifiers) => {
            this.assertActive();
            const sendInputEvent = (wc as unknown as {
              sendInputEvent?: (event: {
                type: 'keyDown' | 'keyUp';
                keyCode: string;
                modifiers?: string[];
              }) => void;
            }).sendInputEvent;
            if (!sendInputEvent) throw new Error('native keyboard input is unavailable');
            sendInputEvent({ type, keyCode, modifiers });
            this.assertActive();
          },
          waitForNetworkIdle: (timeoutMs) => this.network.waitForIdle(wc, { timeoutMs }),
        });
        if (!opening) return actionPromise;
        const outcome = await Promise.race([
          actionPromise.then((value) => ({ type: 'action' as const, value })),
          opening.opened.then((dialog) => ({ type: 'dialog' as const, dialog })),
        ]);
        if (outcome.type === 'action') {
          opening.cancel();
          const closedDialog = this.dialogs.recent(
            wc,
            undefined,
            actionStartedAt,
          );
          if (closedDialog && closedDialog.type !== 'alert') {
            return {
              tabId,
              kind: inner.kind,
              barrier: { kind: 'page-dialog', dialog: closedDialog },
            };
          }
          if (closedDialog) {
            return {
              ...outcome.value,
              dialogs: [{ ...closedDialog, handled: true }],
            };
          }
          return outcome.value;
        }
        if (outcome.dialog.type === 'alert') {
          const value = await actionPromise;
          const closedDialog = this.dialogs.recent(wc, outcome.dialog.id);
          return {
            ...value,
            dialogs: [{
              ...(closedDialog ?? outcome.dialog),
              handled: true,
            }],
          };
        }
        void actionPromise.catch((err) => {
          this.opts.logger.warn('browser action failed after a page dialog opened', {
            tabId,
            actionKind: inner.kind,
            err,
          });
        });
        const releaseRetainedPin = retainTabPin();
        void actionPromise.then(
          releaseRetainedPin,
          releaseRetainedPin,
        );
        return {
          tabId,
          kind: inner.kind,
          barrier: { kind: 'page-dialog', dialog: outcome.dialog },
        };
      };

      const captured = this.artifacts
        && mayStartDownload(inner)
        ? await this.artifacts.capture(
          wc,
          {
            sessionId: this.resolveSessionId(requestWithInnerTarget) ?? 'rsb',
            timeoutMs: inner.timeoutMs ?? req.timeoutMs,
          },
          runAction,
        )
        : { value: await runAction(), downloads: [] };
      return actionOk(req.action, {
        ...captured.value,
        ...(captured.downloads.length > 0 ? { downloads: captured.downloads } : {}),
      });
    });
  }

  private async handleConsole(req: BackendRequest): Promise<BackendResult> {
    // Console capture via CDP. Attach is idempotent — Electron throws if
    // already attached and we ignore that path (e.g. previous DevTools open).
    // Phase 3 returns a one-shot capture of pending console events buffered
    // since the previous `console` call on this webContents. Phase 4 may
    // upgrade to a streaming subscription.
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      const buffer = ensureConsoleBuffer(resolved.wc, this.opts.logger);
      const messages = buffer.drain();
      return actionOk(req.action, { tabId, messages });
    });
  }

  private async handleUpload(req: BackendRequest): Promise<BackendResult> {
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) return actionFailed(req.action, 'no active RSB session');
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      const roots = [
        ...(this.opts.artifactRoot
          ? [artifactSessionRoot(this.opts.artifactRoot(), sessionId)]
          : []),
        ...(this.opts.resolveUploadRoots
          ? await this.opts.resolveUploadRoots(sessionId)
          : []),
      ];
      const paths = await resolveUploadFiles(req.paths, roots);
      await this.tryObservePageSignals(resolved.wc, tabId);
      const data = await this.automation.setFiles(tabId, resolved.wc, {
        ...req,
        paths,
      });
      return actionOk(req.action, data);
    });
  }

  private async handleDialog(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      let dialog;
      try {
        dialog = await this.dialogs.respond(resolved.wc, {
          dialogId: req.dialogId,
          accept: req.accept,
          promptText: req.promptText,
          timeoutMs: req.timeoutMs,
        });
      } catch (err) {
        if (
          !(err instanceof Error)
          || err.message !== 'no page dialog is pending'
          || req.accept !== true
        ) {
          throw err;
        }
        const armed = this.dialogs.armNext(resolved.wc, {
          accept: true,
          promptText: req.promptText,
          timeoutMs: req.timeoutMs,
        });
        void armed.response.catch((responseErr) => {
          this.opts.logger.warn('prepared page dialog response expired', {
            tabId,
            err: responseErr,
          });
        });
        return actionOk(req.action, {
          tabId,
          armed: true,
          retryRequired: true,
        });
      }
      if (dialog.deferred) {
        if (
          dialog.closedBy === 'armed'
          || dialog.type === 'alert'
          || req.accept !== true
        ) {
          return actionOk(req.action, {
            tabId,
            dialog,
            handled: true,
          });
        }
        const armed = this.dialogs.armNext(resolved.wc, {
          accept: true,
          promptText: req.promptText,
          timeoutMs: req.timeoutMs,
        });
        void armed.response.catch((err) => {
          this.opts.logger.warn('prepared page dialog response expired', {
            tabId,
            err,
          });
        });
        return actionOk(req.action, {
          tabId,
          dialog,
          armed: true,
          retryRequired: true,
        });
      }
      return actionOk(req.action, { tabId, dialog });
    });
  }

  private async handleRequests(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      await this.network.observe(resolved.wc);
      const requests = this.network.readRequests(resolved.wc, {
        filter: typeof req.filter === 'string' ? req.filter : undefined,
        clear: req.clear === true,
      });
      return actionOk(req.action, { tabId, requests });
    });
  }

  private async handleResponseBody(req: BackendRequest): Promise<BackendResult> {
    const tabId = await this.resolveDirectActionTarget(req);
    if (!tabId) return actionFailed(req.action, 'targetId required');
    if (typeof req.url !== 'string' || req.url.trim() === '') {
      return actionFailed(req.action, 'responseBody.url required');
    }
    const resolved = await this.resolveTabForDirectAction(req, tabId);
    if (!resolved.ok) return resolved.result;
    return this.withTabPin(tabId, async () => {
      const response = await this.network.readResponseBody(resolved.wc, {
        url: req.url!,
        maxChars: req.maxChars,
        timeoutMs: req.timeoutMs,
      });
      return actionOk(req.action, { tabId, response });
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private recordActivity(req: BackendRequest, ok: boolean): void {
    const directTarget = (req as { targetId?: unknown }).targetId;
    const nestedTarget = (req as { request?: { targetId?: unknown } }).request?.targetId;
    const targetId = typeof directTarget === 'string' && directTarget !== ''
      ? directTarget
      : typeof nestedTarget === 'string' && nestedTarget !== ''
        ? nestedTarget
        : undefined;
    this.activity.push({
      action: req.action,
      finishedAt: new Date().toISOString(),
      ok,
      ...(targetId ? { targetId } : {}),
    });
    if (this.activity.length > 200) {
      this.activity.splice(0, this.activity.length - 200);
    }
  }

  private async tryWatchPageDialog(
    wc: WebContents,
    tabId: string,
  ): Promise<ReturnType<RsbWebviewDialogs['watchOpening']> | undefined> {
    if (this.disposing) return undefined;
    try {
      await this.dialogs.observe(wc);
      return this.dialogs.watchOpening(wc);
    } catch (err) {
      // Dialog capture enriches an action but should not make the action fail
      // when another debugger client owns the guest or Page.enable is refused.
      this.opts.logger.warn('RSB page dialog observation unavailable', { tabId, err });
      return undefined;
    }
  }

  private async tryObserveNetwork(wc: WebContents, tabId: string): Promise<void> {
    if (this.disposing) return;
    try {
      await this.network.observe(wc);
    } catch (err) {
      // Network capture enriches normal browsing actions but must not prevent
      // the underlying page action when DevTools owns the debugger.
      this.opts.logger.warn('RSB network observation unavailable', { tabId, err });
    }
  }

  private async tryObservePageSignals(wc: WebContents, tabId: string): Promise<void> {
    if (this.disposing) return;
    await this.tryObserveNetwork(wc, tabId);
    if (this.disposing) return;
    try {
      await this.dialogs.observe(wc);
    } catch (err) {
      this.opts.logger.warn('RSB page dialog observation unavailable', { tabId, err });
    }
  }

  /**
   * Arm Network.enable as soon as the renderer reports a newly-created tab.
   * `open` starts navigation in the renderer, so waiting until a later
   * `requests` call would lose the document's initial requests.
   */
  private async observeOpenedTab(tabId: string): Promise<void> {
    try {
      const deadline = Date.now() + 2_000;
      for (;;) {
        if (this.disposing) return;
        const wc = this.opts.registry.getWebContentsByTabId(tabId);
        if (wc) {
          await this.tryObservePageSignals(wc, tabId);
          return;
        }
        if (Date.now() >= deadline) {
          this.opts.logger.warn('new browser tab was not reported before network capture arm', {
            tabId,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } catch (err) {
      this.opts.logger.warn('failed to arm network capture for new browser tab', {
        tabId,
        err,
      });
    }
  }

  private trackBackground(operation: Promise<unknown>): void {
    this.backgroundCalls.add(operation);
    void operation.then(
      () => this.backgroundCalls.delete(operation),
      () => this.backgroundCalls.delete(operation),
    );
  }

  /**
   * Per-action automation pin. Wraps an action body so the targeted tab is
   * pinned (LRU eviction skips it, see browserWebviewPool.evictLRU + the
   * pinChangeListener that mirrors pin state into the renderer pool) for the
   * duration of the action — and unpinned the moment the action finishes,
   * success or failure.
   *
   * Lifecycle policy (user's call):
   *   - Inside an action → pinned: user can't accidentally close the tab via
   *     LRU pressure, agent's in-flight wc operation can rely on it being
   *     alive.
   *   - Between actions → unpinned: tab follows normal LRU + manual close
   *     rules. If the user takes their own action (close, or causing LRU
   *     pressure from a different tab) between agent actions, the tab is
   *     subject to that — the next agent action surfaces a clear
   *     "tab not found / destroyed" error rather than holding the tab alive
   *     forever.
   *
   * Concurrency: each action owns a token-scoped registry lease. Concurrent
   * calls and replacement backend generations can release only their own
   * token, so a late finally cannot unpin another live operation.
   */
  private async withTabPin<T>(
    tabId: string,
    body: (retainTabPin: () => (() => void)) => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    const releasePin = this.acquireTabPin(tabId);
    let retained = false;
    try {
      this.assertActive();
      const result = await body(() => {
        retained = true;
        return releasePin;
      });
      this.assertActive();
      return result;
    } finally {
      if (!retained) releasePin();
    }
  }

  private acquireTabPin(tabId: string): () => void {
    const releaseRegistryPin = this.opts.registry.acquirePinLease(tabId);
    let active = true;
    const release = () => {
      if (!active) return;
      active = false;
      this.pinLeases.delete(release);
      releaseRegistryPin();
    };
    this.pinLeases.add(release);
    return release;
  }

  private releasePinLeases(): void {
    for (const release of [...this.pinLeases]) release();
  }

  /**
   * All tab-scoped actions take `targetId` (mapped 1:1 to RSB tabId).
   *
   * Compatibility fallback: vendored runtime auto-resolves missing targetId
   * to the active tab (recipe authors lean on this — first navigate step
   * commonly omits targetId). We mirror that by falling back to the active
   * session's most-recently-reported tab.
   *
   * Returns `null` only when there's neither an explicit targetId nor an
   * inferable active tab — caller still produces the "targetId required"
   * error in that genuinely-ambiguous case.
   */
  private extractTargetId(req: BackendRequest): string | null {
    const v = (req as { targetId?: unknown }).targetId;
    if (typeof v === 'string' && v !== '') return v;
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) return null;
    const records = this.opts.registry.listBySession(sessionId);
    // Last reported wins — RsbBrowserBridge replaces a tab's record on every
    // report, so iteration order reflects most-recently-reported approximately.
    // No formal "active tab" signal flows to main today; this heuristic matches
    // how the vendored runtime picks its default and is good enough for the
    // recipe path (first action establishes a working tab, later actions in
    // the recipe re-use that same targetId via interpolation).
    return records[records.length - 1]?.tabId ?? null;
  }

  /**
   * Target-id resolution for direct actions, detached-window aware.
   *
   * `extractTargetId` falls back to "most-recently-reported tab in the
   * registry" for targetless requests — but when the detached sidebar window
   * is closed the registry was pruned with it, so that fallback sees nothing
   * and the action would die on 'targetId required' before the re-attach
   * path ever runs. In that case dispatch a targetless 'ensure' op: the
   * renderer hydrates the request session, picks its active (or last)
   * web-browser tab from the persisted bucket, materializes it and acks with
   * the tabId — which we adopt as the target.
   */
  private async resolveDirectActionTarget(req: BackendRequest): Promise<string | null> {
    const explicit = this.extractTargetId(req);
    if (explicit) return explicit;
    if (!this.opts.bridge.ensureHost || !this.opts.bridge.isDetached?.()) return null;
    const sessionId = this.resolveSessionId(req);
    if (!sessionId) return null;
    try {
      const ensured = await dispatchTabOp(
        { op: 'ensure', sessionId },
        this.opts.bridge,
        () => this.assertActive(),
      );
      this.assertActive();
      if (ensured.ok && typeof ensured.tabId === 'string') return ensured.tabId;
    } catch (err) {
      this.opts.logger.warn('targetless ensure tab-op failed', {
        action: req.action,
        err,
      });
    }
    return null;
  }

  /**
   * Resolve a tab for a direct WebContents action (navigate / screenshot /
   * pdf / console / act), detached-window aware. Mirrors the ensure/wait
   * path `dispatchTabOp` already runs for open / focus / close:
   *
   *   1. `ensureHost` first — when the user prefers detached mode but has the
   *      sidebar window closed, its `<webview>` guests were destroyed and the
   *      TabRegistry pruned their records; without reopening the host there is
   *      no renderer that could ever re-register the tab. No-op when embedded
   *      or the window is already up.
   *   2. Resolve; on miss — and ONLY in detached mode — dispatch an 'ensure'
   *      tab-op so the renderer hydrates the request session and eagerly
   *      re-materializes this tab's webview (report → registry), then
   *      re-resolve with a bounded poll (`TAB_REATTACH_*`) as safety net.
   *
   * The poll is gated on `bridge.isDetached`: embedded mode's host is the
   * always-alive main window, so a resolve miss there is genuinely stale
   * (user closed the tab / cross-session access) and must fail fast — in
   * production `ensureHost` is always wired (a no-op when embedded), so its
   * presence alone can't justify waiting. In detached mode a genuinely stale
   * tabId does pay the poll timeout before surfacing the same clear error —
   * an accepted trade: automation favors eventual success over fast failure.
   */
  private async resolveTabForDirectAction(
    req: BackendRequest,
    tabId: string,
  ): Promise<{ ok: true; wc: WebContents } | { ok: false; result: BrowserControlResult }> {
    const ensureHost = this.opts.bridge.ensureHost;
    if (ensureHost) {
      try {
        this.assertActive();
        await ensureHost();
        this.assertActive();
      } catch (err) {
        // Window failed to come up (ready timeout etc.) — fall through, the
        // resolve below surfaces the concrete tab error to the agent.
        this.opts.logger.warn('ensureHost failed before direct action', {
          action: req.action,
          err,
        });
      }
    }
    let resolved = this.resolveTabInActiveSession(req, tabId);
    if (resolved.ok || !ensureHost || !this.opts.bridge.isDetached?.()) return resolved;
    // Renderer-driven recovery. Passive polling alone is NOT enough: the
    // reopened sidebar window only hydrates the main window's context session,
    // so a cross-session agent tab would never re-register on its own. Ask
    // the renderer to hydrate the REQUEST session and re-materialize this
    // tab's webview ('ensure' op — report lands before the ack). A renderer
    // `ok:false` means the tab is truly gone from the bucket — fail fast with
    // the original clear error instead of burning the poll timeout.
    const sessionId = this.resolveSessionId(req);
    if (sessionId) {
      try {
        const ensured = await dispatchTabOp(
          { op: 'ensure', sessionId, tabId },
          this.opts.bridge,
          () => this.assertActive(),
        );
        this.assertActive();
        if (!ensured.ok) return resolved;
      } catch (err) {
        // Dispatch timeout / host teardown — the renderer may still be
        // spawning; fall through to the bounded poll below.
        this.opts.logger.warn('ensure tab-op failed before direct action', {
          action: req.action,
          err,
        });
      }
    }
    resolved = this.resolveTabInActiveSession(req, tabId);
    if (resolved.ok) return resolved;
    const wait = this.opts.reattachWait ?? {
      totalMs: TAB_REATTACH_TOTAL_MS,
      pollMs: TAB_REATTACH_POLL_MS,
    };
    const deadline = Date.now() + wait.totalMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, wait.pollMs));
      this.assertActive();
      resolved = this.resolveTabInActiveSession(req, tabId);
      if (resolved.ok) return resolved;
    }
    return resolved;
  }

  /**
   * Cross-session guard. Any tab-scoped wc action (navigate / screenshot /
   * pdf / console / act) must verify the tabId belongs to the currently-
   * active RSB session. Otherwise an agent holding a stale tabId from the
   * previous session could keep operating its tabs after the user switched
   * away — TabRegistry survives session switches by design (tabs are persisted
   * per-session in the renderer's DB).
   *
   * Returns the live WebContents if the tab is in scope, an `actionFailed`
   * payload otherwise. Callers branch on the discriminator.
   */
  private resolveTabInActiveSession(
    req: BackendRequest,
    tabId: string,
  ): { ok: true; wc: WebContents } | { ok: false; result: BrowserControlResult } {
    const action = req.action;
    const active = this.resolveSessionId(req);
    if (!active) {
      return { ok: false, result: actionFailed(action, 'no active RSB session') };
    }
    const recordSession = this.opts.registry.listBySession(active).find(
      (r) => r.tabId === tabId,
    );
    if (!recordSession) {
      return {
        ok: false,
        result: actionFailed(
          action,
          `tab ${tabId} not in active session ${active}`,
        ),
      };
    }
    const wc = this.opts.registry.getWebContentsByTabId(tabId);
    if (!wc) {
      return {
        ok: false,
        result: actionFailed(action, `tab ${tabId} not found or destroyed`),
      };
    }
    return { ok: true, wc };
  }
}

// ── console capture infrastructure ─────────────────────────────────────────
//
// One ring buffer per webContents. Capped to 200 messages so a chatty page
// doesn't keep memory growing between `console` calls. Buffer survives until
// the webContents is destroyed (registry's destroyed listener won't fire here
// because the buffer is keyed off the wc object itself — the WeakMap holds a
// weak reference and is GC'd along with the wc).

interface ConsoleMessage {
  level: number;
  source: string;
  message: string;
  line: number;
  sourceId: string;
  ts: number;
}

class ConsoleRingBuffer {
  private readonly cap = 200;
  private items: ConsoleMessage[] = [];

  push(msg: ConsoleMessage): void {
    this.items.push(msg);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }

  drain(): ConsoleMessage[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

const consoleBuffers = new WeakMap<WebContents, ConsoleRingBuffer>();

function ensureConsoleBuffer(
  wc: WebContents,
  logger: BackendLogger,
): ConsoleRingBuffer {
  let buf = consoleBuffers.get(wc);
  if (buf) return buf;
  buf = new ConsoleRingBuffer();
  consoleBuffers.set(wc, buf);
  // `console-message` fires for every guest console.* call. Defensive: a
  // malformed event shouldn't poison the buffer.
  // Electron < 36: signature is (event, level, message, line, sourceId).
  // Electron 36+: signature is (event, { level, message, lineNumber, sourceId }).
  // Probe at runtime — handle both.
  const handler = (...args: unknown[]) => {
    try {
      const ts = Date.now();
      const first = args[1];
      if (first && typeof first === 'object' && 'level' in (first as object)) {
        const o = first as { level: number; message: string; lineNumber?: number; sourceId?: string; source?: string };
        buf.push({
          level: typeof o.level === 'number' ? o.level : 0,
          source: typeof o.source === 'string' ? o.source : 'guest',
          message: typeof o.message === 'string' ? o.message : String(o.message),
          line: typeof o.lineNumber === 'number' ? o.lineNumber : 0,
          sourceId: typeof o.sourceId === 'string' ? o.sourceId : '',
          ts,
        });
      } else {
        // Legacy 5-arg signature.
        buf.push({
          level: typeof args[1] === 'number' ? (args[1] as number) : 0,
          source: 'guest',
          message: typeof args[2] === 'string' ? (args[2] as string) : String(args[2]),
          line: typeof args[3] === 'number' ? (args[3] as number) : 0,
          sourceId: typeof args[4] === 'string' ? (args[4] as string) : '',
          ts,
        });
      }
    } catch (err) {
      logger.warn('console-message handler threw', err);
    }
  };
  // Cast: Electron typings differ across versions, and we deliberately want
  // both shapes.
  (wc as unknown as { on: (event: string, fn: (...args: unknown[]) => void) => void }).on(
    'console-message',
    handler,
  );
  return buf;
}
