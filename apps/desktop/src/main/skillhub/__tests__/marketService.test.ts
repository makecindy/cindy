import { describe, expect, it, vi } from 'vitest';

import { SkillhubMarketService, normalizeSkillhubSlugs, skillhubIpcError, type SkillhubMarketFetcher } from '../marketService';
import { ServerApiError } from '../../serverApiClient';
import type { ApiFetchOptions } from '../../serverApiClient';
import type { HubSkillInfoForDesktop } from '../infoMapping';

vi.mock('../../serverApiClient', async () => {
  class MockServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = 'ServerApiError';
    }
  }
  return {
    ServerApiError: MockServerApiError,
    serverApiFetch: vi.fn(),
  };
});

type FetchCall = { path: string; opts?: Omit<ApiFetchOptions, 'baseUrl'> };

function makeFetch(responses: unknown[]) {
  const calls: FetchCall[] = [];
  const impl: SkillhubMarketFetcher = async <T,>(path: string, opts?: Omit<ApiFetchOptions, 'baseUrl'>): Promise<T> => {
    calls.push({ path, opts });
    if (responses.length === 0) throw new Error(`unexpected fetch: ${path}`);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next as T;
  };
  const fetch = vi.fn(impl) as unknown as SkillhubMarketFetcher;
  return { fetch, calls };
}

function makeHubSkill(slug: string, overrides: Partial<HubSkillInfoForDesktop> = {}): HubSkillInfoForDesktop {
  return {
    slug,
    displayName: `${slug} display`,
    summary: `${slug} summary`,
    version: '1.2.3',
    owner: { type: 'personal', slug: `owner-${slug}`, name: `Owner ${slug}` },
    visibility: 'public',
    updatedAt: '2026-06-11T00:00:00.000Z',
    categories: [],
    ...overrides,
  };
}

describe('SkillhubMarketService', () => {
  it('normalizes and deduplicates sync slugs before batch-detail lookup', async () => {
    const { fetch, calls } = makeFetch([
      { items: [makeHubSkill('alpha')], availableCount: 4 },
    ]);
    const service = new SkillhubMarketService({ fetch });

    const result = await service.sync({ slugs: ['alpha', '', 'alpha', 'beta', 'my_skill', ' bad ', 'x'.repeat(129)] });

    expect(calls).toEqual([
      {
        path: '/api/skills-hub/skills/batch-detail',
        opts: { method: 'POST', body: { slugs: ['alpha', 'beta'] } },
      },
    ]);
    expect(result).toMatchObject({
      success: true,
      availableUninstalledCount: 4,
      results: [
        { exists: true, name: 'alpha', latestVersion: '1.2.3' },
        { exists: false, name: 'beta' },
        { exists: false, name: 'my_skill' },
        { exists: false, name: ' bad ' },
      ],
    });
  });

  it('blocks management mutations before issuing a request for read-only identities', async () => {
    const { fetch, calls } = makeFetch([]);
    const service = new SkillhubMarketService({
      fetch,
      assertWriteAllowed: () => {
        throw new ServerApiError('SKILL_HUB_READ_ONLY', 403, 'read-only');
      },
    });

    await expect(service.deletePublished('demo')).rejects.toMatchObject({
      code: 'SKILL_HUB_READ_ONLY',
    });
    expect(calls).toEqual([]);
  });

  it('chunks sync requests at the broker batch limit', async () => {
    const slugs = Array.from({ length: 101 }, (_, i) => `skill-${i}`);
    const { fetch, calls: fetchCalls } = makeFetch([{ items: [] }, { items: [] }]);
    const service = new SkillhubMarketService({ fetch });

    await service.sync({ slugs });

    expect(fetchCalls).toHaveLength(2);
    expect((fetchCalls[0]?.opts?.body as { slugs: string[] }).slugs).toHaveLength(100);
    expect((fetchCalls[1]?.opts?.body as { slugs: string[] }).slugs).toEqual(['skill-100']);
  });

  it('groups batch sync by catalog scope and keeps same-slug results distinct', async () => {
    const { fetch, calls } = makeFetch([
      { items: [makeHubSkill('same', { displayName: 'Market Same' })] },
      { items: [makeHubSkill('same', { displayName: 'Team Same', visibility: 'shared' })] },
    ]);
    const service = new SkillhubMarketService({ fetch });

    const result = await service.sync({ skills: [
      { slug: 'same', catalogScope: 'market' },
      { slug: 'same', catalogScope: 'team' },
    ] });

    expect(calls.map(({ path }) => path)).toEqual([
      '/api/skills-hub/skills/batch-detail?scope=market',
      '/api/skills-hub/skills/batch-detail?scope=team',
    ]);
    expect(result.results).toMatchObject([
      { name: 'same', displayName: 'Market Same', catalogScope: 'market' },
      { name: 'same', displayName: 'Team Same', catalogScope: 'team' },
    ]);
  });

  it('lists my published skills through the user-published broker route', async () => {
    const { fetch, calls } = makeFetch([
      { items: [makeHubSkill('mine', { isMine: false })], total: 25 },
    ]);
    const service = new SkillhubMarketService({ fetch });

    const result = await service.listMarket({
      cursor: '1',
      limit: 24,
      sort: 'updated_at',
      q: 'review',
      mine: true,
      category: 'devtools',
    });

    expect(calls[0]?.path).toBe('/api/skills-hub/users/published?page=1&pageSize=24&sort=updated_at&order=desc&q=review&category=devtools');
    expect(calls[0]?.opts).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      nextCursor: '2',
      items: [{ name: 'mine', isMine: true }],
    });
  });

  it('lists available skills with installed skill payload', async () => {
    const { fetch, calls } = makeFetch([
      { items: [makeHubSkill('available')], total: 1 },
    ]);
    const service = new SkillhubMarketService({ fetch });

    const result = await service.listMarket({
      available: true,
      installedSkills: [
        { slug: 'installed-a', version: '1.0.0' },
        { slug: '', version: 'bad' },
        { slug: 'installed-a', version: '1.0.1' },
      ],
    });

    expect(calls[0]).toEqual({
      path: '/api/skills-hub/skills/list?page=1&pageSize=24&scope=all',
      opts: {
        method: 'POST',
        body: { installedSkills: [{ slug: 'installed-a', version: '1.0.1' }] },
      },
    });
    expect(result).toMatchObject({
      success: true,
      nextCursor: null,
      items: [{ name: 'available' }],
    });
  });

  it('passes public and organization catalog scopes to the Hub', async () => {
    const { fetch, calls } = makeFetch([
      { items: [makeHubSkill('public-skill')], total: 1 },
      { items: [makeHubSkill('organization-skill', { visibility: 'shared' })], total: 1 },
    ]);
    const service = new SkillhubMarketService({ fetch });

    const publicResult = await service.listMarket({ scope: 'market', sort: 'trending' });
    const organizationResult = await service.listMarket({ scope: 'team', sort: 'trending' });

    expect(calls.map((call) => call.path)).toEqual([
      '/api/skills-hub/skills?page=1&pageSize=24&sort=trending&order=desc&scope=market',
      '/api/skills-hub/skills?page=1&pageSize=24&sort=trending&order=desc&scope=team',
    ]);
    expect(publicResult.items[0]?.catalogScope).toBe('market');
    expect(organizationResult.items[0]?.catalogScope).toBe('team');
  });

  it('builds detail, file preview, visibility, and scan routes', async () => {
    const { fetch, calls } = makeFetch([
      makeHubSkill('demo/skill'),
      { slug: 'demo/skill', version: '1.0.0', files: [{ path: 'SKILL.md', size: 10, language: 'markdown', truncated: false }] },
      { path: 'SKILL.md', size: 10, language: 'markdown', truncated: false, content: '# Demo' },
      [{ version: '1.0.0' }],
      { sharedTeams: [{ id: 1, slug: 'team-a', name: 'Team A' }], visibleDepts: ['od-1'] },
      { status: 'published' },
    ]);
    const service = new SkillhubMarketService({ fetch });

    await service.info('demo/skill', 'market');
    await service.getPublishedFiles({ name: 'demo/skill', version: '1.0.0', catalogScope: 'market' });
    await service.readPublishedFile({ name: 'demo/skill', path: 'docs/README.md', version: '1.0.0', catalogScope: 'market' });
    await service.listPublishedVersions('demo/skill', 'market');
    await service.getPublishedVisibility('demo/skill');
    await service.getScanStatus({ slug: 'demo/skill', version: '1.0.0', catalogScope: 'market' });

    expect(calls.map((call) => call.path)).toEqual([
      '/api/skills-hub/skills/demo%2Fskill?scope=market',
      '/api/skills-hub/skills/demo%2Fskill/files?version=1.0.0&scope=market',
      '/api/skills-hub/skills/demo%2Fskill/file?path=docs%2FREADME.md&version=1.0.0&scope=market',
      '/api/skills-hub/skills/demo%2Fskill/versions?scope=market',
      '/api/skills-hub/skills/demo%2Fskill/visibility',
      '/api/skills-hub/skills/demo%2Fskill/scan?version=1.0.0&scope=market',
    ]);
    expect(calls[5]?.opts).toEqual({
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
  });

  it('passes deleted detail results through without mapping missing hub fields', async () => {
    const { fetch } = makeFetch([{ deleted: true }]);
    const service = new SkillhubMarketService({ fetch });

    await expect(service.info('local-only')).resolves.toEqual({
      success: true,
      deleted: true,
    });
  });

  it('builds management mutation routes and bodies', async () => {
    const { fetch, calls } = makeFetch([
      { updated: true },
      { deleted: true },
      { unpublished: true },
      { slug: 'demo', visibility: 'private', requestedVisibility: 'public', reviewStatus: 'pending' },
    ]);
    const service = new SkillhubMarketService({
      fetch,
      assertWriteAllowed: vi.fn(),
      assertVisibilityAllowed: vi.fn(),
    });

    await service.updatePublished('demo', { summary: 'new', teamSlug: null });
    await service.deletePublished('demo');
    await service.unpublishPublished('demo');
    const visibilityResult = await service.setPublishedVisibility({
      name: 'demo',
      visibility: 'public',
      teamSlug: 'team-a',
      visibleSlugs: ['team-a', 'od-1'],
    });

    expect(visibilityResult).toEqual({
      success: true,
      result: { slug: 'demo', visibility: 'private', requestedVisibility: 'public', reviewStatus: 'pending' },
    });

    expect(calls).toEqual([
      {
        path: '/api/skills-hub/skills/demo',
        opts: { method: 'PATCH', body: { summary: 'new', teamSlug: null } },
      },
      {
        path: '/api/skills-hub/skills/demo',
        opts: { method: 'DELETE' },
      },
      {
        path: '/api/skills-hub/skills/demo/unpublish',
        opts: { method: 'POST' },
      },
      {
        path: '/api/skills-hub/skills/demo/set-visibility',
        opts: {
          method: 'POST',
          body: { visibility: 'public', teamSlug: 'team-a', visibleSlugs: ['team-a', 'od-1'] },
        },
      },
    ]);
  });

  it('updates installed scope for immediate moves and public-review transitions', async () => {
    const updateRegistryCatalogScope = vi.fn(async () => undefined);
    const { fetch } = makeFetch([
      { slug: 'demo', visibility: 'shared' },
      { slug: 'demo', visibility: 'private' },
      { slug: 'demo', visibility: 'shared', requestedVisibility: 'public', reviewStatus: 'pending' },
    ]);
    const service = new SkillhubMarketService({
      fetch,
      assertWriteAllowed: vi.fn(),
      assertVisibilityAllowed: vi.fn(),
      updateRegistryCatalogScope,
    });

    await service.setPublishedVisibility({ name: 'demo', visibility: 'shared', previousCatalogScope: 'market' });
    await service.setPublishedVisibility({ name: 'demo', visibility: 'private', previousCatalogScope: 'team' });
    await service.setPublishedVisibility({ name: 'demo', visibility: 'public' });

    expect(updateRegistryCatalogScope).toHaveBeenNthCalledWith(1, 'demo', 'team', 'market');
    expect(updateRegistryCatalogScope).toHaveBeenNthCalledWith(2, 'demo', undefined, 'team');
    expect(updateRegistryCatalogScope).toHaveBeenNthCalledWith(3, 'demo', undefined, undefined);
  });

  it('maps categories and user departments into renderer result shapes', async () => {
    const { fetch, calls } = makeFetch([
      [
        {
          slug: 'devtools',
          name: 'DevTools',
          source: 'platform',
          skillCount: 3,
          mySkillCount: 1,
          children: [
            { slug: 'devtools/review', name: 'Review', skillCount: 2, mySkillCount: 1 },
          ],
        },
        { slug: 'writing', name: 'Writing' },
      ],
      {
        departments: [{ deptId: 'od-leaf', name: 'Leaf', path: 'Dept / Leaf' }],
        firstLevelDepts: [
          { deptId: 'od-1', name: 'Dept' },
          { deptId: 'od-1', name: 'Dept (duplicate)' },
        ],
        allDeptIds: ['od-1', 'od-leaf'],
      },
      [{ slug: 'team-a', name: 'Team A', type: 'team' }],
    ]);
    const service = new SkillhubMarketService({ fetch });

    await expect(service.listCategories()).resolves.toEqual({
      success: true,
      categories: [
        { slug: 'devtools', name: 'DevTools', count: 3, myCount: 1, source: 'platform' },
        { slug: 'devtools/review', name: 'Review', count: 2, myCount: 1 },
        { slug: 'writing', name: 'Writing', count: 0, myCount: 0 },
      ],
      totalCount: 5,
      myTotalCount: 2,
    });
    await expect(service.getMyDepts()).resolves.toEqual({
      success: true,
      ids: ['od-1'],
      names: ['Dept'],
    });
    expect(calls[1]).toEqual({
      path: '/api/skills-hub/users/departments',
      opts: undefined,
    });
    await expect(service.listUserTeams()).resolves.toEqual({
      success: true,
      teams: [{ slug: 'team-a', name: 'Team A', type: 'team' }],
    });
  });

  it('requests category lists from the selected catalog scope', async () => {
    const { fetch, calls } = makeFetch([[]]);
    const service = new SkillhubMarketService({ fetch });

    await expect(service.listCategories('team')).resolves.toMatchObject({
      success: true,
      categories: [],
    });
    expect(calls).toEqual([{
      path: '/api/skills-hub/categories?scope=team',
      opts: undefined,
    }]);
  });
});

describe('skillhub market helpers', () => {
  it('normalizes slugs without trimming legacy behavior', () => {
    expect(normalizeSkillhubSlugs(['a', 'a', '', 1, ' b '])).toEqual(['a', ' b ']);
  });

  it('preserves ServerApiError code in IPC error shape', () => {
    expect(skillhubIpcError(new ServerApiError('FORBIDDEN', 403, 'nope'))).toEqual({
      success: false,
      error: 'nope',
      errorCode: 'FORBIDDEN',
    });
  });
});
