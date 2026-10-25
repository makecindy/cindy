import {createMcpAppsRuntime} from '@cindy/app-runtime/mcp-apps/runtime';
import {clearMcpAppDocuments,setMcpAppCallerCleanup} from './sandboxProtocol.js';
const runtime=createMcpAppsRuntime({clearDocuments:clearMcpAppDocuments,setCallerCleanup:setMcpAppCallerCleanup});
export const {setMcpAppsHost,getMcpAppsHost,registerAppServer,clearAppServerConfigs,readAppServer,appServerIds,resetAppServers,mcpAppModelContext}=runtime;
