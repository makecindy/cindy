import type { EmbeddingModelId } from '@cindy/embedding-client';
import type { SkillEmbeddingAdapter } from '@cindy/skill-index';
import type { EmbeddingService } from '../embedding-host/EmbeddingService';

/** Skill index consumer of the existing host transport; credentials remain with the host. */
export function createLocalSkillEmbeddingAdapter(
  model: EmbeddingModelId,
  getService: () => Pick<EmbeddingService, 'embedSync'>,
): SkillEmbeddingAdapter {
  return {
    identity: `cindy-host:${model}:query-document:v1`,
    async embed(texts, inputType) {
      const vectors: number[][] = [];
      let modelUsed: string = model;
      // Match the CLI/host worker batch size; the Skill index already persists reusable vectors.
      for (let offset = 0; offset < texts.length; offset += 32) {
        const result = await getService().embedSync(texts.slice(offset, offset + 32), {
          modelId: model, inputType, timeoutMs: 30_000, bypassCache: true,
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
