export {CUSTOM_PROVIDER_ID_RE, validateCustomProviderConfig, mergeDiscoveredModelsIntoConfig, clearCodexAccountUltrafast, type ValidationResult} from '@cindy/app-runtime/customProviderStore';
import {createCustomProviderStore} from '@cindy/app-runtime/customProviderStore';
import {getDbClient} from '../localDb/client/current.js';
export const {revokeCodexAccountUltrafast, listCustomProviders, getCustomProvider, customProviderExists, createCustomProvider, updateCustomProvider, updateCustomProviderIfUnchanged, deleteCustomProvider} = createCustomProviderStore(getDbClient);
