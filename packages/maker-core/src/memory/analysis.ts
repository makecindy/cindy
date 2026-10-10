/**
 * Memory Analysis (P3) — rule-based recommendation engine + insights.
 * Pure computation over MemoryRecord[]; no LLM in P3 initial (user can trigger later).
 */

import type { MemoryEvent, MemoryRecord, MemoryType } from './types.js';

export type RecommendationKind = 'stale' | 'overlap' | 'deprecated' | 'misplaced' | 'gap';
export type RecommendationSeverity = 'info' | 'warning' | 'critical';

export interface MemoryRecommendation {
  id: string;
  kind: RecommendationKind;
  severity: RecommendationSeverity;
  /** Primary entry filename */
  filename: string;
  /** For overlap: the other entry filename */
  relatedFilename?: string;
  title: string;
  reason: string;
  suggestedAction: 'update' | 'merge' | 'deprecate' | 'review';
  createdAt: string;
}

export interface MemoryInsights {
  totalEntries: number;
  byType: Record<string, number>;
  staleCount: number;
  lastActivityAt: string | null;
  recentEvents: MemoryEvent[];
  gapHints: string[];
  recommendations: MemoryRecommendation[];
}

const STALE_DAYS = 90;
const OVERLAP_WORD_OVERLAP_THRESHOLD = 0.7;

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / Math.min(a.size, b.size);
}

export function analyzeRecommendations(entries: readonly MemoryRecord[]): MemoryRecommendation[] {
  const recs: MemoryRecommendation[] = [];
  const now = new Date().toISOString();

  // Stale detection
  for (const entry of entries) {
    if (entry.frontmatter.type === 'digest') continue;
    const age = daysSince(entry.frontmatter.updatedAt);
    if (age > STALE_DAYS) {
      recs.push({
        id: `stale:${entry.filename}`,
        kind: 'stale',
        severity: age > STALE_DAYS * 2 ? 'critical' : 'warning',
        filename: entry.filename,
        title: entry.frontmatter.title,
        reason: `Unmodified for ${Math.floor(age)} days`,
        suggestedAction: 'review',
        createdAt: now,
      });
    }
  }

  // Overlap detection (description similarity)
  const curated = entries.filter((e) => e.frontmatter.type !== 'digest');
  for (let i = 0; i < curated.length; i++) {
    for (let j = i + 1; j < curated.length; j++) {
      const a = curated[i];
      const b = curated[j];
      const overlap = wordOverlap(tokenize(a.frontmatter.description), tokenize(b.frontmatter.description));
      if (overlap >= OVERLAP_WORD_OVERLAP_THRESHOLD) {
        recs.push({
          id: `overlap:${a.filename}:${b.filename}`,
          kind: 'overlap',
          severity: 'warning',
          filename: a.filename,
          relatedFilename: b.filename,
          title: a.frontmatter.title,
          reason: `Description overlap with "${b.frontmatter.title}" (${Math.round(overlap * 100)}%)`,
          suggestedAction: 'merge',
          createdAt: now,
        });
      }
    }
  }

  return recs;
}

export function computeInsights(
  entries: readonly MemoryRecord[],
  events: readonly MemoryEvent[],
): MemoryInsights {
  const byType: Record<string, number> = {};
  let lastActivityAt: string | null = null;
  for (const entry of entries) {
    byType[entry.frontmatter.type] = (byType[entry.frontmatter.type] ?? 0) + 1;
    if (!lastActivityAt || entry.frontmatter.updatedAt > lastActivityAt) {
      lastActivityAt = entry.frontmatter.updatedAt;
    }
  }

  const staleCount = entries.filter(
    (e) => e.frontmatter.type !== 'digest' && daysSince(e.frontmatter.updatedAt) > STALE_DAYS,
  ).length;

  const recommendations = analyzeRecommendations(entries);

  // Gap hints: types with zero entries
  const gapHints: string[] = [];
  const expectedTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  for (const type of expectedTypes) {
    if (!byType[type]) gapHints.push(`No ${type} memories yet — agent may lack context in this area.`);
  }

  return {
    totalEntries: entries.length,
    byType,
    staleCount,
    lastActivityAt,
    recentEvents: events.slice(0, 20),
    gapHints,
    recommendations,
  };
}
