/**
 * The Host's outbound proxy resolver: the desktop's resolver core (outboundProxyResolverCore.ts),
 * bound to Host ports. Proxy environment variables come first, as on the desktop. Without them, on
 * macOS the Host reads the static system proxy settings (release table row 28, 28b;
 * macos-system-proxy.ts), started by main.ts; PAC is not run yet (28c). Where no system proxy settings
 * are read (other platforms, and any process that did not start them) a request goes direct, as it did
 * when the Host resolved from the environment only, and its outbound path is recorded as `unknown`
 * (session_unavailable) rather than as a confirmed direct route.
 */
import {
  createOutboundProxyResolver,
  type OutboundProxyResolverPorts,
} from '../../desktop/src/main/maker-host/outboundProxyResolverCore.ts';
import { explicitPorts } from './agent/explicit-ports.ts';
import {
  createMacSystemProxySession,
  readScutilProxyOutput,
  type ReadSystemProxySettings,
  type SystemProxySession,
} from './macos-system-proxy.ts';

let systemProxySession: SystemProxySession | null = null;

const hostOutboundProxyResolver = createOutboundProxyResolver(explicitPorts<OutboundProxyResolverPorts>({
  // No Electron app whose readiness gates the system proxy session.
  isAppReady: () => true,
  // The macOS system proxy settings once started; none otherwise (release table row 28).
  getProxySession: () => systemProxySession,
}));

export const resolveHostOutboundProxy = hostOutboundProxyResolver.resolveDesktopOutboundProxy;
/** The resolver's per-upstream outbound path judgement (diagnostics only), as on the desktop. */
export const getHostOutboundPathSnapshotFor = hostOutboundProxyResolver.getOutboundPathSnapshotFor;

/**
 * Reads the macOS system proxy settings with the given reader from now on; null stops reading them.
 * Production passes scutil once at startup (startHostSystemProxySettings); tests pass fixed scutil output,
 * so no test reads the settings of the machine it runs on. Verdicts the resolver core already holds for an
 * upstream stay until they expire (30 s; 5 s when unresolved), as after a settings change.
 */
export function useHostSystemProxySettings(readSettings: ReadSystemProxySettings | null): void {
  systemProxySession = readSettings ? createMacSystemProxySession(readSettings) : null;
}

/** At Host startup (main.ts): on macOS read the static system proxy settings; other platforms have none yet. */
export function startHostSystemProxySettings(): void {
  if (process.platform === 'darwin') useHostSystemProxySettings(readScutilProxyOutput);
}
