import {createLogger} from '../logger.js';
import {ensureTunnelForHost,ensureTunnelUp,initAgentProxyTunnelKeeper,isAgentProxyTunnelKeeperInitialized,pauseTunnelForHost,stopTunnelForHost,tunnelNeedsRebuild,disposeAllTunnels} from './agent-proxy-tunnel.js';
import {getSshHostAgentProxy} from './ssh-host-prefs-store.js';
import {createAgentProxy} from '@cindy/app-runtime/agent-proxy';
export type * from '@cindy/app-runtime/agent-proxy';
export {disposeAllTunnels};
export const {getAgentProxyTunnelState,clearAgentProxyTunnelState,clearAgentProxyTunnelStateAndWait,handleAgentProxyMainHostDown,teardownAgentProxyOnUserDisconnect,initAgentProxy,setAgentProxyLiveTurnChecker,hasPendingAgentProxyReconcile,resolveAgentProxyUrl,buildAgentProxyEnv,buildAgentProxyEnvUppercase,buildAgentProxyMarkerContent,ensureAgentProxyReady,getRemoteAgentProxyEnv,getRemoteAgentProxyEnvUppercase,killRemoteCodexDaemon,reconcileCodexAgentProxyEnv,applyAgentProxyForHost}=createAgentProxy({logger:createLogger('remote-ssh/agent-proxy'),ensureTunnelForHost,ensureTunnelUp,initAgentProxyTunnelKeeper,isAgentProxyTunnelKeeperInitialized,pauseTunnelForHost,stopTunnelForHost,tunnelNeedsRebuild,disposeAllTunnels,getSshHostAgentProxy});
