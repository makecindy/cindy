/**
 * custom-provider-store —— 用户自定义供应商**配置**的 localDb CRUD（不含密钥）。
 *
 * 存储：localDb `custom_providers` 表。DB 文件本身按 userId 切片
 * （`<userData>/xdt-maker-<userId>.db`，换账号 closeDb 重开），故本表天然账号隔离、
 * 无 owner 列（与 `sessions` 一致）。API key 不在此——按 runtime 单独走 safeStorage（见 routing）。
 *
 * 形状：行 ↔ `@cindy/model-providers` 的 `CustomProviderConfig`（per-runtime）。`runtimes` 列以
 * TEXT 存 JSON，出入口转换、反序列化失败安全兜底（{}），不抛错。
 *
 * 验证（`validateCustomProviderConfig`）是纯函数，便于单测；CRUD 经 `getDbClient().drizzle`
 * （测试用 `setCurrentDbClient` 注入内存 db，见 __tests__）。
 */

import { asc, eq } from 'drizzle-orm';

import type {
  AgentKind,
  CustomProviderConfig,
  CustomProviderRuntimeConfig,
  OAuthProviderDescriptor,
} from '@cindy/model-providers';

import { getDbClient } from '../localDb/client/current.js';
import { customProviders } from '../localDb/schema.js';

/** provider id slug 规则（与 safeStorage key 名 `provider_key_<id>_<agent>` 合法字符对齐）。 */
export const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9_-]+$/;
/** 不可占用的内置来源 id。 */
const RESERVED_IDS = new Set(['anthropic', 'openai', 'xd']);
const VALID_AGENTS: readonly AgentKind[] = ['claude-code', 'codex'];
const MAX_ID_LEN = 40;
const MAX_NAME_LEN = 60;

/** 验证结果：ok 或带 code + message（供 handler 映射成 throwIpcError）。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

function invalid(message: string): ValidationResult {
  return { ok: false, code: 'INVALID_PARAMS', message };
}

function validateRuntime(agent: string, rt: unknown): ValidationResult {
  if (!rt || typeof rt !== 'object') return invalid(`runtime '${agent}' must be an object`);
  const r = rt as Record<string, unknown>;
  if (typeof r.baseUrl !== 'string' || r.baseUrl.trim().length === 0) {
    return invalid(`runtime '${agent}' baseUrl required`);
  }
  try {
    const u = new URL(r.baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return invalid(`runtime '${agent}' baseUrl must be http(s)`);
    }
  } catch {
    return invalid(`runtime '${agent}' baseUrl is not a valid URL`);
  }
  if (!Array.isArray(r.models)) return invalid(`runtime '${agent}' models must be an array`);
  for (const m of r.models) {
    if (!m || typeof m !== 'object') return invalid(`runtime '${agent}' model must be an object`);
    const mm = m as Record<string, unknown>;
    if (typeof mm.id !== 'string' || mm.id.trim().length === 0) {
      return invalid(`runtime '${agent}' model.id required`);
    }
    if (typeof mm.name !== 'string' || mm.name.trim().length === 0) {
      return invalid(`runtime '${agent}' model.name required`);
    }
    if (
      mm.contextWindow !== undefined
      && (
        typeof mm.contextWindow !== 'number'
        || !Number.isFinite(mm.contextWindow)
        || mm.contextWindow <= 0
      )
    ) {
      return invalid(`runtime '${agent}' model.contextWindow must be a positive number`);
    }
    if (mm.defaultEnabled !== undefined && typeof mm.defaultEnabled !== 'boolean') {
      return invalid(`runtime '${agent}' model.defaultEnabled must be a boolean`);
    }
  }
  if (r.wireProtocol !== undefined) {
    const allowed = agent === 'claude-code'
      ? ['anthropic-messages']
      : ['openai-responses', 'openai-chat'];
    if (typeof r.wireProtocol !== 'string' || !allowed.includes(r.wireProtocol)) {
      return invalid(`runtime '${agent}' wireProtocol invalid`);
    }
  }
  if (r.headers !== undefined) {
    if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) {
      return invalid(`runtime '${agent}' headers must be an object`);
    }
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return invalid(`runtime '${agent}' headers must be string→string`);
      }
    }
  }
  if (r.modelsUrl !== undefined) {
    if (typeof r.modelsUrl !== 'string' || r.modelsUrl.trim().length === 0) {
      return invalid(`runtime '${agent}' modelsUrl must be a non-empty string`);
    }
    try {
      const u = new URL(r.modelsUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return invalid(`runtime '${agent}' modelsUrl must be http(s)`);
      }
    } catch {
      return invalid(`runtime '${agent}' modelsUrl is not a valid URL`);
    }
  }
  return { ok: true };
}

/** 校验用户填写的 OAuth 描述符（与目录 parseCatalog 的 validateOAuthDescriptor 同规则）。 */
function validateOAuthSection(auth: unknown): ValidationResult {
  if (!auth || typeof auth !== 'object') return invalid('auth must be an object');
  const a = auth as Record<string, unknown>;
  if (a.method !== 'apiKey' && a.method !== 'oauth') return invalid("auth.method must be 'apiKey' | 'oauth'");
  if (a.method === 'apiKey') {
    if (a.oauth !== undefined) return invalid('auth.oauth not allowed for apiKey method');
    return { ok: true };
  }
  const d = a.oauth;
  if (!d || typeof d !== 'object') return invalid('auth.oauth required for oauth method');
  const o = d as Record<string, unknown>;
  for (const field of ['authorizeUrl', 'tokenUrl', 'clientId', 'scopes'] as const) {
    if (typeof o[field] !== 'string' || (o[field] as string).trim().length === 0) {
      return invalid(`auth.oauth.${field} required`);
    }
  }
  for (const field of ['authorizeUrl', 'tokenUrl'] as const) {
    try {
      const u = new URL(o[field] as string);
      // OAuth 端点强制 https:回调虽在回环,但授权码/token 交换绝不能明文出网。
      if (u.protocol !== 'https:') return invalid(`auth.oauth.${field} must be https`);
    } catch {
      return invalid(`auth.oauth.${field} is not a valid URL`);
    }
  }
  if (o.redirectPort !== undefined) {
    if (
      typeof o.redirectPort !== 'number'
      || !Number.isInteger(o.redirectPort)
      || o.redirectPort <= 0
      || o.redirectPort >= 65536
    ) {
      return invalid('auth.oauth.redirectPort invalid');
    }
  }
  return { ok: true };
}

/** 纯函数：校验一份自定义供应商配置的结构合法性（per-runtime）。 */
export function validateCustomProviderConfig(config: unknown): ValidationResult {
  if (!config || typeof config !== 'object') return invalid('config must be an object');
  const c = config as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) return invalid('id required');
  if (c.id.length > MAX_ID_LEN) return invalid(`id too long (max ${MAX_ID_LEN})`);
  if (!CUSTOM_PROVIDER_ID_RE.test(c.id)) return invalid('id must match /^[a-z0-9_-]+$/');
  if (RESERVED_IDS.has(c.id)) return invalid(`id '${c.id}' is reserved`);

  if (typeof c.name !== 'string' || c.name.trim().length === 0) return invalid('name required');
  if (c.name.length > MAX_NAME_LEN) return invalid(`name too long (max ${MAX_NAME_LEN})`);

  if (c.auth !== undefined) {
    const a = validateOAuthSection(c.auth);
    if (!a.ok) return a;
  }

  if (!c.runtimes || typeof c.runtimes !== 'object' || Array.isArray(c.runtimes)) {
    return invalid('runtimes required');
  }
  const rts = c.runtimes as Record<string, unknown>;
  const keys = Object.keys(rts);
  if (keys.length === 0) return invalid('at least one runtime required');
  for (const k of keys) {
    if (!VALID_AGENTS.includes(k as AgentKind)) return invalid(`invalid runtime '${k}'`);
    const r = validateRuntime(k, rts[k]);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** 规整单个 runtime（trim baseUrl、去重 models、裁 headers）。 */
function normalizeRuntime(rt: CustomProviderRuntimeConfig): CustomProviderRuntimeConfig {
  const seen = new Set<string>();
  const models = rt.models
    .map((m) => ({
      id: m.id.trim(),
      name: m.name.trim(),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
    }))
    .filter((m) => {
      if (!m.id || !m.name || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  const headers =
    rt.headers && Object.keys(rt.headers).length > 0 ? { ...rt.headers } : undefined;
  const out: CustomProviderRuntimeConfig = { baseUrl: rt.baseUrl.trim(), models };
  if (rt.wireProtocol) out.wireProtocol = rt.wireProtocol;
  if (headers) out.headers = headers;
  if (rt.modelsUrl && rt.modelsUrl.trim()) out.modelsUrl = rt.modelsUrl.trim();
  return out;
}

/** 把校验通过的输入收敛成规整的 CustomProviderConfig（按固定 agent 序）。 */
function normalizeConfig(config: CustomProviderConfig): CustomProviderConfig {
  const runtimes: Partial<Record<AgentKind, CustomProviderRuntimeConfig>> = {};
  for (const agent of VALID_AGENTS) {
    const rt = config.runtimes[agent];
    if (rt) runtimes[agent] = normalizeRuntime(rt);
  }
  const out: CustomProviderConfig = { id: config.id, name: config.name.trim(), runtimes };
  // auth 规整：apiKey（默认形态）不落 auth 字段；oauth 落 trim 过的描述符。
  if (config.auth?.method === 'oauth' && config.auth.oauth) {
    const d = config.auth.oauth;
    const oauth: OAuthProviderDescriptor = {
      authorizeUrl: d.authorizeUrl.trim(),
      tokenUrl: d.tokenUrl.trim(),
      clientId: d.clientId.trim(),
      scopes: d.scopes.trim(),
    };
    if (d.redirectPort !== undefined) oauth.redirectPort = d.redirectPort;
    if (d.extraAuthParams && Object.keys(d.extraAuthParams).length > 0) {
      oauth.extraAuthParams = { ...d.extraAuthParams };
    }
    if (d.modelsDiscoveryUrl) oauth.modelsDiscoveryUrl = d.modelsDiscoveryUrl.trim();
    out.auth = { method: 'oauth', oauth };
  }
  return out;
}

/**
 * 把授权后自动发现的模型 additions-only 合并进自定义供应商配置的指定 runtime（纯函数）。
 * 已有 id first-wins（用户手填 / 上次发现的条目不被覆盖）；无新增返回 null（调用方免写库）。
 * 持久化发现结果是自定义 OAuth 供应商「重启后模型仍在」的保证——内存 augment 会随进程消失。
 */
export function mergeDiscoveredModelsIntoConfig(
  config: CustomProviderConfig,
  agent: AgentKind,
  discovered: { id: string; name: string }[],
): CustomProviderConfig | null {
  const rt = config.runtimes[agent];
  if (!rt) return null;
  const existing = new Set(rt.models.map((m) => m.id));
  const fresh = discovered.filter((m) => m.id && m.name && !existing.has(m.id));
  if (fresh.length === 0) return null;
  return {
    ...config,
    runtimes: {
      ...config.runtimes,
      [agent]: { ...rt, models: [...rt.models, ...fresh.map((m) => ({ id: m.id, name: m.name }))] },
    },
  };
}

/** 安全解析 auth 列 JSON（坏数据 / 结构不完整兜底为 undefined = API key 历史形态）。 */
function parseAuth(raw: string | null): CustomProviderConfig['auth'] {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const r = validateOAuthSection(v);
  if (!r.ok) return undefined;
  const a = v as { method: 'apiKey' | 'oauth'; oauth?: OAuthProviderDescriptor };
  return a.method === 'oauth' ? a : undefined;
}

/** 安全解析 runtimes JSON（坏数据兜底为 {}，逐字段防御）。 */
function parseRuntimes(raw: string): Partial<Record<AgentKind, CustomProviderRuntimeConfig>> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const obj = v as Record<string, unknown>;
  const out: Partial<Record<AgentKind, CustomProviderRuntimeConfig>> = {};
  for (const agent of VALID_AGENTS) {
    const rt = obj[agent];
    if (!rt || typeof rt !== 'object') continue;
    const r = rt as Record<string, unknown>;
    const models = Array.isArray(r.models)
      ? r.models
          .filter((m): m is Record<string, unknown> =>
            !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string',
          )
          .map((m) => ({
            id: String(m.id),
            name: String(m.name ?? ''),
            ...(typeof m.contextWindow === 'number'
              && Number.isFinite(m.contextWindow)
              && m.contextWindow > 0
              ? { contextWindow: m.contextWindow }
              : {}),
            ...(m.defaultEnabled === false ? { defaultEnabled: false } : {}),
          }))
      : [];
    const entry: CustomProviderRuntimeConfig = {
      baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
      models,
    };
    if (
      typeof r.wireProtocol === 'string' &&
      (r.wireProtocol === 'anthropic-messages' || r.wireProtocol === 'openai-responses' || r.wireProtocol === 'openai-chat')
    ) {
      entry.wireProtocol = r.wireProtocol;
    }
    if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
      entry.headers = r.headers as Record<string, string>;
    }
    if (typeof r.modelsUrl === 'string' && r.modelsUrl.length > 0) entry.modelsUrl = r.modelsUrl;
    out[agent] = entry;
  }
  return out;
}

function rowToConfig(row: typeof customProviders.$inferSelect): CustomProviderConfig {
  const auth = parseAuth(row.auth);
  return { id: row.id, name: row.name, ...(auth ? { auth } : {}), runtimes: parseRuntimes(row.runtimes) };
}

/** 列出当前账号的全部自定义供应商（按 sortOrder 升序，再按 createdAt）。 */
export async function listCustomProviders(): Promise<CustomProviderConfig[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(customProviders)
    .orderBy(asc(customProviders.sortOrder), asc(customProviders.createdAt));
  return rows.map(rowToConfig);
}

/** 取单个；不存在返回 null。 */
export async function getCustomProvider(id: string): Promise<CustomProviderConfig | null> {
  const db = getDbClient().drizzle;
  const row = await db.select().from(customProviders).where(eq(customProviders.id, id)).get();
  return row ? rowToConfig(row) : null;
}

/** 该 id 是否已存在。 */
export async function customProviderExists(id: string): Promise<boolean> {
  return (await getCustomProvider(id)) != null;
}

/**
 * 新建。调用方须先 `validateCustomProviderConfig` + 处理重名（`customProviderExists`）。
 * 返回入库后的规整配置。
 */
export async function createCustomProvider(
  config: CustomProviderConfig,
  now: number = Date.now(),
): Promise<CustomProviderConfig> {
  const c = normalizeConfig(config);
  const db = getDbClient().drizzle;
  const rows = await db.select({ sortOrder: customProviders.sortOrder }).from(customProviders);
  const nextOrder = rows.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
  await db.insert(customProviders).values({
    id: c.id,
    name: c.name,
    runtimes: JSON.stringify(c.runtimes),
    auth: c.auth ? JSON.stringify(c.auth) : null,
    sortOrder: nextOrder,
    createdAt: now,
    updatedAt: now,
  });
  return c;
}

/**
 * 更新（id 不可改）。调用方须先 `validateCustomProviderConfig`。返回更新后的规整配置；
 * 行不存在时返回 null（handler 映射成 NOT_FOUND）。
 */
export async function updateCustomProvider(
  id: string,
  config: CustomProviderConfig,
  now: number = Date.now(),
): Promise<CustomProviderConfig | null> {
  const c = normalizeConfig({ ...config, id });
  const db = getDbClient().drizzle;
  const existing = await db.select().from(customProviders).where(eq(customProviders.id, id)).get();
  if (!existing) return null;
  await db
    .update(customProviders)
    .set({
      name: c.name,
      runtimes: JSON.stringify(c.runtimes),
      auth: c.auth ? JSON.stringify(c.auth) : null,
      updatedAt: now,
    })
    .where(eq(customProviders.id, id));
  return c;
}

/** 删除（幂等：不存在也不报错）。 */
export async function deleteCustomProvider(id: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db.delete(customProviders).where(eq(customProviders.id, id));
}
