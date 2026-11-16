/**
 * The Host's outbound proxy resolver: the desktop's resolver core (outboundProxyResolverCore.ts),
 * bound to Host ports. Proxy environment variables come first, as on the desktop; there is no
 * graphical session from which system proxy settings or a PAC script are read yet (release table
 * row 28: 28b adds macOS static system proxies, 28c PAC). Without proxy environment variables a
 * request goes direct, as it did when the Host resolved from the environment only, and its outbound
 * path is recorded as `unknown` (session_unavailable) rather than as a confirmed direct route.
 */
import {
  createOutboundProxyResolver,
  type OutboundProxyResolverPorts,
} from '../../desktop/src/main/maker-host/outboundProxyResolverCore.ts';
import { explicitPorts } from './agent/explicit-ports.ts';

const hostOutboundProxyResolver = createOutboundProxyResolver(explicitPorts<OutboundProxyResolverPorts>({
  // No Electron app whose readiness gates the system proxy session.
  isAppReady: () => true,
  // The Host does not read system proxy settings or PAC (release table row 28, 28b/28c).
  getProxySession: () => null,
}));

export const resolveHostOutboundProxy = hostOutboundProxyResolver.resolveDesktopOutboundProxy;
/** The resolver's per-upstream outbound path judgement (diagnostics only), as on the desktop. */
export const getHostOutboundPathSnapshotFor = hostOutboundProxyResolver.getOutboundPathSnapshotFor;
