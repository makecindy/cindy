import {createEmbeddingHost} from '@cindy/runtime-db/embedding/host';
import {EmbeddingService} from './EmbeddingService';
import * as providers from './providers';
export type {EmbeddingProvider,EmbeddingJobForProvider} from './providers';
export type {EmbeddingService} from './EmbeddingService';
export type {VecTableSpec} from './VecTableRegistry';
export type {StartEmbeddingHostDeps} from '@cindy/runtime-db/embedding/host';
export const {startEmbeddingHost, stopEmbeddingHost, stopEmbeddingHostIfNoPluginVectorConsumer, getEmbeddingService, registerEmbeddingHostLazyStart, ensureEmbeddingServiceForPluginVector, isPluginVectorConsumerActive, setEmbeddingSourceSuspended, isEmbeddingSourceSuspended, isEmbeddingHostStarted} = createEmbeddingHost({providers,createService: deps => new EmbeddingService(deps)});
