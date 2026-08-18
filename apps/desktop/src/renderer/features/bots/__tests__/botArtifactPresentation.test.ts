import { describe, expect, it } from 'vitest';

import {
  BOT_ARTIFACT_FILTERS,
  artifactTimeLabel,
  botArtifactCategoryKey,
  countBotArtifactsByCategory,
  filterBotArtifacts,
  formatArtifactSize,
} from '../botArtifactPresentation';
import { makeBotArtifact } from '../../../../shared/botArtifact';

function item(target: string, createdAt = 1): ReturnType<typeof makeBotArtifact> {
  return makeBotArtifact({ source: 'generated', target, isRef: false, createdAt });
}

const SAMPLE = [
  item('/w/a.md'),
  item('/w/b.pdf'),
  item('/w/c.csv'),
  item('/w/d.png'),
  item('/w/e.pptx'),
  item('/w/f.zip'),
];

describe('filter chips', () => {
  it('offers 全部 + 四型 + 其它, in that order', () => {
    expect([...BOT_ARTIFACT_FILTERS]).toEqual(['all', 'doc', 'sheet', 'image', 'deck', 'other']);
  });

  it('maps every chip to its own i18n key', () => {
    const keys = BOT_ARTIFACT_FILTERS.map(botArtifactCategoryKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('bots.artifacts.category.all');
  });

  it('filters by category and keeps 全部 as a pass-through', () => {
    expect(filterBotArtifacts(SAMPLE, 'all')).toHaveLength(6);
    expect(filterBotArtifacts(SAMPLE, 'doc').map((row) => row.name)).toEqual(['a.md', 'b.pdf']);
    expect(filterBotArtifacts(SAMPLE, 'sheet').map((row) => row.name)).toEqual(['c.csv']);
    expect(filterBotArtifacts(SAMPLE, 'image').map((row) => row.name)).toEqual(['d.png']);
    expect(filterBotArtifacts(SAMPLE, 'deck').map((row) => row.name)).toEqual(['e.pptx']);
    expect(filterBotArtifacts(SAMPLE, 'other').map((row) => row.name)).toEqual(['f.zip']);
  });

  it('counts each category including the empty ones', () => {
    expect(countBotArtifactsByCategory(SAMPLE)).toEqual({
      doc: 2,
      sheet: 1,
      image: 1,
      deck: 1,
      other: 1,
    });
    expect(countBotArtifactsByCategory([])).toEqual({
      doc: 0,
      sheet: 0,
      image: 0,
      deck: 0,
      other: 0,
    });
  });
});

describe('formatArtifactSize', () => {
  it('omits unknown or empty sizes so the meta line drops that segment', () => {
    expect(formatArtifactSize(null)).toBe('');
    expect(formatArtifactSize(0)).toBe('');
    expect(formatArtifactSize(Number.NaN)).toBe('');
  });

  it('steps up units with one decimal above bytes', () => {
    expect(formatArtifactSize(512)).toBe('512B');
    expect(formatArtifactSize(2048)).toBe('2KB');
    expect(formatArtifactSize(1024 * 1024 * 3.5)).toBe('3.5MB');
  });
});

describe('artifactTimeLabel', () => {
  const now = 1_000_000_000_000;

  it('bands the recent past', () => {
    expect(artifactTimeLabel(now - 5_000, now)).toEqual({ kind: 'justNow' });
    expect(artifactTimeLabel(now - 5 * 60_000, now)).toEqual({ kind: 'minutes', n: 5 });
    expect(artifactTimeLabel(now - 3 * 3_600_000, now)).toEqual({ kind: 'hours', n: 3 });
    expect(artifactTimeLabel(now - 2 * 86_400_000, now)).toEqual({ kind: 'days', n: 2 });
  });

  it('falls back to an absolute date beyond a week', () => {
    const at = now - 9 * 86_400_000;
    expect(artifactTimeLabel(at, now)).toEqual({ kind: 'date', at });
  });

  it('treats clock skew as 刚刚 instead of showing a negative age', () => {
    expect(artifactTimeLabel(now + 60_000, now)).toEqual({ kind: 'justNow' });
  });
});
