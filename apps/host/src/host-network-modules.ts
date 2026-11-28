/**
 * Every module the Host loads that opens network connections itself, and why its traffic to other machines goes
 * through the Host's outbound proxy resolver or does not need to (release table row 28).
 *
 * "Opens network connections itself": a value import of node:http, https, net, tls, http2 or dgram, of undici or
 * ws (or a require / dynamic import of them), references to global fetch, direct calls to a local fetch
 * parameter, or WebSocket construction. Counts cover fetch uses, WebSocket constructions and calls through
 * statically imported network APIs so adding a call in an already classified module also needs review.
 *
 * Guard: hostDesktopSourceContracts.guard.test.ts ("network modules the Host loads") collects them over the Host's
 * import graph (the entries of scripts/build.mjs and the acceptance scripts) and fails on a module missing here, an
 * entry whose module no longer does it, or a different `uses`: a new outbound call that bypasses the resolver
 * cannot land unnoticed.
 *
 * route:
 * - resolver: its requests to other machines take the resolver's verdict (hostOutbound, resolveHostOutboundProxy,
 *   or an agent built from them);
 * - injected: the transport is a port, and the Host passes hostOutbound (where says where);
 * - loopback: it talks to this machine only (a local server, a local control plane, the Host's own endpoint);
 * - no-connection: it imports the module for addresses or types and opens nothing;
 * - same-as-desktop: it goes to other machines without the resolver, as the desktop does too (recorded in the
 *   release table, row 28).
 */
export type HostNetworkRoute = 'resolver' | 'injected' | 'loopback' | 'no-connection' | 'same-as-desktop';

export const HOST_NETWORK_MODULES: Readonly<Record<string, { uses: readonly string[]; route: HostNetworkRoute; reason: string }>> = {
  'apps/desktop/scripts/mcp-apps-mock.mjs': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'A mock MCP app server on loopback for an acceptance script' },
  'apps/desktop/src/main/browser-extension/bridge.ts': { uses: ['imports http', 'imports ws', 'network API calls ×2'], route: 'loopback', reason: 'The browser extension bridge listens on loopback (HTTP + WebSocket) for the local extension' },
  'apps/desktop/src/main/browser-extension/native-binding.ts': { uses: ['imports net', 'network API calls ×1'], route: 'loopback', reason: 'Connects to 127.0.0.1 only (the native messaging binding)' },
  'apps/desktop/src/main/cindy-brain/ghostOauthFlow.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The plugin OAuth redirect listener on loopback; its token requests use the injected fetch (plugins/authorization.ts passes hostOutbound)' },
  'apps/desktop/src/main/cindy-brain/networkConnections.ts': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'injected', reason: 'Plugin WebSockets take the injected agent: plugins/runtime.ts passes hostOutbound.createOutboundHttpAgent' },
  'apps/desktop/src/main/host-ipc-proxy.ts': { uses: ['fetch ×1'], route: 'loopback', reason: 'A client window\'s proxy to the Host\'s loopback endpoint' },
  'apps/desktop/src/main/host-settings/managementAuthorization.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'Delivers a forwarded sign-in callback to the local redirect listener on loopback; runs only on a managed cloud instance' },
  'apps/desktop/src/main/input-handoff/askpass/host.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The askpass server on loopback' },
  'apps/desktop/src/main/maker-host/cli-proxy-bridge.ts': { uses: ['imports http', 'imports net', 'network API calls ×3'], route: 'resolver', reason: 'The Claude and Pi CLI CONNECT bridge resolves each target through resolveHostOutboundProxy, injected by provider-config.ts and agent/runtime.ts' },
  'apps/desktop/src/main/maker-host/generic-oauth.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The OAuth redirect listener on loopback; token requests use the injected fetch (provider-config.ts passes hostOutbound)' },
  'apps/desktop/src/main/maker-host/grok-oauth-login.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The Grok sign-in redirect listener on loopback; token requests use the injected outboundFetch (provider-config.ts passes hostOutbound)' },
  'apps/desktop/src/main/maker-host/outbound-fetch.ts': { uses: ['fetch ×2', 'imports undici', 'network API calls ×8'], route: 'resolver', reason: 'The outbound transport itself: it goes direct only where the resolver says direct' },
  'apps/desktop/src/main/mcp-apps/connection.ts': { uses: ['fetch ×1'], route: 'same-as-desktop', reason: 'A remote (URL) MCP app connects with Node\'s fetch, without the resolver, as in the desktop main process; plugin MCP apps use the plugin transport' },
  'apps/desktop/src/main/mcp-integrations/browser-backend/external-link-handoff.ts': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'loopback', reason: 'The managed browser\'s DevTools endpoint on loopback' },
  'apps/desktop/src/main/mcp-integrations/browser-backend/proxy-auth.ts': { uses: ['fetch ×2', 'imports net', 'imports ws', 'network API calls ×4', 'new WebSocket ×3'], route: 'loopback', reason: 'The managed browser\'s DevTools endpoint, checked to be loopback' },
  'apps/desktop/src/main/mcp-integrations/browser-real-profile/launch.ts': { uses: ['imports net', 'network API calls ×1'], route: 'loopback', reason: 'Takes a free local port' },
  'apps/desktop/src/main/mcp-integrations/codexHttpBridge.ts': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The Codex task action bridge server on loopback' },
  'apps/desktop/src/main/projectIconDiscovery.ts': { uses: ['fetch ×5'], route: 'injected', reason: 'The Host project icon runtime passes hostOutbound.outboundFetch for icon discovery' },
  'apps/desktop/src/main/remote-agent/host/tunnel.ts': { uses: ['imports http', 'imports ws', 'network API calls ×2'], route: 'loopback', reason: 'The remote-agent local tunnel server listens on 127.0.0.1 only for hosted plugin-engine runs' },
  'apps/desktop/src/main/reviewer/reviewOwnerLiveness.ts': { uses: ['imports net', 'network API calls ×2'], route: 'loopback', reason: 'The reviewer owner liveness socket on loopback' },
  'apps/desktop/src/main/ssh-access/cloudComputer.ts': { uses: ['fetch ×1'], route: 'same-as-desktop', reason: 'SSH access reads the public IPv4 of a Cindy cloud guest from the Tencent instance metadata service, which only answers inside the instance; it is fetched directly with a 2 s timeout, never through a proxy, as on the desktop' },
  'apps/desktop/src/main/ssh-access/sshdProbe.ts': { uses: ['imports net', 'network API calls ×1'], route: 'loopback', reason: 'SSH access checks that this machine\'s sshd greets on 127.0.0.1 (one banner line)' },
  'apps/host/src/auth/device-link-registration.mjs': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'resolver', reason: 'Fresh sign-in restores relay registration with createHostWebSocketAgent.' },
  'apps/host/src/auth/login.mjs': { uses: ['imports http', 'network API calls ×1'], route: 'loopback', reason: 'The sign-in callback listener on loopback; auth requests use hostAuthFetch' },
  'apps/host/src/browser-open.mjs': { uses: ['fetch ×1'], route: 'loopback', reason: 'The Host\'s own loopback endpoint (pairing)' },
  'apps/host/src/control.mjs': { uses: ['fetch ×1'], route: 'loopback', reason: 'The running Host\'s loopback control endpoint' },
  'apps/host/src/device-link.ts': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'resolver', reason: 'The relay WebSocket takes createHostWebSocketAgent (outbound.mjs)' },
  'apps/host/src/main.ts': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'resolver', reason: 'hostAgentNetPorts supplies the HTTP fetch and WebSocket agent from the Host outbound transport.' },
  'apps/host/src/platform/client-bridge.ts': { uses: ['imports ws'], route: 'loopback', reason: 'Accepts the platform client\'s socket on the Host\'s loopback server' },
  'apps/host/src/plugins/node-worker.ts': { uses: ['imports net', 'network API calls ×1'], route: 'no-connection', reason: 'Wraps the inherited control pipe (fd 3)' },
  'apps/host/src/server.mjs': { uses: ['imports http', 'imports ws', 'network API calls ×2'], route: 'loopback', reason: 'The Host\'s own loopback server' },
  'packages/agent-net-core/wasm/node.mts': { uses: ['imports dgram', 'imports net', 'network API calls ×2'], route: 'same-as-desktop', reason: 'The Agent-Net worker uses direct UDP for session paths, STUN and UDP relay, as on the desktop.' },
  'packages/agent-net-relay/src/client.ts': { uses: ['fetch ×9', 'imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'injected', reason: 'The live Agent-Net client takes fetch and createWebSocket from hostAgentNetPorts through createAgentNetNode.' },
  'packages/agent-net-relay/src/clientAddress.ts': { uses: ['imports net', 'network API calls ×4'], route: 'no-connection', reason: 'Parses and matches addresses (isIP, BlockList) to attribute relay rate limits to a client; opens nothing.' },
  'packages/agent-net-relay/src/cluster.ts': { uses: ['imports http', 'imports https'], route: 'no-connection', reason: 'Loaded through the Agent-Net relay exports. Cindy Host runs a client and never starts the relay service.' },
  'packages/agent-net-relay/src/datagramQueue.ts': { uses: ['imports ws'], route: 'no-connection', reason: 'The relay queue uses the WebSocket module for its ready state constant.' },
  'packages/agent-net-relay/src/gateway.ts': { uses: ['imports http', 'imports https', 'network API calls ×2'], route: 'no-connection', reason: 'Loaded through the Agent-Net relay exports. Cindy Host runs a client and never starts the relay service.' },
  'packages/agent-net-relay/src/ingress.ts': { uses: ['imports http', 'network API calls ×1'], route: 'no-connection', reason: 'Loaded through the Agent-Net relay exports. Cindy Host runs a client and never starts the relay service.' },
  'packages/agent-net-relay/src/server.ts': { uses: ['imports dgram', 'imports http', 'imports https', 'imports net', 'imports ws', 'network API calls ×9'], route: 'no-connection', reason: 'Loaded through the Agent-Net relay exports. Cindy Host runs a client and never starts the relay service.' },
  'packages/agent-net/src/lan.ts': { uses: ['imports dgram', 'network API calls ×1'], route: 'same-as-desktop', reason: 'The Agent-Net worker uses direct UDP to discover peers on a local network, as on the desktop.' },
  'packages/agent-net/src/nodeNativeEngine.ts': { uses: ['imports dgram', 'network API calls ×1'], route: 'loopback', reason: 'The native engine wakes the Agent-Net worker with one byte to a UDP socket bound to 127.0.0.1; its peer traffic goes over the engine\'s own socket, as on the desktop.' },
  'packages/agent-net/src/portMap.ts': { uses: ['imports dgram', 'imports http', 'imports net', 'network API calls ×8'], route: 'same-as-desktop', reason: 'The Agent-Net worker requests best-effort NAT-PMP/UPnP UDP port mappings directly from the LAN default gateway IP, as on the desktop.' },
  'packages/agent-net/src/sharingClient.ts': { uses: ['fetch ×1'], route: 'no-connection', reason: 'Loaded through Agent-Net exports. Host device links use AgentNetClient and never construct the sharing client.' },
  'packages/agent-net/src/stun.ts': { uses: ['imports https', 'imports net', 'network API calls ×5'], route: 'same-as-desktop', reason: 'The Agent-Net worker queries IP-literal DoH directly only when system DNS returns RFC 2544 Fake-IP (198.18.0.0/15) for a STUN or relay UDP host, as on the desktop.' },
  'packages/agent-net/src/workerSocket.ts': { uses: ['fetch ×1', 'imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'injected', reason: 'Worker HTTP and WebSocket requests use the parent AgentNetClient transport supplied by hostAgentNetPorts.' },
  'packages/anthropic-compat-proxy/src/outbound-proxy.ts': { uses: ['imports http', 'imports https', 'network API calls ×1'], route: 'resolver', reason: 'The HTTP CONNECT agents for the resolver\'s verdicts' },
  'packages/anthropic-compat-proxy/src/server.ts': { uses: ['imports http', 'imports https', 'network API calls ×1'], route: 'resolver', reason: 'The loopback compat proxy; upstream requests take the injected resolver (claude-proxy-runtime.ts passes resolveHostOutboundProxy)' },
  'packages/anthropic-compat-proxy/src/socks5.ts': { uses: ['imports http', 'imports https', 'imports net', 'network API calls ×4'], route: 'resolver', reason: 'The SOCKS5 agents for the resolver\'s verdicts' },
  'packages/anthropic-responses-bridge/src/handler.ts': { uses: ['fetch ×1'], route: 'injected', reason: 'Global fetch only as the default of fetchImpl; anthropicResponsesBridgeHostCore.ts passes outboundFetch (hostOutbound on the Host)' },
  'packages/auth-client/src/linuxCloud.mjs': { uses: ['fetch ×1'], route: 'injected', reason: 'The Host passes hostAuthFetch for cloud sign-in and device confirmation. Instance metadata uses direct link-local fetch.' },
  'packages/browser-control-runtime/src/_generated/extension/src/browser/cdp-proxy-bypass.ts': { uses: ['imports http', 'imports https', 'network API calls ×2'], route: 'loopback', reason: 'Agents that keep DevTools traffic to loopback off any proxy' },
  'packages/browser-control-runtime/src/_generated/extension/src/browser/cdp.helpers.ts': { uses: ['imports ws', 'network API calls ×1', 'new WebSocket ×1'], route: 'loopback', reason: 'DevTools WebSockets of the controlled browser on loopback' },
  'packages/browser-control-runtime/src/_generated/extension/src/browser/navigation-guard.ts': { uses: ['imports net', 'network API calls ×1'], route: 'no-connection', reason: 'Parses addresses for navigation checks' },
  'packages/browser-control-runtime/src/_generated/leaf/src/infra/net/undici-family-policy.ts': { uses: ['imports net', 'network API calls ×4'], route: 'no-connection', reason: 'The address family policy of the guarded dispatcher' },
  'packages/browser-control-runtime/src/_generated/leaf/src/infra/net/undici-runtime.ts': { uses: ['imports net', 'imports undici', 'network API calls ×1'], route: 'loopback', reason: 'The guarded fetch runtime of the browser control client, whose callers target loopback control planes (shim/ssrf-runtime.ts)' },
  'packages/browser-control-runtime/src/shim/_local/ports.ts': { uses: ['imports net', 'network API calls ×1'], route: 'loopback', reason: 'Takes free local ports' },
  'packages/browser-control-runtime/src/shim/ssrf-runtime.ts': { uses: ['fetch ×1', 'imports undici', 'network API calls ×2'], route: 'loopback', reason: 'The guarded fetch of the control client and DevTools helper, which target loopback control planes' },
  'packages/embedding-client/src/client.ts': { uses: ['fetch ×1'], route: 'no-connection', reason: 'The shared embedding implementation is imported; only the desktop starts the embedding host and supplies its outbound fetch' },
  'packages/responses-anthropic-bridge/src/handler.ts': { uses: ['fetch ×1'], route: 'injected', reason: 'Global fetch only as the default of fetchImpl; the Host\'s bridges pass outboundFetch' },
  'packages/responses-chat-bridge/src/handler.ts': { uses: ['fetch ×1'], route: 'injected', reason: 'Global fetch only as the default of fetchImpl; anthropicCompatProxyHostCore.ts passes outboundFetch (hostOutbound on the Host)' },
};
