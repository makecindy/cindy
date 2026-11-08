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
  // EmbeddingClient appends /v1/embeddings; accept both service-root and /v1 configuration.
  const baseUrl = url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
  const env = options.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv;
  const client = new EmbeddingClient({
    baseUrl,
    getApiKey: () => env[apiKeyEnv],
    fetchImpl: options.fetchImpl,
    cacheSize: 0,
  });
  return {
    identity: JSON.stringify({
      protocol: 'openai-compatible-v1',
      endpoint: `${baseUrl}/v1/embeddings`,
      model,
      dimensions: dimensions ?? null,
      inputType: 'omitted-for-query-and-document',
    }),
    async embed(texts, _inputType) {
      const vectors: number[][] = [];
      // Serialize batches instead of turning a library refresh into unbounded API fan-out.
      for (let offset = 0; offset < texts.length; offset += 32) {
        const result = await client.embedOpenAICompatible({
          texts: texts.slice(offset, offset + 32), model, dimensions, timeoutMs: 30_000,
        });
        vectors.push(...result.embeddings);
      }
      return vectors;
    },
  };
}
