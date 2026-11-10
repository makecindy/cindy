/**
 * macOS controller: open another Mac in the system Screen Sharing app instead of
 * Cindy's viewer when the owner turned it on and the Mac is directly reachable.
 *
 * Cindy hands Screen Sharing an address and display options with the login name;
 * the password prompt and "remember in keychain" belong to
 * Screen Sharing, so no password passes through Cindy or a URL. Anything that
 * stops a direct connection falls back to Cindy's own viewer.
 */
import type { RemoteDesktopCapabilities } from '@cindy/device-link';
import { shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState';
import { createLogger } from '../logger';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file';
import {
  probeTcp,
  SCREEN_SHARING_PORT,
  supportsHighPerformance,
} from '../remote-desktop/systemScreenSharing';
import {
  isPrivateScreenSharingAddress,
  verifySystemScreenSharingHost,
} from '../remote-desktop/systemScreenSharingProbe';
import {
  DEFAULT_SYSTEM_SCREEN_SHARING,
  type SystemScreenSharingMode,
  type SystemScreenSharingSettings,
} from '../../shared/remoteDesktopViewer';

const log = createLogger('remote-viewer:system-sharing');
const PROBE_MS = 1200;
const BONJOUR_HOST = /^[A-Za-z0-9-]{1,63}\.local$/;
const LOGIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

const store = createOverrideSettingsFile<SystemScreenSharingSettings>({
  filePath: () => ownerScopedUserDataPath('remote-desktop-system-sharing.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: DEFAULT_SYSTEM_SCREEN_SHARING,
  normalize: (raw) => {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      enabled: value.enabled === true,
      mode: value.mode === 'standard' ? 'standard' : DEFAULT_SYSTEM_SCREEN_SHARING.mode,
    };
  },
  maxBytes: 4 * 1024,
  log,
  label: 'system screen sharing',
});

export function readSystemScreenSharingSettings(): SystemScreenSharingSettings {
  store.invalidateIfChanged();
  return store.read();
}

export async function writeSystemScreenSharingSettings(
  patch: Partial<SystemScreenSharingSettings>,
): Promise<SystemScreenSharingSettings> {
  await store.writePatchAtomic(patch);
  return readSystemScreenSharingSettings();
}

export type SystemScreenSharingPlan =
  | {
      ok: true;
      hosts: string[];
      verificationHosts?: string[];
      user: string | null;
      highPerformance: boolean;
    }
  | { ok: false; reason: 'not-mac' | 'not-reported' | 'not-listening' | 'no-address' };

/**
 * Older peers use Bonjour only. New peers' reported private IPs require a fresh
 * proof from the selected Cindy peer before handing an address to Screen Sharing.
 */
export function planSystemScreenSharing(
  caps: RemoteDesktopCapabilities | null | undefined,
  localHighPerformance: boolean,
): SystemScreenSharingPlan {
  if (caps?.platform !== 'darwin') return { ok: false, reason: 'not-mac' };
  const info = caps.systemScreenSharing;
  if (!info || !Array.isArray(info.hosts)) return { ok: false, reason: 'not-reported' };
  if (info.listening !== true) return { ok: false, reason: 'not-listening' };
  const hosts = info.hosts
    .filter((host): host is string => typeof host === 'string')
    .filter((host) => BONJOUR_HOST.test(host))
    .slice(0, 8);
  const verificationHosts =
    info.addressVerification === 1
      ? [
          ...new Set(
            info.hosts.filter(
              (host): host is string =>
                typeof host === 'string' && isPrivateScreenSharingAddress(host),
            ),
          ),
        ].slice(0, 8)
      : [];
  if (!hosts.length && !verificationHosts.length) return { ok: false, reason: 'no-address' };
  return {
    ok: true,
    hosts,
    ...(verificationHosts.length ? { verificationHosts } : {}),
    user: typeof info.user === 'string' && LOGIN_NAME.test(info.user) ? info.user : null,
    highPerformance: info.highPerformance === true && localHighPerformance,
  };
}

/**
 * Apple applies URL options after restoring saved connection state. `scaled=dynamic`
 * therefore survives that restore, unlike a .plist's initial dynamicResolution flag.
 * Verified with SSAddress.options + SSConnectionOptions.applyURLOptions on macOS 27.2:
 * scalingMode 1 -> 2 and screenQualityMode 5. Not a documented public URL contract.
 */
export function systemScreenSharingUrl(
  host: string,
  user: string | null,
  mode: SystemScreenSharingMode,
): string {
  const login = user ? `${encodeURIComponent(user)}@` : '';
  const query =
    mode === 'high'
      ? 'quality=high&numVirtualDisplays=1&scaled=dynamic'
      : 'quality=adaptive&numVirtualDisplays=0';
  return `vnc://${login}${host}?${query}`;
}

/** First address in preference order that accepts a connection; probes run together. */
async function reachableHost(hosts: string[]): Promise<string | null> {
  const probes = hosts.map((host) => probeTcp(host, SCREEN_SHARING_PORT, PROBE_MS));
  for (const [index, probe] of probes.entries()) if (await probe) return hosts[index];
  return null;
}

type ProbeRequest = (request: {
  op: 'systemSharingProbe';
  action: 'begin' | 'end';
  id: string;
}) => Promise<unknown>;

async function verifiedReachableHost(
  hosts: string[],
  request: ProbeRequest,
  current: () => boolean,
): Promise<string | null> {
  const id = randomBytes(16).toString('hex');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proof = await Promise.race([
      request({ op: 'systemSharingProbe', action: 'begin', id }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    clearTimeout(timer);
    if (!proof || !current()) return null;
    const reachable = await Promise.all(
      hosts.map(
        async (host) =>
          (await verifySystemScreenSharingHost(host, proof, id, current)) &&
          current() &&
          (await probeTcp(host, SCREEN_SHARING_PORT, PROBE_MS)),
      ),
    );
    return current() ? (hosts.find((_, index) => reachable[index]) ?? null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    // Best effort on the original authenticated channel. A dropped/cancelled end
    // still expires on the host; never delay the viewer or reset the shared link.
    if (current()) void request({ op: 'systemSharingProbe', action: 'end', id }).catch(() => {});
  }
}

export type SystemScreenSharingOutcome = 'opened' | 'cancelled' | 'fallback';

/**
 * Opens the target in Screen Sharing, or reports `fallback` so the caller shows
 * Cindy's viewer. `current` turns false when the account or link went away
 * while waiting, which ends the attempt without opening anything.
 */
export async function openWithSystemScreenSharing(options: {
  caps: RemoteDesktopCapabilities | null;
  current: () => boolean;
  requestProbe?: ProbeRequest;
}): Promise<SystemScreenSharingOutcome> {
  const plan = planSystemScreenSharing(options.caps, supportsHighPerformance());
  if (!plan.ok) {
    log.info('system screen sharing unavailable; using Cindy viewer', { reason: plan.reason });
    return 'fallback';
  }
  let host = await reachableHost(plan.hosts);
  if (!options.current()) return 'cancelled';
  if (!host && plan.verificationHosts?.length && options.requestProbe) {
    host = await verifiedReachableHost(
      plan.verificationHosts,
      options.requestProbe,
      options.current,
    );
  }
  if (!options.current()) return 'cancelled';
  if (!host) {
    log.info('system screen sharing unreachable; using Cindy viewer', {
      tried: plan.hosts.length,
      verificationCandidates: plan.verificationHosts?.length ?? 0,
    });
    return 'fallback';
  }
  const settings = readSystemScreenSharingSettings();
  // Default to High Performance without a prompt, while preserving an explicit
  // Standard override. Capability fallback must not overwrite that preference.
  const mode: SystemScreenSharingMode = plan.highPerformance ? settings.mode : 'standard';
  try {
    await shell.openExternal(systemScreenSharingUrl(host, plan.user, mode));
  } catch (error) {
    log.warn('could not open Screen Sharing; using Cindy viewer', {
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'unknown',
    });
    return 'fallback';
  }
  log.info('opened system screen sharing', {
    mode,
    bonjour: BONJOUR_HOST.test(host),
    dynamicResolutionRequested: mode === 'high',
  });
  return 'opened';
}
