import {createCodexEnvironment} from '@cindy/app-runtime/codexEnvironment';
import {getRemoteMcpBridgeToken} from './remoteMcpBridgeToken.js';
import {appServerIds} from '../mcp-apps/runtime.js';
export const {getCodexExtraSpawnConfig,setCodexEnvironmentShutdownHook,getActiveCodexBridgeInstanceId,getActiveCodexBridgeServerNames,shutdownCodexEnvironment,registerCodexMcpThreadContext,unregisterCodexMcpThreadContext,withCodexMcpDiscoveryContext}=createCodexEnvironment({getRemoteMcpBridgeToken,appServerIds});
export type {CodexExtraSpawnConfig,GetCodexExtraSpawnConfigOptions} from '@cindy/app-runtime/codexEnvironment';
