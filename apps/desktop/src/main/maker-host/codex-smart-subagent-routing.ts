import fs from 'node:fs';
import path from 'node:path';

import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  isModelSelectableForNewRoute,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import type {
  CodexSmartSubagentConfig,
  CodexSubagentRouteSnapshot,
} from './codex-subagent-config.js';

const SMART_CATALOG_FILE = 'cindy-smart-subagent-models.json';
const MAX_ADDITIONAL_MODELS = 8;
const NATIVE_V2_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra']);

interface CodexCatalogRecord extends Record<string, unknown> {
  slug: string;
  display_name?: string;
  priority?: number;
  multi_agent_version?: string | null;
}

function fullPromptCompatibility(modelId: string): Record<string, unknown> {
  if (/(?:^|\/)gpt-\d[^/]*$/i.test(modelId)) return {};
  return {
    use_responses_lite: false,
    tool_mode: null,
    include_skills_usage_instructions: true,
  };
}

export interface SmartCandidate {
  providerId: string;
  model: CatalogModel;
}

function finiteCost(model: CatalogModel): number {
  const input = typeof model.cost?.input === 'number' ? model.cost.input : 0;
  const output = typeof model.cost?.output === 'number' ? model.cost.output : 0;
  return input > 0 || output > 0 ? input + output : Number.POSITIVE_INFINITY;
}

function candidateRank(candidate: SmartCandidate): readonly [number, number, number, string] {
  const id = candidate.model.id;
  const familyRank = id.includes('luna')
    ? 0
    : candidate.model.group === 'gpt-budget'
      ? 1
      : candidate.model.group === 'china'
        ? 2
        : 3;
  return [
    familyRank,
    finiteCost(candidate.model),
    candidate.model.sortOrder ?? Number.POSITIVE_INFINITY,
    id,
  ];
}

function compareCandidates(a: SmartCandidate, b: SmartCandidate): number {
  const left = candidateRank(a);
  const right = candidateRank(b);
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    if (l === r) continue;
    return l < r ? -1 : 1;
  }
  return a.providerId.localeCompare(b.providerId);
}

export function selectCodexSmartSubagentCandidates(
  providerViews: readonly ProviderView[],
  opts: { allowChatGptOAuth: boolean },
): SmartCandidate[] {
  const connected = connectedProvidersForAgent([...providerViews], 'codex').filter(
    (provider) =>
      opts.allowChatGptOAuth || provider.routing.codex?.authStrategy !== 'oauth-passthrough',
  );
  const ids = new Set<string>();
  for (const provider of connected) {
    for (const model of provider.models.codex ?? []) {
      if (NATIVE_V2_MODELS.has(model.id)) continue;
      if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
        continue;
      }
      if (model.capabilities?.toolCall === false) continue;
      ids.add(model.id);
    }
  }

  const candidates: SmartCandidate[] = [];
  for (const modelId of ids) {
    const providerId = effectiveSourceIdForModel(connected, null, modelId, 'codex');
    const provider = connected.find((entry) => entry.id === providerId);
    const model = provider ? getModel(provider, modelId, 'codex') : undefined;
    if (!provider || !model) continue;
    candidates.push({ providerId: provider.id, model });
  }
  return candidates.sort(compareCandidates).slice(0, MAX_ADDITIONAL_MODELS);
}

export function codexSmartSubagentRoutingSignature(
  candidates: readonly SmartCandidate[],
  catalogRevision: number,
): string | null {
  if (candidates.length === 0) return null;
  return `smart:${catalogRevision}:${JSON.stringify(candidates.map(({ providerId, model }) => [providerId, model.id]))}`;
}

function reasoningLevels(model: CatalogModel, fallback: unknown): unknown {
  if (model.efforts.length === 0) return fallback;
  return model.efforts.map((effort) => ({
    effort,
    description: `${model.name} ${effort} reasoning`,
  }));
}

export function buildCodexSmartModelCatalog(
  rawCatalog: unknown,
  candidates: readonly SmartCandidate[],
): { models: CodexCatalogRecord[]; routes: CodexSubagentRouteSnapshot[] } | null {
  if (!rawCatalog || typeof rawCatalog !== 'object' || Array.isArray(rawCatalog)) return null;
  const rawModels = (rawCatalog as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return null;
  const models = rawModels.filter(
    (entry): entry is CodexCatalogRecord =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as { slug?: unknown }).slug === 'string',
  );
  const template =
    models.find((model) => model.slug === 'gpt-5.6-terra') ??
    models.find((model) => model.slug === 'gpt-5.6-sol') ??
    models.find((model) => model.multi_agent_version === 'v2');
  if (!template) return null;

  const bySlug = new Map(models.map((model) => [model.slug, model]));
  const candidateBySlug = new Map(candidates.map((candidate) => [candidate.model.id, candidate]));
  const nextModels = models.map((record) => {
    const candidate = candidateBySlug.get(record.slug);
    if (!candidate) return record;
    // Native subscription models already carry their own multi-agent contract.
    // In particular, max_context_window can exceed the default context_window.
    if (candidate.providerId === 'openai' && record.multi_agent_version === 'v2') return record;
    return {
      ...record,
      display_name: candidate.model.name,
      description: candidate.model.description ?? record.description,
      context_window: candidate.model.contextWindow,
      max_context_window: candidate.model.contextWindow,
      default_reasoning_level: candidate.model.defaultEffort ?? record.default_reasoning_level,
      supported_reasoning_levels: reasoningLevels(
        candidate.model,
        record.supported_reasoning_levels,
      ),
      ...fullPromptCompatibility(candidate.model.id),
      multi_agent_version: 'v2',
      visibility: 'list',
      supported_in_api: true,
    };
  });

  let priority =
    Math.max(
      8,
      ...nextModels.map((record) => (typeof record.priority === 'number' ? record.priority : 0)),
    ) + 1;
  for (const candidate of candidates) {
    if (bySlug.has(candidate.model.id)) continue;
    nextModels.push({
      ...template,
      slug: candidate.model.id,
      display_name: candidate.model.name,
      description:
        candidate.model.description ?? `Cindy smart Subagent route for ${candidate.model.name}`,
      priority,
      context_window: candidate.model.contextWindow,
      max_context_window: candidate.model.contextWindow,
      default_reasoning_level: candidate.model.defaultEffort ?? template.default_reasoning_level,
      supported_reasoning_levels: reasoningLevels(
        candidate.model,
        template.supported_reasoning_levels,
      ),
      ...fullPromptCompatibility(candidate.model.id),
      multi_agent_version: 'v2',
      visibility: 'list',
      supported_in_api: true,
      upgrade: null,
    });
    priority += 1;
  }

  return {
    models: nextModels,
    routes: candidates.map((candidate) => ({
      providerId: candidate.providerId,
      catalogModel: candidate.model.id,
    })),
  };
}

export function prepareCodexSmartSubagentConfig(args: {
  codexHome: string;
  providerViews: readonly ProviderView[];
  allowChatGptOAuth: boolean;
  catalogRevision: number;
}): CodexSmartSubagentConfig | null {
  const candidates = selectCodexSmartSubagentCandidates(args.providerViews, {
    allowChatGptOAuth: args.allowChatGptOAuth,
  });
  if (candidates.length === 0) return null;
  const sourcePath = path.join(args.codexHome, 'models_cache.json');
  const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8')) as unknown;
  const built = buildCodexSmartModelCatalog(raw, candidates);
  if (!built || built.routes.length === 0) return null;
  const catalogPath = path.join(args.codexHome, SMART_CATALOG_FILE);
  atomicWriteFileSync(catalogPath, `${JSON.stringify({ models: built.models }, null, 2)}\n`);
  return {
    catalogPath,
    modelCatalog: { models: built.models },
    routes: built.routes,
    routingSignature: codexSmartSubagentRoutingSignature(candidates, args.catalogRevision)!,
  };
}
