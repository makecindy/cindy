import {createAppServerProxy as createProxy} from '@cindy/app-runtime/mcp-apps/serverProxy';
import {getMcpAppsHost,readAppServer} from './runtime.js';
import {createLogger} from '../logger.js';
export const createAppServerProxy=(read:Parameters<typeof createProxy>[0],context:Parameters<typeof createProxy>[1])=>createProxy(read,context,{getMcpAppsHost,readAppServer,logger:createLogger('mcp-apps')});
