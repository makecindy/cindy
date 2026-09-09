import net from 'node:net';
import path from 'node:path';

import {
  MANAGED_CDP_PORT,
  MANAGED_PROFILE,
  REAL_MANAGED_PROFILE,
} from '../browser-managed-config.js';

import type {
  BrowserControlRequest,
  BrowserControlResult,
  BrowserControlRuntime,
} from '@cindy/browser-control-runtime';

import {
  FOREIGN_AGENT_BROWSER_ERROR,
  isBrowserOpenForLoginErrorCode,
} from '../../../shared/browserBackend.js';

import { resolveSourceBrowserFromOs } from './source.js';
import { assertManagedBrowserStopped } from './runtime-stop.js';
import {
  cleanupRealProfileSnapshots,
  readCopiedLoginsCdpPort,
  realProfileDestDir,
  rememberCopiedLoginsCdpPort,
  snapshotRealProfile,
} from './snapshot.js';
import {
  isRealProfileError,
  RealProfileError,
  type ChromiumKind,
  type InstalledChromium,
  type RealProfileStatusHint,
  type SnapshotResult,
} from './types.js';

export interface RealProfileLaunchDeps {
  isEnabled: () => boolean;
  getRuntimeDir: () => string;
  applyConfig: (opts: {
    useRealProfile: boolean;
    executablePath?: string;
    cdpPort?: number;
  }) => void;
  resolveSource?: () => InstalledChromium;
  snapshot?: typeof snapshotRealProfile;
  cleanup?: typeof cleanupRealProfileSnapshots;
  platform?: NodeJS.Platform;
  /** Return a free CDP port at or after `preferred`. Injected in tests. */
  pickCdpPort?: (preferred: number) => Promise<number>;
  /** Cindy-real CDP port from the existing complete marker. Injected in tests. */
  readRememberedCdpPort?: (runtimeDir: string) => number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isRunning(data: unknown): boolean {
  return asRecord(data).running === true;
}

function isHeadless(data: unknown): boolean {
  return asRecord(data).headless === true;
}

/** True when status.userDataDir lives under this Cindy's browser-runtime tree. */
export function isOurManagedBrowser(data: unknown, runtimeDir: string): boolean {
  if (!runtimeDir) return false;
  const userDataDir = asRecord(data).userDataDir;
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) return false;
  const root = path.resolve(runtimeDir);
  const dir = path.resolve(userDataDir);
  return dir === root || dir.startsWith(root + path.sep);
}

/**
 * True only when this Cindy process itself launched the Chrome that status sees.
 * `running` alone is not enough: the vendored status probes the configured CDP
 * port, so another instance's Chrome on 18800 looks "running". Until we spawn,
 * `userDataDir`/`pid` are also missing (config does not set userDataDir), so
 * occupancy must require a live pid plus our user-data-dir.
 */
export function isOwnLiveManagedBrowser(data: unknown, runtimeDir: string): boolean {
  const pid = asRecord(data).pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  return isOurManagedBrowser(data, runtimeDir);
}

export function activeManagedProfileName(useRealProfile: boolean): string {
  return useRealProfile ? REAL_MANAGED_PROFILE : MANAGED_PROFILE;
}

/**
 * The vendored control service captures `defaultProfile` before hot-reloading
 * config. After we swap Cindy → Cindy-real, a start without `profile` looks up
 * the stale name and throws BrowserProfileNotFoundError. Pin the active name
 * on every call except when the caller already chose one.
 */
export function withActiveBrowserProfile(
  request: BrowserControlRequest,
  useRealProfile: boolean,
): BrowserControlRequest {
  if (request.profile) return request;
  return { ...request, profile: activeManagedProfileName(useRealProfile) };
}

export { FOREIGN_AGENT_BROWSER_ERROR };

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function pickManagedCdpPort(
  preferred = MANAGED_CDP_PORT,
  isFree: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  for (let port = preferred; port < preferred + 20; port += 1) {
    if (await isFree(port)) return port;
  }
  throw new RealProfileError(
    'COPY_FAILED',
    `No free agent-browser CDP port in ${preferred}-${preferred + 19}.`,
  );
}

export function annotateStatusData(
  data: unknown,
  hint: RealProfileStatusHint,
): Record<string, unknown> {
  const next = { ...asRecord(data) };
  delete next.realProfilePath;
  next.realProfile = {
    enabled: hint.enabled,
    applied: hint.applied,
    source: hint.source,
  };
  return next;
}

export function wrapRuntimeWithRealProfile(
  inner: Pick<BrowserControlRuntime, 'call'>,
  deps: RealProfileLaunchDeps,
): Pick<BrowserControlRuntime, 'call'> {
  let lastApplied: ChromiumKind | null = null;

  const resolveSource = deps.resolveSource ?? resolveSourceBrowserFromOs;
  const snapshot = deps.snapshot ?? snapshotRealProfile;
  const cleanup = deps.cleanup ?? cleanupRealProfileSnapshots;
  const platform = deps.platform ?? process.platform;

  const hint = (): RealProfileStatusHint => ({
    enabled: deps.isEnabled(),
    applied: deps.isEnabled() && lastApplied !== null,
    source: deps.isEnabled() ? lastApplied : null,
  });

  return {
    async call(request: BrowserControlRequest): Promise<BrowserControlResult> {
      // Vendored open/tabs/snapshot/… call ensureBrowserAvailable() without
      // /start. Consent-on sessions must snapshot before those implicit
      // launches, or the next explicit start short-circuits on our live pid.
      if (shouldPrepareCopiedLogins(request.action, deps.isEnabled())) {
        return startWithSnapshot(inner, request, {
          ...deps,
          resolveSource,
          snapshot,
          cleanup,
          platform,
          getLastApplied: () => lastApplied,
          setLastApplied: (kind) => {
            lastApplied = kind;
          },
        });
      }

      const result = await inner.call(withActiveBrowserProfile(request, deps.isEnabled()));
      if (request.action === 'status' && result.ok) {
        return {
          ...result,
          data: annotateStatusData(result.data, hint()),
        };
      }
      return result;
    },
  };
}

export function shouldPrepareCopiedLogins(
  action: BrowserControlRequest['action'],
  enabled: boolean,
): boolean {
  if (action === 'status' || action === 'stop') return false;
  return action === 'start' || enabled;
}

/**
 * Crash restart can see `running: true` on the remembered Cindy-real port
 * without pid/userDataDir (vendored status only fills those from in-process
 * state). Occupancy of 18800 without a marker is some other instance — relocate
 * rather than stop. A marker means this runtime already launched Cindy-real on
 * that port, so stop the leftover before copying onto the same user-data.
 */
export function shouldStopRememberedLeftover(input: {
  enabled: boolean;
  running: boolean;
  ownLive: boolean;
  rememberedCdpPort: number | null;
}): boolean {
  return (
    input.enabled && input.running && !input.ownLive && typeof input.rememberedCdpPort === 'number'
  );
}

async function startWithSnapshot(
  inner: Pick<BrowserControlRuntime, 'call'>,
  request: BrowserControlRequest,
  deps: RealProfileLaunchDeps & {
    resolveSource: () => InstalledChromium;
    snapshot: typeof snapshotRealProfile;
    cleanup: typeof cleanupRealProfileSnapshots;
    platform: NodeJS.Platform;
    getLastApplied: () => ChromiumKind | null;
    setLastApplied: (kind: ChromiumKind | null) => void;
  },
): Promise<BrowserControlResult> {
  const enabled = deps.isEnabled();
  const managedProfile = activeManagedProfileName(enabled);
  const status = await inner.call({ action: 'status', profile: managedProfile });
  const runtimeDir = deps.getRuntimeDir();
  const revertToIsolated = () => {
    if (runtimeDir) deps.cleanup(runtimeDir);
    deps.applyConfig({ useRealProfile: false, cdpPort: MANAGED_CDP_PORT });
    deps.setLastApplied(null);
    return inner.call(withActiveBrowserProfile(request, false));
  };
  if (isOwnLiveManagedBrowser(status.data, runtimeDir)) {
    return inner.call(withActiveBrowserProfile(request, enabled));
  }

  if (!enabled) {
    return revertToIsolated();
  }

  const readRemembered = deps.readRememberedCdpPort ?? readCopiedLoginsCdpPort;
  if (
    shouldStopRememberedLeftover({
      enabled: true,
      running: isRunning(status.data),
      ownLive: false,
      rememberedCdpPort: readRemembered(runtimeDir),
    })
  ) {
    const stop = await inner.call({ action: 'stop', profile: managedProfile });
    try {
      assertManagedBrowserStopped({ status, stop });
    } catch (err) {
      if (isRealProfileError(err)) return failure(request.action, err.code, err.message);
      return failure(request.action, FOREIGN_AGENT_BROWSER_ERROR, FOREIGN_AGENT_BROWSER_ERROR);
    }
  }

  let cdpPort = MANAGED_CDP_PORT;
  try {
    const pick = deps.pickCdpPort ?? ((preferred: number) => pickManagedCdpPort(preferred));
    cdpPort = await pick(MANAGED_CDP_PORT);
  } catch (err) {
    if (isRealProfileError(err)) return failure(request.action, err.code, err.message);
    return failure(request.action, FOREIGN_AGENT_BROWSER_ERROR, FOREIGN_AGENT_BROWSER_ERROR);
  }

  if (isHeadless(status.data)) {
    return failure(
      request.action,
      'HEADLESS_FORBIDDEN',
      'Real-profile browsing cannot run in headless mode (it would use a separate cookie store).',
    );
  }

  if (!runtimeDir) {
    return failure(request.action, 'COPY_FAILED', 'Browser runtime directory is not configured.');
  }

  try {
    const source = deps.resolveSource();
    const result: SnapshotResult = await deps.snapshot({
      source,
      destDir: realProfileDestDir(runtimeDir),
      platform: deps.platform,
    });
    if (!deps.isEnabled()) {
      return revertToIsolated();
    }
    deps.applyConfig({
      useRealProfile: true,
      executablePath: source.executablePath,
      cdpPort,
    });
    deps.setLastApplied(result.sourceKind);
    rememberCopiedLoginsCdpPort(runtimeDir, cdpPort);
  } catch (err) {
    deps.setLastApplied(null);
    if (isRealProfileError(err)) {
      return failure(request.action, err.code, err.message);
    }
    return failure(
      request.action,
      'COPY_FAILED',
      err instanceof Error ? err.message : 'Failed to copy browser logins.',
    );
  }

  if (!deps.isEnabled()) {
    return revertToIsolated();
  }
  return inner.call(withActiveBrowserProfile(request, true));
}

function failure(
  action: BrowserControlRequest['action'],
  code: string,
  message: string,
): BrowserControlResult {
  return {
    ok: false,
    action,
    errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
    ...(isBrowserOpenForLoginErrorCode(code) ? { data: { reason: code } } : {}),
    message,
  };
}

export function realProfileErrorFromCode(code: string, message: string): RealProfileError {
  if (
    code === 'NO_CHROMIUM' ||
    code === 'PROFILE_LOCKED' ||
    code === 'NO_AUTH_DB' ||
    code === 'HEADLESS_FORBIDDEN' ||
    code === 'COPY_FAILED' ||
    code === 'STOP_FAILED' ||
    code === 'REAL_PROFILE_READ_DENIED' ||
    code === 'APP_BOUND_ENCRYPTION_UNSUPPORTED'
  ) {
    return new RealProfileError(code, message);
  }
  return new RealProfileError('COPY_FAILED', message);
}
