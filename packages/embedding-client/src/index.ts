export { EmbeddingClient, getEmbeddingModel } from './client.js';
export { EmbeddingError } from './types.js';
export type {
  EmbeddingModelId,
  EmbeddingModelMeta,
  EmbeddingClientOptions,
  EmbeddingInputType,
  EmbeddingLogger,
  EmbedRequest,
  EmbedResponse,
  EmbedDocumentsRequest,
  EmbedDocumentsResponse,
} from './types.js';
export { listEmbeddingModels, isKnownEmbeddingModel } from './catalog.js';
