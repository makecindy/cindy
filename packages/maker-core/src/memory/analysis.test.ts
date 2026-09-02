import { describe, expect, it } from 'vitest';
import { analyzeRecommendations, computeInsights } from './analysis.js';
import type { MemoryRecord, MemoryEvent } from './types.js';

function entry(filename: string, type: string, title: string, description: string, updatedAt = '2026-06-01T00:00:00Z'): MemoryRecord {
  return {
    filename,
    slug: filename.replace(/^[a-z]+_/, '').replace(/\.md$/, ''),
    frontmatter: { title, description, type: type as MemoryRecord['frontmatter']['type'], updatedAt },
    body: 'test body',
    sizeBytes: 100,
  };
}

describe('analyzeRecommendations', () => {
  it('flags stale entries (90+ days)', () => {
    const stale = entry('user_old.md', 'user', 'Old', 'desc', '2025-01-01T00:00:00Z');
    const fresh = entry('user_new.md', 'user', 'New', 'other', '2026-08-01T00:00:00Z');
    const recs = analyzeRecommendations([stale, fresh]);
    expect(recs.filter((r) => r.kind === 'stale')).toHaveLength(1);
    expect(recs.find((r) => r.kind === 'stale')?.filename).toBe('user_old.md');
  });

  it('flags overlapping entries by description similarity', () => {
    const a = entry('user_a.md', 'user', 'A', 'prefers concise answers and code examples');
    const b = entry('user_b.md', 'user', 'B', 'prefers concise answers and code samples');
    const recs = analyzeRecommendations([a, b]);
    expect(recs.filter((r) => r.kind === 'overlap')).toHaveLength(1);
  });

  it('skips digest entries', () => {
    const digest = entry('digest_w.md', 'digest', 'Weekly', 'digest', '2025-01-01T00:00:00Z');
    expect(analyzeRecommendations([digest])).toHaveLength(0);
  });
});

describe('computeInsights', () => {
  it('computes counts, gaps and recent events', () => {
    const entries = [entry('user_a.md', 'user', 'A', 'desc')];
    const events: MemoryEvent[] = [
      { id: 1, ts: '2026-09-01T00:00:00Z', op: 'create', actor: 'agent', filename: 'user_a.md', type: 'user', title: 'A', description: 'desc' },
    ];
    const insights = computeInsights(entries, events);
    expect(insights.totalEntries).toBe(1);
    expect(insights.byType['user']).toBe(1);
    expect(insights.gapHints.length).toBeGreaterThan(0);
    expect(insights.recentEvents).toHaveLength(1);
  });
});
