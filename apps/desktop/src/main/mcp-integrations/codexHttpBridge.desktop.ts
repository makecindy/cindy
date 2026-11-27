import { createCodexHttpBridgeRuntime } from './codexHttpBridge.js';
import { appServerIds } from '../mcp-apps/runtime.js';
import { createLogger } from '../logger.js';

const appBindingLog = createLogger('mcp-app-binding');

export type * from './codexHttpBridge.js';
export { REMOTE_COLLAB_SERVER_NAMES, REMOTE_MEMORY_SERVER_NAME, REMOTE_BOT_HELPER_SERVER_NAME, REMOTE_ALLOWED_SERVER_NAMES } from './codexHttpBridge.js';
export const { selectRemoteInjectableServerNames, computeRemoteMcpFingerprint, withMcpRouteIdentity, countLiveBridgeMcpSessions, startCodexHttpBridge } = createCodexHttpBridgeRuntime({
  appServerIds,
  appBindingLogger: { warn: (message, fields) => appBindingLog.warn('%s %j', message, fields) },
});
