/**
 * 本机模型运行时契约（Ollama 托管 + 其它本机连接预设）。
 *
 * 安全边界：renderer 只传 runtime / 操作枚举和已校验的模型名；
 * URL、路径、shell 一律由 Main 写死。
 *
 * 精选目录来自活动 Registry V4；缺少该字段时使用随包快照。
 * 筛选与运行操作留在客户端，服务端仅下发经过校验的数据。
 */

import {
  BUNDLED_CATALOG,
  parseLocalModelCatalog,
  type LocalModelCatalog,
  type LocalCatalogModel,
  type LocalModelVariant,
} from '@cindy/model-providers';

export const MANAGED_OLLAMA_PROVIDER_ID = 'cindy-local-ollama';
export const MANAGED_LMSTUDIO_PROVIDER_ID = 'cindy-local-lmstudio';

export const OLLAMA_LOOPBACK_ORIGIN = 'http://127.0.0.1:11434';
export const OLLAMA_OPENAI_BASE_URL = `${OLLAMA_LOOPBACK_ORIGIN}/v1`;
export const OLLAMA_ANTHROPIC_BASE_URL = OLLAMA_LOOPBACK_ORIGIN;
export const LMSTUDIO_LOOPBACK_ORIGIN = 'http://127.0.0.1:1234';
export const LMSTUDIO_OPENAI_BASE_URL = `${LMSTUDIO_LOOPBACK_ORIGIN}/v1`;
export const LMSTUDIO_ANTHROPIC_BASE_URL = LMSTUDIO_LOOPBACK_ORIGIN;
export const LLAMACPP_OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1';
export const VLLM_OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1';
export const LITELLM_OPENAI_BASE_URL = 'http://127.0.0.1:4000/v1';

export const LOCAL_CONNECT_PRESET_IDS = ['lmstudio'] as const;
export const LOCAL_ADVANCED_PRESET_IDS = ['llamacpp', 'vllm', 'litellm'] as const;

const LOCAL_RUNTIME_BETA_IDS = new Set<string>([
  MANAGED_OLLAMA_PROVIDER_ID,
  MANAGED_LMSTUDIO_PROVIDER_ID,
  'ollama',
  'lmstudio',
  'llamacpp',
  'llama-cpp',
  'vllm',
]);

/** 本机运行时接入仍是 beta：向导、列表、详情共用这一份 id。 */
export function isLocalRuntimeBetaProviderId(id: string): boolean {
  if (LOCAL_RUNTIME_BETA_IDS.has(id)) return true;
  return /^(llama-cpp|vllm)-\d+$/.test(id);
}

export const MAC_OLLAMA_APP_PATH = '/Applications/Ollama.app';
export const MAC_OPEN_BIN = '/usr/bin/open';

/** 策展条目：官方 `name[:tag]`，或 Ollama 可 pull 的 `hf.co/owner/repo[:quant]`。 */
export const OLLAMA_CURATED_LIBRARY_NAME_RE =
  /^(?:hf\.co\/[a-zA-Z0-9._-]{1,128}\/[a-zA-Z0-9._-]{1,128}|[a-zA-Z0-9._-]{1,128})(?::[a-zA-Z0-9._-]{1,128})?$/;
const OLLAMA_NAME_SEGMENT = '[a-zA-Z0-9._-]{1,128}';
/** 官方库名，或用户粘贴后归一化的 `hf.co/owner/repo[:quant]`。 */
export const OLLAMA_MODEL_NAME_RE = new RegExp(
  `^(?:hf\\.co\\/${OLLAMA_NAME_SEGMENT}\\/${OLLAMA_NAME_SEGMENT}|${OLLAMA_NAME_SEGMENT}(?:\\/${OLLAMA_NAME_SEGMENT})?)(?::${OLLAMA_NAME_SEGMENT})?$`,
);
export const MAX_CURATED_OLLAMA_MODELS = 32;

export type LocalRuntimeId = 'ollama';

export type LocalRuntimeStateKind =
  | 'absent'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'incompatible'
  | 'port-conflict'
  | 'pulling'
  | 'error';

export type LocalModelIpcOp =
  | 'status'
  | 'start'
  | 'list'
  | 'pull'
  | 'ensureProvider'
  | 'setModelInPicker'
  | 'delete'
  | 'discardPaused'
  | 'install';

export interface LocalRuntimeStatus {
  runtime: LocalRuntimeId;
  kind: LocalRuntimeStateKind;
  appInstalled: boolean;
  canInstallRuntime?: boolean;
  version?: string;
  message?: string;
}

export type LocalRuntimeInstallPhase =
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'starting'
  | 'success'
  | 'error'
  | 'cancelled';

export interface LocalRuntimeInstallProgress {
  phase: LocalRuntimeInstallPhase;
  version?: string;
  completed?: number;
  total?: number;
  percent?: number;
  bytesPerSecond?: number;
  done: boolean;
  error?: string;
}

export interface LocalInstalledModel {
  name: string;
  sizeBytes?: number;
  digest?: string;
  contextLength?: number;
  inCindy: boolean;
}

export interface RecommendedLocalModel {
  id: string;
  name: string;
  libraryName: string;
  sizeBytes: number;
  minUnifiedMemoryGb: number;
  appleSiliconOnly: boolean;
}

export interface CuratedOllamaModel extends RecommendedLocalModel {
  aliases: string[];
  descriptions?: LocalCatalogModel['descriptions'];
  runtimeProfile?: LocalCatalogModel['runtimeProfile'];
}

export type OllamaPackaging = 'mxfp8' | 'mlx' | 'q4';

/** 从库名读出用户能看见的封装，MXFP8 / MLX / 官方 Q4。 */
export function detectOllamaPackaging(libraryName: string): OllamaPackaging | null {
  const lowered = libraryName.trim().toLowerCase();
  const tag = lowered.includes(':') ? lowered.slice(lowered.lastIndexOf(':') + 1) : lowered;
  if (tag.includes('mxfp8')) return 'mxfp8';
  if (/(?:^|[-_.])mlx(?:$|[-_.])/.test(tag)) return 'mlx';
  if (lowered === 'qwen3.8:27b') return 'q4';
  return null;
}

export type LocalModelPullPhase =
  | 'starting'
  | 'manifest'
  | 'downloading'
  | 'verifying'
  | 'writing'
  | 'success'
  | 'error'
  | 'paused'
  | 'cancelled';

export interface LocalModelPullProgress {
  name: string;
  status: string;
  phase: LocalModelPullPhase;
  completed?: number;
  total?: number;
  percent?: number;
  bytesPerSecond?: number;
  done: boolean;
  error?: string;
}

export type OllamaPullErrorKind = 'not-gguf' | 'not-found' | 'unauthorized' | 'refused' | 'generic';

const OLLAMA_PULL_ERROR_KINDS = new Set<OllamaPullErrorKind>([
  'not-gguf',
  'not-found',
  'unauthorized',
  'refused',
  'generic',
]);

function pullErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** Hugging Face 上的 MLX 仓库 Ollama 拉不下来；官方库里的 `:mlx` 量化除外。 */
export function isHfMlxPullName(name: string): boolean {
  if (!name.startsWith('hf.co/')) return false;
  const repo = name.slice(name.lastIndexOf('/') + 1).split(':')[0] ?? '';
  return /mlx/i.test(repo) && !/gguf/i.test(name);
}

export function classifyOllamaPullError(value: unknown, pullName?: string): OllamaPullErrorKind {
  if (typeof value === 'string' && OLLAMA_PULL_ERROR_KINDS.has(value as OllamaPullErrorKind)) {
    return value as OllamaPullErrorKind;
  }
  if (pullName && isHfMlxPullName(pullName)) return 'not-gguf';
  const text = pullErrorText(value).toLowerCase();
  if (text.includes('not gguf') || text.includes('not compatible with llama.cpp')) {
    return 'not-gguf';
  }
  if (
    text.includes('401') ||
    text.includes('unauthorized') ||
    text.includes('gated') ||
    text.includes('access denied')
  ) {
    return 'unauthorized';
  }
  if (
    text.includes('404') ||
    text.includes('not found') ||
    text.includes('file does not exist') ||
    text.includes('no such host')
  ) {
    return 'not-found';
  }
  if (
    text.includes('not reachable') ||
    text.includes('econnrefused') ||
    text.includes('connection refused')
  ) {
    return 'refused';
  }
  return 'generic';
}

export function classifyOllamaPullStatus(status: string): LocalModelPullPhase {
  const value = status.toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'error';
  if (value.includes('success')) return 'success';
  if (value.includes('manifest') && value.includes('pull')) return 'manifest';
  if (value.includes('verif')) return 'verifying';
  if (value.includes('writ')) return 'writing';
  if (value.includes('download') || value.includes('pulling')) return 'downloading';
  if (value.includes('start')) return 'starting';
  return 'downloading';
}

export interface LocalModelRecommendInput {
  platform: NodeJS.Platform;
  arch: string;
  totalmemBytes: number;
}

const GIB = 1024 * 1024 * 1024;

const BUNDLED_CURATED_CATALOG = BUNDLED_CATALOG.modelRegistry!.localModels!;

function recommendedFromTag(
  id: string,
  name: string,
  spec: LocalModelVariant,
): RecommendedLocalModel {
  return { id, name, ...spec, appleSiliconOnly: spec.appleSiliconOnly === true };
}
// Runtime support is client-owned and survives withdrawal from the catalog.
export const QWEN38_CURATED_TAGS = new Set(['qwen3.8:27b', 'qwen3.8:27b-mlx', 'qwen3.8:27b-mxfp8']);

export function isOllamaModelName(value: unknown): value is string {
  return typeof value === 'string' && OLLAMA_MODEL_NAME_RE.test(value);
}

export function isCuratedOllamaLibraryName(value: unknown): value is string {
  return typeof value === 'string' && OLLAMA_CURATED_LIBRARY_NAME_RE.test(value);
}

const HF_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * 把用户粘贴的 Hugging Face 网址或 `hf.co/...` 收成 Ollama 可 pull 的库名。
 * 策展推荐仍只用官方 tag；这条路只服务手动下载。
 */
export function normalizeOllamaPullName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isOllamaModelName(trimmed)) return trimmed;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'huggingface.co' && host !== 'www.huggingface.co' && host !== 'hf.co') {
    return null;
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0] === 'models') parts.shift();
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || !HF_REPO_SEGMENT.test(owner) || !HF_REPO_SEGMENT.test(repo)) {
    return null;
  }
  if (['datasets', 'spaces', 'organizations', 'login'].includes(owner.toLowerCase())) {
    return null;
  }

  let quant: string | undefined;
  const blobIndex = parts.findIndex(
    (part) => part === 'blob' || part === 'tree' || part === 'resolve',
  );
  if (blobIndex >= 0 && parts[blobIndex + 2]) {
    const file = parts[blobIndex + 2] ?? '';
    const match = file.match(/[-_.]([Qq]\d[\w.-]*|UD-[\w.-]+|iq\d[\w.-]*)\.gguf$/i);
    if (match?.[1]) quant = match[1];
  }
  const queryQuant = parsed.searchParams.get('quant') ?? parsed.searchParams.get('tag');
  if (!quant && queryQuant && HF_REPO_SEGMENT.test(queryQuant)) quant = queryQuant;

  const name = `hf.co/${owner}/${repo}${quant ? `:${quant}` : ''}`;
  return isOllamaModelName(name) ? name : null;
}

/**
 * Ollama 无 tag 时默认 `:latest`。比较 `/api/tags`、进行中 pull 和暂停记录时只走这里。
 */
export function canonicalOllamaModelRef(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  const slash = trimmed.lastIndexOf('/');
  const local = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (local.includes(':')) return trimmed;
  return `${trimmed}:latest`;
}

export function ollamaModelRefsEqual(left: string, right: string): boolean {
  return canonicalOllamaModelRef(left) === canonicalOllamaModelRef(right);
}

export function parseOllamaVersion(value: string): [number, number, number] {
  const match = value.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function ollamaVersionGte(actual: string, need: string): boolean {
  const left = parseOllamaVersion(actual);
  const right = parseOllamaVersion(need);
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! > right[i]!) return true;
    if (left[i]! < right[i]!) return false;
  }
  return true;
}

export function resolveManagedOllamaAgents(input: {
  version?: string;
  capabilities?: string[];
  requires?: string;
}): Array<'pi' | 'claude-code' | 'codex'> {
  const agents: Array<'pi' | 'claude-code' | 'codex'> = ['pi'];
  if (input.requires && input.version && !ollamaVersionGte(input.version, input.requires)) {
    return agents;
  }
  const caps = new Set((input.capabilities ?? []).map((value) => value.toLowerCase()));
  const toolsOk = caps.has('tools');
  if (toolsOk && (!input.version || ollamaVersionGte(input.version, '0.14.0'))) {
    agents.push('claude-code');
  }
  if (toolsOk && (!input.version || ollamaVersionGte(input.version, '0.13.3'))) {
    agents.push('codex');
  }
  return agents;
}

export function isManagedLocalProviderId(id: string): boolean {
  return id === MANAGED_OLLAMA_PROVIDER_ID || id === MANAGED_LMSTUDIO_PROVIDER_ID;
}

export function isAppleSilicon(
  input: Pick<LocalModelRecommendInput, 'platform' | 'arch'>,
): boolean {
  return input.platform === 'darwin' && input.arch === 'arm64';
}

export function unifiedMemoryGb(totalmemBytes: number): number {
  if (!Number.isFinite(totalmemBytes) || totalmemBytes <= 0) return 0;
  return Math.floor(totalmemBytes / GIB);
}

export function isCuratedQwen38Tag(name: string): boolean {
  return QWEN38_CURATED_TAGS.has(name);
}

export function resolveCuratedCatalogSpec(remote?: unknown): LocalModelCatalog {
  return parseLocalModelCatalog(remote) ?? BUNDLED_CURATED_CATALOG;
}

export function findCuratedOllamaModel(
  name: string,
  remote?: unknown,
): LocalCatalogModel | undefined {
  return resolveCuratedCatalogSpec(remote).models.find((m) =>
    m.variants.some((v) => ollamaModelRefsEqual(v.libraryName, name)),
  );
}

export function curatedOllamaDisplayName(name: string, remote?: unknown): string | undefined {
  return findCuratedOllamaModel(name, remote)?.name;
}

/** Ordered variants express packaging preference; hardware fit is always checked locally. */
export function resolveCuratedOllamaCatalog(
  input: LocalModelRecommendInput,
  remote?: unknown,
): CuratedOllamaModel[] {
  const apple = isAppleSilicon(input);
  const memory = unifiedMemoryGb(input.totalmemBytes);
  return resolveCuratedCatalogSpec(remote).models.flatMap((model) => {
    const variants = model.variants.filter((v) => apple || !v.appleSiliconOnly);
    const variant =
      variants.find((v) => memory >= v.minUnifiedMemoryGb) ??
      [...variants].sort((a, b) => a.minUnifiedMemoryGb - b.minUnifiedMemoryGb)[0];
    if (!variant) return [];
    return [
      {
        ...recommendedFromTag(model.id, model.name, variant),
        aliases: model.aliases,
        descriptions: model.descriptions,
        runtimeProfile: model.runtimeProfile,
      },
    ];
  });
}
function fits(model: CuratedOllamaModel, memoryGb: number): boolean {
  return memoryGb >= model.minUnifiedMemoryGb;
}

export type LocalRecommendReason =
  'apple-mxfp8' | 'apple-mlx' | 'generic-27b' | 'compact' | 'unknown';

export interface HostModelRecommendation {
  primary: CuratedOllamaModel | null;
  secondary: CuratedOllamaModel | null;
  reason: LocalRecommendReason;
  appleSilicon: boolean;
  memoryGb: number;
}

/** 只从有证据的推荐名单中按内存选择；候选目录不能自动补位。 */
export function recommendForHost(
  input: LocalModelRecommendInput,
  remote?: unknown,
): HostModelRecommendation {
  const spec = resolveCuratedCatalogSpec(remote);
  const catalog = resolveCuratedOllamaCatalog(input, remote);
  const memoryGb = unifiedMemoryGb(input.totalmemBytes);
  const appleSilicon = isAppleSilicon(input);
  const byId = (id: string) => catalog.find((entry) => entry.id === id);
  const primary =
    memoryGb > 0
      ? (spec.featuredIds.map(byId).find((entry) => entry && fits(entry, memoryGb)) ?? null)
      : null;
  let reason: LocalRecommendReason = memoryGb > 0 ? 'compact' : 'unknown';
  if (primary?.id === 'qwen38-27b') {
    reason = !appleSilicon
      ? 'generic-27b'
      : primary.libraryName === 'qwen3.8:27b-mxfp8'
        ? 'apple-mxfp8'
        : 'apple-mlx';
  }
  const coder = spec.featuredIds
    .map(byId)
    .find((entry) => entry && entry.id !== primary?.id && fits(entry, memoryGb));
  const secondary =
    primary && coder && coder.id !== primary.id && fits(coder, memoryGb) ? coder : null;
  return { primary, secondary, reason, appleSilicon, memoryGb };
}

/** 推荐区只展示有依据且内存适配的选择，允许为空。 */
export function pickFeaturedOllamaModels(
  input: LocalModelRecommendInput,
  remote?: unknown,
): CuratedOllamaModel[] {
  const recommendation = recommendForHost(input, remote);
  return [recommendation.primary, recommendation.secondary].filter(
    (entry): entry is CuratedOllamaModel => Boolean(entry),
  );
}

export function resolveOllamaModelLists(
  input: LocalModelRecommendInput,
  remote?: unknown,
): {
  featured: CuratedOllamaModel[];
  catalog: CuratedOllamaModel[];
  memoryGb: number;
  recommendReason: LocalRecommendReason;
  appleSilicon: boolean;
} {
  const catalog = resolveCuratedOllamaCatalog(input, remote);
  const recommendation = recommendForHost(input, remote);
  return {
    catalog,
    memoryGb: recommendation.memoryGb,
    featured: [recommendation.primary, recommendation.secondary].filter(
      (entry): entry is CuratedOllamaModel => Boolean(entry),
    ),
    recommendReason: recommendation.reason,
    appleSilicon: recommendation.appleSilicon,
  };
}

export function filterCuratedOllamaModels(
  catalog: readonly CuratedOllamaModel[],
  query: string,
): CuratedOllamaModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...catalog];
  return catalog.filter((model) => {
    const haystack = [model.id, model.name, model.libraryName, ...model.aliases]
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface ManagedOllamaFingerprint {
  id: typeof MANAGED_OLLAMA_PROVIDER_ID;
  authMethod: 'none';
  piBaseUrl: typeof OLLAMA_OPENAI_BASE_URL;
  wireProtocol: 'openai-chat';
}

export const MANAGED_OLLAMA_FINGERPRINT: ManagedOllamaFingerprint = {
  id: MANAGED_OLLAMA_PROVIDER_ID,
  authMethod: 'none',
  piBaseUrl: OLLAMA_OPENAI_BASE_URL,
  wireProtocol: 'openai-chat',
};

type RuntimeShape = {
  baseUrl?: string;
  wireProtocol?: string;
  headers?: unknown;
  modelsUrl?: unknown;
  requestPath?: unknown;
  piCatalogProviderId?: unknown;
  models?: unknown;
};

function runtimeIsClean(
  runtime: RuntimeShape | undefined,
  expected: { baseUrl: string; wireProtocol: string },
): boolean {
  if (!runtime) return false;
  if (runtime.baseUrl !== expected.baseUrl) return false;
  if (runtime.wireProtocol !== undefined && runtime.wireProtocol !== expected.wireProtocol) {
    return false;
  }
  if (runtime.modelsUrl) return false;
  if (runtime.requestPath) return false;
  if (runtime.piCatalogProviderId) return false;
  if (
    runtime.headers &&
    typeof runtime.headers === 'object' &&
    Object.keys(runtime.headers).length > 0
  ) {
    return false;
  }
  if (
    Array.isArray(runtime.models) &&
    runtime.models.some(
      (entry) => entry && typeof entry === 'object' && 'route' in entry && entry.route,
    )
  ) {
    return false;
  }
  return true;
}

export function matchesLegacyPiOnlyOllamaFingerprint(input: {
  id: string;
  authMethod?: string;
  runtimes?: Partial<Record<string, RuntimeShape>>;
}): boolean {
  if (input.id !== MANAGED_OLLAMA_PROVIDER_ID) return false;
  if ((input.authMethod ?? 'none') !== 'none') return false;
  const runtimeKeys = Object.keys(input.runtimes ?? {});
  if (runtimeKeys.some((key) => key !== 'pi')) return false;
  return runtimeIsClean(input.runtimes?.pi, {
    baseUrl: OLLAMA_OPENAI_BASE_URL,
    wireProtocol: 'openai-chat',
  });
}

export function matchesManagedOllamaV2Fingerprint(input: {
  id: string;
  authMethod?: string;
  runtimes?: Partial<Record<string, RuntimeShape>>;
}): boolean {
  if (input.id !== MANAGED_OLLAMA_PROVIDER_ID) return false;
  if ((input.authMethod ?? 'none') !== 'none') return false;
  const runtimeKeys = Object.keys(input.runtimes ?? {});
  if (runtimeKeys.some((key) => key !== 'pi' && key !== 'claude-code' && key !== 'codex')) {
    return false;
  }
  return (
    runtimeIsClean(input.runtimes?.pi, {
      baseUrl: OLLAMA_OPENAI_BASE_URL,
      wireProtocol: 'openai-chat',
    }) &&
    runtimeIsClean(input.runtimes?.['claude-code'], {
      baseUrl: OLLAMA_ANTHROPIC_BASE_URL,
      wireProtocol: 'anthropic-messages',
    }) &&
    (runtimeIsClean(input.runtimes?.codex, {
      baseUrl: OLLAMA_OPENAI_BASE_URL,
      wireProtocol: 'openai-chat',
    }) ||
      runtimeIsClean(input.runtimes?.codex, {
        baseUrl: OLLAMA_OPENAI_BASE_URL,
        wireProtocol: 'openai-responses',
      }))
  );
}

export function matchesManagedOllamaFingerprint(input: {
  id: string;
  authMethod?: string;
  runtimes?: Partial<Record<string, RuntimeShape>>;
}): boolean {
  return matchesLegacyPiOnlyOllamaFingerprint(input) || matchesManagedOllamaV2Fingerprint(input);
}
