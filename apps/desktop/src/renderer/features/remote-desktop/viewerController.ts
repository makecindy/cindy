import {
  DESKTOP_KEY_CODES,
  REMOTE_DESKTOP_NETWORK,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  RemoteDesktopViewerSession,
  REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS,
  viewerDisplaySize,
  fittedDisplayModes,
  findRememberedMode,
  RemoteDesktopViewerMedia,
  remoteDesktopFailureKey,
  isDesktopInput,
  isRemoteDesktopChannelRequest,
  parseRemoteDesktopChannelReply,
  REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS,
  type RemoteDesktopCapabilities,
  type RemoteDesktopDisplayMode,
  type RemoteDesktopVideoSettings,
  type RemoteDesktopRequest,
  type DesktopInput,
} from '@cindy/device-link';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';
import { extractIpcError } from '@/utils/ipcError';
import type {
  RemoteDesktopViewerApi,
  RemoteViewerState,
} from '../../../shared/remoteDesktopViewer';
import {
  DEFAULT_VIEWER_PREFERENCES,
  type RememberedViewerResolution,
  type RemoteViewerChannelOutcome as ChannelOutcome,
  type RemoteViewerChannelRequest,
  type RemoteViewerPreferences,
  type RemoteViewerSafety,
  type RemoteViewerCredentialState,
} from '../../../shared/remoteDesktopViewer';

type Size = { width: number; height: number };

export interface ViewerSnapshot {
  target: RemoteViewerState['target'];
  status: string;
  error: string | null;
  controlling: boolean;
  controlPending: boolean;
  caps: RemoteDesktopCapabilities | null;
  displayId: string;
  transport: '' | 'video' | 'direct' | 'relay' | 'screenshots';
  latency: number | null;
  settings: RemoteDesktopVideoSettings;
  ready: boolean;
  scaleMode?: 'fit' | 'actual' | 'custom';
  preferences: RemoteViewerPreferences;
  safety: RemoteViewerSafety;
  receiveRate: number | null;
  closing: boolean;
  credential: RemoteViewerCredentialState | null;
  credentialBusy: boolean;
  credentialNotice: string | null;
  /** The picture was fitted to this window; restore and same-ratio sizes apply. */
  fittedDisplay: Size | null;
}

const sameAspect = (display: Size, width: number, height: number) =>
  width > 0 && height > 0 && Math.abs(display.width / display.height - width / height) < 0.003;

/** macOS reports native fullscreen transitions as a brief hide/show; only a
 * viewer that stays hidden pauses the host's video. Showing resumes at once. */
const HIDDEN_VIDEO_PAUSE_MS = 1500;

function connectionBudget(caps: RemoteDesktopCapabilities | null): number {
  // Match Mobile: system consent has its own two-minute host deadline.
  return (
    REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS +
    (caps?.displays.some((display) => display.id === 'wayland-portal') ? 120_000 : 0)
  );
}

const CLIPBOARD_FAILURE_KEYS: Record<string, string> = {
  DESKTOP_VIEW_ONLY: 'remoteDesktop.viewer.controlRequired',
  CLIPBOARD_UNSUPPORTED: 'remoteDesktop.viewer.clipboardUnsupported',
  CLIPBOARD_EMPTY: 'remoteDesktop.viewer.clipboardEmpty',
  CLIPBOARD_TOO_LONG: 'remoteDesktop.viewer.clipboardTooLong',
};

/** Explains a failed manual clipboard transfer (decoded code); same wording as Mobile. */
export function clipboardFailureKey(error: unknown, action: 'copy' | 'paste'): string {
  return (
    CLIPBOARD_FAILURE_KEYS[error instanceof Error ? error.message : ''] ??
    (action === 'copy'
      ? 'remoteDesktop.viewer.clipboardCopyFailed'
      : 'remoteDesktop.viewer.clipboardPasteFailed')
  );
}

/** Desktop presentation adapter. Reuses the Mobile lease, browser media and
 * input queue; only window visibility and native clipboard live on Desktop.
 */
export class DesktopViewerController {
  private state: ViewerSnapshot = {
    target: null,
    status: 'connecting',
    error: null,
    controlling: false,
    controlPending: false,
    caps: null,
    displayId: '',
    transport: '',
    latency: null,
    settings: { fps: 30, quality: 'auto', audio: true },
    ready: false,
    preferences: { ...DEFAULT_VIEWER_PREFERENCES },
    safety: { privacyActive: false, notice: null, clipboardProgress: null },
    receiveRate: null,
    closing: false,
    credential: null,
    credentialBusy: false,
    credentialNotice: null,
    fittedDisplay: null,
  };
  private scope: RemoteViewerState = { target: null, active: false, generation: -1 };
  private disposed = false;
  private opening = false;
  private epoch = 0;
  private resuming = false;
  private retryAt = 0;
  private retryDelay = 1000;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private frameBusy: string | null = null;
  private heartbeatBusy: string | null = null;
  private streaming = false;
  private clipboardQueue: Promise<void> = Promise.resolve();
  private clipboardQueued = 0;
  private clipboardRevision = 0;
  private pendingSettings = false;
  private offers = new Set<import('@cindy/device-link').RemoteDesktopLease>();
  private mediaChanging = false;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private statsAt = 0;
  private frameAt = 0;
  private hidden = false;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenBusy = false;
  /** Counts host video streams; each new offer starts unpaused. */
  private videoStream = 0;
  private videoHidden = false;
  private unlockAttempted = false;
  private unlockAttempt: Promise<void> = Promise.resolve();
  private channelRequests = new Map<
    string,
    { op: RemoteDesktopRequest['op']; settle(outcome: ChannelOutcome): void }
  >();
  /** The computer's own mode at the start of a lease; choosing it again forgets the memory. */
  private hostMode: { lease: string; modeId?: string } | null = null;
  /** The size last asked of a fitted display. A HiDPI host may report a smaller
   * logical size; the list still shows the entry the user chose as current. */
  private fittedRequest: { lease: string; size: Size } | null = null;
  /** The remembered display choice is reapplied once per lease. */
  private rememberedLease: string | null = null;
  /** A remembered choice that failed is not retried in this window, so it cannot loop reconnects. */
  private rememberedGaveUp = false;
  private credentialRetry: {
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric';
    enabled?: boolean;
  } | null = null;
  private session: RemoteDesktopViewerSession;
  private media: RemoteDesktopViewerMedia;
  private runtime: ReturnType<typeof mountRemoteDesktopViewer>;
  private timers: ReturnType<typeof setInterval>[];
  private unsubscribers: (() => void)[];
  constructor(
    private readonly api: RemoteDesktopViewerApi,
    private readonly root: HTMLElement,
    private readonly changed: (state: ViewerSnapshot) => void,
  ) {
    this.session = new RemoteDesktopViewerSession(this.request);
    this.media = new RemoteDesktopViewerMedia({
      request: this.request,
      send: (message) => this.runtime.receive(message),
      loadIce: (attempt) => api.ice(this.scope.generation, attempt),
      current: () =>
        this.session.lease && this.state.caps
          ? {
              lease: this.session.lease,
              caps: this.state.caps,
              settings: {
                ...this.state.settings,
                audio: this.state.settings.audio && this.state.caps.systemAudio === true,
              },
            }
          : null,
      onOfferStart: (lease) => {
        this.offers.add(lease);
        this.videoStream++;
        this.videoHidden = false;
      },
      onOfferSettled: (lease) => {
        this.offers.delete(lease);
        this.applySettings();
      },
    });
    this.runtime = mountRemoteDesktopViewer(root, (message) => this.message(message), {
      desktop: true,
      net: REMOTE_DESKTOP_NETWORK,
      iceServers: REMOTE_DESKTOP_ICE_SERVERS,
      keyCodes: DESKTOP_KEY_CODES,
    });
    this.unsubscribers = [
      api.onActive((scope) => this.updateScope(scope)),
      ...(api.onChannelRequest
        ? [api.onChannelRequest((message) => void this.forwardChannelRequest(message))]
        : []),
    ];
    void api
      .state()
      .then((scope) => this.updateScope(scope))
      .catch(() => {});
    this.timers = [
      setInterval(() => void this.heartbeat(), 3000),
      setInterval(() => void this.frame(), 350),
      setInterval(() => {
        void this.refreshSafety();
        if (this.statsAt && Date.now() - this.statsAt > 5000)
          this.publish({ receiveRate: null, latency: null });
      }, 1500),
    ];
  }
  private publish(patch: Partial<ViewerSnapshot>): void {
    const previousBudget = connectionBudget(this.state.caps);
    this.state = { ...this.state, ...patch };
    const budget = connectionBudget(this.state.caps);
    // Capabilities arrive after the initial timer starts. Change its budget
    // only when the backend changes, never on repeated caps or media retries.
    if (budget !== previousBudget && this.connectionTimer !== null) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    const waiting =
      this.scope.active &&
      !this.disposed &&
      !this.state.error &&
      !this.state.closing &&
      (!this.state.ready || this.state.status === 'reconnecting');
    if (!waiting) {
      if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    } else if (this.connectionTimer === null) {
      // Transient failures and media fallback must not renew the total budget.
      this.connectionTimer = setTimeout(() => {
        this.fail(new Error('DESKTOP_CONNECTION_TIMEOUT'));
      }, budget);
    }
    if (!this.disposed) this.changed(this.state);
  }
  /** Main decides and checks every request, then may hand small ones back to
   * carry over this window's live media data channel: a direct peer skips the
   * relay round trip. Anything not sent here goes back to Main for the relay. */
  private async forwardChannelRequest(message: RemoteViewerChannelRequest): Promise<void> {
    const { generation, id, request } = message ?? {};
    if (!this.api.channelReply || typeof id !== 'string' || id.length > 64) return;
    const lease = this.session.lease;
    const outcome: ChannelOutcome =
      generation === this.scope.generation &&
      !this.disposed &&
      lease &&
      this.streaming &&
      this.state.caps?.channelRequests === true &&
      isRemoteDesktopChannelRequest(request) &&
      'lease' in request &&
      request.lease === lease.lease
        ? await this.sendOverChannel(id, request)
        : { kind: 'relay' };
    await this.api.channelReply(generation, id, outcome).catch(() => {
      /* Main settles a retired or stale request itself. */
    });
  }
  private sendOverChannel(id: string, request: RemoteDesktopRequest): Promise<ChannelOutcome> {
    // Main never reuses an id; a duplicate is not sent twice.
    if (this.channelRequests.has(id)) return Promise.resolve({ kind: 'relay' });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ kind: 'error', code: 'INVOKE_TIMEOUT' }),
        REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS,
      );
      const settle = (outcome: ChannelOutcome) => {
        if (this.channelRequests.get(id)?.settle !== settle) return;
        this.channelRequests.delete(id);
        clearTimeout(timer);
        resolve(outcome);
      };
      this.channelRequests.set(id, { op: request.op, settle });
      // The viewer answers with channelRequestState / channelReply.
      this.runtime.receive({ type: 'channelRequest', id, request });
    });
  }
  /** Requests ride the media peer. Once it is gone their outcome is unknown. */
  private abandonChannelRequests(): void {
    for (const pending of [...this.channelRequests.values()])
      pending.settle({ kind: 'error', code: 'INVOKE_TIMEOUT' });
  }
  private request = async <T>(
    request: RemoteDesktopRequest,
    beforeSend?: () => void,
  ): Promise<T> => {
    beforeSend?.();
    const scope = this.scope;
    if (!scope.active || this.disposed) throw new Error('DESKTOP_STOPPED');
    try {
      return (await this.api.request(
        scope.generation,
        request,
        request.op === 'offer' || request.op === 'ice' ? this.media.attemptId : undefined,
      )) as T;
    } catch (error) {
      throw new Error(extractIpcError(error)?.message ?? 'DESKTOP_UNAVAILABLE');
    }
  };
  private updateScope(scope: RemoteViewerState): void {
    if (this.disposed || scope.generation < this.scope.generation) return;
    if (scope.generation === this.scope.generation && scope.active === this.scope.active) return;
    this.cancel();
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.scope = scope;
    this.resuming = scope.resume === true;
    this.retryDelay = 1000;
    this.publish({
      target: scope.target,
      error: null,
      status: 'connecting',
      caps: null,
      ready: false,
      closing: false,
      credential: null,
      credentialBusy: false,
      credentialNotice: null,
      preferences: { ...DEFAULT_VIEWER_PREFERENCES },
    });
    this.unlockAttempted = false;
    this.credentialRetry = null;
    this.rememberedGaveUp = false;
    if (scope.active)
      void (async () => {
        try {
          const preferences = await this.api.preferences?.(scope.generation);
          if (this.scope !== scope || this.disposed) return;
          if (preferences)
            this.publish({
              preferences,
              settings: { ...this.state.settings, audio: preferences.audio },
            });
        } catch {
          /* Defaults preserve ordinary viewing if preference storage is unavailable. */
        }
        if (this.scope === scope && !this.disposed) void this.connect();
      })();
  }
  private cancel(preserveFrame = false): void {
    this.epoch++;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    this.pendingSettings = false;
    this.mediaChanging = false;
    this.offers.clear();
    this.statsAt = 0;
    this.frameAt = 0;
    this.videoStream++;
    this.videoHidden = false;
    this.clipboardQueue = Promise.resolve();
    this.clipboardQueued = 0;
    this.opening = false;
    this.streaming = false;
    this.abandonChannelRequests();
    this.media.reset();
    this.runtime?.receive({ type: 'releaseInput' });
    void this.session.stop().catch(() => {});
    this.runtime?.receive({ type: 'stop', preserveFrame });
    this.publish({
      controlling: false,
      controlPending: false,
      ready: false,
      transport: '',
      latency: null,
      receiveRate: null,
      safety: { privacyActive: false, notice: null, clipboardProgress: null },
      fittedDisplay: null,
    });
  }
  private async connect(takeover = false): Promise<void> {
    if (this.opening || !this.scope.active || this.disposed) return;
    this.opening = true;
    const epoch = this.epoch;
    this.publish({
      error: null,
      status: this.resuming ? 'reconnecting' : 'connecting',
      ready: false,
    });
    try {
      const resume = this.resuming;
      const { caps, lease } = await this.session.connect({
        displayId: this.state.displayId || undefined,
        resume,
        takeover,
        // Desktop always operates; a host with `autoControl` grants it with the lease.
        control: true,
        isCurrent: () => this.epoch === epoch && !this.disposed && this.scope.active,
        onCapabilities: (caps) => this.publish({ caps }),
        onStart: () => {
          this.resuming = true;
        },
      });
      if (epoch !== this.epoch) return;
      this.publish({ caps, displayId: lease.display.id, status: 'connecting' });
      this.runtime.receive({
        type: 'init',
        epoch: lease.lease,
        width: lease.display.width,
        height: lease.display.height,
        fillHeight: false,
        trickleIce: caps.trickleIce === true,
        audio: caps.systemAudio && this.state.settings.audio,
        macKeyboard: typeof window !== 'undefined' && window.electronAPI?.platform === 'darwin',
      });
      this.runtime.receive({ type: 'mode', mode: 'pointer' });
      if (!caps.canControl) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
      if (lease.controlling) {
        this.publish({ error: null });
        this.syncControl();
        this.applySettings();
      } else await this.acquireControl();
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    } finally {
      if (epoch === this.epoch) this.opening = false;
    }
  }
  private fail(error: unknown): void {
    const code = error instanceof Error ? error.message : '';
    const blocked =
      remoteDesktopFailureKey(code) ??
      (/DESKTOP_(VIEW_ONLY|INPUT_(BUSY|UNSUPPORTED|UNAVAILABLE|TIMEOUT))/.test(code)
        ? 'controlUnavailable'
        : null);
    this.cancel(true);
    this.publish({ status: 'reconnecting', error: blocked });
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(15000, this.retryDelay * 2);
  }
  retry(): void {
    this.cancel(true);
    this.unlockAttempted = false;
    this.resuming = false;
    void this.connect(this.state.error === 'connectionBusy');
  }
  private async acquireControl(): Promise<void> {
    if (this.state.closing || this.state.controlPending || !this.session.lease) return;
    this.runtime.receive({ type: 'releaseInput' });
    const lease = this.session.lease;
    this.publish({ controlPending: true });
    this.syncControl();
    try {
      const result = await this.session.control(true);
      if (lease !== this.session.lease) return;
      if (!result.controlling) throw new Error('DESKTOP_VIEW_ONLY');
      this.publish({ error: null });
    } finally {
      if (lease === this.session.lease) {
        this.publish({ controlPending: false });
        this.syncControl();
        this.applySettings();
      }
    }
  }
  /** Buttons and actual keyboard/mouse forwarding use the same confirmed state.
   * Menu focus only releases held keys; it does not revoke desktop control. */
  private syncControl(): void {
    const controlling =
      this.state.ready && !this.state.controlPending && this.session.lease?.controlling === true;
    if (controlling === this.state.controlling) return;
    this.clipboardRevision++;
    this.publish({ controlling });
    this.runtime.receive({ type: 'control', enabled: controlling });
    if (controlling) void this.applyRememberedResolution();
  }
  selectDisplay(displayId: string): void {
    if (
      !this.state.caps?.displays.some((d) => d.id === displayId) ||
      displayId === this.state.displayId
    )
      return;
    this.cancel(true);
    this.resuming = false;
    this.publish({ displayId });
    void this.connect();
  }
  settings(patch: Partial<RemoteDesktopVideoSettings>): void {
    this.publish({ settings: { ...this.state.settings, ...patch } });
    if (patch.audio !== undefined) void this.preference({ audio: patch.audio });
    this.pendingSettings = true;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = null;
      this.applySettings();
    }, 0);
  }
  private applySettings(): void {
    if (
      !this.pendingSettings ||
      !this.session.lease ||
      !this.state.ready ||
      this.state.closing ||
      this.offers.size ||
      this.state.controlPending ||
      this.mediaChanging ||
      !['live', 'compatibility'].includes(this.state.status)
    )
      return;
    this.pendingSettings = false;
    this.mediaChanging = true;
    this.runtime.receive({
      type: 'videoSettings',
      audio: this.state.settings.audio && this.state.caps?.systemAudio === true,
    });
  }
  async preference(patch: Partial<RemoteViewerPreferences>): Promise<void> {
    const scope = this.scope;
    try {
      const preferences = await this.api.preferences?.(scope.generation, patch);
      if (this.scope !== scope || this.disposed || !preferences) return;
      this.publish({ preferences });
      void this.refreshSafety();
    } catch {
      if (this.scope === scope)
        this.publish({ safety: { ...this.state.safety, notice: 'viewer.settingsFailed' } });
    }
  }
  async refreshSafety(retry = false): Promise<void> {
    if (!this.state.ready || this.state.closing || !this.api.safety) return;
    const epoch = this.epoch;
    try {
      const safety = await this.api.safety(this.scope.generation, retry);
      if (epoch === this.epoch && !this.disposed) this.publish({ safety });
    } catch {
      /* Connection state owns disconnected/retired generations. */
    }
  }
  async close(): Promise<void> {
    if (this.state.closing) return;
    this.releaseInput();
    this.publish({ closing: true });
    const epoch = this.epoch;
    try {
      await this.api.close(this.scope.generation);
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) this.publish({ closing: false });
      throw error;
    }
  }
  async credential(
    action: 'settings' | 'enable' | 'disable' | 'unlock' | 'biometric',
    enabled?: boolean,
  ): Promise<void> {
    if (
      !this.api.credential ||
      this.state.credentialBusy ||
      !this.state.ready ||
      this.state.closing
    )
      return;
    const scope = this.scope;
    this.publish({ credentialBusy: true, credentialNotice: null });
    this.credentialRetry = { action, enabled };
    try {
      const credential = await this.api.credential(scope.generation, action, enabled);
      if (this.scope === scope && !this.disposed) {
        this.credentialRetry = null;
        this.publish({ credential });
      }
    } catch (error) {
      if (this.scope !== scope || this.disposed) return;
      const code = extractIpcError(error)?.message ?? String(error);
      if (action === 'unlock' && code.includes('PASSWORD_REJECTED'))
        this.credentialRetry = { action: 'enable' };
      if (!code.includes('CREDENTIAL_CANCELLED'))
        this.publish({
          credentialNotice: code.includes('SIGNING_REQUIRED')
            ? 'credentialSigningRequired'
            : code.includes('PASSWORD_REJECTED')
              ? 'credentialPasswordRejected'
              : code.includes('INVALID_IDENTITY')
                ? 'credentialIdentityChanged'
                : code.includes('ACCESSIBILITY_REQUIRED')
                  ? 'credentialAccessibilityRequired'
                  : code.includes('UNLOCK_UNAVAILABLE')
                    ? 'credentialUnlockUnavailable'
                    : 'credentialRequired',
        });
    } finally {
      if (this.scope === scope && !this.disposed) this.publish({ credentialBusy: false });
    }
  }
  retryCredential(): void {
    if (this.credentialRetry)
      void this.credential(this.credentialRetry.action, this.credentialRetry.enabled);
  }
  releaseInput(): void {
    this.runtime.receive({ type: 'releaseInput' });
  }
  /** Hiding keeps the session but pauses the host's video; showing resumes it. */
  setHidden(hidden: boolean): void {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    this.hidden = hidden;
    if (hidden)
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        void this.syncHidden();
      }, HIDDEN_VIDEO_PAUSE_MS);
    else void this.syncHidden();
  }
  private hiddenSettled(): boolean {
    return this.hidden && this.hiddenTimer === null;
  }
  private async syncHidden(): Promise<void> {
    const lease = this.session.lease;
    const hidden = this.hiddenSettled();
    if (
      this.hiddenBusy ||
      this.disposed ||
      !lease ||
      !this.streaming ||
      !this.state.caps?.viewerHidden ||
      hidden === this.videoHidden
    )
      return;
    const stream = this.videoStream;
    this.hiddenBusy = true;
    let failed = false;
    try {
      await this.request({ op: 'viewerHidden', lease: lease.lease, hidden });
    } catch {
      failed = true;
    } finally {
      this.hiddenBusy = false;
    }
    if (stream === this.videoStream) {
      // Even an unacknowledged request may have applied, so track it as applied:
      // showing then always sends a resume. A resume that may not have applied
      // must not leave the picture frozen: rebuild, since a new offer starts unpaused.
      this.videoHidden = hidden;
      if (failed && !hidden && this.session.lease === lease) {
        this.pendingSettings = true;
        this.applySettings();
      }
    }
    // Terminates: after any outcome videoHidden equals the requested state.
    void this.syncHidden();
  }
  actualSize(): void {
    const lease = this.session.lease;
    if (!lease || !this.state.ready) return;
    this.runtime.receive({ type: 'actualSize' });
    const toolbar = this.root.parentElement?.querySelector('.remote-viewer-toolbar');
    const toolbarHeight = toolbar?.getBoundingClientRect().height ?? 60;
    void this.api
      .resize(
        this.scope.generation,
        Math.ceil(lease.display.width),
        Math.ceil(lease.display.height + toolbarHeight),
      )
      .catch(() => {
        /* A closed or replaced viewer must not resize its successor. */
      });
  }
  fit(): void {
    this.runtime.receive({ type: 'fit' });
  }
  zoom(direction: 'in' | 'out'): void {
    this.runtime.receive({ type: 'zoom', factor: direction === 'in' ? 1.25 : 0.8 });
  }
  keys(codes: string[]): void {
    if (!this.state.controlling) return;
    const events: DesktopInput[] = [
      ...codes.map((code) => ({ kind: 'key' as const, code, down: true })),
      ...codes
        .slice()
        .reverse()
        .map((code) => ({ kind: 'key' as const, code, down: false })),
    ];
    this.runtime.receive({ type: 'events', events });
  }
  async workspaceAction(action: 'workspaceLeft' | 'workspaceRight' | 'omarchyMenu'): Promise<void> {
    const lease = this.session.lease;
    if (!lease || !this.state.controlling) return;
    await this.request({ op: 'windowAction', action, lease: lease.lease });
  }
  async clipboard(action: 'copy' | 'paste'): Promise<void> {
    if (!this.state.controlling) throw new Error('DESKTOP_VIEW_ONLY');
    if (this.clipboardQueued >= 8) throw new Error('CLIPBOARD_BUSY');
    const epoch = this.epoch;
    const generation = this.scope.generation;
    const revision = this.clipboardRevision;
    if (this.clipboardQueued === 0) this.clipboardQueue = Promise.resolve();
    this.clipboardQueued++;
    this.releaseInput();
    const transfer = this.clipboardQueue.then(async () => {
      if (
        epoch !== this.epoch ||
        revision !== this.clipboardRevision ||
        this.disposed ||
        !this.state.controlling
      )
        throw new Error('DESKTOP_STOPPED');
      try {
        await this.api.clipboard(generation, action);
      } catch (error) {
        throw new Error(extractIpcError(error)?.message ?? 'DESKTOP_UNAVAILABLE');
      }
    });
    this.clipboardQueue = transfer;
    try {
      await transfer;
    } finally {
      if (epoch === this.epoch) this.clipboardQueued--;
    }
  }
  async permissionGuide(): Promise<void> {
    await this.request({ op: 'permissions', action: 'guide' });
  }
  async displayModes(): Promise<RemoteDesktopDisplayMode[]> {
    const lease = this.session.lease;
    if (!lease) return [];
    const modes = await this.request<RemoteDesktopDisplayMode[]>({
      op: 'displayModes',
      lease: lease.lease,
    });
    if (this.session.lease !== lease) throw new Error('DESKTOP_STOPPED');
    if (this.hostMode?.lease !== lease.lease)
      this.hostMode = { lease: lease.lease, modeId: modes.find((mode) => mode.current)?.id };
    return modes;
  }
  /** Choices for the resolution list. A picture fitted to this window offers
   * sizes of the same ratio instead of the physical monitor's modes; those keep
   * the monitor's own ratio so the picture is never letterboxed by the host. */
  async resolutionModes(): Promise<RemoteDesktopDisplayMode[]> {
    const lease = this.session.lease;
    if (!lease) return [];
    if (this.state.fittedDisplay)
      return fittedDisplayModes(
        this.state.fittedDisplay,
        this.fittedRequest?.lease === lease.lease ? this.fittedRequest.size : lease.display,
      );
    const modes = await this.displayModes();
    // CoreGraphics modes keep their own orientation when Electron's display
    // geometry is rotated. Compare modes in the enumeration's coordinate space.
    const reference = modes.find((mode) => mode.current) ?? lease.display;
    return modes.filter((mode) => sameAspect(mode, reference.width, reference.height));
  }
  /** Applies an entry of the list just read; the host still rejects a stale mode. */
  async resolution(mode: RemoteDesktopDisplayMode): Promise<void> {
    if (!this.session.lease) return;
    const caps = this.state.caps;
    if (
      (caps?.resolutionRestore || (caps?.viewerDisplay && caps.viewerDisplayRestore)) &&
      (caps?.resolutionRestore ||
        [mode.width, mode.height].every((size) => size >= 320 && size <= 2560))
    ) {
      await this.fitDisplay(
        mode.width,
        mode.height,
        true,
        !this.state.fittedDisplay && caps?.resolutionRestore ? mode.id : undefined,
      );
      return;
    }
    throw new Error('DESKTOP_DISPLAY_MODES_UNAVAILABLE');
  }
  /** Returns from a fitted picture to the computer's own display and ratio. */
  async restoreDisplay(): Promise<void> {
    const fitted = this.state.fittedDisplay;
    if (!fitted || !this.state.caps?.viewerDisplayRestore) return;
    await this.fitDisplay(fitted.width, fitted.height, false, undefined, { restore: true });
  }
  /** `ratio` names the picture shape chosen for the same-ratio size list. */
  async fitDisplay(
    width: number,
    height: number,
    exactResolution = false,
    modeId?: string,
    options: { ratio?: Size; remembered?: boolean; restore?: boolean } = {},
  ): Promise<void> {
    if (
      exactResolution &&
      !modeId &&
      ![width, height].every((value) => Number.isInteger(value) && value >= 320 && value <= 2560)
    )
      throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
    const size = exactResolution ? { width, height } : viewerDisplaySize(width, height);
    const lease = this.session.lease;
    const caps = this.state.caps;
    if (
      !size ||
      !lease?.controlling ||
      !(modeId ? caps?.resolutionRestore : caps?.viewerDisplay) ||
      this.state.controlPending
    )
      return;
    const fitted = this.state.fittedDisplay;
    const restore = Boolean(options.restore && fitted && caps?.viewerDisplayRestore);
    this.publish({ controlPending: true });
    this.syncControl();
    // A host that can follow display changes keeps the running stream; only a
    // response without `videoKept` falls back to rebuilding it.
    const keepVideo = caps?.liveDisplaySwitch === true;
    if (!keepVideo) this.media.reset();
    const sourceDisplayId = this.state.displayId;
    try {
      const { videoKept, ...next } = await this.session.fitDisplay(
        size.width,
        size.height,
        restore,
        modeId,
        keepVideo,
        caps?.autoControl === true,
      );
      if (this.session.lease !== lease) return;
      // The next connection reapplies this choice; restoring or choosing the
      // computer's own mode again forgets it. A fit remembers the requested
      // size: a HiDPI host may answer with a smaller mode of the same ratio.
      const ownMode = this.hostMode?.lease === lease.lease && this.hostMode.modeId === modeId;
      void this.rememberResolution(
        sourceDisplayId,
        restore || (modeId && ownMode)
          ? null
          : modeId
            ? { kind: 'mode', modeId, width, height }
            : { kind: 'fit', width: size.width, height: size.height },
      );
      this.fittedRequest = modeId || restore ? null : { lease: lease.lease, size: { ...size } };
      this.publish({
        // Keep the physical source as the reconnect target; the temporary
        // display is only the current capture/input surface.
        displayId: sourceDisplayId,
        // The temporary capture surface is lease state, never a reconnectable
        // display choice in the selector.
        caps,
        // Keep the chosen ratio rather than a rounded size, so same-ratio
        // choices do not drift from one resolution change to the next.
        fittedDisplay:
          modeId || restore
            ? null
            : (options.ratio ??
              (exactResolution && fitted
                ? fitted
                : { width: next.display.width, height: next.display.height })),
      });
      const geometry = {
        width: next.display.width,
        height: next.display.height,
        restore: restore || Boolean(modeId),
      };
      if (videoKept) this.runtime.receive({ type: 'displayGeometry', ...geometry });
      else {
        if (keepVideo) this.media.reset();
        this.streaming = false;
        this.abandonChannelRequests();
        this.runtime.receive({
          type: 'videoSettings',
          ...geometry,
          audio: this.state.settings.audio && this.state.caps?.systemAudio === true,
        });
      }
      if (!next.controlling) await this.session.control(true);
    } catch (error) {
      if (options.remembered) this.rememberedGaveUp = true;
      if (error instanceof Error && error.message === 'INVOKE_TIMEOUT') {
        this.cancel(true);
        void this.connect();
      }
      throw error;
    } finally {
      if (this.session.lease === lease) {
        this.publish({ controlPending: false });
        this.syncControl();
      }
    }
  }
  private async rememberResolution(
    displayId: string,
    value: RememberedViewerResolution | null,
  ): Promise<void> {
    try {
      await this.api.resolution?.(this.scope.generation, displayId, value);
    } catch {
      /* Memory is a convenience; the change itself already applied. */
    }
  }
  /** The host restores its own display when a viewer leaves. Reapply this
   * window's last choice once per lease, after control and the first frame. */
  private async applyRememberedResolution(): Promise<void> {
    const lease = this.session.lease;
    const caps = this.state.caps;
    if (
      !lease ||
      !this.state.ready ||
      !this.state.controlling ||
      !this.api.resolution ||
      !(caps?.resolutionRestore || caps?.viewerDisplay) ||
      this.state.fittedDisplay ||
      this.rememberedGaveUp ||
      this.rememberedLease === lease.lease
    )
      return;
    this.rememberedLease = lease.lease;
    const displayId = this.state.displayId;
    const { id, width, height } = lease.display;
    // A display change the user made meanwhile wins over the remembered one.
    const unchanged = () =>
      this.session.lease === lease &&
      lease.display.id === id &&
      lease.display.width === width &&
      lease.display.height === height &&
      !this.state.fittedDisplay;
    try {
      const remembered = await this.api.resolution(this.scope.generation, displayId);
      if (!remembered) return;
      // A locked computer refuses display changes; let auto-unlock run first.
      await this.unlockAttempt;
      if (!unchanged()) return;
      if (remembered.kind === 'fit') {
        if (!caps.viewerDisplay) return;
        // The ratio is a choice of its own now, not this window's shape.
        const size = { width: remembered.width, height: remembered.height };
        await this.fitDisplay(size.width, size.height, true, undefined, {
          ratio: size,
          remembered: true,
        });
        return;
      }
      if (!caps.resolutionRestore) return;
      const mode = findRememberedMode(await this.resolutionModes(), remembered);
      if (!mode || mode.current || !unchanged()) return;
      await this.fitDisplay(mode.width, mode.height, true, mode.id, { remembered: true });
    } catch {
      /* A failed reapply leaves the computer's own display in place. */
    }
  }
  private async heartbeat(): Promise<void> {
    if (!this.scope.active || this.disposed || this.state.closing) return;
    if (!this.session.lease) {
      if (!this.state.error && Date.now() >= this.retryAt) void this.connect();
      return;
    }
    const leaseId = this.session.lease.lease;
    if (this.heartbeatBusy === leaseId) return;
    this.heartbeatBusy = leaseId;
    const epoch = this.epoch;
    try {
      const result = await this.session.heartbeat();
      if (epoch === this.epoch) {
        if (!result.controlling && !this.opening && !this.state.controlPending)
          this.fail(new Error('DESKTOP_VIEW_ONLY'));
        else this.syncControl();
      }
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof Error && error.message === 'INVOKE_TIMEOUT'))
        this.fail(error);
    } finally {
      if (this.heartbeatBusy === leaseId) this.heartbeatBusy = null;
    }
  }
  private async frame(): Promise<void> {
    const lease = this.session.lease;
    if (
      !lease ||
      this.state.closing ||
      this.streaming ||
      this.frameBusy === lease.lease ||
      !this.scope.active ||
      // Screenshot fallback stops polling while hidden, once it has shown a frame.
      (this.hiddenSettled() && this.state.ready)
    )
      return;
    this.frameBusy = lease.lease;
    try {
      const result = await this.request<{ jpeg: string | null; cursor?: unknown }>({
        op: 'frame',
        lease: lease.lease,
        cursorOverlay: this.state.caps?.cursorOverlay === true,
      });
      if (
        this.session.lease === lease &&
        !this.streaming &&
        typeof result.jpeg === 'string' &&
        result.jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4
      ) {
        const now = Date.now();
        this.publish({
          receiveRate:
            this.frameAt && now > this.frameAt
              ? (result.jpeg.length * 0.75 * 1000) / (now - this.frameAt)
              : null,
        });
        this.frameAt = now;
        this.statsAt = now;
        this.runtime.receive({
          type: 'frame',
          jpeg: result.jpeg,
          ...('cursor' in result ? { cursor: result.cursor } : {}),
        });
      }
    } catch (error) {
      if (this.session.lease === lease) this.fail(error);
    } finally {
      if (this.frameBusy === lease.lease) this.frameBusy = null;
    }
  }
  private message(message: Record<string, unknown>): void {
    const lease = this.session.lease;
    if (!lease || message.epoch !== lease.lease || this.disposed) return;
    if (['iceConfig', 'offer', 'ice'].includes(String(message.type))) {
      void this.media.handle(message).catch((error) => {
        if (this.session.lease === lease) this.fail(error);
      });
      return;
    }
    switch (message.type) {
      case 'scaleMode':
        if (message.mode === 'fit' || message.mode === 'actual' || message.mode === 'custom')
          this.publish({ scaleMode: message.mode });
        break;
      case 'streaming':
        this.streaming = true;
        this.publish({ transport: 'video', latency: null });
        this.present('live');
        void this.syncHidden();
        break;
      case 'framePresented':
        if (this.streaming) break;
        this.publish({ transport: 'screenshots', latency: null });
        this.present('compatibility');
        break;
      case 'fallback':
        this.mediaChanging = false;
        this.streaming = false;
        this.abandonChannelRequests();
        this.publish({ transport: 'screenshots', status: 'compatibility', latency: null });
        this.applySettings();
        break;
      case 'channelRequestState':
        // The channel could not take it: nothing ran, use the relay.
        if (typeof message.id === 'string' && message.sent !== true)
          this.channelRequests.get(message.id)?.settle({ kind: 'relay' });
        break;
      case 'channelReply': {
        const reply = parseRemoteDesktopChannelReply({ ...message, type: 'reply' });
        const pending = reply && this.channelRequests.get(reply.id);
        if (!reply || !pending) break;
        if (reply.ok) pending.settle({ kind: 'result', value: reply.result });
        else
          pending.settle(
            // Refused before running, or a read-only result that did not fit.
            reply.error === 'DESKTOP_CHANNEL_UNSUPPORTED' ||
              reply.error === 'DESKTOP_CHANNEL_BUSY' ||
              (reply.error === 'DESKTOP_REPLY_TOO_LARGE' &&
                (pending.op === 'displayModes' || pending.op === 'clipboardVersion'))
              ? { kind: 'relay' }
              : { kind: 'error', code: reply.error },
          );
        break;
      }
      case 'reconnecting':
        this.publish({ status: 'reconnecting' });
        break;
      case 'network': {
        const transport = message.transport;
        // Only the presented video may supply its route/RTT. JPEG fallback
        // must not inherit a previous video's route or latency.
        if (
          !this.streaming ||
          (transport !== 'video' && transport !== 'direct' && transport !== 'relay')
        )
          break;
        this.publish({
          transport,
          receiveRate:
            typeof message.bytesPerSecond === 'number' &&
            Number.isFinite(message.bytesPerSecond) &&
            message.bytesPerSecond >= 0
              ? message.bytesPerSecond
              : null,
          latency:
            typeof message.latencyMs === 'number' &&
            Number.isFinite(message.latencyMs) &&
            message.latencyMs >= 0
              ? message.latencyMs
              : null,
        });
        this.statsAt = Date.now();
        break;
      }
      case 'inputOverflow':
        this.fail(new Error('DESKTOP_INPUT_UNAVAILABLE'));
        break;
      case 'input':
        if (
          !Number.isSafeInteger(message.sequence) ||
          !Array.isArray(message.events) ||
          message.events.length > 64 ||
          !message.events.every(isDesktopInput)
        )
          return;
        void this.request({
          op: 'input',
          lease: lease.lease,
          sequence: message.sequence as number,
          events: message.events,
        })
          .catch((error) => {
            if (
              this.session.lease === lease &&
              !(error instanceof Error && error.message === 'INVOKE_TIMEOUT')
            )
              this.fail(error);
          })
          .finally(() => {
            if (this.session.lease === lease)
              this.runtime.receive({ type: 'ack', epoch: lease.lease, sequence: message.sequence });
          });
        break;
    }
  }
  private present(status: string): void {
    if (status === 'live') this.mediaChanging = false;
    this.retryDelay = 1000;
    this.publish({ ready: true, status });
    // Start auto-unlock before control can trigger the remembered display
    // change, which waits for it: a locked computer refuses display changes.
    if (!this.unlockAttempted && this.state.caps?.platform === 'darwin') {
      this.unlockAttempted = true;
      this.unlockAttempt = this.credential('unlock').catch(() => {});
    }
    this.syncControl();
    this.applySettings();
    void this.refreshSafety();
  }
  dispose(): void {
    this.cancel();
    this.disposed = true;
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = null;
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    for (const t of this.timers) clearInterval(t);
    for (const off of this.unsubscribers) off();
    this.runtime.dispose();
  }
}
