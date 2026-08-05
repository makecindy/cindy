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
  type BrowserControlRuntime,
  type BrowserRuntimeConfig,
} from '@cindy/browser-control-runtime';

import { createLogger } from '../logger.js';
import { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
import { loadUserBrowserRecipes, type UserRecipesResult } from '../browser-recipes/loader.js';
import { writeUserRecipe, type WriteUserRecipeResult } from '../browser-recipes/writer.js';
import { stopRuntimeForQuitIfUsed, trackBrowserRuntimeUsage } from './browser-dispose.js';
import {
  BackendRouter,
  ExternalChromeBackend,
  RsbWebviewBackend,
  type BackendKind,
  type BrowserBackend,
} from './browser-backend/index.js';
import {
  getRsbBrowserBridge,
  dispatchTabOp as _dispatchTabOp,
} from '../rsb-browser-bridge/index.js';
import {
  readBrowserBackendSettings,
  writeBrowserBackendKind,
  resetBrowserBackendSettings,
  readBrowserBackendSettingsState,
} from '../browser-backend-settings-store.js';
import {
  getActiveRsbSessionId,
  setActiveRsbSessionId,
} from '../rsb-browser-bridge/active-session.js';
import {
  requireEnum,
  requireObject,
  optionalNullableString,
} from '../utils/ipcValidate.js';

export { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';

const logger = createLogger('mcp/cindy_browser');

/**
 * Managed profile identity. The profile key doubles as (a) the Chrome profile
 * display name rendered in the launched browser's top-right profile button and (b)
 * the user-data-dir folder name — so it's branded "Cindy" to make the automation
 * browser obviously distinct from the user's everyday Chrome at a glance. The runtime
 * seeds the name + color into the profile's Local State / Preferences before launch
 * (decoration re-checks the desired name every launch, so a profile dir carried over
 * with an old display name self-heals to "Cindy" on first run).
 * (Same Chrome binary as the user's, so the dock/taskbar icon is unchanged.)
 *
 * ⚠️ 磁盘标识符:这是 2026-07 品牌翻转时钉死的目录名,之后【不要】再跟随
 * @cindy/maker-shared/branding 的 BRAND_NAME 变化——改了会指向新的空 profile
 * 目录,丢失既有登录态/Cookie。老 profile 的接续路径:
 *  - 老 userData(xdt-maker)里的 `browser-runtime/browser/XDMaker` 由 mToc 首登
 *    迁移(legacyUserDataMigration.ts)复制为新 userData 的 `browser/Cindy`;
 *  - 新 userData 里若已有旧名目录(翻转前的 dev 实例),下方 module-eval 的
 *    就地改名自愈处理。两处的 'XDMaker'/'Cindy' 字面量与本常量保持一致。
 */
const MANAGED_PROFILE = 'Cindy';
/** 翻转前(≤2026-07-17)创建的受管 profile 目录名,仅用于就地改名自愈。 */
const LEGACY_MANAGED_PROFILE = 'XDMaker';
/**
 * Fixed brand tint for the managed profile. This intentionally stays on the vivid
 * teal variant instead of the Default Light auto-approval text color. NOTE:
 * Chrome treats this as a *seed* and generates a tonal toolbar theme from it (Material
 * You), so it is NOT painted literally — but a SATURATED hue like this renders as a
 * clean teal, unlike a neutral/near-black seed which Chrome muddies into a grey-blue.
 * (The darker #000050 variant is near-neutral and would muddy, so we use #00D9C5.)
 */
const DEFAULT_PROFILE_COLOR = '#00D9C5';
/**
 * Vendored "managed launch" driver enum value (required by the runtime to mark a
 * profile as launch-and-own vs attach-to-existing). It DOES surface in the
 * `profiles`/`status`/`doctor` diagnostic output, so the runtime scrubs the
 * vendored brand from those success bodies at its boundary (see runtime.ts
 * DIAGNOSTIC_ACTIONS) — the agent never sees the raw "openclaw" string.
 */
const MANAGED_DRIVER = 'openclaw' as const;
/**
 * Managed Chrome CDP port. The runtime only auto-assigns a port to its built-in
 * default profile (keyed by the vendored default name); a custom-named managed
 * profile MUST define its own `cdpPort` or the runtime rejects it with "must define
 * cdpPort or cdpUrl". 18800 is the vendored default CDP port-range start.
 */
const MANAGED_CDP_PORT = 18800;

/**
 * Default ("managed") config: a single playwright-launched Chrome profile, headed,
 * with a STABLE persistent user-data-dir (logins survive across sessions). This is
 * the product default — a "dedicated persistent login automation browser".
 * (`browser-backend-settings-store` resolves `'external'` as the system default,
 * so this config is what a user who never touched the toggle gets.)
 *
 * SECURITY POSTURE (intentional, owner-decided 2026-06):
 *  - No `ssrfPolicy` is set → the strict browser-side DNS-rebinding gate +
 *    redirect-chain inspection stay OFF, so the agent CAN navigate to
 *    localhost / private-network hosts. This is deliberate: Cindy is an internal
 *    tool and users need the agent to drive local dev servers / internal sites.
 *    (Private-IP *literals* are still classified by the vendored resolver; what's
 *    intentionally allowed is hostname→private navigation.) Do not arm
 *    `dangerouslyAllowPrivateNetwork:false` here without re-confirming that call.
 *  - Page-context `evaluate` (and recipe `evaluate` steps) run author/agent JS in
 *    Chromium, whose network stack is NOT subject to the Node SSRF guard — a
 *    same-origin `fetch` there can reach any host the browser can. This residual
 *    surface is accepted as inherent to browser automation (it's the same
 *    capability the `act:evaluate` tool already exposes), not a regression.
 */
function buildManagedConfig(): BrowserRuntimeConfig {
  return {
    browser: {
      enabled: true,
      defaultProfile: MANAGED_PROFILE,
      headless: false, // headed so the user can see + log into sites
      profiles: {
        [MANAGED_PROFILE]: {
          driver: MANAGED_DRIVER,
          color: DEFAULT_PROFILE_COLOR,
          cdpPort: MANAGED_CDP_PORT,
        },
      },
    },
  };
}

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
      logger.info(`managed profile dir renamed in place: ${LEGACY_MANAGED_PROFILE} -> ${MANAGED_PROFILE}`);
    }
  } catch (err) {
    logger.warn(`managed profile dir rename failed (fresh profile will be used): ${String(err)}`);
  }
}
healLegacyManagedProfileDir();

// Single shared runtime for the desktop process. Boots with the managed profile
// (electron-free, safe at module-eval); logs route into the unified logger.
//
// `vendoredRuntime` is the raw upstream object behind a thin usage-tracking
// wrapper (see `trackBrowserRuntimeUsage`): every consumer in this module —
// the `ExternalChromeBackend` (behind the `BackendRouter`, which is what
// @cindy/mcps via `getBrowserMcpDeps` and host helpers below receive), the
// availability probe and the login helper — calls through the wrapper, so
// `disposeBrowserRuntime` can tell whether the runtime saw ANY traffic this
// session. We never hand the raw object out; swapping the active backend in
// Phase 5 is a single `router.setBackend()` call away.
const vendoredRuntime = trackBrowserRuntimeUsage(
  createBrowserControlRuntime({
    config: buildManagedConfig(),
    logSink: (level, scope, args) => {
      // Bind to `logger`: the unified logger's methods rely on `this`, and calling
      // a detached `logger[level]` reference would lose it (undefined in strict
      // mode) and silently break the browser runtime's log channel.
      const fn = (logger[level] ?? logger.info).bind(logger);
      fn(`[${scope}]`, ...args);
    },
  }),
);

const externalBackend = new ExternalChromeBackend(vendoredRuntime, logger);

type SessionUploadRootResolver = (sessionId: string) => Promise<string[]>;

let resolveSessionUploadRoots: SessionUploadRootResolver = async () => [];

export function setBrowserSessionUploadRootResolver(
  resolver: SessionUploadRootResolver,
): void {
  resolveSessionUploadRoots = resolver;
}

/**
 * RSB-webview backend instance (Phase 3+). Lazily constructed because the
 * TabRegistry singleton must be available — which it is right after this
 * module evaluates, since `getRsbBrowserBridge()` is self-instantiating.
 */
const rsbBackend = new RsbWebviewBackend({
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
    ensureHost: () => ensureHostForBackend(),
    // detached 偏好信号:直连动作解析 miss 时,只有 detached 模式才值得等
    // 子窗口 renderer 重注册 tab;内嵌模式主窗常驻,miss 即真失效,快速失败。
    isDetached: () => isDetachedForBackend(),
    logger,
  },
  logger,
});

/**
 * Initial backend selection — driven by the persisted settings file. On first
 * launch (no override) the system default from `browser-backend-settings-store`
 * is applied; that default is `'external'` (the managed Chrome below). Users
 * who explicitly picked a backend keep their choice — see the DEFAULT HISTORY
 * note in that store for the override semantics behind the two flips.
 */
function backendForKind(kind: BackendKind): BrowserBackend {
  switch (kind) {
    case 'external':
      return externalBackend;
    case 'rsb-webview':
      return rsbBackend;
  }
}

const initialKind = readBrowserBackendSettings().kind;

/**
 * Process-wide router. Phase 5 wires it to the persisted backend kind. All
 * downstream consumers (MCP deps, login helper, availability probe, quit
 * disposer) go through the router so the swap is a single `setBackend` call.
 *
 * The router implements `BrowserControlRuntime` (its `.call` matches the
 * contract verbatim) so @cindy/mcps consumes it as the runtime with no adapter.
 */
const router = new BackendRouter(backendForKind(initialKind), logger);

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
export function setMainWindowAccessorForBackend(
  accessor: () => Electron.WebContents | null,
): void {
  mainWindowAccessor = accessor;
}

/**
 * Ensure-host hook — populated by bootstrap-electron with the RSB window
 * controller's `ensureOpenForAutomation`. Default no-op keeps the embedded
 * (non-detached) behavior: host is the always-alive main window.
 */
let ensureHostForBackendImpl: () => Promise<void> = () => Promise.resolve();

function ensureHostForBackend(): Promise<void> {
  return ensureHostForBackendImpl();
}

/** Bootstrap hook, same pattern as `setMainWindowAccessorForBackend`. */
export function setEnsureHostForBackend(impl: () => Promise<void>): void {
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
 * `BackendRouter.setBackend` contract).
 */
export async function setActiveBrowserBackendKind(kind: BackendKind): Promise<void> {
  if (router.getCurrentBackendKind() === kind) {
    // Same-kind path: skip both the swap AND the settings write. The renderer
    // UI already guards against same-kind clicks; if this path runs it's a
    // programmatic caller and there's no semantic to upgrade. Writing the
    // settings file on every click would churn fs.writeFile without changing
    // anything observable.
    return;
  }
  await router.setBackend(backendForKind(kind));
  writeBrowserBackendKind(kind);
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
    // Router implements `BrowserControlRuntime` — the MCP tool layer never sees
    // the backend split. Swapping the active backend (Phase 5) is invisible from
    // @cindy/mcps' perspective.
    getRuntime: () => router,
    supportsResourceDownloads: () => router.kind === 'rsb-webview',
    supportsSemanticQueries: () => router.kind === 'rsb-webview',
    logger,
  };
}

/**
 * Probe whether a local browser is available (drives the Settings UI's
 * "未检测到本机浏览器 / 下载 Chrome" cell).
 *
 * **Always** goes to the vendored runtime, NOT the router — this probe asks
 * "did the user install Chrome on their machine?", which is purely a property
 * of the EXTERNAL backend. The RSB-webview backend uses Electron's bundled
 * Chromium and is always available; routing through router would make the
 * Settings card lie ("未检测到 Chrome") whenever the user has the internal
 * backend selected, even on a machine with Chrome installed.
 */
export async function getBrowserAvailability(): Promise<BrowserAvailability> {
  const res = await vendoredRuntime.call({ action: 'status' });
  return extractBrowserAvailability(res.data);
}

/**
 * Read the currently-active backend kind. Reflects the Settings-driven toggle
 * (persisted override) merged over the system default, not a fixed value.
 */
export function getActiveBrowserBackendKind(): BackendKind {
  return router.getCurrentBackendKind();
}

/**
 * Register Phase 5 IPC handlers for the Settings UI:
 *   - `browser-backend:get-state` → current kind + override state
 *   - `browser-backend:set-kind`  → swap active backend + persist
 *   - `browser-backend:reset`     → clear user override, follow current default
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

  ipcMain.handle('browser-backend:get-state', () => {
    const state = readBrowserBackendSettingsState();
    return {
      active: router.getCurrentBackendKind(),
      systemDefault: state.defaults.kind,
      isOverride: state.isCustomized,
    };
  });

  ipcMain.handle('browser-backend:set-kind', async (_e, payload: unknown) => {
    const obj = requireObject(payload, 'set-kind payload');
    // requireEnum throws throwIpcError('INVALID_PARAMS') for unknown kinds —
    // rule 13: handlers must use throwIpcError, never bare `throw new Error`.
    const kind = requireEnum(obj.kind, ['external', 'rsb-webview'] as const, 'kind');
    await setActiveBrowserBackendKind(kind);
    return { ok: true, active: router.getCurrentBackendKind() };
  });

  ipcMain.handle('browser-backend:reset', async () => {
    const next = resetBrowserBackendSettings();
    await setActiveBrowserBackendKind(next.kind);
    return { ok: true, active: router.getCurrentBackendKind() };
  });

  ipcMain.handle('rsb-browser-bridge:set-active-session', (_e, payload: unknown) => {
    const obj = requireObject(payload, 'set-active-session payload');
    // optionalNullableString accepts `null` explicitly + non-empty string +
    // undefined/empty as "no value". Anything else (e.g. {sessionId: 42})
    // collapses to null, which is the only reasonable fallback — we're not
    // surfacing the rare malformed-payload path as a hard error since the
    // semantic is "renderer no longer focused on any RSB session".
    const raw = optionalNullableString(obj.sessionId);
    const sessionId: string | null = raw === null ? null : raw ?? null;
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
  // **Always** goes to the vendored runtime, NOT the router — "打开 Agent 专用浏
  // 览器" is the external Chrome workflow: user clicks it to log into sites in
  // the dedicated `Cindy` profile. If the user picked the rsb-webview backend
  // they don't need this button at all (logins go through the sidebar webview);
  // routing through router would either no-op (rsb backend's `start` is a
  // no-op) or open the wrong thing.
  const started = await vendoredRuntime.call({ action: 'start' });
  if (!started.ok) {
    throw new Error(started.message ?? `browser start failed (HTTP ${started.status ?? '?'})`);
  }
  // Best-effort raise: if the browser was already open, `start` is a no-op and its
  // window stays behind ours — focus an existing tab to bring the OS window to front
  // (no-op-safe on a fresh launch, which is already frontmost). Never opens a tab.
  const tabsRes = await vendoredRuntime.call({ action: 'tabs' });
  const tabs = (tabsRes.data as { tabs?: Array<{ targetId?: string; suggestedTargetId?: string }> } | undefined)
    ?.tabs;
  const first = Array.isArray(tabs) ? tabs[0] : undefined;
  const targetId = first?.suggestedTargetId ?? first?.targetId;
  if (tabsRes.ok && targetId) {
    await vendoredRuntime.call({ action: 'focus', targetId });
  }
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
  // Always stop the vendored Chrome directly, NOT through the router. The
  // router may currently point at RsbWebviewBackend (whose `dispose` is a
  // no-op by design — webview lifecycle is owned by the RSB UI). If we only
  // dispose-via-router, a user who ever switched to external Chrome and back
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
