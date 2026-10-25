import {EmbeddingService as SharedEmbeddingService, type EmbeddingServiceDeps} from '@cindy/runtime-db/embedding/EmbeddingService';
import * as providers from './providers';
import {isProviderModelRouteDisabled,isProviderRouteSuspended} from '../utility-model/oneShotCandidates';
export type * from '@cindy/runtime-db/embedding/EmbeddingService';
export class EmbeddingService extends SharedEmbeddingService { constructor(deps: EmbeddingServiceDeps) { super(deps, {providers,isProviderModelRouteDisabled,isProviderRouteSuspended}); } }
