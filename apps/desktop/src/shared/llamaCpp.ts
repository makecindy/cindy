import type { LocalCatalogModel, LocalGgufVariant } from '@cindy/model-providers';

/** Managed llama.cpp uses its own loopback port; existing user servers stay independent. */
export const MANAGED_LLAMACPP_PROVIDER_ID = 'cindy-local-llamacpp';
export const LLAMACPP_MANAGED_PORT = 11435;
export const LLAMACPP_MANAGED_ORIGIN = `http://127.0.0.1:${LLAMACPP_MANAGED_PORT}`;
export const LLAMACPP_DEFAULT_CONTEXT = 32768;

/** Explicit Flash-Next trial setting; do not extend unrelated/unknown GGUF models. */
export function llamaCppContextSize(model: Pick<LlamaCppModel, 'repo'>): number {
  return supportsLlamaCppMillionContext(model) ? 262144 : LLAMACPP_DEFAULT_CONTEXT;
}

export function supportsLlamaCppMillionContext(model: Pick<LlamaCppModel, 'repo'>): boolean {
  return model.repo === 'bartowski/Qwen3.8-Flash-Next-GGUF';
}

/** Only the explicitly verified packaging opts into an expanded runtime window. */
export function llamaCppMaxContextSize(model: Pick<LlamaCppModel, 'repo'>): number {
  return supportsLlamaCppMillionContext(model) ? 1_000_000 : LLAMACPP_DEFAULT_CONTEXT;
}

/** One server is shared by all harnesses; allocate enough for every saved working budget. */
export function llamaCppModelPreset(
  model: LlamaCppModel,
  limits: Record<string, number>,
): string[] {
  const requested = ['pi', 'codex', 'claude-code']
    .map((agent) => limits[`${agent}:${MANAGED_LLAMACPP_PROVIDER_ID}:${model.id}`])
    .filter((value): value is number => Number.isSafeInteger(value) && value! >= 1000);
  const context = Math.max(llamaCppContextSize(model), ...requested);
  const extended = supportsLlamaCppMillionContext(model) && context > 262144;
  if (context > llamaCppMaxContextSize(model)) throw new Error('INVALID_MODEL_CONTEXT');
  return [
    `[${model.id}]`,
    `ctx-size = ${context}`,
    ...(extended ? ['rope-scaling = yarn', 'rope-scale = 4', 'yarn-orig-ctx = 262144'] : []),
  ];
}

export interface LlamaCppFile {
  name: string;
  size: number;
}
export interface LlamaCppModel {
  id: string;
  repo: string;
  file: string;
  size: number;
}
export interface LlamaCppSnapshot {
  installed: boolean;
  supported: boolean;
  running: boolean;
  /** Only the instance owning the child can expose stop/restart controls. */
  canManageRuntime?: boolean;
  canPauseDownload?: boolean;
  version?: string;
  models: LlamaCppModel[];
  catalog?: LlamaCppCatalogEntry[];
  recommendation?: {
    /** Model-level shortlist, not a llama.cpp benchmark or peak-memory guarantee. */
    featuredIds: string[];
    memoryGb: number;
    appleSilicon: boolean;
    chip?: string;
  };
  operation?: {
    kind: 'install' | 'download' | 'start';
    model?: LlamaCppDownloadInput;
    bytesPerSecond?: number;
    paused?: boolean;
    completed: number;
    total: number;
  };
}
export interface LlamaCppCatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  descriptions?: LocalCatalogModel['descriptions'];
  variants: LocalGgufVariant[];
}
export interface LlamaCppDownloadInput {
  repo: string;
  file: string;
}

/** Repository IDs, never local paths, URLs, revisions or arbitrary CLI arguments. */
export function validLlamaCppRepo(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value)
  );
}
export function validLlamaCppFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    value.split('/').every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)) &&
    value.endsWith('.gguf') &&
    !/^(mmproj|mtp|dflash)[-_.]/i.test(value.split('/').at(-1)!)
  );
}
