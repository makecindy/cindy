import { describe, expect, it } from 'vitest';

import { mapHubSkillInfoToDesktopInfo } from '../infoMapping';

describe('mapHubSkillInfoToDesktopInfo', () => {
  it('preserves category slugs from Hub detail responses', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'lark-task',
      icon: 'https://skillhub.example.test/assets/default-skill-icon-v4.svg',
      displayName: 'Lark Task',
      summary: 'Market summary',
      description: 'Manage tasks',
      version: '1.0.0',
      owner: { type: 'user', slug: 'u_1', name: 'User One' },
      visibility: 'public',
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      categories: [
        { slug: 'engine', name: 'Engine' },
        { slug: 'office', name: 'Office' },
      ],
      tags: [{ slug: 'automation', name: 'Automation', source: 'platform' }],
      githubUrl: 'https://github.com/example/lark-task',
      stats: { downloads: 135 },
    }, { catalogScope: 'market' });

    expect(info.categories).toEqual(['engine', 'office']);
    expect(info.tags).toEqual([{ slug: 'automation', name: 'Automation', source: 'platform' }]);
    expect(info.githubUrl).toBe('https://github.com/example/lark-task');
    expect(info.icon).toBe('https://skillhub.example.test/assets/default-skill-icon-v4.svg');
    expect(info.description).toBe('Market summary');
    expect(info.downloads).toBe(135);
    expect(info.catalogScope).toBe('market');
  });

  it('falls back to Hub description when summary is absent', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'lark-task',
      displayName: 'Lark Task',
      description: 'Manifest description',
      version: '1.0.0',
      owner: { type: 'user', slug: 'u_1', name: 'User One' },
      visibility: 'public',
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      categories: [],
    });

    expect(info.description).toBe('Manifest description');
    expect(info.downloads).toBe(0);
  });

  it('keeps organization ownership and the member publisher as separate fields', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'org-skill',
      displayName: 'Org Skill',
      description: 'Organization skill',
      version: '1.0.0',
      owner: { type: 'org', slug: 'acme', name: 'Acme' },
      publisher: { name: 'Cindy Publisher' },
      visibility: 'public',
      updatedAt: '2026-09-02T00:00:00.000Z',
    });

    expect(info.authorName).toBe('Acme');
    expect(info.publisherName).toBe('Cindy Publisher');
  });

  it('preserves Hub ownership, visibility, and review status needed by My Published management', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'review-helper',
      displayName: 'Review Helper',
      description: 'Review flow',
      version: '1.0.0',
      owner: { type: 'personal', slug: 'u_1', name: 'User One' },
      visibility: 'private',
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      moderationStatus: 'rejected',
      categories: [],
    });

    expect(info.visibility).toBe('DEPARTMENT_SCOPED');
    expect(info.publishedVisibility).toBe('private');
    expect(info.ownerType).toBe('personal');
    expect(info.moderationStatus).toBe('rejected');
  });

  it('preserves separate market and pending versions from Hub review state', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'review-helper',
      displayName: 'Review Helper',
      description: 'Review flow',
      version: '1.0.0',
      marketVersion: '1.0.0',
      pendingVersion: { version: '1.0.2', status: 'scanning' },
      owner: { type: 'personal', slug: 'u_1', name: 'User One' },
      visibility: 'public',
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      moderationStatus: 'published',
      categories: [],
    });

    expect(info.latestVersion).toBe('1.0.0');
    expect(info.marketVersion).toBe('1.0.0');
    expect(info.pendingVersion).toEqual({ version: '1.0.2', status: 'scanning' });
    expect(info.moderationStatus).toBe('published');
  });

  it('preserves an independent public visibility review on the current version', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'review-helper',
      displayName: 'Review Helper',
      description: 'Review flow',
      version: '1.0.0',
      owner: { type: 'personal', slug: 'u_1', name: 'User One' },
      visibility: 'private',
      visibilityReview: {
        requestedVisibility: 'public',
        status: 'rejected',
        reason: 'More details required',
      },
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      categories: [],
    });

    expect(info.visibilityReview).toEqual({
      requestedVisibility: 'public',
      status: 'rejected',
      reason: 'More details required',
    });
  });

  it('maps Hub fileHash to folderHash when provided', () => {
    const info = mapHubSkillInfoToDesktopInfo({
      slug: 'review-helper',
      displayName: 'Review Helper',
      description: 'Review flow',
      version: '1.0.0',
      fileHash: 'server-folder-hash',
      owner: { type: 'personal', slug: 'u_1', name: 'User One' },
      visibility: 'public',
      updatedAt: '2026-06-03T01:00:00.000Z',
      isMine: true,
      categories: [],
    });

    expect(info.folderHash).toBe('server-folder-hash');
  });
});
