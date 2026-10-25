import type { ProviderGroupRouter } from './router.js';
import type { ProviderGroupExternalLoad } from './externalLoad.js';
export interface ProviderGroupOwnerScope { router: ProviderGroupRouter; externalLoad: ProviderGroupExternalLoad; isCurrent(): boolean }
