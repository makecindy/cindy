import {EmbeddingWorker as SharedEmbeddingWorker, type EmbeddingWorkerOptions} from '@cindy/runtime-db/embedding/EmbeddingWorker';
import * as providers from './providers';
export type * from '@cindy/runtime-db/embedding/EmbeddingWorker';
export class EmbeddingWorker extends SharedEmbeddingWorker { constructor(deps: EmbeddingWorkerOptions) { super(deps, providers); } }
