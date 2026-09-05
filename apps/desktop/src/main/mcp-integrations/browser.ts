// 浏览器自动化 desktop host(L3)。维护者指南(架构 + 踩坑 + 上游同步):
// packages/browser-control-runtime/upstream/MAINTAINING.md
//
// Keep this import FIRST (above @cindy/browser-control-runtime): it sets
// XDT_BROWSER_RUNTIME_DIR before the runtime import below reads it into its eager
// CONFIG_DIR const (see browser-runtime-env.ts). No import-order autofix is
// configured, so this position is stable.
import './browser-runtime-env.js';
import fs from 'node:fs';
import nodePath from 'node:path';
import { app, ipcMain } from 'electron';
import {
  createBrowserControlRuntime,
  setBrowserControlRuntimeConfig,
  type BrowserProxyRoute,
  type BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import { createLogger } from '../logger.js';
import { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
import { loadUserBrowserRecipes, type UserRecipesResult } from '../browser-recipes/loader.js';
import { writeUserRecipe, type WriteUserRecipeResult } from '../browser-recipes/writer.js';
import {
  BrowserBackendController,
  BrowserBackendHealthService,
  ExternalChromeBackend,
  RsbWebviewBackend,
  type BackendKind,
  type BrowserBackend,
} from './browser-backend/index.js';
import { getRsbBrowserBridge } from '../rsb-browser-bridge/index.js';
import {
  readBrowserBackendSettings,
  writeBrowserBackendKind,
  writeBrowserUseRealProfile,
  resetBrowserBackendSettings,
  readBrowserBackendSettingsState,
} from '../browser-backend-settings-store.js';
import {
  getActiveRsbSessionId,
  setActiveRsbSessionId,
} from '../rsb-browser-bridge/active-session.js';
import { requireObject, optionalNullableString } from '../utils/ipcValidate.js';
import {
  buildManagedConfig,
  MANAGED_CDP_PORT,
  MANAGED_PROFILE,
  managedBrowserGuardIdentity,
  type ManagedBrowserConfigOptions,
} from './browser-managed-config.js';
import {
  assertManagedBrowserStopped,
  cleanupCopiedLoginsThen,
  createBrowserProfileLifecycleQueue,
  managedConfigPatchBeforeStop,
  FOREIGN_AGENT_BROWSER_ERROR,
  probeOsSourceProfileReadAccess,
  readCopiedLoginsCdpPort,
  wrapRuntimeWithRealProfile,
  wrapRuntimeWithProfileLifecycleQueue,
} from './browser-real-profile/index.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { createBrowserBackendIpcHandlers } from './browser-backend/settings-ipc.js';
import { raiseAgentBrowserWindow } from './raise-agent-browser-window.js';
import {
  BrowserOpenForLoginError,
  browserOpenForLoginErrorCodeFromData,
} from '../../shared/browserBackend.js';

export { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';

const logger = createLogger('mcp/cindy_browser');

/** 翻转前(≤2026-07-17)创建的受管 profile 目录名,仅用于就地改名自愈。 */
const LEGACY_MANAGED_PROFILE = 'XDMaker';

/**
 * 就地改名自愈:同一 userData 下存在翻转前的 `browser/XDMaker` 而无 `browser/Cindy`
 * 时,整目录 rename(同卷原子、瞬时)——覆盖「身份翻转后、本次改名前」跑过 agent
 * 浏览器的 dev 实例。mToc 迁移直接落到新名,不依赖这里。必须在 runtime 首次
 * launch(创建 profile 目录)之前执行;rename 失败(如旧 Chrome 进程持锁)只 warn,
 * 后果是该实例从空 profile 重新开始,不阻塞。
 */
function healLegacyManagedProfileDir(): void {
  const runtimeDir = process.env.XDT_BROWSER_RUNTIME_DIR;
  if (!runtimeDir) return; // 非 Electron 上下文(单测):runtime 走自身默认目录,不动
  try {
    const legacy = nodePath.join(runtimeDir, 'browser', LEGACY_MANAGED_PROFILE);
    const current = nodePath.join(runtimeDir, 'browser', MANAGED_PROFILE);
    if (fs.existsSync(legacy) && !fs.existsSync(current)) {
      fs.renameSync(legacy, current);
      logger.info(
        `managed profile dir renamed in place: ${LEGACY_MANAGED_PROFILE} -> ${MANAGED_PROFILE}`,
      );
    }
  } catch (err) {
    logger.warn(`managed profile dir rename failed (fresh profile will be used): ${String(err)}`);
  }
}
healLegacyManagedProfileDir();

function realProfileRuntimeDir(): string {
  return process.env.XDT_BROWSER_RUNTIME_DIR ?? '';
}

const browserRuntimeLogSink = (
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
  scope: string,
  args: unknown[],
) => {
  const hostLevel = level === 'trace' ? 'debug' : level === 'fatal' ? 'error' : level;
  const fn = (logger[hostLevel] ?? logger.info).bind(logger);
  fn(`[${scope}]`, ...args);
};

/** Last proxy launch options, so real-profile applyConfig cannot drop them. */
let lastProxyLaunch: {
  proxyServer?: string;
  proxyAllowedHostnames?: readonly string[];
} = {};

/** Last applied profile identity, so the CDP guard follows Cindy-real / relocated ports. */
let lastManagedIdentity = {
  useRealProfile: false,
  cdpPort: MANAGED_CDP_PORT,
};

function rememberManagedIdentity(opts: ManagedBrowserConfigOptions): void {
  if (typeof opts.useRealProfile === 'boolean') {
    lastManagedIdentity.useRealProfile = opts.useRealProfile;
    if (!opts.useRealProfile && opts.cdpPort === undefined) {
      lastManagedIdentity.cdpPort = MANAGED_CDP_PORT;
    }
  }
  if (typeof opts.cdpPort === 'number') {
    lastManagedIdentity.cdpPort = opts.cdpPort;
  }
}

function currentGuardIdentity(): { cdpHttpUrl: string; managedUserDataDir?: string } {
  const runtimeDir = realProfileRuntimeDir();
  if (!runtimeDir) {
    return { cdpHttpUrl: `http://127.0.0.1:${lastManagedIdentity.cdpPort}` };
  }
  return managedBrowserGuardIdentity({
    runtimeDir,
    useRealProfile: lastManagedIdentity.useRealProfile,
    cdpPort: lastManagedIdentity.cdpPort,
  });
}

function applyManagedConfig(opts: ManagedBrowserConfigOptions): void {
  if ('proxyServer' in opts || 'proxyAllowedHostnames' in opts) {
    lastProxyLaunch = {
      proxyServer: opts.proxyServer,
      proxyAllowedHostnames: opts.proxyAllowedHostnames,
    };
  }
  const merged = { ...lastProxyLaunch, ...opts };
  rememberManagedIdentity(merged);
  setBrowserControlRuntimeConfig(buildManagedConfig(merged));
}

function currentRealProfileLaunchOpts(): {
  useRealProfile: boolean;
  cdpPort?: number;
} {
  const useRealProfile = readBrowserBackendSettings().useRealProfile === true;
  const remembered = useRealProfile ? readCopiedLoginsCdpPort(realProfileRuntimeDir()) : null;
  return {
    useRealProfile,
    ...(remembered ? { cdpPort: remembered } : {}),
  };
}

function wrapManagedRuntime(inner: BrowserControlRuntime) {
  return wrapRuntimeWithRealProfile(inner, {
    isEnabled: () => readBrowserBackendSettings().useRealProfile,
    getRuntimeDir: realProfileRuntimeDir,
    applyConfig: (opts) => {
      applyManagedConfig({ ...lastProxyLaunch, ...opts });
    },
  });
}

/** Create an immutable-config runtime for one managed-browser launch route. */
function createManagedRuntime(route: BrowserProxyRoute): BrowserControlRuntime {
  lastProxyLaunch = {
    proxyServer: route.mode === 'proxied' ? route.server : undefined,
    proxyAllowedHostnames: route.allowedHostnames,
  };
  const merged = {
    ...currentRealProfileLaunchOpts(),
    ...lastProxyLaunch,
  };
  rememberManagedIdentity(merged);
  return wrapManagedRuntime(
    createBrowserControlRuntime({
      config: buildManagedConfig(merged),
      logSink: browserRuntimeLogSink,
    }),
  ) as BrowserControlRuntime;
}

const initialUseRealProfile = readBrowserBackendSettings().useRealProfile;
const rememberedCopiedLoginsCdpPort = initialUseRealProfile
  ? readCopiedLoginsCdpPort(realProfileRuntimeDir())
  : null;
lastManagedIdentity = {
  useRealProfile: initialUseRealProfile === true,
  cdpPort: rememberedCopiedLoginsCdpPort ?? MANAGED_CDP_PORT,
};

const directBrowserRuntime = createBrowserControlRuntime({
  config: buildManagedConfig({
    proxyServer: undefined,
    useRealProfile: initialUseRealProfile,
    ...(rememberedCopiedLoginsCdpPort ? { cdpPort: rememberedCopiedLoginsCdpPort } : {}),
  }),
  logSink: browserRuntimeLogSink,
});

const externalChromeBackend = new ExternalChromeBackend(
  wrapManagedRuntime(directBrowserRuntime),
  logger,
  {
    createRuntime: createManagedRuntime,
    cdpHttpUrl: () => currentGuardIdentity().cdpHttpUrl,
    managedUserDataDir: () => currentGuardIdentity().managedUserDataDir,
  },
);

/**
 * Real-profile consent switches (`setBrowserUseRealProfile`, reset, quit) must
 * be serialized with every external-browser call. The backend serializes its
 * own calls, but a consent switch stops the browser and swaps directories, so
 * it must not interleave with a call the backend has already admitted: the
 * queue wraps the backend from outside. Code that already runs inside the
 * queue talks to `externalChromeBackend` directly (re-entering would deadlock).
 */
const browserProfileLifecycleQueue = createBrowserProfileLifecycleQueue();
const externalBackend: BrowserBackend = {
  kind: 'external',
  call: wrapRuntimeWithProfileLifecycleQueue(externalChromeBackend, browserProfileLifecycleQueue).call,
  dispose: () => browserProfileLifecycleQueue.run(() => externalChromeBackend.dispose()),
};

type SessionUploadRootResolver = (sessionId: string) => Promise<string[]>;

let resolveSessionUploadRoots: SessionUploadRootResolver = async () => [];

export function setBrowserSessionUploadRootResolver(resolver: SessionUploadRootResolver): void {
  resolveSessionUploadRoots = resolver;
}

/**
 * Create an RSB-webview backend instance (Phase 3+). The instance is terminal
 * after `dispose()`, so every activation/recovery must call this factory rather
 * than reusing a process-wide singleton.
 *
 * Lazily constructed because the
 * TabRegistry singleton must be available — which it is right after this
 * module evaluates, since `getRsbBrowserBridge()` is self-instantiating.
 */
function createRsbBackend(): RsbWebviewBackend {
  return new RsbWebviewBackend({
    registry: getRsbBrowserBridge(),
    getActiveSessionId: () => getActiveRsbSessionId(),
    artifactRoot: () => nodePath.join(app.getPath('temp'), 'cindy-browser-artifacts'),
    resolveUploadRoots: (sessionId) => resolveSessionUploadRoots(sessionId),
    bridge: {
      // Lazy main-window lookup. Phase 2 uses the same pattern; once the host
      // window is available the dispatch lands cleanly, before that the request
      // rejects with `host renderer not available`.
      getHostWebContents: () => {
        // bootstrap-electron owns mainWindowRef; we read it through the public
        // helper to avoid a circular import.
        const win = readMainWindowForBackend();
        return win;
      },
      // detached 偏好开 + 侧边栏子窗口关着时,tab-op 前先把子窗口拉起来并等
      // renderer ready 握手(否则没有任何 renderer 挂着 RSB store 可执行 op)。
      ensureHost: (sessionId) => ensureHostForBackend(sessionId),
      // detached 偏好信号:直连动作解析 miss 时,只有 detached 模式才值得等
      // 子窗口 renderer 重注册 tab;内嵌模式主窗常驻,miss 即真失效,快速失败。
      isDetached: () => isDetachedForBackend(),
      logger,
    },
    logger,
  });
}

/**
 * Initial backend selection — driven by the persisted settings file. On first
 * launch (no override) the system default from `browser-backend-settings-store`
 * is applied; that default is `'external'` (the managed Chrome below). Users
 * who explicitly picked a backend keep their choice — see the DEFAULT HISTORY
 * note in that store for the override semantics behind the two flips.
 */
const initialKind = readBrowserBackendSettings().kind;

/**
 * Process-wide lifecycle controller. Phase 5 wires it to the persisted backend kind. All
 * downstream consumers (MCP deps, login helper, availability probe, quit
 * disposer) go through the controller so switching and same-kind recovery are
 * serialized.
 *
 * The controller implements `BrowserControlRuntime` (its `.call` matches the
 * contract verbatim) so @cindy/mcps consumes it as the runtime with no adapter.
 */
const backendController = new BrowserBackendController({
  initialKind,
  externalBackend,
  createRsbBackend,
  logger,
});
const browserBackendHealthService = new BrowserBackendHealthService(backendController, logger);

/**
 * Main-window webContents accessor — populated by bootstrap-electron via
 * `setMainWindowAccessorForBackend`. Without this the RsbWebviewBackend has
 * no way to reach the renderer for tab-op dispatch.
 */
let mainWindowAccessor: () => Electron.WebContents | null = () => null;

function readMainWindowForBackend(): Electron.WebContents | null {
  return mainWindowAccessor();
}

/**
 * Bootstrap hook. Called from `bootstrap-electron.ts` once `mainWindowRef` is
 * known. Idempotent re-binds are safe.
 */
export function setMainWindowAccessorForBackend(accessor: () => Electron.WebContents | null): void {
  mainWindowAccessor = accessor;
}

/**
 * Ensure-host hook — populated by bootstrap-electron with the RSB window
 * controller's `ensureOpenForAutomation`. Default no-op keeps the embedded
 * (non-detached) behavior: host is the always-alive main window.
 */
let ensureHostForBackendImpl: (sessionId?: string) => Promise<void> = () => Promise.resolve();

function ensureHostForBackend(sessionId?: string): Promise<void> {
  return ensureHostForBackendImpl(sessionId);
}

/** Bootstrap hook, same pattern as `setMainWindowAccessorForBackend`. */
export function setEnsureHostForBackend(impl: (sessionId?: string) => Promise<void>): void {
  ensureHostForBackendImpl = impl;
}

/**
 * Detached-preference probe — populated by bootstrap-electron from the RSB
 * window settings. Default `false` keeps embedded semantics (fail fast on
 * tab-resolve miss, no re-attach polling).
 */
let isDetachedForBackendImpl: () => boolean = () => false;

function isDetachedForBackend(): boolean {
  return isDetachedForBackendImpl();
}

/** Bootstrap hook, same pattern as `setEnsureHostForBackend`. */
export function setIsDetachedForBackend(impl: () => boolean): void {
  isDetachedForBackendImpl = impl;
}

/**
 * Switch the active backend. Called from the Phase 5 toggle IPC handler.
 * Persists the new kind to disk and disposes the outgoing backend (per
 * lifecycle controller contract).
 */
export async function setActiveBrowserBackendKind(kind: BackendKind): Promise<void> {
  // The controller performs the same-kind check inside its serialized queue.
  // Doing it here would race two Settings actions: a request for the current
  // kind could return early while an earlier queued request is about to switch
  // away from it.
  const changed = await backendController.setKind(kind);
  if (!changed) return;
  writeBrowserBackendKind(kind);
}

async function stopExternalRuntimeIfUsed(): Promise<void> {
  const useRealProfile = readBrowserBackendSettings().useRealProfile;
  const patch = managedConfigPatchBeforeStop({
    rememberedCdpPort: useRealProfile ? readCopiedLoginsCdpPort(realProfileRuntimeDir()) : null,
  });
  if (patch) {
    applyManagedConfig({ ...lastProxyLaunch, ...patch });
  }
  // Inside the lifecycle queue: talk to the inner backend. It verifies process
  // absence and resets the proxy route, which a raw runtime stop would skip.
  const status = await externalChromeBackend.call({ action: 'status' });
  const running =
    status.ok &&
    status.data !== null &&
    typeof status.data === 'object' &&
    (status.data as { running?: unknown }).running === true;
  const stop = running ? await externalChromeBackend.call({ action: 'stop' }) : null;
  assertManagedBrowserStopped({ status, stop });
}

/**
 * Persist consent, stop the managed Chrome so the next start can switch
 * directories, and delete the snapshot when consent is revoked. Disable only
 * persists after the Cindy-real copy is gone; a cleanup failure keeps the
 * switch on so the user can retry. An unsuccessful or unverifiable stop also
 * aborts so POSIX open handles cannot keep copied cookies after unlink.
 */
async function applyBrowserUseRealProfile(enabled: boolean): Promise<boolean> {
  await stopExternalRuntimeIfUsed();
  if (!enabled) {
    cleanupCopiedLoginsThen(realProfileRuntimeDir(), () => {
      writeBrowserUseRealProfile(false);
    });
  } else {
    writeBrowserUseRealProfile(true);
  }
  applyManagedConfig({ ...lastProxyLaunch, useRealProfile: enabled });
  return readBrowserBackendSettings().useRealProfile;
}

export function setBrowserUseRealProfile(enabled: boolean): Promise<boolean> {
  return browserProfileLifecycleQueue.run(() => applyBrowserUseRealProfile(enabled));
}

/**
 * Browser automation deps for cindy_browser MCP.
 *
 * The concrete runtime is intentionally hidden behind the neutral
 * BrowserControlRuntime contract so the desktop host does not depend on an
 * upstream product API or product-facing name.
 */
export function getBrowserMcpDeps(): {
  getRuntime(): BrowserControlRuntime;
  supportsResourceDownloads(): boolean;
  supportsSemanticQueries(): boolean;
  logger: typeof logger;
  getUserRecipes(): Promise<UserRecipesResult>;
  saveUserRecipe(input: Parameters<typeof writeUserRecipe>[0]): Promise<WriteUserRecipeResult>;
} {
  return {
    // L2 user-recipe layer (userData/browser-recipes); merged over the bundled
    // L1 catalog inside the MCP. Empty/missing dir → bundled-only (== before).
    getUserRecipes: () => loadUserBrowserRecipes(),
    // Self-grow: persist an agent/user-authored recipe into L2 (validated by the MCP).
    saveUserRecipe: (input) => writeUserRecipe(input),
    // Controller implements `BrowserControlRuntime` — the MCP tool layer never sees
    // the backend split. Swapping the active backend (Phase 5) is invisible from
    // @cindy/mcps' perspective.
    getRuntime: () => backendController,
    supportsResourceDownloads: () => backendController.kind === 'rsb-webview',
    supportsSemanticQueries: () => backendController.kind === 'rsb-webview',
    logger,
  };
}

/**
 * Probe whether a local browser is available (drives the Settings UI's
 * "未检测到本机浏览器 / 下载 Chrome" cell).
 *
 * **Always** goes to the external managed-browser backend, NOT the active controller — this probe asks
 * "did the user install Chrome on their machine?", which is purely a property
 * of the EXTERNAL backend. The RSB-webview backend uses Electron's bundled
 * Chromium and is always available; routing through the active controller would make the
 * Settings card lie ("未检测到 Chrome") whenever the user has the internal
 * backend selected, even on a machine with Chrome installed.
 */
export async function getBrowserAvailability(): Promise<BrowserAvailability> {
  const res = await externalBackend.call({ action: 'status' });
  return extractBrowserAvailability(res.data);
}

/**
 * Read the currently-active backend kind. Reflects the Settings-driven toggle
 * (persisted override) merged over the system default, not a fixed value.
 */
export function getActiveBrowserBackendKind(): BackendKind {
  return backendController.getCurrentBackendKind();
}

/**
 * Rebuild the active embedded control backend and verify the replacement before
 * reporting success. The controller swaps first, so every existing MCP runtime
 * reference immediately delegates to the fresh instance; no Agent-side cache
 * needs to be invalidated separately.
 */
export function recoverActiveBrowserBackend() {
  return browserBackendHealthService.recover();
}

/** Probe once, then automatically replace a failed embedded backend. */
export function getBrowserBackendHealth() {
  return browserBackendHealthService.getHealth();
}

/**
 * Register Phase 5 IPC handlers for the Settings UI:
 *   - `browser-backend:get-state` → current kind + override state
 *   - `browser-backend:set-kind`  → swap active backend + persist
 *   - `browser-backend:reset`     → clear user override, follow current default
 *   - `browser-backend:get-health` → probe + one automatic embedded recovery
 *   - `browser-backend:recover`    → force a fresh embedded backend + verify
 *   - `browser-backend:probe-source-read` → `{ readable }` only; skip FDA if true
 *   - `rsb-browser-bridge:set-active-session` → renderer pushes the focused
 *      sessionId; RsbWebviewBackend reads via getActiveRsbSessionId() at
 *      action time (Phase 3 dependency).
 *
 * Idempotent — repeat calls (HMR, tests) are no-op via the `registered` flag.
 */
let backendIpcRegistered = false;
export function registerBrowserBackendIpc(): void {
  if (backendIpcRegistered) return;
  backendIpcRegistered = true;

  const handlers = createBrowserBackendIpcHandlers({
    assertTrusted: assertTrustedAppRendererEvent,
    getState: () => {
      const state = readBrowserBackendSettingsState();
      return {
        active: backendController.getCurrentBackendKind(),
        systemDefault: state.defaults.kind,
        isOverride: state.customizedKeys.includes('kind'),
        useRealProfile: state.value.useRealProfile,
      };
    },
    setKind: async (kind) => {
      await setActiveBrowserBackendKind(kind);
      return backendController.getCurrentBackendKind();
    },
    setUseRealProfile: async (enabled) => {
      return setBrowserUseRealProfile(enabled);
    },
    reset: async () => {
      const next = await browserProfileLifecycleQueue.run(async () => {
        if (readBrowserBackendSettings().useRealProfile) {
          await applyBrowserUseRealProfile(false);
        }
        return resetBrowserBackendSettings();
      });
      await setActiveBrowserBackendKind(next.kind);
      return backendController.getCurrentBackendKind();
    },
    getHealth: getBrowserBackendHealth,
    recover: recoverActiveBrowserBackend,
    probeSourceRead: () => probeOsSourceProfileReadAccess(),
  });
  ipcMain.handle('browser-backend:get-state', handlers.getState);
  ipcMain.handle('browser-backend:set-kind', handlers.setKind);
  ipcMain.handle('browser-backend:set-use-real-profile', handlers.setUseRealProfile);
  ipcMain.handle('browser-backend:reset', handlers.reset);
  ipcMain.handle('browser-backend:get-health', handlers.getHealth);
  ipcMain.handle('browser-backend:recover', handlers.recover);
  ipcMain.handle('browser-backend:probe-source-read', handlers.probeSourceRead);

  ipcMain.handle('rsb-browser-bridge:set-active-session', (_e, payload: unknown) => {
    const obj = requireObject(payload, 'set-active-session payload');
    // optionalNullableString accepts `null` explicitly + non-empty string +
    // undefined/empty as "no value". Anything else (e.g. {sessionId: 42})
    // collapses to null, which is the only reasonable fallback — we're not
    // surfacing the rare malformed-payload path as a hard error since the
    // semantic is "renderer no longer focused on any RSB session".
    const raw = optionalNullableString(obj.sessionId);
    const sessionId: string | null = raw === null ? null : (raw ?? null);
    setActiveRsbSessionId(sessionId);
    return { ok: true };
  });

  logger.info('browser-backend IPC handlers registered');
}

/**
 * Launch the (headed) automation browser so the user can log into the sites they
 * want the agent to operate. Drives the Settings →「自动操作」"打开 Agent 专用浏览器"
 * action. Logins persist in the managed profile's user-data-dir.
 */
export async function openBrowserForLogin(): Promise<void> {
  // `start` launches the headed managed Chrome (idempotent: no-op if already running).
  // It already provides a window + new-tab page, so we NEVER open another tab here:
  // doing so raced with Chrome's own initial tab on a cold start and produced a
  // duplicate tab on the first open.
  //
  // **Always** goes to the external managed-browser backend, NOT the active controller — "打开 Agent 专用浏
  // 览器" is the external Chrome workflow: user clicks it to log into sites in
  // the dedicated `Cindy` profile. If the user picked the rsb-webview backend
  // they don't need this button at all (logins go through the sidebar webview);
  // routing through the active controller would either no-op (rsb backend's `start` is a
  // no-op) or open the wrong thing.
  // `start` without proxyServer is an explicit request for direct mode. Probe
  // first so opening the login browser never tears down an already-running
  // caller-selected proxy route just to raise its window.
  const status = await externalBackend.call({ action: 'status' });
  if (!status.ok) {
    throw new Error(
      status.message === FOREIGN_AGENT_BROWSER_ERROR || status.message?.includes('Another Cindy')
        ? FOREIGN_AGENT_BROWSER_ERROR
        : (status.message ?? `browser status failed (HTTP ${status.status ?? '?'})`),
    );
  }
  const running = (status.data as { running?: unknown } | undefined)?.running;
  if (running !== true && running !== false) {
    throw new Error('browser status did not report whether the managed browser is running');
  }
  // A running browser whose route is unknown — Cindy restarted and inherited a
  // Chrome from a previous launch — cannot be driven: ordinary actions are
  // refused until the route is re-established, so skipping `start` here would
  // make this return success while raise below silently failed and the window
  // never came forward. `start` is the only path that adopts or replaces such a
  // process and reinstates its request guard, so run it in that case too.
  const proxyMode = (status.data as { proxy?: { mode?: unknown } } | undefined)?.proxy?.mode;
  if (!running || proxyMode === 'unknown') {
    const started = await externalBackend.call({ action: 'start' });
    if (!started.ok) {
      const reason = browserOpenForLoginErrorCodeFromData(started.data);
      if (reason) throw new BrowserOpenForLoginError(reason);
      if (
        started.message === FOREIGN_AGENT_BROWSER_ERROR ||
        started.message?.includes('Another Cindy')
      ) {
        throw new BrowserOpenForLoginError(FOREIGN_AGENT_BROWSER_ERROR);
      }
      throw new Error('Agent browser failed to start.');
    }
  }
  // Occupancy is handled inside start (relocate CDP instead of attaching).
  // Do not re-probe status.running here: vendored `running` means "CDP is
  // reachable", and pid/userDataDir can still be missing or point at a
  // leftover Chrome on 18800 after a successful start of *this* window.
  await raiseAgentBrowserWindow(externalBackend);
}

/**
 * App-quit cleanup: stop the managed Chrome so it doesn't outlive the app.
 *
 * Registered into the lifecycle disposer chain (bootstrap-electron.ts
 * `onQuit('browser-runtime', …, 'async')`). The managed browser is a lazily
 * spawned process owned by the external managed-browser backend; nothing else sends `stop`, so
 * without this the headed Chrome + its locked user-data-dir survive app
 * quit / crash / dev-reload, and the next launch has to recover a stale
 * SingletonLock. Goes through the external backend's serialized disposer,
 * which swallows errors.
 *
 * NOTE (Windows): the managed runtime stop sends SIGTERM→SIGKILL to the launched Chrome
 * process. Chromium's child renderer/GPU processes normally exit with their
 * parent, but full process-tree teardown on win32 is not yet verified — if
 * orphans are observed, add a host-side `taskkill /F /T /PID <pid>` fallback here
 * (requires surfacing the pid; the vendored runtime does not expose it today).
 * NOTE: updater force-quit (updateService.ts) bypasses `before-quit`, so this may
 * not run on the auto-update relaunch path; stale-lock recovery covers that case.
 */
export function disposeBrowserRuntime(): Promise<void> {
  // Always stop the external managed Chrome directly, NOT through the active controller.
  // The controller may currently point at RsbWebviewBackend, whose dispose only
  // releases control listeners and does not own the external Chrome process. If
  // we only dispose through the active backend, a user who switched to external Chrome and back
  // leaves a headed Chrome process surviving app quit (the external backend
  // doesn't know about the swap and Phase 5 swap-time dispose already ran;
  // a stale-lock recovery on next launch is the symptom).
  //
  // The external backend tracks whether its runtime was used and skips an
  // unnecessary stop for a browser-less session. If it was used, stop is
  // idempotent and safe even when the active backend is the embedded webview.
  // `externalBackend.dispose` runs under the profile lifecycle queue so quit
  // cannot interleave with an in-flight consent switch.
  externalChromeBackend.beginQuiescence();
  return externalBackend.dispose();
}
