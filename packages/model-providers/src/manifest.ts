/**
 * manifest —— 外部供应商 manifest（`cindy://settings/providers?manifest=<https-url>`）的
 * 专用解析与校验。
 *
 * 与目录 presets 的 `sanitizePresets` 是**刻意不同的两套语义**：
 *   - 目录清洗面向官方托管数据，目标是"尽量保留目录其它内容"，对部分非法可选字段
 *     （modelsUrl / requestPath / 模型 route 等）采取剥字段、留预设的容错策略；
 *   - manifest 来自不受信的外部 URL，必须 **fail-closed**：任何未知字段、非法值、
 *     越界形态都整条拒绝，绝不降级成部分预填。这里不复用 sanitizePresets，
 *     防止目录容错语义被顺手带进外部信任边界。
 *
 * v1 显式契约（收窄面，后续可按需放宽）：
 *   - 根字段白名单：id / name / nameEn / nameZhTW / docsUrl / authMethod / runtimes；
 *   - authMethod 只允许缺省或 'apiKey'（'none' 免鉴权网关 v1 不开）；
 *   - runtime 字段白名单：baseUrl / modelsUrl / models / wireProtocol；
 *     headers、requestPath、modelDiscovery、baseUrlEditable、piCatalogProviderId
 *     出现即整条拒绝——headers 是潜在凭证注入通道，其余扩大外部可控面；
 *   - 端点 URL（baseUrl / modelsUrl）仅 https、无 username/password、无 query/hash
 *     （query 是 `?key=...` 凭证走私通道）；
 *   - 模型条目白名单：id / name / contextWindow / supportsImageInput；
 *     reasoning / route / piApi 等策展元数据 v1 不从外部输入接受。
 *
 * 输出的 preset 逐字段新建（不透传输入对象），保证任何未校验字段都不可能幸存。
 * manifest 的 `id` 只做格式校验；调用方（主进程拉取层）会把它重写为
 * `manifest:<host>` 命名空间值——它仅是 UI 模板元数据，最终落库 id 由用户侧
 * 既有规则生成，永不进入内置 provider / preset id 命名空间。
 */

import type {
  AgentKind,
  ProviderPreset,
  ProviderPresetRuntime,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from './types.js';

/** 整条拒绝的原因分类（结构化返回给主进程 → renderer 错误文案分档）。 */
export type ProviderManifestRejectReason =
  | 'invalid-json'
  | 'unknown-root-field'
  | 'invalid-id'
  | 'invalid-name'
  | 'invalid-docs-url'
  | 'invalid-auth-method'
  | 'invalid-runtimes'
  | 'forbidden-runtime-field'
  | 'unknown-runtime-field'
  | 'invalid-endpoint'
  | 'invalid-models';

export type ProviderManifestParseResult =
  | { ok: true; preset: ProviderPreset }
  | { ok: false; reason: ProviderManifestRejectReason };

// 本地小守卫：常量表用导出类型收窄标注——上游 union 演进时这里编译期即报错，
// 不会与 catalog.ts 的模块私有守卫静默漂移。
const MANIFEST_AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];
const MANIFEST_WIRE_PROTOCOLS: readonly ProviderWireProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
];

const ROOT_FIELD_WHITELIST = new Set([
  'id',
  'name',
  'nameEn',
  'nameZhTW',
  'docsUrl',
  'authMethod',
  'runtimes',
]);
const RUNTIME_FIELD_WHITELIST = new Set(['baseUrl', 'modelsUrl', 'models', 'wireProtocol']);
/** 出现即整条拒绝的 runtime 字段（v1 契约里明确关死的面）。 */
const RUNTIME_FIELD_FORBIDDEN = new Set([
  'headers',
  'requestPath',
  'modelDiscovery',
  'baseUrlEditable',
  'piCatalogProviderId',
]);
const MODEL_FIELD_WHITELIST = new Set(['id', 'name', 'contextWindow', 'supportsImageInput']);

/** manifest 自带 id 的格式契约：小写 slug（仅模板元数据，见文件头）。 */
const MANIFEST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_MODEL_FIELD_LENGTH = 200;
const MAX_MODELS_PER_RUNTIME = 100;
const MAX_URL_LENGTH = 2048;

function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (MANIFEST_AGENT_KINDS as readonly string[]).includes(v);
}

function isWireProtocolAllowedForAgent(
  agent: AgentKind,
  value: unknown,
): value is ProviderWireProtocol {
  return (
    typeof value === 'string'
    && (MANIFEST_WIRE_PROTOCOLS as readonly string[]).includes(value)
    && (agent !== 'claude-code' || value === 'anthropic-messages')
  );
}

function isNonEmptyDisplayName(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_DISPLAY_NAME_LENGTH;
}

/**
 * 端点 URL 的 fail-closed 解析：https-only、无凭证、无 query/hash。
 * query 被明确关死——`?key=...` 形态是把凭证走私进"无凭证 manifest"契约的通道。
 */
function parseStrictHttpsEndpoint(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.search !== '' || url.hash !== '') return null;
  return url;
}

/** docsUrl 是展示用可点链接（非请求端点）：https + 无凭证即可，允许 query。 */
function isValidDocsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseManifestModel(value: unknown): ProviderRuntimeModelConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MODEL_FIELD_WHITELIST.has(key)) return null;
  }
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > MAX_MODEL_FIELD_LENGTH) {
    return null;
  }
  if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > MAX_MODEL_FIELD_LENGTH) {
    return null;
  }
  if (
    m.contextWindow !== undefined
    && (typeof m.contextWindow !== 'number'
      || !Number.isFinite(m.contextWindow)
      || m.contextWindow <= 0)
  ) {
    return null;
  }
  if (m.supportsImageInput !== undefined && typeof m.supportsImageInput !== 'boolean') return null;
  return {
    id: m.id,
    name: m.name,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.supportsImageInput === true ? { supportsImageInput: true } : {}),
  };
}

function parseManifestRuntime(
  agent: AgentKind,
  value: unknown,
): { ok: true; runtime: ProviderPresetRuntime } | { ok: false; reason: ProviderManifestRejectReason } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid-runtimes' };
  }
  const rt = value as Record<string, unknown>;
  for (const key of Object.keys(rt)) {
    if (RUNTIME_FIELD_FORBIDDEN.has(key)) return { ok: false, reason: 'forbidden-runtime-field' };
    if (!RUNTIME_FIELD_WHITELIST.has(key)) return { ok: false, reason: 'unknown-runtime-field' };
  }
  if (!parseStrictHttpsEndpoint(rt.baseUrl)) return { ok: false, reason: 'invalid-endpoint' };
  if (rt.modelsUrl !== undefined && !parseStrictHttpsEndpoint(rt.modelsUrl)) {
    return { ok: false, reason: 'invalid-endpoint' };
  }
  if (rt.wireProtocol !== undefined && !isWireProtocolAllowedForAgent(agent, rt.wireProtocol)) {
    return { ok: false, reason: 'invalid-runtimes' };
  }
  if (!Array.isArray(rt.models) || rt.models.length > MAX_MODELS_PER_RUNTIME) {
    return { ok: false, reason: 'invalid-models' };
  }
  const models: ProviderRuntimeModelConfig[] = [];
  const seenModelIds = new Set<string>();
  for (const entry of rt.models) {
    const model = parseManifestModel(entry);
    if (!model || seenModelIds.has(model.id)) return { ok: false, reason: 'invalid-models' };
    seenModelIds.add(model.id);
    models.push(model);
  }
  return {
    ok: true,
    runtime: {
      baseUrl: rt.baseUrl as string,
      models,
      ...(rt.modelsUrl !== undefined ? { modelsUrl: rt.modelsUrl as string } : {}),
      ...(rt.wireProtocol !== undefined
        ? { wireProtocol: rt.wireProtocol as ProviderWireProtocol }
        : {}),
    },
  };
}

/**
 * 解析一份外部供应商 manifest 文本。整条通过才返回 preset；任何一处不合规
 * 都返回带原因的拒绝，绝无部分结果。
 */
export function parseProviderManifest(text: string): ProviderManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid-json' };
  }
  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ROOT_FIELD_WHITELIST.has(key)) return { ok: false, reason: 'unknown-root-field' };
  }
  if (typeof root.id !== 'string' || !MANIFEST_ID_RE.test(root.id)) {
    return { ok: false, reason: 'invalid-id' };
  }
  if (!isNonEmptyDisplayName(root.name)) return { ok: false, reason: 'invalid-name' };
  if (root.nameEn !== undefined && !isNonEmptyDisplayName(root.nameEn)) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (root.nameZhTW !== undefined && !isNonEmptyDisplayName(root.nameZhTW)) {
    return { ok: false, reason: 'invalid-name' };
  }
  if (root.docsUrl !== undefined && !isValidDocsUrl(root.docsUrl)) {
    return { ok: false, reason: 'invalid-docs-url' };
  }
  if (root.authMethod !== undefined && root.authMethod !== 'apiKey') {
    return { ok: false, reason: 'invalid-auth-method' };
  }
  if (!root.runtimes || typeof root.runtimes !== 'object' || Array.isArray(root.runtimes)) {
    return { ok: false, reason: 'invalid-runtimes' };
  }
  const runtimeEntries = Object.entries(root.runtimes as Record<string, unknown>);
  if (runtimeEntries.length === 0) return { ok: false, reason: 'invalid-runtimes' };
  const runtimes: ProviderPreset['runtimes'] = {};
  for (const [agent, value] of runtimeEntries) {
    if (!isAgentKind(agent)) return { ok: false, reason: 'invalid-runtimes' };
    const runtime = parseManifestRuntime(agent, value);
    if (!runtime.ok) return runtime;
    runtimes[agent] = runtime.runtime;
  }
  return {
    ok: true,
    preset: {
      id: root.id,
      name: (root.name as string).trim(),
      ...(root.nameEn !== undefined ? { nameEn: (root.nameEn as string).trim() } : {}),
      ...(root.nameZhTW !== undefined ? { nameZhTW: (root.nameZhTW as string).trim() } : {}),
      ...(root.docsUrl !== undefined ? { docsUrl: root.docsUrl as string } : {}),
      ...(root.authMethod !== undefined ? { authMethod: 'apiKey' as const } : {}),
      runtimes,
    },
  };
}
