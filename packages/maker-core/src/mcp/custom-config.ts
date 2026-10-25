/** Shared custom MCP configuration and validation; tokens are stored separately. */
export const MCP_TRANSPORTS = ['http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export interface CustomMcpConfig { id: string; name: string; transport: McpTransport; url: string; headers: Record<string, string>; }

/** MCP id slug 规则（与 safeStorage key 名 `mcp_token_<id>` 合法字符对齐）。 */
export const CUSTOM_MCP_ID_RE = /^[a-z0-9_-]+$/;

/**
 * slug 正则允许下划线，于是 `__proto__` / `constructor` 这类名字是合法 id，而 server 名
 * 会被当作普通对象的 key 使用（agent 侧的 mcpServers map）。装配层已改用 null-prototype
 * 兜底，这里从源头再拒一次，避免这种 id 流进任何按 key 建表的下游。
 */
const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 该 id 是否不适合当对象 key。
 *
 * 校验是**新加的**，旧版本存下来的行不会被重新校验：启动刷新直接读库建 provider。
 * 装配层因此要能自己识别并隔离这类历史行，共用这一个判定，避免两处名单漂移。
 */
export function isUnsafeMcpServerId(id: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(id);
}
const MAX_ID_LEN = 40;
const MAX_NAME_LEN = 60;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Claude Code requires custom HTTP header values to be printable ASCII. Keep
 * this check at the persisted-config boundary so an invalid value cannot be
 * saved and fail later during a non-interactive MCP startup.
 */
function isPrintableAsciiHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** 验证结果：ok 或带 code + message（供 handler 映射成 throwIpcError）。 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_PARAMS'; message: string };

function invalid(message: string): ValidationResult {
  return { ok: false, code: 'INVALID_PARAMS', message };
}

/**
 * 纯函数：校验一份自定义 MCP 配置的结构合法性。
 *
 * `reservedIds` 传内置 MCP server 名（生产由 getBuiltinMcpServerNames() 派生）。撞名的
 * 自定义 MCP 会在装配层按 key 顶替内置 server，还顺带继承审批策略里对该 server 名的
 * 信任，所以这里直接拒收；装配层另有一道纵深防御会跳过它。
 */
export function validateCustomMcpConfig(
  config: unknown,
  reservedIds: readonly string[] = [],
): ValidationResult {
  if (!config || typeof config !== 'object') return invalid('config must be an object');
  const c = config as Record<string, unknown>;

  if (typeof c.id !== 'string' || c.id.length === 0) return invalid('id required');
  if (c.id.length > MAX_ID_LEN) return invalid(`id too long (max ${MAX_ID_LEN})`);
  if (!CUSTOM_MCP_ID_RE.test(c.id)) return invalid('id must match /^[a-z0-9_-]+$/');
  if (UNSAFE_OBJECT_KEYS.has(c.id)) {
    return invalid(`id '${c.id}' is not allowed`);
  }
  if (reservedIds.includes(c.id)) {
    return invalid(`id '${c.id}' is reserved by a builtin MCP server; pick another id`);
  }

  if (typeof c.name !== 'string' || c.name.trim().length === 0) return invalid('name required');
  if (c.name.length > MAX_NAME_LEN) return invalid(`name too long (max ${MAX_NAME_LEN})`);

  if (typeof c.transport !== 'string' || !MCP_TRANSPORTS.includes(c.transport as McpTransport)) {
    return invalid(`transport must be one of ${MCP_TRANSPORTS.join('|')}`);
  }

  if (typeof c.url !== 'string' || c.url.trim().length === 0) return invalid('url required');
  try {
    const u = new URL(c.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return invalid('url must be http(s)');
    }
  } catch {
    return invalid('url is not a valid URL');
  }

  if (c.headers !== undefined) {
    if (!c.headers || typeof c.headers !== 'object' || Array.isArray(c.headers)) {
      return invalid('headers must be an object');
    }
    for (const [k, v] of Object.entries(c.headers as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        return invalid('headers must be string→string');
      }
      const headerName = k.trim();
      if (headerName.length > 0 && !HTTP_HEADER_NAME_RE.test(headerName)) {
        return invalid('header names must be valid HTTP tokens');
      }
      if (!isPrintableAsciiHeaderValue(v)) {
        return invalid('header values must contain printable ASCII characters');
      }
    }
  }
  return { ok: true };
}

