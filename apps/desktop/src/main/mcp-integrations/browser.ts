
import fs from 'node:fs';
import nodePath from 'node:path';
import {
  createBrowserControlRuntime,
  browserUploadDirectory,
  setBrowserControlRuntimeConfig,
  type BrowserProxyRoute,
  type BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import type { BrowserMcpDeps } from '@cindy/mcps';

import { createLogger } from '../logger.js';
import { createRecipeFileBroker } from './browser-backend/rsb-webview-upload-policy.js';
import {
  userBrowserCapabilities,
  UserBrowserBackend,
  type UserBrowserPageControl,
  type UserBrowserBackendOptions,
} from './browser-backend/user-browser-backend.js';
import { artifactSessionRoot } from './browser-backend/rsb-webview-artifacts.js';
import { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
import { browserExperienceStore } from '../browser-recipes/experience.js';
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
  RealProfileError,
  createBrowserProfileLifecycleQueue,
  managedConfigPatchBeforeStop,
  FOREIGN_AGENT_BROWSER_ERROR,
  isRealProfileError,
  probeOsSourceProfileReadAccess,
  readCopiedLoginsCdpPort,
  resolveSourceBrowserFromOs,
  wrapRuntimeWithRealProfile,
  wrapRuntimeWithProfileLifecycleQueue,
  activeManagedProfileName,
} from './browser-real-profile/index.js';
import { createBrowserBackendIpcHandlers } from './browser-backend/settings-ipc.js';
import { readCdpBrowserCommandLine, terminateManagedChromePortOwner } from './browser-backend/proxy-auth.js';
import { openExtensionStoreInUserBrowser, startUserBrowser } from './browser-backend/open-extension-store.js';
import { ExternalLinkHandoff } from './browser-backend/external-link-handoff.js';
import { resolveBrowserScreenshot } from './browserScreenshotResolver.js';
import { compressInlineImage } from './inlineImageCompressor.js';
import { raiseAgentBrowserWindow } from './raise-agent-browser-window.js';
import { hasSecretPages, isSecretPage } from '../input-handoff/secretTaint.js';
import {
  BrowserOpenForLoginError,
  browserOpenForLoginErrorCodeFromData,
} from '../../shared/browserBackend.js';

export { extractBrowserAvailability, type BrowserAvailability } from './browser-availability.js';
import { BrowserBackendController, resolveBackendProfile } from './browser-backend/controller.js';
import { BrowserBackendHealthService } from './browser-backend/health-service.js';
import { ExternalChromeBackend } from './browser-backend/external-chrome-backend.js';
import type { BackendKind, BrowserBackend } from './browser-backend/types.js';
import type { createBrowserBackendSettingsStore } from '../browser-backend-settings-store.js';
import type { createUserRecipeLoader, UserRecipesResult } from '../browser-recipes/loader.js';
import type { createUserRecipeWriter, WriteUserRecipeResult } from '../browser-recipes/writer.js';

export interface BrowserRuntimePorts {
  tempDir(): string;
  /** Assembly-owned launch defaults; isolated hosts must not claim Desktop's port. */
  managedLaunch?: Pick<ManagedBrowserConfigOptions, 'cdpPort' | 'executablePath' | 'headless' | 'useMockKeychain'>;
  settings: ReturnType<typeof createBrowserBackendSettingsStore>;
  recipes: ReturnType<typeof createUserRecipeLoader> & ReturnType<typeof createUserRecipeWriter>;
  secretIo: { readStrict(key: string): string | null; write(key: string, value: string): boolean };
  createEmbeddedBackend(resolveUploadRoots: (sessionId: string) => Promise<string[]>): BrowserBackend;
}
/** Own browser state in the execution host, never in a disposable UI attachment. */
export function createBrowserRuntime(ports: BrowserRuntimePorts) {
const app = { getPath: (_: 'temp') => ports.tempDir() };
const genericOAuthSecretIo = ports.secretIo;
const { readBrowserBackendSettings, readBrowserBackendSettingsState, writeBrowserBackendKind, writeBrowserUseRealProfile, resetBrowserBackendSettings } = ports.settings;
const { loadUserBrowserRecipes, userRecipesDir, writeUserRecipe } = ports.recipes;
const managedLaunch = ports.managedLaunch ?? {};
const managedPort = managedLaunch.cdpPort ?? MANAGED_CDP_PORT;
const createRsbBackend = () => ports.createEmbeddedBackend(id => resolveSessionUploadRoots(id));


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
  cdpPort: managedPort,
};

function rememberManagedIdentity(opts: ManagedBrowserConfigOptions): void {
  if (typeof opts.useRealProfile === 'boolean') {
    lastManagedIdentity.useRealProfile = opts.useRealProfile;
    if (!opts.useRealProfile && opts.cdpPort === undefined) {
      lastManagedIdentity.cdpPort = managedPort;
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
  const merged = { ...managedLaunch, ...lastProxyLaunch, ...opts };
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
    isolatedCdpPort: managedPort,
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
    ...managedLaunch,
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
  cdpPort: rememberedCopiedLoginsCdpPort ?? managedPort,
};

const directBrowserRuntime = createBrowserControlRuntime({
  config: buildManagedConfig({
    ...managedLaunch,
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
    // The failed-stop teardown may only run for a request that targeted this
    // browser: the MCP stop tool threads a resolved profile name, and a stale
    // one 404s before dispatch — that error must never kill the active browser.
    managedProfileName: () => activeManagedProfileName(readBrowserBackendSettings().useRealProfile),
    // The vendored stop can only signal a process it launched. On Windows the
    // spawned browser is a short-lived launcher, so once it exits the runtime
    // has no PID left while the real browser keeps the CDP port — every later
    // stop then fails to verify and every later launch is refused. Terminating
    // the port owner at the OS level (after re-proving profile and port) is the
    // only way to reclaim it.
    terminateManagedPortOwner: async ({ cdpHttpUrl, cdpPort, userDataDir }) =>
      await terminateManagedChromePortOwner({
        cdpHttpUrl,
        cdpPort,
        userDataDir,
        logger,
      }),
    ...(process.platform === 'darwin'
      ? {
          createLinkHandoff: (isAgentOpeningTab: () => boolean) => new ExternalLinkHandoff({
            cdpHttpUrl: () => currentGuardIdentity().cdpHttpUrl,
            managedUserDataDir: () => currentGuardIdentity().managedUserDataDir,
            isAgentOpeningTab,
            logger,
          }),
        }
      : {}),
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

function setBrowserSessionUploadRootResolver(resolver: SessionUploadRootResolver): void {
  resolveSessionUploadRoots = resolver;
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
/**
 * Page-control provider for the user's own browser: the browserExtension plugin
 * slot owns the bridge; bootstrap wires the accessor so this module never
 * imports cindy-brain. Default = no page-control plugin installed.
 */
let userBrowserPageControlProvider: () => UserBrowserPageControl | null = () => null;

let userBrowserUnavailableReason: UserBrowserBackendOptions['getUnavailableReason'];
function setUserBrowserPageControlProvider(
  provider: () => UserBrowserPageControl | null,
  unavailableReason?: UserBrowserBackendOptions['getUnavailableReason'],
): void {
  userBrowserPageControlProvider = provider;
  userBrowserUnavailableReason = unavailableReason;
}

let currentUserBrowserBackend: UserBrowserBackend | null = null;
/** A task's turn ended: clear the activity marks it left in the user's browser. */
function clearUserBrowserMarksForSession(sessionId: string): void {
  if (backendController.kind !== 'user-browser') return;
  void currentUserBrowserBackend?.clearSessionMarks(sessionId).catch(() => undefined);
}

function createUserBrowserBackend(): UserBrowserBackend {
  return (currentUserBrowserBackend = new UserBrowserBackend({
    getPageControl: () => userBrowserPageControlProvider(),
    startBrowser: () => startUserBrowser({ resolveBrowser: () => resolveSourceBrowserFromOs() }),
    getUnavailableReason: () => userBrowserUnavailableReason?.() ?? 'plugin-missing',
    // Same upload roots as the sidebar browser: the session's own folders plus its artifacts.
    resolveUploadRoots: async (sessionId) => [
      artifactSessionRoot(nodePath.join(app.getPath('temp'), 'cindy-browser-artifacts'), sessionId),
      ...(await resolveSessionUploadRoots(sessionId)),
    ],
    logger,
  }));
}

const backendController = new BrowserBackendController({
  initialKind,
  externalBackend,
  createRsbBackend,
  createUserBrowserBackend,
  persistKind: writeBrowserBackendKind,
  logger,
});
const browserBackendHealthService = new BrowserBackendHealthService(backendController, logger);

/**
 * Switch the active backend. Shared by Settings and browser MCP mode changes.
 * Persists the new kind to disk and disposes the outgoing backend (per
 * lifecycle controller contract).
 */
async function setActiveBrowserBackendKind(kind: BackendKind): Promise<void> {
  // The controller performs the same-kind check inside its serialized queue.
  // Doing it here would race two Settings actions: a request for the current
  // kind could return early while an earlier queued request is about to switch
  // away from it.
  await backendController.setKind(kind);
}

/**
 * Whether the Chrome on the managed CDP port was started with a profile outside this Cindy's
 * browser runtime, i.e. another Cindy (another edition or a dev build) shares the port. Only
 * used to explain a failed stop; it never decides whether a browser may be closed.
 */
async function managedPortHeldByAnotherCindy(): Promise<boolean> {
  const runtimeDir = realProfileRuntimeDir();
  if (!runtimeDir) return false;
  const commandLine = await readCdpBrowserCommandLine(currentGuardIdentity().cdpHttpUrl).catch(
    () => null,
  );
  return commandLine !== null && !commandLine.includes(`--user-data-dir=${runtimeDir}${nodePath.sep}`);
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
  // Do NOT gate the stop on the vendored `running` flag. That flag is CDP
  // readiness, and an inherited Cindy-real Chrome (Cindy restarted while it
  // stayed up) reports `running: false` with a null pid, because vendored
  // status fills pid only from in-process state. Skipping the stop there lets
  // the caller delete the copied-logins directory under a live browser: on
  // POSIX the unlink succeeds while Chrome keeps writing cookies and passwords
  // into the now-unlinked files. The backend's stop is idempotent and proves
  // absence itself, so always issue it and require it to succeed.
  const stop = await externalChromeBackend.call({ action: 'stop' });
  try {
    assertManagedBrowserStopped({ status, stop });
  } catch (err) {
    if (isRealProfileError(err) && err.code === 'STOP_FAILED' && (await managedPortHeldByAnotherCindy())) {
      throw new RealProfileError(
        'FOREIGN_AGENT_BROWSER',
        'Another Cindy is using the agent browser port, so copied logins cannot be changed now.',
      );
    }
    throw err;
  }
  if (!stop.ok) {
    throw new RealProfileError(
      'STOP_FAILED',
      'Could not stop the agent browser before changing copied logins.',
    );
  }
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

function setBrowserUseRealProfile(enabled: boolean): Promise<boolean> {
  return backendController.runLifecycle(() =>
    browserProfileLifecycleQueue.run(() => applyBrowserUseRealProfile(enabled)),
  );
}

/**
 * Browser automation deps for cindy_browser MCP.
 *
 * The concrete runtime is intentionally hidden behind the neutral
 * BrowserControlRuntime contract so the desktop host does not depend on an
 * upstream product API or product-facing name.
 */
function browserRecipeSecretId(key: string): string {
  if (!['spotify', 'xiaoyuzhou'].includes(key)) throw new Error('Unknown browser recipe credential');
  return `browser-recipe-${key}`;
}

function getBrowserMcpDeps(): {
  experienceStore: NonNullable<BrowserMcpDeps['experienceStore']>;
  getRuntime(): BrowserControlRuntime;
  resolveProfile: NonNullable<BrowserMcpDeps['resolveProfile']>;
  getBackendScope: NonNullable<BrowserMcpDeps['getBackendScope']>;
  getBackendKind: NonNullable<BrowserMcpDeps['getBackendKind']>;
  resolveScreenshot: NonNullable<BrowserMcpDeps['resolveScreenshot']>;
  compressInlineImage: NonNullable<BrowserMcpDeps['compressInlineImage']>;
  setBackend(kind: BackendKind): Promise<BackendKind>;
  supportsResourceDownloads(): boolean;
  supportsSemanticQueries(): boolean;
  backendCapabilities: NonNullable<BrowserMcpDeps['backendCapabilities']>;
  logger: typeof logger;
  getUserRecipes(): Promise<UserRecipesResult>;
  saveUserRecipe(input: Parameters<typeof writeUserRecipe>[0]): Promise<WriteUserRecipeResult>;
  recipeSecrets: { read(key: string): string | null; write(key: string, value: string): boolean };
  recipeFiles: NonNullable<BrowserMcpDeps['recipeFiles']>;
  pageReadsRestricted(target: { profile?: string; targetId?: string }): Promise<boolean>;
} {
  return {
    experienceStore: browserExperienceStore(userRecipesDir()),
    recipeFiles: async (sessionId) => {
      const sessionRoots = sessionId ? await resolveSessionUploadRoots(sessionId) : [];
      const roots = sessionId ? [
        artifactSessionRoot(nodePath.join(app.getPath('temp'), 'cindy-browser-artifacts'), sessionId),
        ...sessionRoots,
      ] : [];
      // Both backends keep invocation copies under their existing upload root.
      // A checked path grants metadata inspection, never subsequent writes.
      return createRecipeFileBroker(roots, sessionRoots, sessionId ? (backendController.kind === 'external'
        ? artifactSessionRoot(browserUploadDirectory, sessionId) : roots[0]) : undefined);
    },
    recipeSecrets: {
      read: (key) => genericOAuthSecretIo.readStrict(browserRecipeSecretId(key)),
      write: (key, value) => genericOAuthSecretIo.write(browserRecipeSecretId(key), value),
    },
    setBackend: async (kind) => {
      await setActiveBrowserBackendKind(kind);
      return backendController.getCurrentBackendKind();
    },
    // L2 user-recipe layer (userData/browser-recipes); merged over the bundled
    // L1 catalog inside the MCP. Empty/missing dir → bundled-only (== before).
    getUserRecipes: () => loadUserBrowserRecipes(),
    // Self-grow: persist an agent/user-authored recipe into L2 (validated by the MCP).
    saveUserRecipe: (input) => writeUserRecipe(input),
    // Controller implements `BrowserControlRuntime` — the MCP tool layer never sees
    // the backend split. Swapping the active backend (Phase 5) is invisible from
    // @cindy/mcps' perspective.
    getRuntime: () => backendController,
    resolveProfile: (profile) => resolveBackendProfile(backendController.kind, profile, () =>
      activeManagedProfileName(readBrowserBackendSettings().useRealProfile)),
    getBackendScope: () => backendController.getBackendScope(),
    getBackendKind: () => backendController.getCurrentBackendKind(),
    resolveScreenshot: (result) =>
      resolveBrowserScreenshot(result, {
        runtimeDir: process.env.XDT_BROWSER_RUNTIME_DIR,
      }),
    compressInlineImage,
    supportsResourceDownloads: () => backendController.kind === 'rsb-webview',
    supportsSemanticQueries: () => backendController.kind === 'rsb-webview',
    // The user's browser matches the dedicated one from extension 0.4.42 on, except what needs the
    // debugger (PDF, trusted input). Older extensions only read and do basic input; the MCP layer
    // refuses the rest before dispatch instead of letting a page job fail opaquely.
    backendCapabilities: () =>
      backendController.kind === 'user-browser' ? userBrowserCapabilities(userBrowserPageControlProvider()) : {},
    // 代输入: pause page-state reads on a tab still showing a page where the owner typed a secret.
    pageReadsRestricted: async ({ profile, targetId }) => {
      if (!hasSecretPages()) return false;
      const listed = await backendController.call({ action: 'tabs', ...(profile ? { profile } : {}) });
      if (!listed.ok) return true;
      const tabs = (listed.data as { tabs?: Array<Record<string, unknown>> } | undefined)?.tabs ?? [];
      // The backend also accepts a tab's short alias, label or an unambiguous id prefix, so match those too.
      const named = targetId
        ? tabs.filter(
            (tab) =>
              tab.targetId === targetId ||
              tab.tabId === targetId ||
              tab.suggestedTargetId === targetId ||
              tab.label === targetId ||
              (typeof tab.targetId === 'string' && tab.targetId.startsWith(targetId)),
          )
        : [];
      // A target the (possibly truncated) tab list does not show may still be the page the owner typed
      // into: while any secret page is remembered, fail closed. Without a target the runtime acts on its
      // last tab, so every listed tab is checked.
      if (targetId && named.length === 0) return true;
      return (targetId ? named : tabs).some((tab) => typeof tab.url === 'string' && isSecretPage(tab.url));
    },
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
async function getBrowserAvailability(): Promise<BrowserAvailability> {
  const res = await externalBackend.call({ action: 'status' });
  return extractBrowserAvailability(res.data);
}

/**
 * Read the currently-active backend kind. Reflects the Settings-driven toggle
 * (persisted override) merged over the system default, not a fixed value.
 */
function getActiveBrowserBackendKind(): BackendKind {
  return backendController.getCurrentBackendKind();
}

/**
 * Rebuild the active embedded control backend and verify the replacement before
 * reporting success. The controller swaps first, so every existing MCP runtime
 * reference immediately delegates to the fresh instance; no Agent-side cache
 * needs to be invalidated separately.
 */
function recoverActiveBrowserBackend() {
  return browserBackendHealthService.recover();
}

/** Probe once, then automatically replace a failed embedded backend. */
function getBrowserBackendHealth() {
  return browserBackendHealthService.getHealth();
}

function createBrowserSettingsHandlers<Event>(assertTrusted: (event: Event) => void) {

  return createBrowserBackendIpcHandlers<Event>({
    assertTrusted,
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
      // Keep controller -> profile queue ordering, matching external disposal.
      await backendController.setKind(
        readBrowserBackendSettingsState().defaults.kind,
        () => browserProfileLifecycleQueue.run(async () => {
          if (readBrowserBackendSettings().useRealProfile) {
            await applyBrowserUseRealProfile(false);
          }
          resetBrowserBackendSettings();
        }),
      );
      return backendController.getCurrentBackendKind();
    },
    getHealth: getBrowserBackendHealth,
    recover: recoverActiveBrowserBackend,
    probeSourceRead: () => probeOsSourceProfileReadAccess(),
    openExtensionStore: () =>
      openExtensionStoreInUserBrowser({ resolveBrowser: () => resolveSourceBrowserFromOs() }),
  });
}


/**
 * Launch the (headed) automation browser so the user can log into the sites they
 * want the agent to operate. Drives the Settings →「自动操作」"打开 Agent 专用浏览器"
 * action. Logins persist in the managed profile's user-data-dir.
 */
async function openBrowserForLogin(): Promise<void> {
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
function disposeBrowserRuntime(): Promise<void> {
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
  return backendController.dispose().finally(() => externalBackend.dispose());
}
return { setBrowserSessionUploadRootResolver, setUserBrowserPageControlProvider, clearUserBrowserMarksForSession, setActiveBrowserBackendKind, setBrowserUseRealProfile, getBrowserMcpDeps, getBrowserAvailability, getActiveBrowserBackendKind, recoverActiveBrowserBackend, getBrowserBackendHealth, createBrowserSettingsHandlers, openBrowserForLogin, disposeBrowserRuntime };
}
