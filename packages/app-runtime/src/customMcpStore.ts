/**
 * custom-mcp-store —— 用户自定义 MCP 服务器**配置**的 localDb CRUD（不含 token）。
 *
 * 存储：localDb `custom_mcp_servers` 表。DB 文件按 userId 切片
 * （`<userData>/xdt-maker-<userId>.db`，换账号 closeDb 重开），故本表天然账号隔离、无 owner 列
 * （与 `custom_providers` / `sessions` 一致）。bearer token 不在此——单独走 safeStorage
 * （`mcp_token_<id>`，见 shared/providerSecrets 的 customMcpSecretStorageKey）。
 *
 * 仅支持远程 transport（http/sse），一条记录 = 一个可被 Claude / Codex 共同调用的远程 MCP。
 *
 * 验证（`validateCustomMcpConfig`）是纯函数，便于单测；CRUD 经 `getDbClient().drizzle`
 * （测试用 `setCurrentDbClient` 注入内存 db，见 __tests__）。
 */

import { asc, eq, sql } from 'drizzle-orm';
import { customMcpServers } from '@cindy/runtime-db/schema';
import {
  MCP_TRANSPORTS,
  type CustomMcpConfig,
  type McpTransport,
} from '@cindy/maker-core';

export { MCP_TRANSPORTS };
export type { CustomMcpConfig, McpTransport };

export { CUSTOM_MCP_ID_RE, isUnsafeMcpServerId, validateCustomMcpConfig, type ValidationResult } from '@cindy/maker-core';
import { isUnsafeMcpServerId, validateCustomMcpConfig } from '@cindy/maker-core';


export function createCustomMcpStore(getDbClient:()=>Pick<import('@cindy/runtime-db/client/DbClient').DbClient,'drizzle'>) {



/** 规整配置（trim、裁剪 headers）。 */
function normalizeConfig(config: CustomMcpConfig): CustomMcpConfig {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    const key = k.trim();
    if (key.length > 0) headers[key] = v;
  }
  return {
    id: config.id,
    name: config.name.trim(),
    transport: config.transport,
    url: config.url.trim(),
    headers,
  };
}

/** 安全解析 headers JSON（坏数据兜底 {}）。 */
function parseHeaders(raw: string): Record<string, string> {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function rowToConfig(row: typeof customMcpServers.$inferSelect): CustomMcpConfig {
  return {
    id: row.id,
    name: row.name,
    transport: (MCP_TRANSPORTS.includes(row.transport as McpTransport)
      ? row.transport
      : 'http') as McpTransport,
    url: row.url,
    headers: parseHeaders(row.headers),
  };
}

/** 列出当前账号的全部自定义 MCP（按 sortOrder 升序，再按 createdAt）。 */
async function listCustomMcpServers(): Promise<CustomMcpConfig[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select()
    .from(customMcpServers)
    .orderBy(asc(customMcpServers.sortOrder), asc(customMcpServers.createdAt));
  return rows.map(rowToConfig);
}

/** Secret-free generation markers for freezing a Bot task's MCP capability set. */
async function listCustomMcpRuntimeGenerations(): Promise<Array<{
  id: string;
  transport: McpTransport;
  updatedAt: number;
}>> {
  const rows = await getDbClient().drizzle
    .select({
      id: customMcpServers.id,
      transport: customMcpServers.transport,
      updatedAt: customMcpServers.updatedAt,
    })
    .from(customMcpServers)
    .orderBy(asc(customMcpServers.sortOrder), asc(customMcpServers.createdAt));
  return rows.map((row) => ({
    id: row.id,
    transport: (MCP_TRANSPORTS.includes(row.transport as McpTransport)
      ? row.transport
      : 'http') as McpTransport,
    updatedAt: row.updatedAt,
  }));
}

/** 取单个；不存在返回 null。 */
async function getCustomMcpServer(id: string): Promise<CustomMcpConfig | null> {
  const db = getDbClient().drizzle;
  const row = await db.select().from(customMcpServers).where(eq(customMcpServers.id, id)).get();
  return row ? rowToConfig(row) : null;
}

/** 该 id 是否已存在。 */
async function customMcpServerExists(id: string): Promise<boolean> {
  return (await getCustomMcpServer(id)) != null;
}

/**
 * 新建。调用方须先 `validateCustomMcpConfig` + 处理重名（`customMcpServerExists`）。
 * 返回入库后的规整配置。
 */
async function createCustomMcpServer(
  config: CustomMcpConfig,
  now: number = Date.now(),
): Promise<CustomMcpConfig> {
  const c = normalizeConfig(config);
  const db = getDbClient().drizzle;
  const agg = await db
    .select({ maxOrder: sql<number | null>`MAX(${customMcpServers.sortOrder})` })
    .from(customMcpServers)
    .get();
  const nextOrder = (agg?.maxOrder ?? -1) + 1;
  await db.insert(customMcpServers).values({
    id: c.id,
    name: c.name,
    transport: c.transport,
    url: c.url,
    headers: JSON.stringify(c.headers),
    sortOrder: nextOrder,
    createdAt: now,
    updatedAt: now,
  });
  return c;
}

/**
 * 更新（id 不可改）。调用方须先 `validateCustomMcpConfig`。返回更新后的规整配置；
 * 行不存在时返回 null（handler 映射成 NOT_FOUND）。
 */
async function updateCustomMcpServer(
  id: string,
  config: CustomMcpConfig,
  now: number = Date.now(),
): Promise<CustomMcpConfig | null> {
  const c = normalizeConfig({ ...config, id });
  const db = getDbClient().drizzle;
  const existing = await db
    .select()
    .from(customMcpServers)
    .where(eq(customMcpServers.id, id))
    .get();
  if (!existing) return null;
  await db
    .update(customMcpServers)
    .set({
      name: c.name,
      transport: c.transport,
      url: c.url,
      headers: JSON.stringify(c.headers),
      updatedAt: now,
    })
    .where(eq(customMcpServers.id, id));
  return c;
}

/** 删除（幂等：不存在也不报错）。 */
async function deleteCustomMcpServer(id: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db.delete(customMcpServers).where(eq(customMcpServers.id, id));
}
return {
  listCustomMcpServers,
  listCustomMcpRuntimeGenerations,
  getCustomMcpServer,
  customMcpServerExists,
  createCustomMcpServer,
  updateCustomMcpServer,
  deleteCustomMcpServer
};
}
