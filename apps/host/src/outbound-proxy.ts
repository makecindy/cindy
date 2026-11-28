/**
 * The Host's outbound proxy resolver: the desktop's resolver core (outboundProxyResolverCore.ts),
 * bound to Host ports. Proxy environment variables come first, as on the desktop; without them the core asks
 * the system proxy session set here (release table row 28):
 * - macOS: the static system proxy settings (28b, macos-system-proxy.ts); when they use PAC or auto-discovery,
 *   the Chromium proxy helper (28c, chromium-proxy.ts) answers, falling back to the static reading;
 * - Windows: the Chromium proxy helper, prewarmed before the first request (28c); without an answer in time the request
 *   goes direct and its path is recorded as `unknown` (resolve_failed);
 * - other platforms (Linux): none; only the proxy environment variables are read, and a request without them goes
 *   direct with its path recorded as `unknown` (session_unavailable), not as a confirmed direct route.
 * Only main.ts starts the system settings (startHostSystemProxySettings); a process that did not, such as a test
 * or an acceptance script importing outbound.mjs, reads the proxy environment variables only.
 */
import { hasProxyEnvConfig } from '@cindy/anthropic-compat-proxy';

import {
  createOutboundProxyResolver,
  type OutboundProxyResolverPorts,
} from '../../desktop/src/main/maker-host/outboundProxyResolverCore.ts';
import { explicitPorts } from './agent/explicit-ports.ts';
import { createChromiumProxyHelper, type ChromiumProxyHelper, type ChromiumProxyHelperState } from './chromium-proxy.ts';
import {
  createMacSystemProxySession,
  readScutilProxyOutput,
  type ReadSystemProxySettings,
  type SystemProxySession,
} from './macos-system-proxy.ts';
import { resolveHostDataDir } from './profile-path.mjs';

let systemProxySession: SystemProxySession | null = null;
let chromiumHelper: ChromiumProxyHelper | null = null;

const hostOutboundProxyResolver = createOutboundProxyResolver(explicitPorts<OutboundProxyResolverPorts>({
  // No Electron app whose readiness gates the system proxy session.
  isAppReady: () => true,
  // The platform's system proxy session once started; none otherwise (release table row 28).
  getProxySession: () => systemProxySession,
}));

export const resolveHostOutboundProxy = hostOutboundProxyResolver.resolveDesktopOutboundProxy;
/** The resolver's per-upstream outbound path judgement (diagnostics only), as on the desktop. */
export const getHostOutboundPathSnapshotFor = hostOutboundProxyResolver.getOutboundPathSnapshotFor;

/**
 * Reads the macOS system proxy settings with the given reader from now on, asking `chromium` for PAC and
 * auto-discovery; null stops reading them. Production passes scutil and the Chromium proxy helper once at startup
 * (startHostSystemProxySettings); tests pass fixed scutil output and a stand-in helper, so no test reads the
 * settings of the machine it runs on. Verdicts the resolver core already holds for an upstream stay until they
 * expire (30 s; 5 s when unresolved), as after a settings change.
 */
export function useHostSystemProxySettings(readSettings: ReadSystemProxySettings | null, chromium: SystemProxySession | null = null): void {
  systemProxySession = readSettings ? createMacSystemProxySession(readSettings, chromium) : null;
}

/** Windows (28c): every resolution without proxy environment variables asks `chromium`; null stops it. */
export function useHostChromiumProxySession(chromium: SystemProxySession | null): void {
  systemProxySession = chromium;
}

/** Prepare the system session before login or startup can send its first request. */
export async function startHostSystemProxySettings({
  platform = process.platform,
  readSettings = readScutilProxyOutput,
  makeHelper = () => createChromiumProxyHelper({ profileDir: resolveHostDataDir() }),
}: {
  platform?: NodeJS.Platform;
  readSettings?: ReadSystemProxySettings;
  makeHelper?: () => ChromiumProxyHelper;
} = {}): Promise<void> {
  if (platform !== 'darwin' && platform !== 'win32') return;
  let helper: ChromiumProxyHelper;
  try {
    helper = chromiumHelper = makeHelper();
  } catch (error) {
    // The static macOS settings remain usable even if the helper profile cannot be created.
    if (platform === 'darwin') useHostSystemProxySettings(readSettings);
    throw error;
  }
  if (platform === 'darwin') {
    const session = createMacSystemProxySession(readSettings, helper);
    systemProxySession = session;
    if (hasProxyEnvConfig() || !await session.needsChromium().catch(() => false)) return;
  } else {
    systemProxySession = helper;
    if (hasProxyEnvConfig()) return;
  }
  await helper.warmUp();
}

/** At Host shutdown: stops the Chromium proxy helper, if it runs, by its handle. */
export async function stopHostSystemProxySettings(): Promise<void> {
  await chromiumHelper?.close();
}

/** How this Host finds its outbound proxy, for `cindy-host status` (never a proxy address or a setting). */
export function describeHostOutboundProxy(): {
  environmentVariables: boolean;
  systemSettings: 'static-and-chromium-helper' | 'chromium-helper' | 'not-read';
  helper: ChromiumProxyHelperState | 'none';
} {
  return {
    environmentVariables: hasProxyEnvConfig(),
    systemSettings: process.platform === 'darwin' ? 'static-and-chromium-helper'
      : process.platform === 'win32' ? 'chromium-helper' : 'not-read',
    helper: chromiumHelper?.state() ?? 'none',
  };
}

/** The `cindy-host status` line for a running Host's describeHostOutboundProxy(). */
export function describeOutboundProxyLine(value: unknown): string {
  const state = value as Partial<ReturnType<typeof describeHostOutboundProxy>> | null;
  const environment = state?.environmentVariables ? 'proxy environment variables (used first)' : 'no proxy environment variables';
  const system = state?.systemSettings === 'static-and-chromium-helper'
    ? `system settings (static; PAC and auto-discovery through the Chromium helper, ${state.helper ?? 'none'})`
    : state?.systemSettings === 'chromium-helper'
      ? `system settings through the Chromium helper (${state.helper ?? 'none'})`
      : 'system proxy settings and PAC are not read on this platform';
  return `${environment}; ${system}`;
}
