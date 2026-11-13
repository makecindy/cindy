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
  parsePluginCatalogPage,
  parsePluginReadPage,
  parsePluginRecommendations,
  parsePluginResolveRequest,
  parsePluginResolveResponse,
  type PluginCatalogPage,
  type PluginResolveResponse,
  type PluginResolveTarget,
  type PluginScope,
  type VisiblePluginSummary,
} from '@cindy/plugin-protocol';

import { getClientEndpoint } from '../clientEndpointsService.js';
import { createLogger } from '../logger.js';
import { serverApiFetch, type ApiFetchOptions } from '../serverApiClient.desktop.js';
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

/**
 * 当前服务端还没有 v7.5 按需读取接口（`catalog` / `defaults` / `resolve` / `recommendations`）。
 * 客户端可能先于 plugin-server 上线：旧服务端把 `GET /api/plugins/<name>` 当成插件 ID
 * 校验（400），且没有 `POST /api/plugins/resolve`（404）。调用方据此回退到旧的整份目录读取。
 */
export class PluginMarketEndpointUnsupportedError extends Error {
  readonly code = 'PLUGIN_MARKET_ENDPOINT_UNSUPPORTED';
  constructor() {
    super('Plugin market server does not support paged reads');
    this.name = 'PluginMarketEndpointUnsupportedError';
  }
}

/** 记住「服务端不支持」的时长；过期后重新探测，服务端部署后无需重启客户端。 */
const LEGACY_SERVER_MEMO_MS = 10 * 60_000;
const LEGACY_CURSOR_PREFIX = 'legacy:';

/** HTTP 状态来自 serverApiFetch 抛出的 ServerApiError；网络错误为 0，解析错误没有状态。 */
function httpStatus(error: unknown): number | null {
  const status = typeof error === 'object' && error !== null ? (error as { statusCode?: unknown }).statusCode : undefined;
  return typeof status === 'number' ? status : null;
}

type Fetcher = <T>(
  apiPath: string,
  options: Omit<ApiFetchOptions, 'baseUrl'>,
) => Promise<T>;

type PluginCatalogRead = PluginCatalogPage & {
  /** Main-only, request-scoped query results for legacy installed-count deduction. */
  legacyQueryPlugins?: VisiblePluginSummary[];
};

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
  /** 按市场地址记住旧服务端，值为到期时间。 */
  private readonly legacyServerUntil = new Map<string, number>();

  constructor(
    private readonly fetcher: Fetcher = defaultFetcher,
    private readonly getClientVersion: () => string = () => '0.0.0',
    private readonly getBaseUrl: () => string = () => getClientEndpoint('pluginApiBaseUrl'),
    private readonly now: () => number = Date.now,
  ) {}

  private isKnownLegacyServer(): boolean {
    const key = this.getBaseUrl();
    const until = this.legacyServerUntil.get(key);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.legacyServerUntil.delete(key);
    return false;
  }

  private rememberLegacyServer(): void {
    log.warn('plugin server lacks paged read endpoints, falling back to full catalog reads');
    this.legacyServerUntil.set(this.getBaseUrl(), this.now() + LEGACY_SERVER_MEMO_MS);
  }

  /**
   * 只把「接口不存在」认定为旧服务端：404 / 405，或固定参数的 defaults 首页被旧路由当成
   * 插件 ID 拒绝（400）。网络、鉴权、5xx、组织变更等错误原样抛出。
   */
  private async readDefaultsPage(cursor: string | null) {
    const search = new URLSearchParams({ limit: '100' });
    if (cursor) search.set('cursor', cursor);
    try {
      return parsePluginReadPage(await this.fetcher<unknown>(`/api/plugins/defaults?${search}`, this.requestOptions()), pluginObjectUrlOptions());
    } catch (error) {
      const status = httpStatus(error);
      if (status === 404 || status === 405 || (status === 400 && cursor === null)) {
        this.rememberLegacyServer();
        throw new PluginMarketEndpointUnsupportedError();
      }
      throw error;
    }
  }

  /** catalog / recommendations 的参数可能被新服务端合法地拒绝（400），用固定参数的 defaults 首页确认。 */
  private async confirmLegacyServer(error: unknown, allowBadRequest: boolean): Promise<boolean> {
    const status = httpStatus(error);
    if (status === 404 || status === 405) {
      this.rememberLegacyServer();
      return true;
    }
    if (status !== 400 || !allowBadRequest) return false;
    try {
      await this.readDefaultsPage(null);
      return false;
    } catch (probeError) {
      if (probeError instanceof PluginMarketEndpointUnsupportedError) return true;
      return false;
    }
  }

  private requestOptions(): Omit<ApiFetchOptions, 'baseUrl'> {
    return {
      cache: 'no-store',
      headers: { [CINDY_CLIENT_VERSION_HEADER]: this.getClientVersion(),
        'x-cindy-plugin-migrations': 'simulator-id-v1' },
      timeoutMs: PLUGIN_MARKET_API_TIMEOUT_MS,
    };
  }

  async catalog(options: { scope?: PluginScope | 'all'; query?: string; limit?: number;
    cursor?: string | null; counts?: boolean } = {}): Promise<PluginCatalogRead> {
    if (options.cursor?.startsWith(LEGACY_CURSOR_PREFIX) || this.isKnownLegacyServer()) return this.legacyCatalog(options);
    try {
      return await this.readCatalogPage(options);
    } catch (error) {
      if (await this.confirmLegacyServer(error, !options.cursor)) return this.legacyCatalog(options);
      throw error;
    }
  }

  private async readCatalogPage(options: { scope?: PluginScope | 'all'; query?: string; limit?: number;
    cursor?: string | null; counts?: boolean }) {
    const search = new URLSearchParams({ scope: options.scope ?? 'all', limit: String(options.limit ?? 12),
      counts: String(options.counts !== false) });
    if (options.query?.trim()) search.set('query', options.query.trim());
    if (options.cursor) search.set('cursor', options.cursor);
    return parsePluginCatalogPage(await this.fetcher<unknown>(`/api/plugins/catalog?${search}`, this.requestOptions()), pluginObjectUrlOptions());
  }

  /** 旧服务端：读整份目录后在本地分页，游标是本地偏移量。 */
  private async legacyCatalog(options: { scope?: PluginScope | 'all'; query?: string; limit?: number;
    cursor?: string | null; counts?: boolean }): Promise<PluginCatalogRead> {
    const scope = options.scope ?? 'all';
    const limit = options.limit ?? 12;
    let offset = 0;
    if (options.cursor) {
      const raw = options.cursor.startsWith(LEGACY_CURSOR_PREFIX) ? options.cursor.slice(LEGACY_CURSOR_PREFIX.length) : '';
      offset = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(offset)) throw new Error('Plugin 市场分页游标不合法');
    }
    const catalog = await this.listAll(options.query?.trim() || undefined);
    const visible = scope === 'all' ? catalog.plugins : catalog.plugins.filter(plugin => plugin.scope === scope);
    const plugins = visible.slice(offset, offset + limit);
    const next = offset + plugins.length;
    const counts = options.counts === false ? null : {
      all: catalog.plugins.length,
      public: catalog.plugins.filter(plugin => plugin.scope === 'public').length,
      organization: catalog.plugins.filter(plugin => plugin.scope === 'organization').length,
      personal: catalog.plugins.filter(plugin => plugin.scope === 'personal').length,
    };
    return {
      schemaVersion: 2,
      plugins,
      nextCursor: next < visible.length ? `${LEGACY_CURSOR_PREFIX}${next}` : null,
      currentOrganization: catalog.currentOrganization,
      ...(catalog.organizationAccessError ? { organizationAccessError: catalog.organizationAccessError } : {}),
      counts,
      ...(counts ? { legacyQueryPlugins: catalog.plugins } : {}),
    };
  }

  async recommendations() {
    if (this.isKnownLegacyServer()) throw new PluginMarketEndpointUnsupportedError();
    try {
      return await this.readRecommendations();
    } catch (error) {
      if (await this.confirmLegacyServer(error, true)) throw new PluginMarketEndpointUnsupportedError();
      throw error;
    }
  }

  private async readRecommendations() {
    return parsePluginRecommendations(await this.fetcher<unknown>('/api/plugins/recommendations', this.requestOptions()), pluginObjectUrlOptions());
  }

  async resolve(targets: PluginResolveTarget[], query?: string): Promise<PluginResolveResponse> {
    const body = parsePluginResolveRequest({ targets, ...(query?.trim() ? { query: query.trim() } : {}) });
    if (this.isKnownLegacyServer()) return this.legacyResolve(targets, query);
    try {
      return parsePluginResolveResponse(await this.fetcher<unknown>('/api/plugins/resolve', {
        ...this.requestOptions(), method: 'POST', body,
      }), targets, pluginObjectUrlOptions());
    } catch (error) {
      // 旧服务端没有 POST 路由；请求体由客户端 parser 生成，400 不能当成接口缺失。
      const status = httpStatus(error);
      if (status !== 404 && status !== 405) throw error;
      this.rememberLegacyServer();
      return this.legacyResolve(targets, query);
    }
  }

  /** 旧服务端：在整份目录里按插件 ID 或 ghostId + namespace 核对目标。 */
  private async legacyResolve(targets: PluginResolveTarget[], query?: string): Promise<PluginResolveResponse> {
    const catalog = await this.listAll();
    const matching = query?.trim() ? new Set((await this.listAll(query.trim())).plugins.map(plugin => plugin.id)) : null;
    const orgSlug = catalog.currentOrganization?.orgSlug ?? null;
    // `undefined` = unknown organization namespace (old server sent neither): never match it to a public (`null`) target.
    const namespaceOf = (plugin: { scope: PluginScope; namespace?: string | null }): string | null | undefined =>
      plugin.namespace !== undefined ? plugin.namespace : plugin.scope === 'organization' ? (orgSlug ?? undefined) : null;
    const owns = (target: PluginResolveTarget, identity: { pluginId: string; ghostId: string; scope: PluginScope; namespace?: string | null }) =>
      target.pluginId ? target.pluginId === identity.pluginId
        : target.ghostId === identity.ghostId && namespaceOf(identity) !== undefined && target.namespace === namespaceOf(identity);
    const results: PluginResolveResponse['results'] = targets.map((target) => {
      const plugin: VisiblePluginSummary | undefined = catalog.plugins.find(item => owns(target, { ...item, pluginId: item.id }));
      return plugin
        ? { key: target.key, status: 'available', plugin: target.ghostId ? { ...plugin, namespace: target.namespace } : plugin,
          matchesQuery: matching ? matching.has(plugin.id) : true }
        : { key: target.key, status: 'unavailable' };
    });
    return {
      schemaVersion: 2,
      results,
      removals: catalog.removals.filter(notice => targets.some(target => owns(target, notice))),
      currentOrganization: catalog.currentOrganization,
      ...(catalog.organizationAccessError ? { organizationAccessError: catalog.organizationAccessError } : {}),
    };
  }

  /** 旧服务端抛 {@link PluginMarketEndpointUnsupportedError}，由调用方改读整份目录。 */
  async defaults(cursor: string | null = null) {
    if (this.isKnownLegacyServer()) throw new PluginMarketEndpointUnsupportedError();
    return this.readDefaultsPage(cursor);
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

  /** `readmeLocale` 让服务端按该语言选详细介绍；旧服务端忽略这个参数。 */
  async detail(
    pluginId: string,
    options?: { readmeLocale?: string },
  ): Promise<GetPluginResponse['plugin']> {
    const query = options?.readmeLocale
      ? `?readmeLocale=${encodeURIComponent(options.readmeLocale)}`
      : '';
    return parseGetPluginResponse(
      await this.fetcher<unknown>(
        `/api/plugins/${encodeURIComponent(pluginId)}${query}`,
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
