/**
 * 目录运行时校验(parseCatalog)+ presets 清洗排序。
 *
 * 2026-07-19 起 bundled 目录由 `builtin.ts` 组装:内置供应商身份卡是 TS 常量,
 * `catalog/providers.json`(v2)承载 xAI 的离线 fallback 元数据 + presets 模板——它仍是
 * ① OSS `cfg/providers.json` 的发布物 ② dev 直读的仓库文件。anthropic/openai/xd
 * 的模型清单运行时动态注入(见 apps/desktop maker-host active-catalog),不再进目录文件。
 * xAI 登录后同样由账号 `/v1/models` 决定成员；此处静态段只在尚无成功账号快照时救急，
 * 并为已发现成员补上下文、价格、能力与路由。
 * 所有跨端模型元数据统一进入严格版本化的 `modelRegistry`;目录顶层不接受旁路元数据块。
 */

import { parseModelRegistry } from './modelAccessValidator.js';

import { PI_MODEL_APIS, PI_REASONING_EFFORTS } from './types.js';
import type {
  Catalog,
  Provider,
  CatalogModel,
  AgentKind,
  Effort,
  ProviderPreset,
  PresetSortRegion,
  ProviderModelRouteConfig,
} from './types.js';
import { withVerifiedStaticWindows } from './builtin.js';
import { findReservedOAuthExtraParam } from './provider-oauth.js';
import { isProviderRequestPath } from './provider-url.js';

export { BUNDLED_CATALOG, BUILTIN_PROVIDERS } from './builtin.js';

const AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];
const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const WIRE_PROTOCOLS = ['anthropic-messages', 'openai-responses', 'openai-chat'] as const;

function isWireProtocol(value: unknown): value is (typeof WIRE_PROTOCOLS)[number] {
  return typeof value === 'string' && (WIRE_PROTOCOLS as readonly string[]).includes(value);
}

function isWireProtocolAllowedForAgent(
  agent: AgentKind,
  value: unknown,
): value is (typeof WIRE_PROTOCOLS)[number] {
  return isWireProtocol(value) && (agent !== 'claude-code' || value === 'anthropic-messages');
}

function isValidModelRoute(
  agent: AgentKind,
  runtimeBaseUrl: unknown,
  value: unknown,
): value is ProviderModelRouteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  if (
    typeof route.baseUrl !== 'string' ||
    route.baseUrl.trim().length === 0 ||
    !isWireProtocolAllowedForAgent(agent, route.wireProtocol)
  ) return false;
  try {
    const runtimeUrl = new URL(String(runtimeBaseUrl));
    const routeUrl = new URL(route.baseUrl);
    if (
      (runtimeUrl.protocol !== 'http:' && runtimeUrl.protocol !== 'https:') ||
      (routeUrl.protocol !== 'http:' && routeUrl.protocol !== 'https:') ||
      runtimeUrl.username ||
      runtimeUrl.password ||
      routeUrl.username ||
      routeUrl.password ||
      routeUrl.origin !== runtimeUrl.origin
    ) return false;
  } catch {
    return false;
  }
  return route.requestPath === undefined || isProviderRequestPath(route.requestPath);
}

function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && (AGENT_KINDS as readonly string[]).includes(v);
}

function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
}

function isPiModelApi(v: unknown): boolean {
  return typeof v === 'string' && (PI_MODEL_APIS as readonly string[]).includes(v);
}

function hasValidPresetReasoningCapability(
  agent: AgentKind,
  model: Record<string, unknown>,
): boolean {
  const hasCapability =
    model.reasoning !== undefined
    || model.reasoningEfforts !== undefined
    || model.reasoningDefaultEffort !== undefined;
  if (!hasCapability) return true;
  if (agent !== 'pi' || typeof model.reasoning !== 'boolean') return false;
  if (model.reasoning !== true) {
    return model.reasoningEfforts === undefined && model.reasoningDefaultEffort === undefined;
  }
  if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length === 0) return false;
  const efforts = model.reasoningEfforts;
  const effortsValid = (
    efforts.every(
      (effort) =>
        typeof effort === 'string' && (PI_REASONING_EFFORTS as readonly string[]).includes(effort),
    ) && new Set(efforts).size === efforts.length
  );
  if (!effortsValid) return false;
  return (
    model.reasoningDefaultEffort === undefined
    || (
      typeof model.reasoningDefaultEffort === 'string'
      && efforts.includes(model.reasoningDefaultEffort)
    )
  );
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`[model-providers] invalid catalog: ${msg}`);
}

/** access 是产品展示契约：旧目录可缺省，提供了就必须是完整的判别联合。 */
function validateAccess(p: Provider): void {
  const access = p.access;
  if (access === undefined) return;
  assert(access && typeof access === 'object' && !Array.isArray(access), `provider '${p.id}' access must be an object`);
  assert(
    access.kind === 'subscription' || access.kind === 'api' || access.kind === 'managed',
    `provider '${p.id}' access.kind invalid`,
  );
  if (access.kind === 'subscription') {
    assert(
      typeof access.product === 'string' && access.product.trim().length > 0,
      `provider '${p.id}' subscription access.product missing`,
    );
  }
}

/** 轻量校验一个 model 条目的必需字段。 */
function validateModel(
  m: CatalogModel,
  providerId: string,
  agent: AgentKind,
  runtimeBaseUrl: unknown,
): void {
  assert(typeof m.id === 'string' && m.id.length > 0, `model.id missing in provider '${providerId}'`);
  assert(typeof m.name === 'string' && m.name.length > 0, `model.name missing for '${m.id}'`);
  if (m.piApi !== undefined) {
    assert(isPiModelApi(m.piApi), `model.piApi invalid for '${m.id}'`);
  }
  if (m.route !== undefined) {
    assert(
      isValidModelRoute(agent, runtimeBaseUrl, m.route),
      `model.route invalid for '${m.id}' in provider '${providerId}'`,
    );
  }
  assert(typeof m.contextWindow === 'number' && m.contextWindow > 0, `model.contextWindow invalid for '${m.id}'`);
  assert(Array.isArray(m.efforts), `model.efforts must be array for '${m.id}'`);
  assert(m.efforts.every(isEffort), `model.efforts has invalid value for '${m.id}'`);
  if (m.defaultEffort !== null) {
    assert(isEffort(m.defaultEffort), `model.defaultEffort invalid for '${m.id}'`);
    assert(m.efforts.includes(m.defaultEffort), `model.defaultEffort not listed in efforts for '${m.id}'`);
  }
  // icon 是可选展示字段:只校验形态,不校验取值(未知值由渲染层回落来源供应商标,
  // 见 sections.ts resolveModelIconKind)——网关先于客户端登记新图标时不至于 parse 失败。
  if (m.icon !== undefined) {
    assert(typeof m.icon === 'string' && m.icon.trim().length > 0, `model.icon must be a non-empty string for '${m.id}'`);
  }
}

/** 校验 oauth 描述符（提供了就必须完整——它驱动登录与路由，坏数据必须在 parse 期暴露）。 */
function validateOAuthDescriptor(p: Provider): void {
  const d = p.auth?.oauth;
  if (d === undefined) return;
  assert(d && typeof d === 'object' && !Array.isArray(d), `provider '${p.id}' auth.oauth must be an object`);
  const raw = d as unknown as Record<string, unknown>;
  const flow = raw.flow ?? 'authorization-code';
  assert(
    flow === 'authorization-code' || flow === 'device-code',
    `provider '${p.id}' auth.oauth.flow invalid`,
  );
  for (const field of ['tokenUrl', 'clientId', 'scopes'] as const) {
    assert(typeof raw[field] === 'string' && raw[field].length > 0, `provider '${p.id}' auth.oauth.${field} missing`);
  }
  const requireHttpsUrl = (field: string): void => {
    const value = raw[field];
    let valid = false;
    if (typeof value === 'string') {
      try {
        const url = new URL(value);
        valid = url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        valid = false;
      }
    }
    assert(valid, `provider '${p.id}' auth.oauth.${field} must be https`);
  };
  requireHttpsUrl('tokenUrl');
  if (flow === 'authorization-code') {
    requireHttpsUrl('authorizeUrl');
    assert(
      raw.deviceAuthorizationUrl === undefined && raw.extraDeviceParams === undefined,
      `provider '${p.id}' auth.oauth device-code fields not allowed for authorization-code`,
    );
  } else {
    requireHttpsUrl('deviceAuthorizationUrl');
    assert(
      raw.authorizeUrl === undefined
        && raw.extraAuthParams === undefined
        && raw.redirectPort === undefined,
      `provider '${p.id}' auth.oauth authorization-code fields not allowed for device-code`,
    );
  }
  if (raw.redirectPort !== undefined) {
    assert(
      flow === 'authorization-code'
        && typeof raw.redirectPort === 'number'
        && Number.isInteger(raw.redirectPort)
        && raw.redirectPort > 0
        && raw.redirectPort < 65536,
      `provider '${p.id}' auth.oauth.redirectPort invalid`,
    );
  }
  const validateParams = (field: 'extraAuthParams' | 'extraDeviceParams'): void => {
    if (raw[field] === undefined) return;
    assert(
      raw[field] && typeof raw[field] === 'object' && !Array.isArray(raw[field]),
      `provider '${p.id}' auth.oauth.${field} invalid`,
    );
    assert(
      Object.values(raw[field] as Record<string, unknown>).every((value) => typeof value === 'string'),
      `provider '${p.id}' auth.oauth.${field} invalid`,
    );
    const collision = findReservedOAuthExtraParam(
      raw[field] as Record<string, unknown>,
      flow,
    );
    assert(
      collision === null,
      `provider '${p.id}' auth.oauth.${field} cannot override '${String(collision)}'`,
    );
  };
  if (flow === 'authorization-code') validateParams('extraAuthParams');
  else validateParams('extraDeviceParams');
  if (raw.modelsDiscoveryUrl !== undefined) {
    let valid = false;
    if (typeof raw.modelsDiscoveryUrl === 'string') {
      try {
        const url = new URL(raw.modelsDiscoveryUrl);
        valid = url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        valid = false;
      }
    }
    assert(
      valid,
      `provider '${p.id}' auth.oauth.modelsDiscoveryUrl must be https`,
    );
  }
}

/** 轻量校验一个 provider。 */
function validateProvider(p: Provider): void {
  assert(typeof p.id === 'string' && p.id.length > 0, 'provider.id missing');
  // id 会被 host 直接拼进 safeStorage 键名/文件名（provider_oauth_<id> 等），
  // 必须限定 slug 字符集，防被投毒目录用 `../` 之类字符把凭证写出存储目录。
  assert(/^[a-zA-Z0-9_-]+$/.test(p.id), `provider.id has illegal characters: '${p.id}'`);
  assert(typeof p.name === 'string' && p.name.length > 0, `provider.name missing for '${p.id}'`);
  assert(
    p.auth
      && (
        p.auth.method === 'oauth'
        || p.auth.method === 'apiKey'
        || p.auth.method === 'managed'
        || p.auth.method === 'none'
    ),
    `provider.auth.method invalid for '${p.id}'`,
  );
  assert(
    p.auth.method === 'oauth' || p.auth.oauth === undefined,
    `provider '${p.id}' auth.oauth not allowed for ${p.auth.method} method`,
  );
  // agents 允许为空**当且仅当**声明了媒体清单(媒体-only 供应商,如 Gemini 图像
  // API key 来源,2026-07 图像多来源):图像/视频模型不经 agent runtime,由主机
  // 图像通道直调,不需要任何 agent 路由;没有媒体清单的空 agents 仍是无效数据。
  const hasMediaModels =
    (Array.isArray(p.imageModels) && p.imageModels.length > 0) ||
    (Array.isArray(p.videoModels) && p.videoModels.length > 0) ||
    (Array.isArray(p.embeddingModels) && p.embeddingModels.length > 0);
  assert(
    Array.isArray(p.agents) && (p.agents.length > 0 || hasMediaModels),
    `provider.agents missing for '${p.id}'`,
  );
  assert(p.agents.every(isAgentKind), `provider.agents has invalid kind for '${p.id}'`);
  assert(p.routing && typeof p.routing === 'object', `provider.routing missing for '${p.id}'`);
  assert(
    p.models !== null && typeof p.models === 'object' && !Array.isArray(p.models),
    `provider.models must be a per-agent map for '${p.id}'`,
  );
  // 约束：供应商声明支持的每个 agent，都必须有对应路由描述符 + per-agent 模型数组。
  for (const agent of p.agents) {
    const routing = p.routing[agent];
    assert(routing, `provider '${p.id}' declares agent '${agent}' but no routing[${agent}]`);
    if (routing.upstream !== undefined) {
      let valid = false;
      try {
        const url = new URL(routing.upstream);
        valid = (
          (url.protocol === 'http:' || url.protocol === 'https:')
          && !url.username
          && !url.password
        );
      } catch {
        valid = false;
      }
      assert(valid, `provider '${p.id}' routing[${agent}].upstream invalid`);
    }
    if (routing.wireProtocol !== undefined) {
      assert(
        isWireProtocol(routing.wireProtocol),
        `provider '${p.id}' routing[${agent}].wireProtocol invalid`,
      );
      if (agent === 'claude-code') {
        assert(
          routing.wireProtocol !== 'openai-chat',
          `provider '${p.id}' routing[${agent}] cannot use openai-chat`,
        );
      }
      // Codex supports native Responses, Responses→Chat and Responses→Anthropic local
      // bridges. The latter is deliberately a local handler path; transparent forwarding
      // must never be used for an Anthropic Messages runtime.
    }
    if (routing.requestPath !== undefined) {
      assert(
        isProviderRequestPath(routing.requestPath),
        `provider '${p.id}' routing[${agent}].requestPath invalid`,
      );
    }
    // modelPrefixes（路由服务范围）提供了就必须是命名空间前缀形态（`xai/` 这类,以 `/` 结尾）——
    // 结构上保证 claude-* 等裸 wire model 永远不会命中,防止把 scope 声明成误伤辅助请求的形状。
    if (routing.modelPrefixes !== undefined) {
      assert(
        Array.isArray(routing.modelPrefixes) && routing.modelPrefixes.length > 0,
        `provider '${p.id}' routing[${agent}].modelPrefixes must be a non-empty array`,
      );
      for (const prefix of routing.modelPrefixes) {
        assert(
          typeof prefix === 'string' && /^[a-zA-Z0-9_-]+\/$/.test(prefix),
          `provider '${p.id}' routing[${agent}].modelPrefixes entry '${String(prefix)}' must be a namespace prefix ending with '/'`,
        );
      }
    }
    const list = p.models[agent];
    assert(Array.isArray(list), `provider '${p.id}' declares agent '${agent}' but no models[${agent}]`);
    for (const m of list) validateModel(m, p.id, agent, routing.upstream);
  }
  // 约束：若声明了 titleModel（标题 oneShot 用的最经济模型），它必须存在于本供应商任一
  // agent 的模型清单里 —— 防把不存在 / 拼错的 id 配进去导致运行时静默起不出标题。
  // 豁免:动态清单供应商(全部 models 数组为空,清单运行时注入——2026-07-19 统一重构后
  // 的 anthropic/openai/xd)无静态清单可校验,titleModel 指向的是运行时会出现的 id。
  if (p.titleModel !== undefined) {
    assert(typeof p.titleModel === 'string' && p.titleModel.length > 0, `provider '${p.id}' titleModel must be a non-empty string`);
    const hasStaticModels = p.agents.some((agent) => (p.models[agent] ?? []).length > 0);
    if (hasStaticModels) {
      const known = p.agents.some((agent) => (p.models[agent] ?? []).some((m) => m.id === p.titleModel));
      assert(known, `provider '${p.id}' titleModel '${p.titleModel}' not found in any agent's models`);
    }
  }
  // 媒体模型清单与默认选型(图像/视频同一套规则):
  // 清单 id/name 非空、id 不重复,不参与 agent/routing 约束(媒体模型不经
  // agent runtime);默认选型必须与清单配套且每个值指向在册 id。
  validateMediaModels(p.id, 'imageModels', p.imageModels, 'imageDefaults', p.imageDefaults);
  validateMediaModels(p.id, 'videoModels', p.videoModels, 'videoDefaults', p.videoDefaults);
  // 向量清单同一套规则(PR #1707 review):不校验的话,远端把 embeddingModels 写成
  // 对象、给重复/空 id、或让 embeddingDefaults 指向清单外型号,都能通过
  // parseCatalog();前一种随后在 deriveCindyMediaConfig 的 for...of 里抛错,被上层
  // 降级成空清单 —— 表现是所有插件向量请求变 NO_CANDIDATE,而真正的坏数据在目录里。
  validateMediaModels(
    p.id,
    'embeddingModels',
    p.embeddingModels,
    'embeddingDefaults',
    p.embeddingDefaults,
  );
  validateAccess(p);
  validateOAuthDescriptor(p);
}

/** 图像/视频模型清单 + 默认选型的共用校验(字段名只用于报错定位)。 */
function validateMediaModels(
  providerId: string,
  modelsField: string,
  models: Array<{
    id: string;
    name: string;
    modalities?: { input: string[]; output: string[] };
    officialDocs?: string;
  }> | undefined,
  defaultsField: string,
  defaults: { standard: string; draft?: string; best?: string } | undefined,
): void {
  if (models !== undefined) {
    assert(Array.isArray(models), `provider '${providerId}' ${modelsField} must be an array`);
    const seen = new Set<string>();
    for (const m of models) {
      assert(m && typeof m === 'object', `provider '${providerId}' ${modelsField} entry must be an object`);
      assert(typeof m.id === 'string' && m.id.length > 0, `provider '${providerId}' ${modelsField} entry missing id`);
      assert(typeof m.name === 'string' && m.name.length > 0, `provider '${providerId}' ${modelsField} '${m.id}' missing name`);
      assert(!seen.has(m.id), `provider '${providerId}' ${modelsField} has duplicate id '${m.id}'`);
      seen.add(m.id);
      if (m.modalities !== undefined) {
        assert(
          m.modalities && typeof m.modalities === 'object' && !Array.isArray(m.modalities),
          `provider '${providerId}' ${modelsField} '${m.id}' modalities must be an object`,
        );
        for (const key of ['input', 'output'] as const) {
          const values = m.modalities[key];
          assert(
            Array.isArray(values) && values.length > 0 && values.length <= 16,
            `provider '${providerId}' ${modelsField} '${m.id}' modalities.${key} must be a non-empty bounded array`,
          );
          assert(
            values.every(
              (value) =>
                typeof value === 'string' &&
                value.length > 0 &&
                value.length <= 64 &&
                value.trim() === value,
            ) && new Set(values).size === values.length,
            `provider '${providerId}' ${modelsField} '${m.id}' modalities.${key} contains invalid values`,
          );
        }
      }
      if (m.officialDocs !== undefined) {
        let valid = false;
        if (typeof m.officialDocs === 'string' && m.officialDocs.length <= 2_048) {
          try {
            const url = new URL(m.officialDocs);
            valid = url.protocol === 'https:' && !url.username && !url.password;
          } catch {
            valid = false;
          }
        }
        assert(
          valid,
          `provider '${providerId}' ${modelsField} '${m.id}' officialDocs must be https`,
        );
      }
    }
  }
  if (defaults !== undefined) {
    assert(defaults && typeof defaults === 'object', `provider '${providerId}' ${defaultsField} must be an object`);
    assert(Array.isArray(models) && models.length > 0, `provider '${providerId}' ${defaultsField} requires ${modelsField}`);
    const ids = new Set((models ?? []).map((m) => m.id));
    for (const key of ['standard', 'draft', 'best'] as const) {
      const v = defaults[key];
      if (key === 'standard') assert(typeof v === 'string' && v.length > 0, `provider '${providerId}' ${defaultsField}.standard missing`);
      if (v !== undefined) assert(ids.has(v), `provider '${providerId}' ${defaultsField}.${key} '${v}' not in ${modelsField}`);
    }
  }
}

/** 模型派生相关字段的稳定签名（用于跨供应商一致性校验，固定 key 序）。
 *  注：**不含** `supportsFastMode` —— Fast 能力是 per-(provider, agent) 的（见 CatalogModel
 *  文档），同一 model id 在不同供应商下可显式分叉（如某网关剥掉 fast 字段 ⇒ 该来源配 false），
 *  故意排除出一致性校验以放行这种分叉。同理**不含** `icon`（展示图标 per-provider 可分叉）
 *  与 `defaultEnabled`。其余派生字段仍要求跨供应商一致。 */
function modelSignature(m: CatalogModel): string {
  return JSON.stringify({
    name: m.name,
    description: m.description ?? null,
    contextWindow: m.contextWindow,
    efforts: m.efforts,
    effortDisplayNames: m.effortDisplayNames ?? null,
    defaultEffort: m.defaultEffort,
    group: m.group ?? null,
    sortOrder: m.sortOrder ?? null,
  });
}

/**
 * 同一 agent 下、同一 model id 跨多个供应商（如 gpt-5.5 同时由 openai 与 xd 提供）
 * 必须承载一致的元数据。host 派生 availableModels 时按 provider 序 first-wins 去重，
 * 元数据分叉会导致「选了同名模型但 ctx / effort 不同」的静默漂移。
 * 注：跨 agent 不约束（gpt-5.5 在 cc=1M / codex=272k 本就分叉，正是 per-agent 拆分的意义）。
 */
function validateModelConsistency(catalog: Catalog): void {
  const sigByKey = new Map<string, string>();
  for (const p of catalog.providers) {
    for (const agent of p.agents) {
      for (const m of p.models[agent] ?? []) {
        const key = `${agent}\u0000${m.id}`;
        const sig = modelSignature(m);
        const prev = sigByKey.get(key);
        if (prev === undefined) sigByKey.set(key, sig);
        else assert(prev === sig, `model '${m.id}' has inconsistent metadata across providers for agent '${agent}'`);
      }
    }
  }
}

/** 单条预设是否合法（结构完整、至少一个合法 runtime）。 */
function isValidPreset(v: unknown): v is ProviderPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id.length === 0) return false;
  if (typeof p.name !== 'string' || p.name.length === 0) return false;
  if (p.docsUrl !== undefined && typeof p.docsUrl !== 'string') return false;
  if (
    p.authMethod !== undefined
    && p.authMethod !== 'apiKey'
    && p.authMethod !== 'none'
  ) return false;
  if (!p.runtimes || typeof p.runtimes !== 'object' || Array.isArray(p.runtimes)) return false;
  const entries = Object.entries(p.runtimes as Record<string, unknown>);
  if (entries.length === 0) return false;
  for (const [agent, rt] of entries) {
    if (!isAgentKind(agent)) return false;
    if (!rt || typeof rt !== 'object') return false;
    const r = rt as Record<string, unknown>;
    if (typeof r.baseUrl !== 'string' || r.baseUrl.length === 0) return false;
    if (!Array.isArray(r.models)) return false;
    for (const m of r.models) {
      if (!m || typeof m !== 'object') return false;
      const mm = m as Record<string, unknown>;
      if (typeof mm.id !== 'string' || mm.id.length === 0) return false;
      if (typeof mm.name !== 'string' || mm.name.length === 0) return false;
      if (mm.piApi !== undefined && !isPiModelApi(mm.piApi)) return false;
      if (
        mm.contextWindow !== undefined
        && (typeof mm.contextWindow !== 'number' || !Number.isFinite(mm.contextWindow) || mm.contextWindow <= 0)
      ) return false;
      if (mm.supportsImageInput !== undefined && typeof mm.supportsImageInput !== 'boolean') {
        return false;
      }
      if (!hasValidPresetReasoningCapability(agent, mm)) return false;
    }
    if (r.wireProtocol !== undefined && !isWireProtocol(r.wireProtocol)) return false;
    if (agent === 'claude-code' && r.wireProtocol === 'openai-chat') return false;
    if (r.headers !== undefined) {
      if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) return false;
      if (Object.values(r.headers as Record<string, unknown>).some((x) => typeof x !== 'string')) return false;
    }
    if (r.baseUrlEditable !== undefined && typeof r.baseUrlEditable !== 'boolean') return false;
    if (
      r.piCatalogProviderId !== undefined
      && (agent !== 'pi' || typeof r.piCatalogProviderId !== 'string' || !/^[a-z0-9-]+$/.test(r.piCatalogProviderId))
    ) return false;
    // modelsUrl / requestPath 不在此淘汰整条——非法值由 sanitizePresets 剥字段。
  }
  return true;
}

/** 是否合法 http(s) URL（modelsUrl 归一化用）。 */
function isHttpUrl(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function httpUrl(v: unknown): URL | null {
  if (!isHttpUrl(v)) return null;
  return new URL(v as string);
}

function normalizedEndpointUrl(value: unknown): string | null {
  const url = httpUrl(value);
  if (!url) return null;
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

/**
 * Compatibility for catalog data generated before explicit Pi wireProtocol was shipped.
 * Those entries copied the exact Claude/Anthropic endpoint into runtimes.pi. Equality with the
 * Claude runtime is the authority here; a different Pi URL remains unconfigured and fail-closed.
 */
function isLegacyAnthropicPiRuntime(
  preset: ProviderPreset,
  agent: AgentKind,
  runtime: NonNullable<ProviderPreset['runtimes'][AgentKind]>,
): boolean {
  if (agent !== 'pi' || runtime.wireProtocol !== undefined) return false;
  const claudeRuntime = preset.runtimes['claude-code'];
  if (
    !claudeRuntime ||
    (claudeRuntime.wireProtocol !== undefined &&
      claudeRuntime.wireProtocol !== 'anthropic-messages')
  ) return false;
  const piEndpoint = normalizedEndpointUrl(runtime.baseUrl);
  return piEndpoint !== null && piEndpoint === normalizedEndpointUrl(claudeRuntime.baseUrl);
}

/**
 * runtime.modelsUrl 非法（非 http(s) URL）时剥掉该字段、保留预设本体——OSS 推错一个
 * 不可见字段不该让整条预设消失，更不该让用户保存时撞 main 侧 URL 校验无法自助修复。
 */
function normalizePresetRuntimeOptions(p: ProviderPreset): ProviderPreset {
  let changed = false;
  const runtimes: ProviderPreset['runtimes'] = {};
  for (const [agent, rt] of Object.entries(p.runtimes) as [AgentKind, ProviderPreset['runtimes'][AgentKind] & object][]) {
    let next = rt;
    if (isLegacyAnthropicPiRuntime(p, agent, next)) {
      next = { ...next, wireProtocol: 'anthropic-messages' };
      changed = true;
    }
    const models = next.models.map((model) => {
      if (model.route === undefined || isValidModelRoute(agent, next.baseUrl, model.route)) {
        return model;
      }
      const { route: _drop, ...rest } = model;
      changed = true;
      return rest;
    });
    if (models.some((model, index) => model !== next.models[index])) {
      next = { ...next, models };
    }
    if (next.modelsUrl !== undefined && !isHttpUrl(next.modelsUrl)) {
      const { modelsUrl: _drop, ...rest } = next;
      next = rest;
      changed = true;
    }
    if (next.requestPath !== undefined && !isProviderRequestPath(next.requestPath)) {
      const { requestPath: _drop, ...rest } = next;
      next = rest;
      changed = true;
    }
    if (next.modelDiscovery !== undefined) {
      const runtimeUrl = httpUrl(next.baseUrl);
      const sources = Array.isArray(next.modelDiscovery)
        ? next.modelDiscovery.filter((candidate) => {
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
            const source = candidate as unknown as Record<string, unknown>;
            const sourceUrl = httpUrl(source.baseUrl);
            if (!runtimeUrl || !sourceUrl || sourceUrl.origin !== runtimeUrl.origin) return false;
            if (!isWireProtocol(source.wireProtocol)) return false;
            if (agent === 'claude-code' && source.wireProtocol !== 'anthropic-messages') {
              return false;
            }
            if (
              source.modelsUrl !== undefined &&
              (!isHttpUrl(source.modelsUrl) ||
                httpUrl(source.modelsUrl)?.origin !== sourceUrl.origin)
            ) {
              return false;
            }
            return (
              source.requestPath === undefined || isProviderRequestPath(source.requestPath)
            );
          })
        : [];
      if (
        !Array.isArray(next.modelDiscovery) ||
        sources.length !== next.modelDiscovery.length
      ) {
        changed = true;
      }
      if (sources.length > 0) {
        next = { ...next, modelDiscovery: sources };
      } else {
        const { modelDiscovery: _drop, ...rest } = next;
        next = rest;
      }
    }
    runtimes[agent] = next;
  }
  return changed ? { ...p, runtimes } : p;
}

/**
 * 预设段容错清洗：逐条校验、坏条目丢弃 + 按 id 去重（first-wins）。
 *
 * 刻意**不走 assert**：预设是纯 UI 模板数据，不参与路由；OSS 推错一条预设不应让
 * 整份远端目录 parse 失败回退 bundled（那会连带丢掉远端的模型/路由更新）。
 */
export function sanitizePresets(input: unknown): ProviderPreset[] {
  if (!Array.isArray(input)) return [];
  const out: ProviderPreset[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (!isValidPreset(v) || seen.has(v.id)) continue;
    seen.add(v.id);
    // 可选呈现字段逐项归一化,**不许分支 continue**:多个字段同时非法时早退会漏清洗
    // (如 regionHint + nameEn 都坏,坏 nameEn 会原样流出——Codex P2,2026-07-24)。
    let preset = v as ProviderPreset;
    // regionHint 非法值不淘汰整条预设(它只是呈现提示),归一化为缺省(区域中立)。
    if (preset.regionHint !== undefined && preset.regionHint !== 'cn' && preset.regionHint !== 'global') {
      const { regionHint: _drop, ...rest } = preset as ProviderPreset & { regionHint: unknown };
      preset = rest as ProviderPreset;
    }
    // nameEn 非法值(非字符串/空白串)同容错语义:剥字段不淘汰整条。
    if (preset.nameEn !== undefined && (typeof preset.nameEn !== 'string' || preset.nameEn.trim().length === 0)) {
      const { nameEn: _drop, ...rest } = preset as ProviderPreset & { nameEn: unknown };
      preset = rest as ProviderPreset;
    }
    // 繁中展示名非法时只剥掉该字段，保留预设本体并回落到 name。
    if (preset.nameZhTW !== undefined && (typeof preset.nameZhTW !== 'string' || preset.nameZhTW.trim().length === 0)) {
      const { nameZhTW: _drop, ...rest } = preset as ProviderPreset & { nameZhTW: unknown };
      preset = rest as ProviderPreset;
    }
    out.push(normalizePresetRuntimeOptions(preset));
  }
  return out;
}

/**
 * 预设展示名:中文 UI 用目录 `name`(国内厂商为中文原名),其它语言优先 `nameEn`
 * (缺省回落 `name`)。纯呈现选择,不影响预设 id / 创建后的供应商命名语义。
 */
export function presetDisplayName(
  preset: Pick<ProviderPreset, 'name' | 'nameEn' | 'nameZhTW'>,
  locale: string,
): string {
  const normalizedLocale = locale.toLowerCase().replaceAll('_', '-');
  if (normalizedLocale === 'zh-tw' || normalizedLocale.startsWith('zh-hant')) {
    return preset.nameZhTW ?? preset.name;
  }
  return normalizedLocale.startsWith('zh') ? preset.name : (preset.nameEn ?? preset.name);
}

/** 预设的厂商分组键：id 去掉区域后缀（`zhipu-glm-cn`/`zhipu-glm-global` → `zhipu-glm`）。 */
function presetVendorKey(p: ProviderPreset): string {
  const key = p.id.replace(/-(cn|global)$/, '');
  // 智谱国内品牌沿用 zhipu，海外品牌使用 zai，但仍是同一厂商的区域渠道。
  return key === 'zai-coding-plan' ? 'zhipu-coding-plan' : key;
}

/**
 * 预设列表排序（稳定，纯呈现层）：
 *   - 按**厂商分组**（id 去区域后缀），厂商间按分组键首字母升序；
 *   - 同一厂商的国内/国际条目**相邻**，组内按客户端构建区域排先后（cn/dev → cn 在前，global → global 在前）；
 *   - 组内无 regionHint 的条目居中，保持目录原始顺序。
 * 只排序不过滤 —— 所有预设对所有用户可见可选，可达性由「测试连接」实测裁决。
 */
export function sortPresetsForRegion(
  presets: ProviderPreset[],
  region: PresetSortRegion,
): ProviderPreset[] {
  const cnFirst = region !== 'global';
  const regionRank = (p: ProviderPreset): number => {
    if (p.regionHint === undefined) return 1;
    if (p.regionHint === 'cn') return cnFirst ? 0 : 2;
    return cnFirst ? 2 : 0; // 'global'
  };
  return [...presets].sort((a, b) => {
    const vendor = presetVendorKey(a).localeCompare(presetVendorKey(b), 'en');
    if (vendor !== 0) return vendor;
    return regionRank(a) - regionRank(b);
  });
}

/**
 * 把任意来源（远端 / 本地文件文本 / 对象）解析校验成 Catalog。
 * 失败抛错——调用方决定回退兜底。
 */
export function parseCatalog(input: string | unknown): Catalog {
  const obj: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  assert(obj && typeof obj === 'object', 'root is not an object');
  const allowedRootFields = new Set(['version', 'providers', 'presets', 'modelRegistry']);
  const unknownRootField = Object.keys(obj).find((field) => !allowedRootFields.has(field));
  assert(!unknownRootField, `catalog.${unknownRootField} is not allowed`);
  const catalog = obj as Catalog;
  assert(typeof catalog.version === 'string', 'catalog.version missing');
  assert(Array.isArray(catalog.providers) && catalog.providers.length > 0, 'catalog.providers missing/empty');
  for (const p of catalog.providers) validateProvider(p);
  validateModelConsistency(catalog);
  // presets 容错清洗（坏条目丢弃，不让预设错误拖垮整份目录）。
  const presets = sanitizePresets((catalog as { presets?: unknown }).presets);
  if (presets.length > 0) catalog.presets = presets;
  else delete catalog.presets;
  if ((catalog as { modelRegistry?: unknown }).modelRegistry !== undefined) {
    const registry = parseModelRegistry((catalog as { modelRegistry: unknown }).modelRegistry);
    assert(registry.ok, registry.ok ? '' : registry.error);
    catalog.modelRegistry = registry.value;
  }
  // 远端下发目录与 bundled 同格式:静态条目的窗口是产品侧写定的真实上限,标记为已核实
  // (幂等;条目自己表过态时尊重原值)。动态发现的模型不经这里 —— 见 withVerifiedStaticWindows。
  //
  // 刻意**不**原地替换 catalog.providers:入参可能就是 BUNDLED_CATALOG(共享的 import 对象),
  // 原地改会把标记悄悄写回那份共享目录 —— 既是跨调用方的副作用,也会让「bundled 自己有没有
  // 标记」这类断言变成假通过。
  return { ...catalog, providers: catalog.providers.map(withVerifiedStaticWindows) };
}
