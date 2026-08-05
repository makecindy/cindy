export { EmbeddingClient, getEmbeddingModel } from './client.js';
export { EmbeddingError } from './types.js';
export type {
  EmbeddingModelId,
  EmbeddingModelMeta,
  EmbeddingClientOptions,
  EmbeddingLogger,
  EmbedRequest,
  EmbedResponse,
} from './types.js';
export { listEmbeddingModels, isKnownEmbeddingModel } from './catalog.js';
