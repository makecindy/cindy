/**
 * 本机模型运行时契约（Ollama 托管 + 其它本机连接预设）。
 *
 * 安全边界：renderer 只传 runtime / 操作枚举和已校验的模型名；
 * URL、路径、shell 一律由 Main 写死。
 *
 * 精选目录是纯数据（`ollamaCuratedCatalog.json`）。挑选算法和库名白名单留在本文件，
 * 以后这份 JSON 可以改由 `/api/model-catalog/catalog` 下发；未知根字段现在不能写进
 * Catalog schema，所以本 PR 不改热更协议。
 */

import curatedCatalogJson from './ollamaCuratedCatalog.json' with { type: 'json' };

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

export type OllamaPullErrorKind =
  | 'not-gguf'
  | 'not-found'
  | 'unauthorized'
  | 'refused'
  | 'generic';

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

export function classifyOllamaPullError(
  value: unknown,
  pullName?: string,
): OllamaPullErrorKind {
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

interface CuratedTagSpec {
  libraryName: string;
  sizeBytes: number;
  minUnifiedMemoryGb: number;
  appleSiliconOnly?: boolean;
}

interface CuratedModelSpec {
  id: string;
  name: string;
  libraryName: string;
  appleLibraryName?: string;
  aliases: string[];
  sizeBytes: number;
  minUnifiedMemoryGb: number;
}

interface CuratedCatalogSpec {
  version: number;
  qwen38: {
    id: string;
    name: string;
    aliases: string[];
    mxfp8: CuratedTagSpec;
    mlx: CuratedTagSpec;
    generic: CuratedTagSpec;
  };
  featuredIds: string[];
  featuredCoderId?: string;
  models: CuratedModelSpec[];
}

function recommendedFromTag(
  id: string,
  name: string,
  spec: CuratedTagSpec,
): RecommendedLocalModel {
  return {
    id,
    name,
    libraryName: spec.libraryName,
    sizeBytes: spec.sizeBytes,
    minUnifiedMemoryGb: spec.minUnifiedMemoryGb,
    appleSiliconOnly: spec.appleSiliconOnly === true,
  };
}

const BUNDLED_CURATED_CATALOG = curatedCatalogJson as CuratedCatalogSpec;

export const QWEN38_MXFP8: RecommendedLocalModel = recommendedFromTag(
  BUNDLED_CURATED_CATALOG.qwen38.mxfp8.libraryName,
  BUNDLED_CURATED_CATALOG.qwen38.name,
  BUNDLED_CURATED_CATALOG.qwen38.mxfp8,
);

export const QWEN38_MLX: RecommendedLocalModel = recommendedFromTag(
  BUNDLED_CURATED_CATALOG.qwen38.mlx.libraryName,
  BUNDLED_CURATED_CATALOG.qwen38.name,
  BUNDLED_CURATED_CATALOG.qwen38.mlx,
);

export const QWEN38_CURATED_TAGS = new Set<string>([
  QWEN38_MXFP8.libraryName,
  QWEN38_MLX.libraryName,
  BUNDLED_CURATED_CATALOG.qwen38.generic.libraryName,
]);

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
  const blobIndex = parts.findIndex((part) => part === 'blob' || part === 'tree' || part === 'resolve');
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

/** 低于 32GB 统一内存不推荐 27B；MLX 仅 Apple Silicon。算法留在客户端，门槛来自策展数据。 */
export function recommendQwen38(
  input: LocalModelRecommendInput,
  remote?: unknown,
): RecommendedLocalModel | null {
  if (!isAppleSilicon(input)) return null;
  const spec = resolveCuratedCatalogSpec(remote);
  const gb = unifiedMemoryGb(input.totalmemBytes);
  if (gb >= spec.qwen38.mxfp8.minUnifiedMemoryGb) {
    return recommendedFromTag(spec.qwen38.mxfp8.libraryName, spec.qwen38.name, spec.qwen38.mxfp8);
  }
  if (gb >= spec.qwen38.mlx.minUnifiedMemoryGb) {
    return recommendedFromTag(spec.qwen38.mlx.libraryName, spec.qwen38.name, spec.qwen38.mlx);
  }
  return null;
}

export function isCuratedQwen38Tag(name: string): boolean {
  return QWEN38_CURATED_TAGS.has(name);
}

export function curatedOllamaDisplayName(libraryName: string): string | undefined {
  const catalogs = [
    resolveCuratedOllamaCatalog({
      platform: 'darwin',
      arch: 'arm64',
      totalmemBytes: 128 * GIB,
    }),
    resolveCuratedOllamaCatalog({
      platform: 'linux',
      arch: 'x64',
      totalmemBytes: 128 * GIB,
    }),
  ];
  for (const catalog of catalogs) {
    const exact = catalog.find((entry) => entry.libraryName === libraryName);
    if (exact) return exact.name;
  }
  const family = libraryName.split(':')[0] ?? libraryName;
  for (const catalog of catalogs) {
    const hit = catalog.find((entry) => (entry.libraryName.split(':')[0] ?? '') === family);
    if (hit) return hit.name;
  }
  return undefined;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function isSafeName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
}

function isSafeAlias(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 40;
}

function isSafeSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= GIB && value <= 256 * GIB;
}

function isSafeMemoryGb(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 4 && value <= 512;
}

function sanitizeTagSpec(raw: unknown): CuratedTagSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as CuratedTagSpec;
  if (!isCuratedOllamaLibraryName(spec.libraryName)) return null;
  if (!isSafeSize(spec.sizeBytes) || !isSafeMemoryGb(spec.minUnifiedMemoryGb)) return null;
  return {
    libraryName: spec.libraryName,
    sizeBytes: spec.sizeBytes,
    minUnifiedMemoryGb: spec.minUnifiedMemoryGb,
    ...(spec.appleSiliconOnly === true ? { appleSiliconOnly: true } : {}),
  };
}

function sanitizeModelSpec(raw: unknown): CuratedModelSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as CuratedModelSpec;
  if (!isSafeId(spec.id) || !isSafeName(spec.name)) return null;
  if (!isCuratedOllamaLibraryName(spec.libraryName)) return null;
  if (spec.appleLibraryName !== undefined && !isCuratedOllamaLibraryName(spec.appleLibraryName)) {
    return null;
  }
  if (!Array.isArray(spec.aliases) || spec.aliases.length > 16 || !spec.aliases.every(isSafeAlias)) {
    return null;
  }
  if (!isSafeSize(spec.sizeBytes) || !isSafeMemoryGb(spec.minUnifiedMemoryGb)) return null;
  return {
    id: spec.id,
    name: spec.name.trim(),
    libraryName: spec.libraryName,
    ...(spec.appleLibraryName ? { appleLibraryName: spec.appleLibraryName } : {}),
    aliases: spec.aliases.map((alias) => alias.trim()),
    sizeBytes: spec.sizeBytes,
    minUnifiedMemoryGb: spec.minUnifiedMemoryGb,
  };
}

function sanitizeCatalogSpec(raw: unknown): CuratedCatalogSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as CuratedCatalogSpec;
  if (spec.version !== 1) return null;
  if (!spec.qwen38 || !isSafeId(spec.qwen38.id) || !isSafeName(spec.qwen38.name)) return null;
  if (
    !Array.isArray(spec.qwen38.aliases) ||
    spec.qwen38.aliases.length > 16 ||
    !spec.qwen38.aliases.every(isSafeAlias)
  ) {
    return null;
  }
  const mxfp8 = sanitizeTagSpec(spec.qwen38.mxfp8);
  const mlx = sanitizeTagSpec(spec.qwen38.mlx);
  const generic = sanitizeTagSpec(spec.qwen38.generic);
  if (!mxfp8 || !mlx || !generic) return null;
  if (!Array.isArray(spec.featuredIds) || spec.featuredIds.length === 0 || spec.featuredIds.length > 8) {
    return null;
  }
  if (!spec.featuredIds.every(isSafeId)) return null;
  if (spec.featuredCoderId !== undefined && !isSafeId(spec.featuredCoderId)) return null;
  if (!Array.isArray(spec.models) || spec.models.length > MAX_CURATED_OLLAMA_MODELS) return null;
  const models: CuratedModelSpec[] = [];
  const seen = new Set<string>([spec.qwen38.id]);
  for (const entry of spec.models) {
    const model = sanitizeModelSpec(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return {
    version: 1,
    qwen38: {
      id: spec.qwen38.id,
      name: spec.qwen38.name.trim(),
      aliases: spec.qwen38.aliases.map((alias) => alias.trim()),
      mxfp8,
      mlx,
      generic,
    },
    featuredIds: spec.featuredIds,
    ...(spec.featuredCoderId ? { featuredCoderId: spec.featuredCoderId } : {}),
    models,
  };
}

function modelFromSpec(
  spec: CuratedModelSpec,
  apple: boolean,
): CuratedOllamaModel {
  const libraryName = apple && spec.appleLibraryName ? spec.appleLibraryName : spec.libraryName;
  return {
    id: spec.id,
    name: spec.name,
    libraryName,
    aliases: spec.aliases,
    sizeBytes: spec.sizeBytes,
    minUnifiedMemoryGb: spec.minUnifiedMemoryGb,
    appleSiliconOnly: apple && Boolean(spec.appleLibraryName),
  };
}

/**
 * 策展数据入口。现在只读 bundled JSON；以后可把 remote 换成 catalog section。
 * 远端/覆盖数据不合法时整表回落 bundled，挑选算法仍在客户端。
 */
export function resolveCuratedCatalogSpec(remote?: unknown): CuratedCatalogSpec {
  return sanitizeCatalogSpec(remote) ?? sanitizeCatalogSpec(BUNDLED_CURATED_CATALOG)!;
}

/** 可搜索目录：比推荐区更大，默认不展示。 */
export function resolveCuratedOllamaCatalog(
  input: LocalModelRecommendInput,
  remote?: unknown,
): CuratedOllamaModel[] {
  const spec = resolveCuratedCatalogSpec(remote);
  const apple = isAppleSilicon(input);
  const qwen38 =
    recommendQwen38(input, spec) ??
    recommendedFromTag(
      spec.qwen38.id,
      spec.qwen38.name,
      apple ? spec.qwen38.mlx : spec.qwen38.generic,
    );

  return [
    {
      ...qwen38,
      id: spec.qwen38.id,
      name: spec.qwen38.name,
      aliases: spec.qwen38.aliases,
    },
    ...spec.models.map((entry) => modelFromSpec(entry, apple)),
  ];
}

function fits(model: CuratedOllamaModel, memoryGb: number): boolean {
  return memoryGb >= model.minUnifiedMemoryGb;
}

export type LocalRecommendReason =
  | 'apple-mxfp8'
  | 'apple-mlx'
  | 'generic-27b'
  | 'compact'
  | 'unknown';

export interface HostModelRecommendation {
  primary: CuratedOllamaModel;
  secondary: CuratedOllamaModel | null;
  reason: LocalRecommendReason;
  appleSilicon: boolean;
  memoryGb: number;
}

function smallestByMemory(models: readonly CuratedOllamaModel[]): CuratedOllamaModel | undefined {
  return [...models].sort((left, right) => left.minUnifiedMemoryGb - right.minUnifiedMemoryGb)[0];
}

/** 每个用户一条主推：按芯片和内存选官方封装，绝不把跑不动的 27B 硬塞给小机器。 */
export function recommendForHost(
  input: LocalModelRecommendInput,
  remote?: unknown,
): HostModelRecommendation {
  const spec = resolveCuratedCatalogSpec(remote);
  const catalog = resolveCuratedOllamaCatalog(input, remote);
  const memoryGb = unifiedMemoryGb(input.totalmemBytes);
  const appleSilicon = isAppleSilicon(input);
  const byId = (id: string) => catalog.find((entry) => entry.id === id);
  const qwen = byId(spec.qwen38.id);

  let primary: CuratedOllamaModel | undefined;
  let reason: LocalRecommendReason = 'compact';

  if (memoryGb <= 0) {
    primary =
      [...spec.featuredIds].reverse().map(byId).find(Boolean) ?? smallestByMemory(catalog);
    reason = 'unknown';
  } else if (appleSilicon && qwen && memoryGb >= spec.qwen38.mxfp8.minUnifiedMemoryGb) {
    primary = qwen;
    reason = 'apple-mxfp8';
  } else if (appleSilicon && qwen && memoryGb >= spec.qwen38.mlx.minUnifiedMemoryGb) {
    primary = qwen;
    reason = 'apple-mlx';
  } else if (!appleSilicon && qwen && memoryGb >= spec.qwen38.generic.minUnifiedMemoryGb) {
    primary = qwen;
    reason = 'generic-27b';
  } else {
    primary =
      spec.featuredIds.map(byId).find((entry) => entry && fits(entry, memoryGb)) ??
      [...catalog]
        .filter((entry) => fits(entry, memoryGb))
        .sort((left, right) => right.minUnifiedMemoryGb - left.minUnifiedMemoryGb)[0] ??
      smallestByMemory(catalog);
    reason = 'compact';
  }

  const fallback = primary ?? catalog[0];
  if (!fallback) {
    throw new Error('curated ollama catalog is empty');
  }
  const coder = spec.featuredCoderId ? byId(spec.featuredCoderId) : undefined;
  const secondary =
    coder && coder.id !== fallback.id && (memoryGb <= 0 || fits(coder, memoryGb)) ? coder : null;

  return { primary: fallback, secondary, reason, appleSilicon, memoryGb };
}

/** 外面只露 1–2 条：主推 + 内存够时的编程备选。 */
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
