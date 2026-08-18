import { describe, expect, it } from 'vitest';

import {
  botArtifactDedupeKey,
  botArtifactDisplayName,
  botArtifactExtension,
  classifyBotArtifact,
  makeBotArtifact,
} from '../botArtifact';

describe('botArtifactDisplayName', () => {
  it('takes the last path segment for both separators', () => {
    expect(botArtifactDisplayName('/Users/me/work/report.docx')).toBe('report.docx');
    expect(botArtifactDisplayName('C:\\work\\deck.pptx')).toBe('deck.pptx');
  });

  it('drops query and hash from protocol addresses', () => {
    expect(botArtifactDisplayName('xdt-file://local/?path=x')).toBe('local');
    expect(botArtifactDisplayName('cindy-media://blobs/abc.png#frag')).toBe('abc.png');
  });

  it('decodes percent escapes and survives broken ones', () => {
    expect(botArtifactDisplayName('/tmp/%E6%8A%A5%E5%91%8A.md')).toBe('报告.md');
    expect(botArtifactDisplayName('/tmp/100%.md')).toBe('100%.md');
  });

  it('never returns an empty name for a non-empty input', () => {
    expect(botArtifactDisplayName('///')).toBe('///');
  });
});

describe('botArtifactExtension', () => {
  it('lowercases real extensions', () => {
    expect(botArtifactExtension('/a/B.PNG')).toBe('png');
    expect(botArtifactExtension('/a/notes.MD')).toBe('md');
  });

  it('rejects version-like and numeric tails', () => {
    expect(botArtifactExtension('/a/release-v1.2')).toBe('');
    expect(botArtifactExtension('/a/report.2026')).toBe('');
  });

  it('returns empty for names without an extension', () => {
    expect(botArtifactExtension('/etc/hosts')).toBe('');
    expect(botArtifactExtension('/a/trailing.')).toBe('');
  });
});

describe('classifyBotArtifact', () => {
  it('maps the four finalized types', () => {
    expect(classifyBotArtifact('/x/plan.md')).toBe('doc');
    expect(classifyBotArtifact('/x/plan.pdf')).toBe('doc');
    expect(classifyBotArtifact('/x/plan.docx')).toBe('doc');
    expect(classifyBotArtifact('/x/data.csv')).toBe('sheet');
    expect(classifyBotArtifact('/x/data.xlsx')).toBe('sheet');
    expect(classifyBotArtifact('/x/hero.png')).toBe('image');
    expect(classifyBotArtifact('/x/hero.webp')).toBe('image');
    expect(classifyBotArtifact('/x/q3.pptx')).toBe('deck');
    expect(classifyBotArtifact('/x/q3.key')).toBe('deck');
  });

  it('falls back to the generic file card', () => {
    expect(classifyBotArtifact('/x/archive.zip')).toBe('other');
    expect(classifyBotArtifact('/etc/hosts')).toBe('other');
  });

  it('trusts the protocol scheme over a missing extension', () => {
    expect(classifyBotArtifact('xdt-image://session/frame')).toBe('image');
    expect(classifyBotArtifact('xdt-video://session/clip')).toBe('other');
  });
});

describe('botArtifactDedupeKey', () => {
  it('keeps POSIX case so two real files never merge', () => {
    expect(botArtifactDedupeKey({ path: '/a/A.txt', ref: null })).not.toBe(
      botArtifactDedupeKey({ path: '/a/a.txt', ref: null }),
    );
  });

  it('folds Windows shape across case and separators', () => {
    expect(botArtifactDedupeKey({ path: 'C:/x/A.md', ref: null })).toBe(
      botArtifactDedupeKey({ path: 'C:\\x\\a.md', ref: null }),
    );
  });

  it('prefers the protocol ref when both are present', () => {
    expect(botArtifactDedupeKey({ path: '/a/b.png', ref: 'cindy-media://blobs/h.png' })).toBe(
      'cindy-media://blobs/h.png',
    );
  });
});

describe('makeBotArtifact', () => {
  it('builds a path-backed item without leaking a ref', () => {
    const item = makeBotArtifact({
      source: 'generated',
      target: '/w/out/summary.md',
      isRef: false,
      createdAt: 42,
      sessionId: 's1',
    });
    expect(item).toMatchObject({
      source: 'generated',
      category: 'doc',
      name: 'summary.md',
      ext: 'md',
      path: '/w/out/summary.md',
      ref: null,
      sizeBytes: null,
      createdAt: 42,
      sessionId: 's1',
      delegationId: null,
    });
    expect(item.id).toBe('/w/out/summary.md');
  });

  it('builds a ref-backed item with no disk path', () => {
    const item = makeBotArtifact({
      source: 'delegation',
      target: 'cindy-media://blobs/h.png',
      isRef: true,
      createdAt: 7,
      delegationId: 'del-1',
    });
    expect(item.path).toBeNull();
    expect(item.ref).toBe('cindy-media://blobs/h.png');
    expect(item.category).toBe('image');
    expect(item.delegationId).toBe('del-1');
  });

  it('prefers an explicit display name over the path tail', () => {
    const item = makeBotArtifact({
      source: 'attachment',
      target: '/tmp/cache/abc123.bin',
      isRef: false,
      name: '  季度复盘.pdf  ',
      createdAt: 1,
    });
    expect(item.name).toBe('季度复盘.pdf');
    // 分类看的是真实目标,不是展示名 —— 缓存落盘名 .bin 不是 pdf。
    expect(item.category).toBe('other');
  });
});
