import { describe, expect, it } from 'vitest';

import {
  formatMemoryHubSize,
  scopeDisplayName,
  scopeIsOpenable,
  splitCuratedAndDigestEntries,
  type MemoryHubEntrySummary,
  type MemoryHubScope,
} from '@/lib/memoryHub';

function makeEntry(
  type: MemoryHubEntrySummary['frontmatter']['type'],
  filename: string,
): MemoryHubEntrySummary {
  return {
    filename,
    slug: filename.replace(/\.md$/, '').replace(/^[a-z]+_/, ''),
    frontmatter: {
      title: filename,
      description: 'hook',
      type,
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    sizeBytes: 128,
  };
}

describe('splitCuratedAndDigestEntries', () => {
  it('groups curated entries in canonical type order and separates digest', () => {
    const entries = [
      makeEntry('digest', 'digest_compaction.md'),
      makeEntry('reference', 'reference_docs.md'),
      makeEntry('user', 'user_prefs.md'),
      makeEntry('project', 'project_hub.md'),
      makeEntry('feedback', 'feedback_style.md'),
    ];
    const { curated, digest } = splitCuratedAndDigestEntries(entries);
    expect(curated.map((entry) => entry.frontmatter.type)).toEqual([
      'user',
      'feedback',
      'project',
      'reference',
    ]);
    expect(digest).toHaveLength(1);
    expect(digest[0]?.filename).toBe('digest_compaction.md');
  });

  it('returns empty groups for empty input', () => {
    const { curated, digest } = splitCuratedAndDigestEntries([]);
    expect(curated).toEqual([]);
    expect(digest).toEqual([]);
  });
});

describe('scope helpers', () => {
  const openable: MemoryHubScope = {
    dirName: 'Users-leng-work-demo',
    kind: 'local',
    scopeKey: '/Users/leng/work/demo',
    displayPath: '/Users/leng/work/demo',
  };
  const remote: MemoryHubScope = {
    dirName: 'ssh-prod-0123456789abcdef',
    kind: 'remote',
    scopeKey: null,
    displayPath: '/srv/app',
  };
  const bare: MemoryHubScope = {
    dirName: 'Users-leng-orphan',
    kind: 'local',
    scopeKey: null,
    displayPath: null,
  };

  it('prefers displayPath then scopeKey then dirName', () => {
    expect(scopeDisplayName(openable, 'dir')).toBe('/Users/leng/work/demo');
    expect(scopeDisplayName(remote, 'remote')).toBe('/srv/app');
    expect(scopeDisplayName(bare, 'legacy')).toBe('legacy · Users-leng-orphan');
  });

  it('only scopes with a reconstructed key are openable', () => {
    expect(scopeIsOpenable(openable)).toBe(true);
    expect(scopeIsOpenable(remote)).toBe(false);
    expect(scopeIsOpenable(bare)).toBe(false);
  });
});

describe('formatMemoryHubSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatMemoryHubSize(512)).toBe('512 B');
    expect(formatMemoryHubSize(2048)).toBe('2.0 KB');
    expect(formatMemoryHubSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
