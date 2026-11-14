import { EmbeddingClient } from '@cindy/embedding-client';
import type { SkillEmbeddingAdapter } from './types.js';

/** Persist only the environment variable name, never its credential value. */
export interface SkillEmbeddingConfig {
  baseUrl: string;
  model: string;
  dimensions?: number;
  apiKeyEnv: string;
}

/** Opt-in OpenAI-compatible transport. Index persistence belongs to the caller. */
export function createSkillEmbeddingAdapter(
  config: SkillEmbeddingConfig,
  options: { env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch } = {},
): SkillEmbeddingAdapter {
  const url = new URL(config.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Embedding baseUrl must be an HTTP(S) URL without credentials, query or fragment');
  }
  const model = config.model.trim();
  if (!model) throw new Error('Embedding model must not be empty');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) {
    throw new Error('Embedding apiKeyEnv must name an environment variable');
  }
  const dimensions = config.dimensions;
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1)) {
    throw new Error('Embedding dimensions must be a positive integer');
  }
  // A bare origin uses OpenAI's /v1; explicit API prefixes (including /paas/v4) stay intact.
  const baseUrl = url.href.replace(/\/+$/, '') + (url.pathname === '/' ? '/v1' : '');
  const env = options.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv;
  const client = new EmbeddingClient({
    baseUrl,
    embeddingsPath: '/embeddings',
    getApiKey: () => env[apiKeyEnv],
    fetchImpl: options.fetchImpl,
    cacheSize: 0,
  });
  return {
    identity: JSON.stringify({
      protocol: 'openai-compatible-v1',
      endpoint: `${baseUrl}/embeddings`,
      model,
      dimensions: dimensions ?? null,
      inputType: 'omitted-for-query-and-document',
    }),
    async embed(texts, _inputType) {
      const vectors: number[][] = [];
      let modelUsed = model;
      // Serialize batches instead of turning a library refresh into unbounded API fan-out.
      for (let offset = 0; offset < texts.length; offset += 32) {
        const result = await client.embedOpenAICompatible({
          texts: texts.slice(offset, offset + 32), model, dimensions, timeoutMs: 30_000,
        });
        if (offset > 0 && result.modelUsed !== modelUsed) {
          throw new Error('Embedding model changed between batches; rebuild with a stable model');
        }
        modelUsed = result.modelUsed;
        vectors.push(...result.embeddings);
      }
      return { vectors, modelUsed };
    },
  };
}
