import { describe, expect, it, vi } from 'vitest';

import { PluginMarketApi, PluginMarketEndpointUnsupportedError } from '../api';

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
}));
const serverApi = vi.hoisted(() => ({ serverApiFetch: vi.fn() }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logger.warn, error: vi.fn() }),
}));
vi.mock('../../serverApiClient.desktop.js', () => ({ serverApiFetch: serverApi.serverApiFetch }));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://plugins.example.com',
}));

const PLUGIN_A = `c${'a'.repeat(24)}`;
const PLUGIN_B = `c${'b'.repeat(24)}`;

it('reports only the bounded event contract with explicit auth and rechecks before HTTP serialization', async () => {
  const guard = vi.fn();
  const events = [{ eventId: 'event-1', releaseId: 'release-1', occurredAt: '2026-10-12T00:00:00.000Z' }];
  const fetcher = vi.fn().mockImplementation(async (_path, options) => {
    expect(options).toMatchObject({ method: 'POST', token: 'test-token', skipAutoRefresh: true, skipSessionInvalidation: true });
    expect(options.bodyFactory()).toEqual({ events });
    return { accepted: ['event-1'], duplicate: [], rejected: [] };
  });
  expect(await new PluginMarketApi(fetcher).reportUsage('plugin/id', events, { token: 'test-token', assertCurrent: guard }))
    .toMatchObject({ accepted: ['event-1'] });
  expect(fetcher.mock.calls[0][0]).toBe('/api/plugins/plugin%2Fid/usage-events');
  expect(guard).toHaveBeenCalledTimes(3);
});

function summary(id: string, ghostId: string) {
  return {
    id,
    ghostId,
    name: ghostId,
    description: null,
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    currentRelease: {
      id: `release-${ghostId}`,
      version: '1.0.0',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      publishedAt: '2026-07-23T00:00:00.000Z',
    },
  };
}

function removal(pluginId: string, ghostId: string) {
  return {
    pluginId,
    ghostId,
    scope: 'organization',
    organizationId: 'org-1',
    action: 'purge',
    removedAt: '2026-08-03T08:00:00.000Z',
  };
}

/** 依序吐出各页响应（自动补 schemaVersion: 2）的 fetcher mock。 */
function pagedFetcher(...pages: Array<Record<string, unknown>>) {
  const fetcher = vi.fn();
  for (const page of pages) {
    fetcher.mockResolvedValueOnce({ schemaVersion: 2, ...page });
  }
  return fetcher;
}

describe('PluginMarketApi 默认 fetcher 的日志隐私', () => {
  it('⚠️ 默认 fetcher 走 serverApiFetch 时带 redactErrorDetails + logLabel（不外泄插件 ID）', async () => {
    // 2026-08-06 review：plugin 的 path 带用户装的插件 ID,4xx/5xx 日志不得外泄它。
    serverApi.serverApiFetch.mockReset();
    serverApi.serverApiFetch.mockRejectedValueOnce(new Error('nope'));
    await expect(new PluginMarketApi().detail('cindy-github')).rejects.toBeTruthy();
    const opts = serverApi.serverApiFetch.mock.calls[0]?.[1] ?? {};
    expect(opts.redactErrorDetails).toBe(true);
    expect(opts.logLabel).toBe('/api/plugins');
    expect(opts.allowedRedactedErrorCodes).toEqual([
      'PLUGIN_NAMESPACE_CLIENT_REQUIRED',
      'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
      'PLUGIN_NAMESPACE_CONFIG_REQUIRED',
      'PLUGIN_LIST_CHANGED',
    ]);
  });
});

/** serverApiFetch 抛出的错误形状：脱敏后只剩 HTTP 状态与通用码。 */
function httpError(status: number) {
  return Object.assign(new Error(`请求失败 (${status})`), { code: status === 0 ? 'NETWORK_ERROR' : `HTTP_${status}`, statusCode: status });
}

/** 模拟尚未部署 v7.5 读取接口的旧 plugin-server。 */
function legacyServer(plugins: unknown[], onUnknown: (path: string) => never = (path) => {
  throw httpError(path === '/api/plugins/resolve' ? 404 : 400);
}) {
  const fetcher = vi.fn();
  fetcher.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/plugins?')) return { schemaVersion: 2, plugins, nextCursor: null };
    return onUnknown(path);
  });
  return fetcher;
}

describe('PluginMarketApi 旧服务端兼容', () => {
  // unit：客户端 62588f5ff0 先于服务端 eb701e0d4 上线；旧服务端把 defaults 当插件 ID（400），没有 resolve（404）。
  it('reads the full catalog when defaults, resolve and catalog do not exist, and remembers it', async () => {
    const fetcher = legacyServer([summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')]);
    const api = new PluginMarketApi(fetcher, undefined, () => 'https://plugins.example.com', () => 0);
    await expect(api.defaults()).rejects.toBeInstanceOf(PluginMarketEndpointUnsupportedError);

    const resolved = await api.resolve([{ key: 'a', pluginId: PLUGIN_A }, { key: 'b', ghostId: 'beta', namespace: null },
      { key: 'missing', ghostId: 'gamma', namespace: null }]);
    expect(resolved.results.map(row => [row.key, row.status])).toEqual([['a', 'available'], ['b', 'available'], ['missing', 'unavailable']]);

    const page = await api.catalog({ limit: 1 });
    expect(page.plugins.map(plugin => plugin.id)).toEqual([PLUGIN_A]);
    expect(page.counts?.all).toBe(2);
    expect((await api.catalog({ limit: 1, cursor: page.nextCursor })).plugins.map(plugin => plugin.id)).toEqual([PLUGIN_B]);
    // 记住旧服务端后不再逐个撞 404 / 400。
    expect(fetcher.mock.calls.map(call => String(call[0])).filter(path => !path.startsWith('/api/plugins?')))
      .toEqual(['/api/plugins/defaults?limit=100']);
  });

  it('falls back when only resolve is missing (404) and probes again after the memo expires', async () => {
    let now = 0;
    const fetcher = legacyServer([summary(PLUGIN_A, 'alpha')]);
    const api = new PluginMarketApi(fetcher, undefined, () => 'https://plugins.example.com', () => now);
    expect((await api.resolve([{ key: 'a', pluginId: PLUGIN_A }])).results[0]!.status).toBe('available');
    now = 11 * 60_000;
    await api.resolve([{ key: 'a', pluginId: PLUGIN_A }]);
    expect(fetcher.mock.calls.filter(call => call[0] === '/api/plugins/resolve')).toHaveLength(2);
  });

  it('does not match an organization plugin with unknown namespace to a public target', async () => {
    const org = { ...summary(PLUGIN_A, 'alpha'), scope: 'organization', organizationId: 'org-1' };
    const api = new PluginMarketApi(legacyServer([org]), undefined, () => 'https://plugins.example.com', () => 0);
    const resolved = await api.resolve([{ key: 'root', ghostId: 'alpha', namespace: null }]);
    expect(resolved.results).toEqual([{ key: 'root', status: 'unavailable' }]);
  });

  it.each([0, 401, 403, 500, 503])('does not fall back on HTTP %i', async (status) => {
    const fetcher = legacyServer([summary(PLUGIN_A, 'alpha')], () => { throw httpError(status); });
    const api = new PluginMarketApi(fetcher);
    await expect(api.defaults()).rejects.toMatchObject({ statusCode: status });
    await expect(api.resolve([{ key: 'a', pluginId: PLUGIN_A }])).rejects.toMatchObject({ statusCode: status });
    await expect(api.catalog()).rejects.toMatchObject({ statusCode: status });
    expect(fetcher.mock.calls.some(call => String(call[0]).startsWith('/api/plugins?'))).toBe(false);
  });

  it('keeps a catalog 400 as an error when the server does have defaults', async () => {
    const fetcher = vi.fn();
    fetcher.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/plugins/defaults')) return { schemaVersion: 2, plugins: [], nextCursor: null };
      throw httpError(400);
    });
    await expect(new PluginMarketApi(fetcher).catalog({ query: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(fetcher.mock.calls.some(call => String(call[0]).startsWith('/api/plugins?'))).toBe(false);
  });
});

describe('PluginMarketApi', () => {
  // unit：v7.5 市场必须按页读取；旧 listAll 用例不能证明首屏不会追完整目录。
  it('reads one catalog page and preserves complete query counts without following its cursor', async () => {
    const fetcher = pagedFetcher({ plugins: [summary(PLUGIN_A, 'alpha')], nextCursor: 'next-page',
      counts: { all: 200, public: 200, organization: 0, personal: 0 } });
    const result = await new PluginMarketApi(fetcher).catalog({ query: 'alpha', limit: 12 });
    expect(result.plugins).toHaveLength(1);
    expect(result.counts?.all).toBe(200);
    expect(result.nextCursor).toBe('next-page');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toContain('/api/plugins/catalog?');
  });

  it('rejects incomplete target responses instead of interpreting them as missing installations', async () => {
    const fetcher = pagedFetcher({ results: [], currentOrganization: null, removals: [] });
    await expect(new PluginMarketApi(fetcher).resolve([{ key: 'installed', pluginId: PLUGIN_A }])).rejects.toThrow();
    expect(fetcher.mock.calls[0]![0]).toBe('/api/plugins/resolve');
  });

  it('paginates with opaque cursors and deduplicates repeated ids', async () => {
    const fetcher = pagedFetcher(
      { plugins: [summary(PLUGIN_A, 'alpha')], nextCursor: PLUGIN_A },
      {
        plugins: [summary(PLUGIN_A, 'alpha'), summary(PLUGIN_B, 'beta')],
        nextCursor: null,
      },
    );
    const api = new PluginMarketApi(fetcher, () => '1.2.3');

    await expect(api.listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      removals: [],
    });
    expect(fetcher.mock.calls[1]?.[0]).toContain(`cursor=${PLUGIN_A}`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-cindy-version': '1.2.3' },
      timeoutMs: 15_000,
    });
  });

  it('sends the client version on detail and download unchanged', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugin: {
          ...summary(PLUGIN_A, 'alpha'),
          currentRelease: {
            ...summary(PLUGIN_A, 'alpha').currentRelease,
            manifest: {
              schemaVersion: 2, id: 'alpha', name: 'alpha', version: '1.0.0', kind: 'chip',
              entry: 'index.js', slots: ['tool'], tools: [{ name: 'help', description: 'Help' }],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        url: 'https://downloads.example.test/plugin.cindy',
        expiresAt: '2099-01-01T00:00:00.000Z',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
      });
    const api = new PluginMarketApi(fetcher, () => '0.0.0-dev');
    await api.detail(PLUGIN_A);
    await api.download(PLUGIN_A, 'release-alpha');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { 'x-cindy-version': '0.0.0-dev' } });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { 'x-cindy-version': '0.0.0-dev' } });
    expect(fetcher.mock.calls.map((call) => call[1]?.headers?.['x-cindy-version'])).toEqual(['0.0.0-dev', '0.0.0-dev']);
  });

  it('deduplicates removals by pluginId across pages keeping the first-seen notice', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
      },
      {
        plugins: [],
        removals: [
          // 同 pluginId 但内容不同的后到通告必须被丢弃(保首见)。
          { ...removal(PLUGIN_A, 'alpha'), removedAt: '2026-08-04T00:00:00.000Z' },
          removal(PLUGIN_B, 'beta'),
        ],
        nextCursor: null,
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [],
      removals: [
        { pluginId: PLUGIN_A, removedAt: '2026-08-03T08:00:00.000Z' },
        { pluginId: PLUGIN_B },
      ],
    });
  });

  it('keeps active plugins over conflicting removals across pages', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [],
        removals: [removal(PLUGIN_A, 'alpha'), removal(PLUGIN_B, 'beta')],
        nextCursor: PLUGIN_A,
      },
      { plugins: [summary(PLUGIN_A, 'alpha')], removals: [], nextCursor: null },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }],
      removals: [{ pluginId: PLUGIN_B }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'market removal ignored because plugin is active',
      { pluginId: PLUGIN_A },
    );
  });

  it('fails closed when the server still returns schema v1', async () => {
    const api = new PluginMarketApi(
      vi.fn().mockResolvedValue({
        schemaVersion: 1,
        plugins: [],
        nextCursor: null,
      }),
    );

    await expect(api.listAll()).rejects.toThrow('schemaVersion');
  });

  it('rejects a cursor that does not advance', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      schemaVersion: 2,
      plugins: [],
      nextCursor: PLUGIN_A,
    });
    const api = new PluginMarketApi(fetcher);

    await expect(api.listAll()).rejects.toThrow('游标未前进');
  });

  it('surfaces currentOrganization from the completed list response', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
    });
  });

  // 服务端是否每页都重复下发 currentOrganization 没有写进契约。若它只在首页带,
  // 逐页覆盖会让后续页的 null 抹掉身份事实,多页目录的组织就永远缓存不到前缀。
  // 上面那条用例两页都带了值,所以在"每页重复"的假设下必过、抓不到这个问题。
  it('keeps the first non-null currentOrganization across later pages that omit it', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: null,
      },
    );

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      currentOrganization: { organizationId: 'org-acme', pluginPrefix: 'acme' },
    });
  });

  it('rejects a later page whose organization namespace conflicts with the first-page identity', async () => {
    const fetcher = pagedFetcher(
      {
        plugins: [], nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      },
      {
        plugins: [{ ...summary(PLUGIN_B, 'beta'), scope: 'organization',
          organizationId: 'org-other', namespace: 'other' }],
        nextCursor: null,
      },
    );
    await expect(new PluginMarketApi(fetcher).listAll()).rejects.toThrow('namespace');
  });

  it('rejects conflicting organization facts across pages even with empty listings', async () => {
    const fetcher = pagedFetcher(
      { plugins: [], nextCursor: PLUGIN_A,
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' } },
      { plugins: [], nextCursor: null,
        currentOrganization: { organizationId: 'org-other', orgSlug: 'other', pluginPrefix: 'other' } },
    );
    await expect(new PluginMarketApi(fetcher).listAll()).rejects.toThrow('currentOrganization');
  });

  it('keeps a null currentOrganization as a personal-identity fact', async () => {
    const fetcher = pagedFetcher({
      plugins: [summary(PLUGIN_A, 'alpha')],
      nextCursor: null,
      currentOrganization: null,
    });

    await expect(new PluginMarketApi(fetcher).listAll()).resolves.toMatchObject({
      currentOrganization: null,
    });
  });

  it('keeps one organization access error across pages and rejects a disagreement', async () => {
    const organization = { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' };
    const accessError = { code: 'PLUGIN_NAMESPACE_CONFIG_REQUIRED', message: '暂不可用' };
    const consistent = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: 'cursor-1',
        currentOrganization: organization,
        organizationAccessError: accessError,
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: organization,
        organizationAccessError: accessError,
      },
    );
    await expect(new PluginMarketApi(consistent).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      removals: [],
      organizationAccessError: accessError,
    });

    const changedReason = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: 'cursor-1',
        currentOrganization: organization,
        organizationAccessError: {
          code: 'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
          message: '稍后重试',
        },
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: organization,
        organizationAccessError: accessError,
      },
    );
    await expect(new PluginMarketApi(changedReason).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_A }, { id: PLUGIN_B }],
      organizationAccessError: {
        code: 'PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE',
        message: '稍后重试',
      },
    });

    const disagreed = pagedFetcher(
      {
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: 'cursor-1',
        currentOrganization: organization,
        organizationAccessError: accessError,
      },
      {
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: organization,
      },
    );
    await expect(new PluginMarketApi(disagreed).listAll()).rejects.toThrow('organizationAccessError');
  });

  it('restarts the catalog once after PLUGIN_LIST_CHANGED and does not loop', async () => {
    const changed = Object.assign(new Error('changed'), {
      code: 'PLUGIN_LIST_CHANGED',
      statusCode: 409,
    });
    const restarted = vi.fn()
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_A, 'alpha')],
        nextCursor: 'cursor-1',
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      })
      .mockRejectedValueOnce(changed)
      .mockResolvedValueOnce({
        schemaVersion: 2,
        plugins: [summary(PLUGIN_B, 'beta')],
        nextCursor: null,
        currentOrganization: { organizationId: 'org-acme', orgSlug: 'acme', pluginPrefix: 'acme' },
      });
    await expect(new PluginMarketApi(restarted).listAll()).resolves.toMatchObject({
      plugins: [{ id: PLUGIN_B }],
    });
    expect(restarted).toHaveBeenCalledTimes(3);
    expect(String(restarted.mock.calls[2]?.[0])).not.toContain('cursor=');

    const stuck = vi.fn().mockRejectedValue(changed);
    await expect(new PluginMarketApi(stuck).listAll()).rejects.toMatchObject({
      code: 'PLUGIN_LIST_CHANGED',
    });
    expect(stuck).toHaveBeenCalledTimes(2);
  });
});
