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
  type BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import { createLogger } from '../logger.js';
import { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
import { loadUserBrowserRecipes, type UserRecipesResult } from '../browser-recipes/loader.js';
import { writeUserRecipe, type WriteUserRecipeResult } from '../browser-recipes/writer.js';
import { stopRuntimeForQuitIfUsed, trackBrowserRuntimeUsage } from './browser-dispose.js';
import {
  BrowserBackendController,
  BrowserBackendHealthService,
  ExternalChromeBackend,
  RsbWebviewBackend,
  type BackendKind,
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
import { buildManagedConfig, MANAGED_PROFILE } from './browser-managed-config.js';
import {
  assertManagedBrowserStopped,
  cleanupCopiedLoginsThen,
  managedConfigPatchBeforeStop,
  FOREIGN_AGENT_BROWSER_ERROR,
  probeOsSourceProfileReadAccess,
  readCopiedLoginsCdpPort,
  wrapRuntimeWithRealProfile,
} from './browser-real-profile/index.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { createBrowserBackendIpcHandlers } from './browser-backend/settings-ipc.js';
import { raiseAgentBrowserWindow } from './raise-agent-browser-window.js';

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

const initialUseRealProfile = readBrowserBackendSettings().useRealProfile;
const rememberedCopiedLoginsCdpPort = initialUseRealProfile
  ? readCopiedLoginsCdpPort(realProfileRuntimeDir())
  : null;

// Single shared runtime for the desktop process. Boots with the managed profile
// (electron-free, safe at module-eval); logs route into the unified logger.
//
// `vendoredRuntime` is the raw upstream object behind a thin usage-tracking
// wrapper (see `trackBrowserRuntimeUsage`): every consumer in this module —
// the `ExternalChromeBackend` (behind the lifecycle controller, which is what
// @cindy/mcps via `getBrowserMcpDeps` and host helpers below receive), the
// availability probe and the login helper — calls through the wrapper, so
// `disposeBrowserRuntime` can tell whether the runtime saw ANY traffic this
// session. We never hand the raw object out; swapping the active backend in
// Backend switching and recovery stay behind the process-wide controller.
const vendoredRuntime = trackBrowserRuntimeUsage(
  createBrowserControlRuntime({
    config: buildManagedConfig({
      useRealProfile: initialUseRealProfile,
      ...(rememberedCopiedLoginsCdpPort ? { cdpPort: rememberedCopiedLoginsCdpPort } : {}),
    }),
    logSink: (level, scope, args) => {
      // Bind to `logger`: the unified logger's methods rely on `this`, and calling
      // a detached `logger[level]` reference would lose it (undefined in strict
      // mode) and silently break the browser runtime's log channel.
      const fn = (logger[level] ?? logger.info).bind(logger);
      fn(`[${scope}]`, ...args);
    },
  }),
);

/**
 * Consent-gated snapshot wrapper sits *outside* usage tracking: a failed
 * copy must not count as "runtime used", or quit-time `stop` would boot
 * Playwright just to shut it down.
 */
const externalRuntime = wrapRuntimeWithRealProfile(vendoredRuntime, {
  isEnabled: () => readBrowserBackendSettings().useRealProfile,
  getRuntimeDir: realProfileRuntimeDir,
  applyConfig: (opts) => {
    setBrowserControlRuntimeConfig(buildManagedConfig(opts));
  },
});

const externalBackend = new ExternalChromeBackend(externalRuntime, logger);

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
    setBrowserControlRuntimeConfig(buildManagedConfig(patch));
  }
  const status = await vendoredRuntime.call({ action: 'status' });
  const running =
    status.ok &&
    status.data !== null &&
    typeof status.data === 'object' &&
    (status.data as { running?: unknown }).running === true;
  const stop = running ? await externalRuntime.call({ action: 'stop' }) : null;
  assertManagedBrowserStopped({ status, stop });
}

/**
 * Persist consent, stop the managed Chrome so the next start can switch
 * directories, and delete the snapshot when consent is revoked. Disable only
 * persists after the Cindy-real copy is gone; a cleanup failure keeps the
 * switch on so the user can retry. An unsuccessful or unverifiable stop also
 * aborts so POSIX open handles cannot keep copied cookies after unlink.
 */
export async function setBrowserUseRealProfile(enabled: boolean): Promise<boolean> {
  await stopExternalRuntimeIfUsed();
  if (!enabled) {
    cleanupCopiedLoginsThen(realProfileRuntimeDir(), () => {
      writeBrowserUseRealProfile(false);
    });
  } else {
    writeBrowserUseRealProfile(true);
  }
  setBrowserControlRuntimeConfig(buildManagedConfig({ useRealProfile: enabled }));
  return readBrowserBackendSettings().useRealProfile;
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
 * **Always** goes to the vendored runtime, NOT the active controller — this probe asks
 * "did the user install Chrome on their machine?", which is purely a property
 * of the EXTERNAL backend. The RSB-webview backend uses Electron's bundled
 * Chromium and is always available; routing through the active controller would make the
 * Settings card lie ("未检测到 Chrome") whenever the user has the internal
 * backend selected, even on a machine with Chrome installed.
 */
export async function getBrowserAvailability(): Promise<BrowserAvailability> {
  const res = await externalRuntime.call({ action: 'status' });
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
      const previous = readBrowserBackendSettings();
      const next = resetBrowserBackendSettings();
      if (previous.useRealProfile && !next.useRealProfile) {
        await setBrowserUseRealProfile(false);
      }
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
  // **Always** goes to the vendored runtime, NOT the active controller — "打开 Agent 专用浏
  // 览器" is the external Chrome workflow: user clicks it to log into sites in
  // the dedicated `Cindy` profile. If the user picked the rsb-webview backend
  // they don't need this button at all (logins go through the sidebar webview);
  // routing through the active controller would either no-op (rsb backend's `start` is a
  // no-op) or open the wrong thing.
  const started = await externalRuntime.call({ action: 'start' });
  if (!started.ok) {
    throw new Error(
      started.message === FOREIGN_AGENT_BROWSER_ERROR || started.message?.includes('Another Cindy')
        ? FOREIGN_AGENT_BROWSER_ERROR
        : (started.message ?? `browser start failed (HTTP ${started.status ?? '?'})`),
    );
  }
  // Occupancy is handled inside start (relocate CDP instead of attaching).
  // Do not re-probe status.running here: vendored `running` means "CDP is
  // reachable", and pid/userDataDir can still be missing or point at a
  // leftover Chrome on 18800 after a successful start of *this* window.
  await raiseAgentBrowserWindow(externalRuntime);
}

/**
 * App-quit cleanup: stop the managed Chrome so it doesn't outlive the app.
 *
 * Registered into the lifecycle disposer chain (bootstrap-electron.ts
 * `onQuit('browser-runtime', …, 'async')`). The managed browser is a lazily
 * spawned process owned by the vendored runtime; nothing else sends `stop`, so
 * without this the headed Chrome + its locked user-data-dir survive app
 * quit / crash / dev-reload, and the next launch has to recover a stale
 * SingletonLock. Goes through the electron-free `stopRuntimeForQuitIfUsed`
 * (which swallows errors — see browser-dispose.ts).
 *
 * NOTE (Windows): the vendored stop sends SIGTERM→SIGKILL to the launched Chrome
 * process. Chromium's child renderer/GPU processes normally exit with their
 * parent, but full process-tree teardown on win32 is not yet verified — if
 * orphans are observed, add a host-side `taskkill /F /T /PID <pid>` fallback here
 * (requires surfacing the pid; the vendored runtime does not expose it today).
 * NOTE: updater force-quit (updateService.ts) bypasses `before-quit`, so this may
 * not run on the auto-update relaunch path; stale-lock recovery covers that case.
 */
export function disposeBrowserRuntime(): Promise<void> {
  // Always stop the vendored Chrome directly, NOT through the active controller.
  // The controller may currently point at RsbWebviewBackend, whose dispose only
  // releases control listeners and does not own the external Chrome process. If
  // we only dispose through the active backend, a user who switched to external Chrome and back
  // leaves a headed Chrome process surviving app quit (the vendored runtime
  // doesn't know about the swap and Phase 5 swap-time dispose already ran;
  // a stale-lock recovery on next launch is the symptom).
  //
  // Short-circuit via the usage tracker: the vendored dispatch bridge boots
  // the browser control service (dynamic playwright import included) before
  // routing ANY action, `stop` included — so on a session that never touched
  // the browser runtime, an unconditional stop would START services during
  // quit, which is an exit-hang amplifier. If the runtime WAS used, `stop` is
  // idempotent and safe regardless of which backend is currently active.
  return stopRuntimeForQuitIfUsed(vendoredRuntime, logger);
}
