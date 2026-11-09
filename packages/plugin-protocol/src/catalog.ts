import { isValidGhostId } from './manifest.js';
import { isValidPluginNamespace, isValidPluginResourceId, parseListPluginsResponse,
  type ListPluginsResponse, type VisiblePluginSummary, type PluginObjectUrlOptions } from './delivery.js';
import { PluginProtocolError, isoDate, object, string } from './internal/parse.js';

export interface PluginCatalogCounts { all: number; public: number; organization: number; personal: number }
export type PluginReadPage = Omit<ListPluginsResponse, 'removals'>;
export interface PluginCatalogPage extends PluginReadPage { counts: PluginCatalogCounts | null }
export interface PluginRecommendations {
  schemaVersion: ListPluginsResponse['schemaVersion'];
  windowStart: string;
  windowEnd: string;
  plugins: VisiblePluginSummary[];
}
export type PluginResolveTarget = { key: string } & (
  { pluginId: string; ghostId?: never; namespace?: never }
  | { ghostId: string; namespace: string | null; pluginId?: never }
);
export interface PluginResolveRequest { targets: PluginResolveTarget[]; query?: string }
export interface PluginResolveResponse extends Omit<ListPluginsResponse, 'plugins' | 'nextCursor'> {
  results: ({ key: string; status: 'available'; plugin: VisiblePluginSummary; matchesQuery: boolean }
    | { key: string; status: 'unavailable' })[];
}

export function parsePluginReadPage(value: unknown, options?: PluginObjectUrlOptions): PluginReadPage {
  const raw = object(value, 'response');
  if ('removals' in raw) throw new PluginProtocolError('读取页不能携带清理通告');
  const { removals: _removals, ...page } = parseListPluginsResponse(raw, options);
  if (page.plugins.length > 100 || new Set(page.plugins.map(item => item.id)).size !== page.plugins.length)
    throw new PluginProtocolError('读取页过大或含重复标识');
  return page;
}

export function parsePluginCatalogPage(value: unknown, options?: PluginObjectUrlOptions): PluginCatalogPage {
  const raw = object(value, 'response');
  const page = parsePluginReadPage(raw, options);
  if (raw.counts === null) return { ...page, counts: null };
  const counts = object(raw.counts, 'response.counts');
  const result = {} as PluginCatalogCounts;
  for (const key of ['all', 'public', 'organization', 'personal'] as const) {
    const count = counts[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      throw new PluginProtocolError(`response.counts.${key} 不合法`);
    result[key] = count;
  }
  if (result.all !== result.public + result.organization + result.personal)
    throw new PluginProtocolError('response.counts 总数不一致');
  return { ...page, counts: result };
}

export function parsePluginRecommendations(value: unknown, options?: PluginObjectUrlOptions): PluginRecommendations {
  const raw = object(value, 'response');
  const page = parsePluginReadPage({ ...raw, nextCursor: null }, options);
  const windowStart = isoDate(raw.windowStart, 'response.windowStart');
  const windowEnd = isoDate(raw.windowEnd, 'response.windowEnd');
  if ('nextCursor' in raw || page.plugins.length > 12
    || Date.parse(windowEnd) - Date.parse(windowStart) !== 86_400_000
    || page.plugins.some(item => item.scope !== 'public' || item.publisherKind !== 'official'))
    throw new PluginProtocolError('推荐池、来源或统计窗口不合法');
  return { schemaVersion: page.schemaVersion, windowStart, windowEnd, plugins: page.plugins };
}

export function parsePluginResolveRequest(value: unknown): PluginResolveRequest {
  const raw = object(value, 'request');
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 100)
    throw new PluginProtocolError('targets 必须包含 1–100 个目标');
  const keys = new Set<string>();
  const targets = raw.targets.map((value): PluginResolveTarget => {
    const target = object(value, 'target');
    const key = string(target.key, 'target.key', 128);
    if (keys.has(key)) throw new PluginProtocolError('target.key 重复');
    keys.add(key);
    if (target.pluginId !== undefined) {
      if (!isValidPluginResourceId(target.pluginId) || 'ghostId' in target || 'namespace' in target)
        throw new PluginProtocolError('资源标识与逻辑身份不能混用');
      return { key, pluginId: target.pluginId };
    }
    if (!isValidGhostId(target.ghostId) || (target.namespace !== null && !isValidPluginNamespace(target.namespace)))
      throw new PluginProtocolError('逻辑身份必须显式包含合法 namespace');
    return { key, ghostId: target.ghostId, namespace: target.namespace as string | null };
  });
  let query: string | undefined;
  if (raw.query !== undefined) {
    query = string(raw.query, 'request.query', 100).trim();
    if (!query) throw new PluginProtocolError('query 不能为空');
  }
  return { targets, ...(query ? { query } : {}) };
}

export function parsePluginResolveResponse(value: unknown, targets: PluginResolveTarget[], options?: PluginObjectUrlOptions): PluginResolveResponse {
  const raw = object(value, 'response');
  if (!Array.isArray(raw.results) || raw.results.length !== targets.length)
    throw new PluginProtocolError('目标核查结果不完整');
  const expected = new Set(targets.map(item => item.key));
  const available: unknown[] = [];
  const results = raw.results.map(value => {
    const item = object(value, 'result');
    const key = string(item.key, 'result.key', 128);
    if (!expected.delete(key)) throw new PluginProtocolError('未知或重复目标结果');
    if (item.status === 'unavailable') return { key, status: 'unavailable' as const };
    if (item.status !== 'available' || typeof item.matchesQuery !== 'boolean')
      throw new PluginProtocolError('目标核查状态不合法');
    available.push(item.plugin);
    return { key, status: 'available' as const, plugin: item.plugin, matchesQuery: item.matchesQuery };
  });
  const parsed = parseListPluginsResponse({ ...raw, plugins: available, nextCursor: null }, options);
  let resolvedIndex = 0;
  for (const item of results) {
    if (item.status !== 'available') continue;
    const plugin = parsed.plugins[resolvedIndex++]!;
    const target = targets.find(target => target.key === item.key)!;
    if (target.ghostId && (target.ghostId !== plugin.ghostId || target.namespace !== plugin.namespace))
      throw new PluginProtocolError('核查结果与请求的逻辑身份不一致');
  }
  for (const notice of parsed.removals) {
    if (!targets.some(target => target.pluginId ? target.pluginId === notice.pluginId
      : target.ghostId === notice.ghostId && target.namespace === notice.namespace))
      throw new PluginProtocolError('清理通告不属于请求目标');
  }
  let index = 0;
  return { schemaVersion: parsed.schemaVersion, currentOrganization: parsed.currentOrganization,
    removals: parsed.removals, ...(parsed.organizationAccessError ? { organizationAccessError: parsed.organizationAccessError } : {}),
    results: results.map(item => item.status === 'available' ? { ...item, plugin: parsed.plugins[index++]! } : item) };
}
