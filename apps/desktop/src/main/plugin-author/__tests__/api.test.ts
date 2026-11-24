/**
 * Organization plugin author / colleague-picker client (#1541, server #1553 / #1593).
 * Protects: a server without author routes is detected only by the list's route-level 404 and
 * never confused with a missing plugin; responses that arrive after an account switch are dropped;
 * lookups respect the server batch limit; picker IPC rejects malformed input.
 * Entry: PluginAuthorApi with an injected fetch; createPluginAuthorPickerHandlers. Unit tier.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../host.js', () => ({ createPluginAuthorApi: vi.fn() }));
vi.mock('../../plugin-contributions/reviewUpdates.js', () => ({ organizationReviewUpdates: vi.fn() }));

import { createServerApiClient, ServerApiError } from '../../serverApiClient.js';
import { PluginAuthorApi, PluginAuthorUnsupportedError, type AuthorFetch } from '../api.js';
import { createOrganizationReviewUpdates, organizationDecision } from '../reviewUpdates.js';
import { createPluginAuthorManagementHandlers, createPluginAuthorPickerHandlers, mapPluginAuthorError } from '../registerIpc.js';

function api(fetch: AuthorFetch, ownerKey: () => string | null = () => 'owner-a') {
  return new PluginAuthorApi({
    fetch,
    pluginBaseUrl: () => 'https://plugins.example.test',
    authBaseUrl: () => 'https://auth.example.test',
    clientVersion: () => '1.2.3',
    ownerKey,
  });
}

const summary = (id: string, ghostId: string) => ({
  id, ghostId, namespace: 'acme', name: ghostId, myRole: 'creator', status: 'active',
});

describe('PluginAuthorApi', () => {
  it('reads every page of the author list and tells an old server from a missing plugin', async () => {
    const fetch = vi.fn(async (path: string) => (path.includes('cursor=c2')
      ? { plugins: [summary('p2', 'b')], nextCursor: null }
      : { plugins: [summary('p1', 'a')], nextCursor: 'c2' })) as unknown as AuthorFetch;
    await expect(api(fetch).listPages()).resolves.toMatchObject({ plugins: [{ id: 'p1' }, { id: 'p2' }], nextCursor: null });

    // A long list stops after a bounded number of pages and says where to continue.
    let page = 0;
    const endless = vi.fn(async () => ({ plugins: [summary(`p${page}`, `g${page}`)], nextCursor: `c${++page}` })) as unknown as AuthorFetch;
    const first = await api(endless).listPages();
    expect(first.plugins).toHaveLength(20);
    expect(first.nextCursor).toBe('c20');

    const oldServer = vi.fn(async () => { throw new ServerApiError('NOT_FOUND', 404, '资源不存在'); });
    await expect(api(oldServer as unknown as AuthorFetch).listPages()).rejects.toBeInstanceOf(PluginAuthorUnsupportedError);

    const missingPlugin = vi.fn(async () => { throw new ServerApiError('PLUGIN_NOT_FOUND', 404, 'x'); });
    await expect(api(missingPlugin as unknown as AuthorFetch).detail('p9')).rejects.toMatchObject({ code: 'PLUGIN_NOT_FOUND' });
  });

  it('drops a response that arrives after the account changed', async () => {
    let owner = 'owner-a';
    const fetch = vi.fn(async () => {
      owner = 'owner-b';
      return { departments: [] };
    }) as unknown as AuthorFetch;
    await expect(api(fetch, () => owner).departments()).rejects.toThrow(/OWNER_CHANGED/);
    await expect(api(fetch, () => null).departments()).rejects.toThrow(/PERMISSION_DENIED/);
  });

  // Review fix: a 401 refresh can replace the signed-in identity. The resend must not carry a
  // write that the previous account started.
  it('does not resend a write after a refresh switched the account', async () => {
    let owner = 'owner-a';
    const sent: string[] = [];
    const fetch = createServerApiClient({
      fetch: vi.fn(async (_url: unknown, init?: { method?: string }) => {
        sent.push(init?.method ?? 'GET');
        return new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED', message: 'expired' } }), { status: 401 });
      }) as unknown as typeof globalThis.fetch,
      locale: () => 'en',
      auth: {
        getAccessToken: () => `token-${owner}`,
        refresh: vi.fn(async () => { owner = 'owner-b'; return true; }),
        invalidateSession: vi.fn(),
      } as never,
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }) as unknown as AuthorFetch;
    await expect(api(fetch, () => owner).update('p1', { status: 'disabled' })).rejects.toThrow(/OWNER_CHANGED/);
    expect(sent).toEqual(['PATCH']);
  });

  it('looks up member names in batches the server accepts', async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (_path: string, options: { body?: unknown }) => {
      bodies.push(options.body);
      return { members: [] };
    }) as unknown as AuthorFetch;
    await api(fetch).lookupColleagues(Array.from({ length: 150 }, (_, index) => `m${index % 120}`));
    expect(bodies.map((body) => (body as { membershipIds: string[] }).membershipIds.length)).toEqual([100, 20]);
  });
});

describe('plugin author picker IPC', () => {
  it('validates picker input and maps old servers to UNSUPPORTED_CAPABILITY', async () => {
    const fake = {
      departmentMembers: vi.fn(async () => ({ members: [], total: 0 })),
      searchColleagues: vi.fn(async () => []),
    };
    const handlers = createPluginAuthorPickerHandlers(() => fake as never);
    await handlers.departmentMembers({ departmentId: 'd1', page: 2 });
    expect(fake.departmentMembers).toHaveBeenCalledWith('d1', 2);
    expect(() => handlers.departmentMembers({ departmentId: 'd1', page: 0 })).toThrow();
    expect(() => handlers.searchColleagues('   ')).toThrow();
    expect(() => mapPluginAuthorError(new PluginAuthorUnsupportedError())).toThrow(/UNSUPPORTED_CAPABILITY/);
    expect(() => mapPluginAuthorError(new ServerApiError('RATE_LIMITED', 429, 'x'))).toThrow(/RATE_LIMITED/);
    // Review fix: a business 404 on any other call is not "older server".
    expect(() => mapPluginAuthorError(new ServerApiError('RELEASE_NOT_FOUND', 404, 'x'))).toThrow(/\[NOT_FOUND\]/);
    expect(() => mapPluginAuthorError(new ServerApiError('NOT_FOUND', 404, 'x'))).toThrow(/\[NOT_FOUND\]/);
    expect(() => mapPluginAuthorError(new ServerApiError('PLUGIN_NOT_FOUND', 404, 'x'))).toThrow(/PLUGIN_NOT_FOUND/);
  });
});

// Author management (#1504 permission table). The server enforces roles; the client must send
// only shapes the server accepts and report its answers in author-facing terms.
describe('plugin author management', () => {
  it('validates writes and maps the server answers authors need to read', async () => {
    const calls: Array<[string, string | undefined, unknown]> = [];
    const fetch = vi.fn(async (path: string, options: { method?: string; body?: unknown }) => {
      calls.push([path, options.method, options.body]);
      if (path.endsWith('/maintainers') && options.method === 'POST') {
        throw new ServerApiError('PLUGIN_GHOST_ID_CONFLICT', 409, 'x');
      }
      if (options.method === 'DELETE') throw new ServerApiError('EMPTY_RESPONSE', 204, '响应体为空');
      if (options.method === 'PATCH') throw new ServerApiError('PLUGIN_DISABLED_BY_ADMIN', 409, 'x');
      return {};
    }) as unknown as AuthorFetch;
    const handlers = createPluginAuthorManagementHandlers(() => api(fetch));

    expect(() => handlers.updatePlugin({ pluginId: 'p1', update: { visibilityAudience: { type: 'matchAny' } } })).toThrow();
    expect(() => handlers.updatePlugin({ pluginId: 'p1', update: { status: 'archived' } })).toThrow();
    expect(() => handlers.updatePlugin({ pluginId: 'p1', update: { status: 'active', name: 'x' } })).toThrow();
    await expect(handlers.updatePlugin({ pluginId: 'p1', update: { status: 'active' } }))
      .rejects.toMatchObject({ code: 'PLUGIN_DISABLED_BY_ADMIN' });
    expect(() => mapPluginAuthorError(new ServerApiError('PLUGIN_DISABLED_BY_ADMIN', 409, 'x')))
      .toThrow(/PLUGIN_DISABLED_BY_ADMIN/);

    // Legacy role conditions already on the plugin may stay; a new role is refused before sending.
    const roleFetch = vi.fn(async (path: string, options: { method?: string }) => {
      if (options.method === 'PATCH') return { plugin: { id: 'p1', ghostId: 'g', name: 'G', myRole: 'creator', status: 'active' } };
      return { plugin: { id: 'p1', ghostId: 'g', name: 'G', myRole: 'creator', status: 'active',
        visibilityAudience: { type: 'matchAny', roles: ['model_admin'], emails: ['a@e.com'] } } };
    }) as unknown as AuthorFetch;
    const roleHandlers = createPluginAuthorManagementHandlers(() => api(roleFetch));
    await expect(roleHandlers.updatePlugin({ pluginId: 'p1', update: { visibilityAudience: { type: 'matchAny', roles: ['model_admin'] } } }))
      .resolves.toMatchObject({ id: 'p1' });
    await expect(roleHandlers.updatePlugin({ pluginId: 'p1', update: { visibilityAudience: { type: 'matchAny', roles: ['admin'] } } }))
      .rejects.toThrow(/不能新增/);
    expect(vi.mocked(roleFetch).mock.calls.filter(([, options]) => (options as { method?: string }).method === 'PATCH')).toHaveLength(1);

    await expect(handlers.addMaintainer({ pluginId: 'p1', membershipId: 'm2' })).rejects.toThrow(/PLUGIN_MAINTAINER_EXISTS/);
    await expect(handlers.removeMaintainer({ pluginId: 'p1', authorizationId: 'a2' })).resolves.toBeUndefined();
    expect(calls.map(([path, method]) => `${method} ${path}`)).toEqual([
      'PATCH /api/personal/plugins/p1',
      'POST /api/personal/plugins/p1/maintainers',
      'DELETE /api/personal/plugins/p1/maintainers/a2',
    ]);
  });
});

// #1541 unread dots: organization review results are recomputed only when the change signal
// moves; servers without the signal (404, including older author servers that route `/changes`
// as a plugin id) show no organization dots and the list is never polled instead.
describe('organization review updates', () => {
  const base = { id: 'p1', ghostId: 'g', name: 'G', myRole: 'creator' as const, status: 'active' as const };

  // #1593: the server reports the latest review event; its opaque id is the unread key, so the
  // client derives nothing from release states. Minimal failing input: a delisting of the same
  // version again (new id) must give a new key, and no event gives no dot.
  it('takes the review result and its key from the server review event', () => {
    const at = '2026-11-20T00:00:00.000Z';
    const event = (id: string, kind: 'approved' | 'rejected' | 'disabled', releaseId: string | null) =>
      ({ id, kind, at, releaseId, actorType: 'organization' });
    expect(organizationDecision({ ...base, latestRelease: { id: 'r2', version: '2', reviewStatus: 'rejected' },
      latestReviewEvent: event('e1', 'rejected', 'r2') }))
      .toMatchObject({ pluginId: 'org:p1', status: 'rejected', key: 'e1', releaseId: 'r2', version: '2', decidedAt: at });
    const delisted = { ...base, status: 'disabled' as const, disabledByAdmin: true, currentRelease: { id: 'r1', version: '1' } };
    expect(organizationDecision({ ...delisted, latestReviewEvent: event('e2', 'disabled', null) }))
      .toMatchObject({ status: 'disabled', key: 'e2', releaseId: 'r1', version: '1' });
    expect(organizationDecision({ ...delisted, latestReviewEvent: event('e3', 'disabled', null) })!.key).toBe('e3');
    // A pending submission, a cancellation or the author's own delisting is no event.
    expect(organizationDecision({ ...base, latestRelease: { id: 'r2', version: '2', reviewStatus: 'pending' }, latestReviewEvent: null })).toBeNull();
    expect(organizationDecision(base)).toBeNull();
  });

  it('rereads the author list only when the change signal moves', async () => {
    let token = { changedAt: '2026-11-20T00:00:00.000Z', eventCount: 3 };
    const listPages = vi.fn(async () => ({
      plugins: [{ ...base, latestRelease: { id: 'r2', version: '2', reviewStatus: 'rejected' as const },
        latestReviewEvent: { id: 'e1', kind: 'rejected' as const, at: '2026-11-20T00:00:00.000Z', releaseId: 'r2', actorType: 'organization' } }],
      nextCursor: null,
    }));
    const changes = vi.fn(async () => token);
    const updates = createOrganizationReviewUpdates({ api: () => ({ changes, listPages }), ownerKey: () => 'owner-a' });
    await expect(updates.read()).resolves.toHaveLength(1);
    await updates.read();
    expect(listPages).toHaveBeenCalledTimes(1);
    expect(updates.isCurrent('org:p1', 'e1')).toBe(true);
    token = { ...token, eventCount: 4 };
    await updates.read();
    expect(listPages).toHaveBeenCalledTimes(2);

    // A failed change signal fails the read (the window keeps its dots); the list is not polled.
    changes.mockRejectedValueOnce(new Error('offline'));
    await expect(updates.read()).rejects.toThrow('offline');
    expect(listPages).toHaveBeenCalledTimes(2);
  });

  // Greptile review on #12469: every window checks the team results; without sharing, two windows
  // read the change signal and the whole author list twice. Minimal failing input: two reads start
  // before the first one settles — one change-signal request and one list read serve both; another
  // account is never handed that read.
  it('shares one in-flight read per account across callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const changes = vi.fn(async () => { await gate; return { changedAt: '2026-11-20T00:00:00.000Z', eventCount: 1 }; });
    const listPages = vi.fn(async () => ({ plugins: [], nextCursor: null }));
    let owner = 'owner-a';
    const updates = createOrganizationReviewUpdates({ api: () => ({ changes, listPages }), ownerKey: () => owner });
    const first = updates.read();
    const second = updates.read();
    owner = 'owner-b';
    const other = updates.read();
    owner = 'owner-a';
    release();
    await Promise.all([first, second, other]);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(listPages).toHaveBeenCalledTimes(1);
  });

  it('reads per-version review results', async () => {
    const fetch = vi.fn(async () => {
      return { nextCursor: null, releases: [
        { id: 'r2', version: '2', reviewStatus: 'rejected', publishedAt: '2026-11-19T00:00:00.000Z',
          review: { outcome: 'rejected', decidedAt: '2026-11-20T00:00:00.000Z', reason: '缺少说明', actorType: 'organization' } },
        { id: 'r1', version: '1', reviewStatus: 'approved', publishedAt: '2026-11-01T00:00:00.000Z' },
      ] };
    }) as unknown as AuthorFetch;
    const page = await api(fetch).releases('p1');
    expect(page.releases[0]?.review).toEqual({ outcome: 'rejected', decidedAt: '2026-11-20T00:00:00.000Z', reason: '缺少说明', actorType: 'organization' });
    expect(page.releases[1]?.review).toBeUndefined();
  });
});
