import piModelCatalogJson from '../catalog/pi-model-catalog.json' with { type: 'json' };

import { PI_REASONING_EFFORTS } from './types.js';
import type { CatalogModel, Effort, ModelCost, PiModelApi } from './types.js';

interface PiCatalogRow {
  id: string;
  name?: string;
  api?: string;
  provider: string;
  contextWindow: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>> | null;
  cost?: ModelCost;
}

const PI_CATALOG = piModelCatalogJson as unknown as {
  generatedAt: string;
  providers: Record<string, PiCatalogRow[]>;
};

function catalogEfforts(row: PiCatalogRow): Effort[] {
  if (!row.reasoning || !row.thinkingLevelMap) return [];
  return PI_REASONING_EFFORTS.filter((effort) => row.thinkingLevelMap?.[effort] != null);
}

function defaultEffort(efforts: readonly Effort[]): Effort | null {
  if (efforts.length === 0) return null;
  for (const effort of ['medium', 'high', 'low', 'xhigh', 'max', 'minimal'] as const) {
    if (efforts.includes(effort)) return effort;
  }
  return efforts[0] ?? null;
}

function portablePiApi(api: string | undefined): PiModelApi | undefined {
  switch (api) {
    case 'anthropic-messages':
    case 'openai-responses':
    case 'openai-completions':
    case 'google-generative-ai':
      return api;
    default:
      return undefined;
  }
}

/**
 * Convert Pi's pinned native catalog into Cindy's Pi-only membership list.
 *
 * The OpenAI subscription route keeps Cindy's `chatgpt/` identity prefix, while its native
 * `openai-codex-responses` transport remains in the raw snapshot for pi-host to materialize.
 */
export function piNativeCatalogModels(
  piProviderId: string,
  options: { idPrefix?: string; group?: string } = {},
): CatalogModel[] {
  const rows = PI_CATALOG.providers[piProviderId];
  if (!rows) {
    throw new Error(`[model-providers] Pi catalog missing provider '${piProviderId}'`);
  }
  return rows.map((row, index) => {
    if (
      row.provider !== piProviderId ||
      !Number.isFinite(row.contextWindow) ||
      row.contextWindow <= 0
    ) {
      throw new Error(`[model-providers] invalid Pi catalog row '${piProviderId}/${row.id}'`);
    }
    const efforts = catalogEfforts(row);
    const piApi = portablePiApi(row.api);
    return {
      id: `${options.idPrefix ?? ''}${row.id}`,
      name: row.name ?? row.id,
      ...(options.group ? { group: options.group } : {}),
      sortOrder: index,
      contextWindow: row.contextWindow,
      contextWindowVerified: true,
      ...(Number.isFinite(row.maxTokens) && row.maxTokens! > 0 ? { maxOutput: row.maxTokens } : {}),
      efforts,
      defaultEffort: defaultEffort(efforts),
      status: 'active',
      ...(row.input?.includes('image') ? { supportsImageInput: true } : {}),
      ...(row.cost ? { cost: row.cost } : {}),
      ...(piApi ? { piApi } : {}),
    };
  });
}
