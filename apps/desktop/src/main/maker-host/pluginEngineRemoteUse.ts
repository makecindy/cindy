/**
 * Desktop assembly for 「允许被远程调用」of plugin-provided task engines.
 * Delegates to pluginEngineRemoteUseCore.ts over Desktop's remote-provider-access-store.
 */
import { isRemoteProviderInvocationAllowed, setRemoteProviderInvocationEnabled } from './remote-provider-access-store.js';
import {
  createPluginEngineRemoteUse,
  isPluginEngineModelTurnedOff,
  type PluginEngineRemoteUse,
} from './pluginEngineRemoteUseCore.js';

export { isPluginEngineModelTurnedOff, type PluginEngineRemoteUse };

const desktopRemoteUse = createPluginEngineRemoteUse({
  isRemoteProviderInvocationAllowed: (providerId) => isRemoteProviderInvocationAllowed(providerId),
  setRemoteProviderInvocationEnabled: (providerId, enabled) => setRemoteProviderInvocationEnabled(providerId, enabled),
});

export const {
  pluginEngineRemoteUse,
  isPluginEngineOfferedRemotely,
  isPluginEngineOfferedToGuests,
  hasPluginEngineOfferedRemotely,
  setPluginEngineRemoteUse,
} = desktopRemoteUse;
