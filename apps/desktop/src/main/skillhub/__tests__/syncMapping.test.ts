import { describe, expect, it } from 'vitest';

import { buildSkillhubSyncResponse } from '../syncMapping';
import type { HubSkillInfoForDesktop } from '../infoMapping';

function makeHubSkill(slug: string, overrides: Partial<HubSkillInfoForDesktop> = {}): HubSkillInfoForDesktop {
  return {
    slug,
    displayName: `${slug} display`,
    summary: `${slug} summary`,
    version: '1.0.0',
    owner: { type: 'personal', slug: `owner-${slug}`, name: `Owner ${slug}` },
    visibility: 'public',
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildSkillhubSyncResponse', () => {
  it('preserves availableUninstalledCount for empty local syncs', () => {
    expect(buildSkillhubSyncResponse([], [
      { catalogScope: 'market', response: { items: [], availableCount: 7 } },
    ])).toEqual({
      success: true,
      results: [],
      availableUninstalledCount: 7,
    });
  });

  it('keeps the first available count from chunked batch-detail responses', () => {
    const response = buildSkillhubSyncResponse([
      { slug: 'skill-a', catalogScope: 'market' },
      { slug: 'skill-b', catalogScope: 'team' },
    ], [
      { catalogScope: 'market', response: { items: [makeHubSkill('skill-a')], availableCount: 2 } },
      { catalogScope: 'team', response: { items: [makeHubSkill('skill-b')], availableCount: 3 } },
    ]);

    expect(response.availableUninstalledCount).toBe(2);
    expect(response.results).toMatchObject([
      {
        exists: true,
        name: 'skill-a',
        catalogScope: 'market',
        displayName: 'skill-a display',
        authorId: 'owner-skill-a',
        latestVersion: '1.0.0',
      },
      {
        exists: true,
        name: 'skill-b',
        catalogScope: 'team',
        displayName: 'skill-b display',
        authorId: 'owner-skill-b',
        latestVersion: '1.0.0',
      },
    ]);
  });

  it('returns exists:false for local skills missing from Hub without inventing count metadata', () => {
    expect(buildSkillhubSyncResponse([{ slug: 'missing-skill', catalogScope: 'team' }], [
      { catalogScope: 'team', response: { items: [] } },
    ])).toEqual({
      success: true,
      results: [{ name: 'missing-skill', catalogScope: 'team', exists: false }],
    });
  });
});
