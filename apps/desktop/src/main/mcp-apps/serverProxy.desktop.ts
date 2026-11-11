import { getMcpAppsHost, readAppServer } from './runtime.js';
import { createAppServerProxyFactory } from './serverProxy.js';
export const createAppServerProxy = createAppServerProxyFactory({ getMcpAppsHost, readAppServer });
