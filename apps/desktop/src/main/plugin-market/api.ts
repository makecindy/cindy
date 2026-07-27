import {
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  type GetPluginResponse,
  type ListPluginsResponse,
  type PluginDownloadResponse,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';

type Fetcher = <T>(
  apiPath: string,
  options: Omit<ApiFetchOptions, 'baseUrl'>,
) => Promise<T>;

const defaultFetcher: Fetcher = (apiPath, options) =>
  serverApiFetch(apiPath, {
    ...options,
    baseUrl: getClientEndpoint('pluginApiBaseUrl'),
  });

/** plugin-server 普通客户端 API；每个响应都经过共享 v2 parser fail-closed。 */
export class PluginMarketApi {
  constructor(private readonly fetcher: Fetcher = defaultFetcher) {}

  async listAll(query?: string): Promise<ListPluginsResponse['plugins']> {
    const plugins: ListPluginsResponse['plugins'] = [];
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
      if (!response.nextCursor) return plugins;
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
