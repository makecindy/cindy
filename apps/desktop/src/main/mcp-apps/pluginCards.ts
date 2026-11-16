import { getMcpAppsHost, readAppServer } from './runtime.js';
import { createPluginAppPublisher } from './pluginCardsCore.js';
export { pluginAppResult, pluginModelResult } from './pluginCardsCore.js';
export const publishPluginAppResult = createPluginAppPublisher({ getMcpAppsHost, readAppServer });
