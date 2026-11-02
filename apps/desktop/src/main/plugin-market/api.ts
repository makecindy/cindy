import {
  assertPluginListOrganizationNamespace,
  CINDY_CLIENT_VERSION_HEADER,
  parseGetPluginResponse,
  parseListPluginsResponse,
  parsePluginDownloadResponse,
  type GetPluginResponse,
  type ListPluginsResponse,
  type OrganizationPluginAccessError,
  type PluginRemovalNotice,
  type PluginDownloadResponse,
  parsePluginUsageAck,
  type PluginUsageEventInput,
  type PluginUsageAck,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.js';
import { pluginObjectUrlOptions } from './objectUrlPolicy.js';

const log = createLogger('plugin-market-api');
const PLUGIN_MARKET_API_TIMEOUT_MS = 15_000;

/** 固定业务码，不含插件身份，可以穿过市场请求的脱敏边界。 */
export const PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES = [
  'PLUGIN_NAMESPACE_CLIENT_REQUIRED',
  'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
  'PLUGIN_NAMESPACE_CONFIG_REQUIRED',
  'PLUGIN_LIST_CHANGED',
] as const;

export type PluginMarketPassthroughErrorCode =
  (typeof PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES)[number];

export function isPluginMarketPassthroughErrorCode(
  code: string,
): code is PluginMarketPassthroughErrorCode {
  return (PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES as readonly string[]).includes(code);
}

function isPluginListChangedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'PLUGIN_LIST_CHANGED'
  );
}

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
    allowedRedactedErrorCodes: PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES,
  });

/** plugin-server 普通客户端 API；每个响应都经过共享 v2 parser fail-closed。 */
export class PluginMarketApi {
  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly getClientVersion: () => string = () => '0.0.0',
  ) {}

  private requestOptions(): Omit<ApiFetchOptions, 'baseUrl'> {
    return {
      cache: 'no-store',
      headers: { [CINDY_CLIENT_VERSION_HEADER]: this.getClientVersion(),
        'x-cindy-plugin-migrations': 'simulator-id-v1' },
      timeoutMs: PLUGIN_MARKET_API_TIMEOUT_MS,
    };
  }

  async listAll(
    query?: string,
  ): Promise<
    Pick<ListPluginsResponse, 'plugins' | 'removals' | 'currentOrganization' | 'organizationAccessError'>
  > {
    try {
      return await this.collectList(query);
    } catch (error) {
      if (!isPluginListChangedError(error)) throw error;
      log.warn('plugin list cursor invalidated, retrying from the first page');
      return this.collectList(query);
    }
  }

  private async collectList(
    query?: string,
  ): Promise<
    Pick<ListPluginsResponse, 'plugins' | 'removals' | 'currentOrganization' | 'organizationAccessError'>
  > {
    const plugins: ListPluginsResponse['plugins'] = [];
    const removalsByPluginId = new Map<string, PluginRemovalNotice>();
    let currentOrganization: ListPluginsResponse['currentOrganization'] = null;
    let organizationAccessError: OrganizationPluginAccessError | undefined;
    let organizationAccessState: 'unknown' | 'present' | 'absent' = 'unknown';
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const search = new URLSearchParams({ scope: 'all', limit: '100' });
      if (query?.trim()) search.set('query', query.trim());
      if (cursor) search.set('cursor', cursor);
      const response = parseListPluginsResponse(
        await this.fetcher<unknown>(
          `/api/plugins?${search.toString()}`,
          this.requestOptions(),
        ),
        pluginObjectUrlOptions(),
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
      // 取**第一个非 null** 的值，不要每页覆盖。服务端是否每页都重复下发
      // `currentOrganization` 并没有写进契约(PLAN §6 没有这一条),若它只在首页带，
      // 逐页覆盖会让第二页的 null 把身份事实抹掉——多页目录的组织就永远缓存不到前缀。
      // 两种服务端行为下这个写法都对，且结果确定。
      if (currentOrganization && response.currentOrganization &&
          (currentOrganization.organizationId !== response.currentOrganization.organizationId ||
            currentOrganization.orgSlug !== response.currentOrganization.orgSlug)) {
        throw new Error('Plugin 市场分页 currentOrganization 不一致');
      }
      currentOrganization ??= response.currentOrganization;
      const pageError = response.organizationAccessError;
      if (organizationAccessState === 'unknown') {
        organizationAccessState = pageError ? 'present' : 'absent';
        organizationAccessError = pageError;
      } else if (pageError) {
        if (organizationAccessState !== 'present') {
          throw new Error('Plugin 市场分页 organizationAccessError 不一致');
        }
        if (organizationAccessError?.code !== pageError.code) {
          log.warn('organization access error code changed across pages', {
            first: organizationAccessError?.code,
            next: pageError.code,
          });
        }
      } else if (organizationAccessState !== 'absent') {
        throw new Error('Plugin 市场分页 organizationAccessError 不一致');
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
        assertPluginListOrganizationNamespace(currentOrganization, plugins, removals);
        return {
          plugins,
          removals,
          currentOrganization,
          ...(organizationAccessError ? { organizationAccessError } : {}),
        };
      }
      if (response.nextCursor === cursor) throw new Error('Plugin 市场分页游标未前进');
      cursor = response.nextCursor;
    }
    throw new Error('Plugin 市场分页超过安全上限');
  }

  async detail(pluginId: string): Promise<GetPluginResponse['plugin']> {
    return parseGetPluginResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}`,
        this.requestOptions(),
      ),
      pluginObjectUrlOptions(),
    ).plugin;
  }

  async download(
    pluginId: string,
    releaseId: string,
  ): Promise<PluginDownloadResponse> {
    return parsePluginDownloadResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/download`,
        this.requestOptions(),
      ),
      pluginObjectUrlOptions(),
    );
  }

  async reportUsage(
    pluginId: string,
    events: PluginUsageEventInput[],
    context: { token: string | null; assertCurrent(): void },
  ): Promise<PluginUsageAck> {
    context.assertCurrent();
    const response = await this.fetcher<unknown>(
      `/api/plugins/${encodeURIComponent(pluginId)}/usage-events`,
      {
        ...this.requestOptions(),
        method: 'POST',
        token: context.token,
        timeoutMs: 5_000,
        skipAutoRefresh: true,
        skipSessionInvalidation: true,
        bodyFactory: () => {
          context.assertCurrent();
          return { events };
        },
      },
    );
    context.assertCurrent();
    return parsePluginUsageAck(response, events.map(event => event.eventId));
  }
}
