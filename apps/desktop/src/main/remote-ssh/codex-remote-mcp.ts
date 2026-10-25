import {createCodexRemoteMcp} from '@cindy/app-runtime/codexRemoteMcp';
import {app} from 'electron';
import {createLogger} from '../logger.js';
import {getRemoteMcpBridgeToken} from '../mcp-integrations/remoteMcpBridgeToken.js';
import {appServerIds} from '../mcp-apps/runtime.js';
export const {removeRemoteMcpForwardPref,invalidateRemoteCodexMcpEndpointState,buildRemoteCodexSessionMcpConfig,renderManagedMcpBlock,mergeManagedMcpBlock,setRemoteMcpForwardRearmedHook,ensureRemoteMcpForward,stripRemoteCodexMcpConfig,hasPendingRemoteMcpDrift,ensureRemoteCodexMcpBridge}=createCodexRemoteMcp({userDataDirectory:()=>app.getPath("userData"),logger:createLogger("codex-remote-mcp"),getRemoteMcpBridgeToken,appServerIds});
export type {RemoteMcpBridgeEndpoint,EnsureRemoteCodexMcpResult,StripRemoteCodexMcpConfigResult} from '@cindy/app-runtime/codexRemoteMcp';
