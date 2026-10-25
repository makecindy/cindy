import {appServerIds} from '../mcp-apps/runtime.js';
import {createCcRemoteMcp} from '@cindy/app-runtime/ccRemoteMcp';
import {app} from 'electron';
import {getRemoteMcpBridgeToken} from '../mcp-integrations/remoteMcpBridgeToken.js';
import {getSessionOrcaRole,getWorkerLink} from '../localDb/orcaTeamStore.js';
export const {synthesizeCcRemoteVendorOptions,prepareCcRemoteQueryMcp,buildCcRemoteHttpMcpServers,CC_MCP_DISABLED_FINGERPRINT,readCcAppliedFingerprint,writeCcAppliedFingerprint}=createCcRemoteMcp({appServerIds,userDataDirectory:()=>app.getPath("userData"),getRemoteMcpBridgeToken,getSessionOrcaRole,getWorkerLink});
export type {CcRemoteHttpMcpDeps,CcRemoteHttpMcpServerConfig} from '@cindy/app-runtime/ccRemoteMcp';
