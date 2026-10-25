import { createLlamaCppDownloads } from '@cindy/model-providers/local-runtime/llamaCppDownloads';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
export * from '@cindy/model-providers/local-runtime/llamaCppDownloads';
export const { resolveLlamaCppRelease, downloadLlamaCppAsset, resolveHfRepository } =
  createLlamaCppDownloads(outboundFetch);
