import { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
export type { ResolvedImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import { createLogger } from '../logger';
import { getMaker } from '../maker-host';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService';
import { readImDefaultSettings } from './defaultSettingsStore';
import { readImRemoteProviderRoute } from './remoteProviderRoute';

export const {
  getImDefaultEffortFor,
  resolveImSessionDefaults,
  readImDefaultSettingsFingerprint,
  readImRawDefaultRoute,
  resolveDefaultProviderIdForModel,
} = createImSessionDefaults({
  getCapabilities: agent => getMaker().getCapabilities(agent),
  readImDefaultSettings: channel => readImDefaultSettings(channel),
  listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
  readImRemoteProviderRoute: route => readImRemoteProviderRoute(route),
  log: createLogger('im:defaults'),
});
