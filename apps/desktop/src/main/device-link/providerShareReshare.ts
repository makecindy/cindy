import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { providerShareGuestAccess } from './providerShareHost.js';
import { createProviderShareReshare, normalizeProviderShareReshareFile, RESHARE_STORE_MAX_BYTES, type ReshareFile } from '@cindy/remote-agent/host/reshare';
export type { ProviderShareResharePeer, ProviderShareReshareRecord, ProviderShareReshareSyncResult, ProviderShareReshareEvents } from '@cindy/remote-agent/host/reshare';
const store = createOverrideSettingsFile<ReshareFile>({
  filePath: () => ownerScopedUserDataPath('provider-share-reshare.json'), scopeKey: activeOwnerScopeKey,
  defaults: {records: []}, normalize: normalizeProviderShareReshareFile,
  log: createLogger('provider-share:reshare'), label: 'provider-share-reshare', maxBytes: RESHARE_STORE_MAX_BYTES, logLoadedValue: false,
});
export const {syncProviderShareReshare, isProviderShareReshareApproved, decideProviderShareReshare, listProviderShareReshares, pruneProviderShareReshares, setProviderShareReshareEvents, providerShareResharePeerOf, handleProviderShareReshare, providerShareReshareAllows, __testing} = createProviderShareReshare({store, guestAccess: providerShareGuestAccess});
