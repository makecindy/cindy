import { describe, expect, it } from 'vitest';

import { deriveDetailActionState, deriveDetailState, type DetailActionState, type DetailState } from '../detailButtons';

function makeSkill(overrides: Partial<SkillhubSkill> = {}): SkillhubSkill {
  return {
    id: 'skill:global:test-skill',
    kind: 'skill',
    scope: 'global',
    name: 'test-skill',
    absolutePath: '/home/sam/.claude/skills/test-skill',
    mdPath: '/home/sam/.claude/skills/test-skill/SKILL.md',
    files: [],
    registryEntry: null,
    ...overrides,
  } as SkillhubSkill;
}

function makeRegistryEntry(overrides: Partial<StoredInstall> = {}): StoredInstall {
  return {
    version: '3',
    authorId: '',
    folderHash: 'abc123',
    installedAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  } as StoredInstall;
}

function makeInfo(overrides: Partial<SkillhubInfoResult> = {}): SkillhubInfoResult {
  return {
    name: 'test-skill',
    displayName: 'Test Skill',
    description: '',
    authorId: 'user_other',
    authorName: 'Alice',
    isMine: false,
    latestVersion: '5',
    folderHash: 'def456',
    visibility: 'PUBLIC',
    visibleDeptIds: [],
    publishedAt: '2024-01-01T00:00:00Z',
    latestPublishedFromDeviceId: null,
    ...overrides,
  } as SkillhubInfoResult;
}

function makeDetailState(overrides: Partial<DetailState> = {}): DetailState {
  return {
    origin: null,
    isMine: null,
    localVersion: null,
    latestVersion: null,
    marketDeleted: false,
    authorName: '',
    ...overrides,
  };
}

describe('deriveDetailState — null guards', () => {
  it('returns null when entry is null', () => {
    expect(deriveDetailState(null, null, false)).toBeNull();
  });

  it('returns null when entry kind is command', () => {
    expect(deriveDetailState(makeSkill({ kind: 'command' }), null, false)).toBeNull();
  });

  it('returns null when entry kind is agent', () => {
    expect(deriveDetailState(makeSkill({ kind: 'agent' }), null, false)).toBeNull();
  });
});

describe('deriveDetailState — no registryEntry', () => {
  it('returns local-only state when no registry and no server info', () => {
    expect(deriveDetailState(makeSkill({ registryEntry: null }), null, false)).toEqual({
      origin: null,
      isMine: null,
      localVersion: null,
      latestVersion: null,
      marketDeleted: false,
      authorName: '',
    });
  });

  it('picks up isMine and latestVersion from server when available', () => {
    expect(deriveDetailState(
      makeSkill({ registryEntry: null }),
      makeInfo({ isMine: true, latestVersion: '2', authorName: 'Me' }),
      false,
    )).toEqual({
      origin: null,
      isMine: true,
      localVersion: null,
      latestVersion: '2',
      marketDeleted: false,
      authorName: 'Me',
    });
  });
});

describe('deriveDetailState — registryEntry + server info', () => {
  it('preserves explicit installed origin and uses server ownership', () => {
    expect(deriveDetailState(
      makeSkill({ registryEntry: makeRegistryEntry({ origin: 'installed', version: '3' }) }),
      makeInfo({ isMine: true, latestVersion: '5', authorName: 'Me' }),
      false,
    )).toEqual({
      origin: 'installed',
      isMine: true,
      localVersion: '3',
      latestVersion: '5',
      marketDeleted: false,
      authorName: 'Me',
    });
  });

  it('infers installed origin for legacy registry data when server says it is foreign', () => {
    expect(deriveDetailState(
      makeSkill({ registryEntry: makeRegistryEntry({ version: '1' }) }),
      makeInfo({ isMine: false, latestVersion: '1', authorName: 'Bob' }),
      false,
    )).toEqual({
      origin: 'installed',
      isMine: false,
      localVersion: '1',
      latestVersion: '1',
      marketDeleted: false,
      authorName: 'Bob',
    });
  });

  it('does not invent installed origin for legacy registry data when server says it is mine', () => {
    expect(deriveDetailState(
      makeSkill({ registryEntry: makeRegistryEntry({ version: '2' }) }),
      makeInfo({ isMine: true, latestVersion: '3', authorName: 'Me' }),
      false,
    )).toEqual({
      origin: null,
      isMine: true,
      localVersion: '2',
      latestVersion: '3',
      marketDeleted: false,
      authorName: 'Me',
    });
  });
});

describe('deriveDetailState — server unavailable and market deleted', () => {
  it('preserves explicit origin when server unavailable', () => {
    expect(deriveDetailState(
      makeSkill({ registryEntry: makeRegistryEntry({ origin: 'installed', version: '3' }) }),
      null,
      false,
    )).toEqual({
      origin: 'installed',
      isMine: null,
      localVersion: '3',
      latestVersion: null,
      marketDeleted: false,
      authorName: '',
    });
  });

  it('passes through marketDeleted only when server info is absent', () => {
    const entry = makeSkill({ registryEntry: makeRegistryEntry({ origin: 'published', version: '2.0.0' }) });

    expect(deriveDetailState(entry, null, true)).toMatchObject({
      origin: 'published',
      localVersion: '2.0.0',
      marketDeleted: true,
    });

    expect(deriveDetailState(entry, makeInfo({ isMine: true, latestVersion: '2.0.0' }), true)).toMatchObject({
      isMine: true,
      latestVersion: '2.0.0',
      marketDeleted: false,
    });
  });
});

describe('deriveDetailActionState', () => {
  const matrix: Array<{
    name: string;
    detail: Partial<DetailState>;
    registryEntry: StoredInstall | null;
    localFolderHash: string | null;
    expected: DetailActionState;
  }> = [
    {
      name: 'same-name local-only skill colliding with a foreign market skill is not installed',
      detail: {
        origin: null,
        isMine: false,
        latestVersion: '1.0.0',
        authorName: 'Mock Market Owner',
      },
      registryEntry: null,
      localFolderHash: null,
      expected: {
        showUninstall: false,
        status: { kind: 'none' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'same-name skill with install registry is treated as installed',
      detail: {
        origin: 'installed',
        isMine: false,
        localVersion: '1.0.0',
        latestVersion: '1.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'installed', version: '1.0.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: true,
        status: { kind: 'installed-tag', version: '1.0.0' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'same-name installed foreign skill can update while preserving dirty warning',
      detail: {
        origin: 'installed',
        isMine: false,
        localVersion: '1.0.0',
        latestVersion: '1.0.1',
      },
      registryEntry: makeRegistryEntry({ origin: 'installed', version: '1.0.0', folderHash: 'old' }),
      localFolderHash: 'changed',
      expected: {
        showUninstall: true,
        status: { kind: 'update', latestVersion: '1.0.1' },
        isOutdated: true,
        isMineDirty: false,
        showForeignDirtyBanner: true,
      },
    },
    {
      name: 'learned skill sharing a market name never offers the market update action',
      detail: {
        origin: 'learned',
        isMine: false,
        localVersion: '0.1.0',
        latestVersion: '1.0.1',
      },
      registryEntry: makeRegistryEntry({ origin: 'learned', version: '0.1.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: false,
        status: { kind: 'none' },
        isOutdated: true,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'own learned skill sharing a market name prompts publish-new-version instead of published tag',
      detail: {
        origin: 'learned',
        isMine: true,
        localVersion: '0.1.0',
        latestVersion: '1.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'learned', version: '0.1.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: false,
        status: { kind: 'publish-new-version' },
        isOutdated: true,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'imported skill can uninstall and never offers market update',
      detail: {
        origin: 'imported',
        isMine: false,
        localVersion: '0.1.0',
        latestVersion: '2.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'imported', version: '0.1.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: true,
        status: { kind: 'none' },
        isOutdated: true,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'own imported skill sharing a market name prompts publish-new-version',
      detail: {
        origin: 'imported',
        isMine: true,
        localVersion: '0.1.0',
        latestVersion: '1.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'imported', version: '0.1.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: true,
        status: { kind: 'publish-new-version' },
        isOutdated: true,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'imported skill with no market record can publish-to-market',
      detail: {
        origin: 'imported',
        isMine: false,
        localVersion: '0.1.0',
        latestVersion: null,
        marketDeleted: true,
      },
      registryEntry: makeRegistryEntry({ origin: 'imported', version: '0.1.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: true,
        status: { kind: 'publish-to-market' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'own published clean skill shows published tag without uninstall',
      detail: {
        origin: 'published',
        isMine: true,
        localVersion: '1.0.0',
        latestVersion: '1.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'published', version: '1.0.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: false,
        status: { kind: 'published-tag', version: '1.0.0' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'own published dirty skill prompts publish-new-version',
      detail: {
        origin: 'published',
        isMine: true,
        localVersion: '1.0.0',
        latestVersion: '1.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'published', version: '1.0.0', folderHash: 'old' }),
      localFolderHash: 'changed',
      expected: {
        showUninstall: false,
        status: { kind: 'publish-new-version' },
        isOutdated: false,
        isMineDirty: true,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'own published local version ahead of remote prompts publish-new-version',
      detail: {
        origin: 'published',
        isMine: true,
        localVersion: '1.0.0',
        latestVersion: '0.0.0',
      },
      registryEntry: makeRegistryEntry({ origin: 'published', version: '1.0.0', folderHash: 'same' }),
      localFolderHash: 'same',
      expected: {
        showUninstall: false,
        status: { kind: 'publish-new-version' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'my dirty skill stays on publish-new-version when another device published a newer version',
      detail: {
        origin: 'published',
        isMine: true,
        localVersion: '1.0.0',
        latestVersion: '1.0.1',
      },
      registryEntry: makeRegistryEntry({ origin: 'published', version: '1.0.0', folderHash: 'old' }),
      localFolderHash: 'changed',
      expected: {
        showUninstall: false,
        status: { kind: 'publish-new-version' },
        isOutdated: true,
        isMineDirty: true,
        showForeignDirtyBanner: false,
      },
    },
    {
      name: 'local-only skill explicitly missing from market can be published',
      detail: {
        origin: null,
        isMine: null,
        latestVersion: null,
        marketDeleted: true,
      },
      registryEntry: null,
      localFolderHash: null,
      expected: {
        showUninstall: false,
        status: { kind: 'publish-to-market' },
        isOutdated: false,
        isMineDirty: false,
        showForeignDirtyBanner: false,
      },
    },
  ];

  it.each(matrix)('$name', ({ detail, registryEntry, localFolderHash, expected }) => {
    expect(deriveDetailActionState(
      makeDetailState(detail),
      registryEntry,
      localFolderHash,
    )).toEqual(expected);
  });

  it('uses server authority: mine + synced shows published tag even when local origin is installed', () => {
    expect(deriveDetailActionState(
      makeDetailState({
        origin: 'installed',
        isMine: true,
        localVersion: '3',
        latestVersion: '3',
      }),
      makeRegistryEntry({ origin: 'installed', version: '3' }),
      'abc123',
    )).toEqual({
      showUninstall: true,
      status: { kind: 'published-tag', version: '3' },
      isOutdated: false,
      isMineDirty: false,
      showForeignDirtyBanner: false,
    });
  });

  it('never returns publish-to-market when server confirms a latestVersion exists', () => {
    expect(deriveDetailActionState(
      makeDetailState({
        origin: null,
        isMine: false,
        latestVersion: '5',
        authorName: 'Alice',
      }),
      null,
      'abc123',
    )?.status).toEqual({ kind: 'none' });
  });

  it('does not offer publish-to-market when server state is unknown', () => {
    expect(deriveDetailActionState(
      makeDetailState({
        origin: null,
        isMine: null,
        latestVersion: null,
        marketDeleted: false,
      }),
      null,
      null,
    )?.status).toEqual({ kind: 'none' });
  });

  it('offers publish-to-market when server returns no record for a non-owned skill', () => {
    expect(deriveDetailActionState(
      makeDetailState({
        origin: null,
        isMine: false,
        latestVersion: null,
        marketDeleted: false,
      }),
      null,
      null,
    )?.status).toEqual({ kind: 'publish-to-market' });
  });
});
