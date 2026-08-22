import { describe, expect, it } from 'vitest';

import {
  BOT_ARTIFACT_FILTERS,
  artifactTimeLabel,
  botArtifactCategoryKey,
  countBotArtifactsByCategory,
  filterBotArtifacts,
  formatArtifactSize,
  parseSheetPreview,
  sheetPreviewDelimiter,
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
  item('/w/g.mp4'),
  item('/w/f.zip'),
];

describe('filter chips', () => {
  it('offers 全部 + 五型 + 其它, in that order', () => {
    expect([...BOT_ARTIFACT_FILTERS]).toEqual([
      'all',
      'doc',
      'sheet',
      'image',
      'deck',
      'video',
      'other',
    ]);
  });

  it('maps every chip to its own i18n key', () => {
    const keys = BOT_ARTIFACT_FILTERS.map(botArtifactCategoryKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('bots.artifacts.category.all');
  });

  it('filters by category and keeps 全部 as a pass-through', () => {
    expect(filterBotArtifacts(SAMPLE, 'all')).toHaveLength(7);
    expect(filterBotArtifacts(SAMPLE, 'doc').map((row) => row.name)).toEqual(['a.md', 'b.pdf']);
    expect(filterBotArtifacts(SAMPLE, 'sheet').map((row) => row.name)).toEqual(['c.csv']);
    expect(filterBotArtifacts(SAMPLE, 'image').map((row) => row.name)).toEqual(['d.png']);
    expect(filterBotArtifacts(SAMPLE, 'deck').map((row) => row.name)).toEqual(['e.pptx']);
    expect(filterBotArtifacts(SAMPLE, 'video').map((row) => row.name)).toEqual(['g.mp4']);
    expect(filterBotArtifacts(SAMPLE, 'other').map((row) => row.name)).toEqual(['f.zip']);
  });

  it('counts each category including the empty ones', () => {
    expect(countBotArtifactsByCategory(SAMPLE)).toEqual({
      doc: 2,
      sheet: 1,
      image: 1,
      deck: 1,
      video: 1,
      other: 1,
    });
    expect(countBotArtifactsByCategory([])).toEqual({
      doc: 0,
      sheet: 0,
      image: 0,
      deck: 0,
      video: 0,
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

describe('sheet mini preview', () => {
  it('maps only the delimiters it can really parse', () => {
    expect(sheetPreviewDelimiter('csv')).toBe(',');
    expect(sheetPreviewDelimiter('TSV')).toBe('\t');
    // xlsx / numbers 需要解析器,仓里没有依赖 → null = 回退图标,不编数据。
    expect(sheetPreviewDelimiter('xlsx')).toBeNull();
    expect(sheetPreviewDelimiter('')).toBeNull();
  });

  it('takes the first 4 rows x 3 columns and pads short rows', () => {
    const rows = parseSheetPreview('a,b,c,d\n1,2,3,4\n5,6\n7,8,9\n10,11,12\n', ',');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['5', '6', ''],
      ['7', '8', '9'],
    ]);
  });

  it('honours RFC4180 quoting, doubled quotes and BOM', () => {
    // CSV 原文:BOM + 引号包裹的带逗号表头 + `""` 转义出的一个真实双引号。
    const csv = '\uFEFF"日期, 周","说""话",c\n';
    expect(parseSheetPreview(csv, ',')).toEqual([['日期, 周', '说"话', 'c']]);
  });

  it('drops a trailing record that the head read may have cut in half', () => {
    expect(parseSheetPreview('a,b,c\n1,2,3\n4,5,par', ',', { truncated: true })).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    // 读全了的同一份内容:最后一行是完整的,保留。
    expect(parseSheetPreview('a,b,c\n1,2,3\n4,5,6', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('skips blank lines and returns nothing for an empty head', () => {
    expect(parseSheetPreview('a,b,c\n\n1,2,3\n', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseSheetPreview('', ',')).toEqual([]);
  });
});
