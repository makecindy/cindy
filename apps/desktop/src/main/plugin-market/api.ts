import {
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  type GetPluginResponse,
  type ListPluginsResponse,
  type PluginRemovalNotice,
  type PluginDownloadResponse,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';

const log = createLogger('plugin-market-api');

type Fetcher = <T>(
  apiPath: string,
  options: Omit<ApiFetchOptions, 'baseUrl'>,
) => Promise<T>;

const defaultFetcher: Fetcher = (apiPath, options) =>
  serverApiFetch(apiPath, {
    ...options,
    baseUrl: () => getClientEndpoint('pluginApiBaseUrl'),
    // 插件市场的 path 都带用户装的插件 ID(`/api/plugins/<pluginId>[/releases/<id>/download]`),
    // 4xx/5xx 落进 serverApiClient 的日志会外泄第三方插件身份。redactErrorDetails 压掉响应
    // 详情,logLabel 用不含 ID 的路由模板代替真实 path(2026-08-06 review)。
    redactErrorDetails: true,
    logLabel: '/api/plugins',
  });

/** plugin-server 普通客户端 API；每个响应都经过共享 v2 parser fail-closed。 */
export class PluginMarketApi {
  constructor(private readonly fetcher: Fetcher = defaultFetcher) {}

  async listAll(
    query?: string,
  ): Promise<Pick<ListPluginsResponse, 'plugins' | 'removals'>> {
    const plugins: ListPluginsResponse['plugins'] = [];
    const removalsByPluginId = new Map<string, PluginRemovalNotice>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({ scope: 'all', limit: '100' });
      if (query?.trim()) search.set('query', query.trim());
      if (cursor) search.set('cursor', cursor);
      const response = parseListPluginsResponse(
        await this.fetcher<unknown>(`/api/plugins?${search.toString()}`, {
          cache: 'no-store',
        }),
      );
      for (const plugin of response.plugins) {
        if (seen.has(plugin.id)) continue;
        seen.add(plugin.id);
        plugins.push(plugin);
      }
      for (const removal of response.removals) {
        if (!removalsByPluginId.has(removal.pluginId)) {
          removalsByPluginId.set(removal.pluginId, removal);
        }
      }
      if (!response.nextCursor) {
        // 在架优先(契约:通告与**任一页** plugins 有交集即作废)的作用域是
        // 未经 owner 过滤的完整目录,必须留在聚合层;挪到 service 的 owner
        // 视角之后,owner 不可见但在架的插件会被错误放行清理。
        const removals = [...removalsByPluginId.values()].filter((removal) => {
          if (!seen.has(removal.pluginId)) return true;
          log.warn('market removal ignored because plugin is active', {
            pluginId: removal.pluginId,
          });
          return false;
        });
        return { plugins, removals };
      }
      if (response.nextCursor === cursor) throw new Error('Plugin 市场分页游标未前进');
      cursor = response.nextCursor;
    }
    throw new Error('Plugin 市场分页超过安全上限');
  }

  async detail(pluginId: string): Promise<GetPluginResponse['plugin']> {
    return parseGetPluginResponse(
      await this.fetcher<unknown>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
        cache: 'no-store',
      }),
    ).plugin;
  }

  async download(
    pluginId: string,
    releaseId: string,
  ): Promise<PluginDownloadResponse> {
    return parsePluginDownloadResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/download`,
        { cache: 'no-store' },
      ),
    );
  }
}
