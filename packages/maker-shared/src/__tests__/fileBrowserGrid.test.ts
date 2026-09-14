import { describe, expect, it } from 'vitest';
import {
  buildFileBrowserGridItems,
  buildWorkdirPathLevels,
  fileThumbKind,
  filterFileNameMatches,
  formatFileBrowserDate,
  joinRelPath,
  normalizeRemoteOpDirEntries,
  parentRelPath,
  summarizeFileBrowserGrid,
  type FileBrowserRemoteOpEntry,
} from '../fileBrowserGrid.js';

const NOW = new Date(2026, 6, 4, 18, 0, 0).getTime(); // 2026-07-04 18:00 本地时区

function entry(partial: Partial<FileBrowserRemoteOpEntry> & Pick<FileBrowserRemoteOpEntry, 'relPath' | 'type'>): FileBrowserRemoteOpEntry {
  return {
    name: partial.relPath.split('/').pop() ?? partial.relPath,
    size: 0,
    mtimeMs: NOW - 86_400_000 * 30,
    ...partial,
  };
}

describe('normalizeRemoteOpDirEntries', () => {
  it('接受裸数组与 {entries} 包装,丢弃缺关键字段的项', () => {
    const raw = [
      { name: 'src', relPath: 'src', type: 'directory', size: 0, mtimeMs: 1 },
      { relPath: 'a.txt', type: 'file' }, // 缺 name/size/mtime → 补默认
      { name: 'bad' }, // 缺 relPath/type → 丢弃
      'junk',
    ];
    expect(normalizeRemoteOpDirEntries(raw)).toHaveLength(2);
    expect(normalizeRemoteOpDirEntries({ entries: raw })).toHaveLength(2);
    const fallback = normalizeRemoteOpDirEntries(raw)[1];
    expect(fallback).toMatchObject({ name: 'a.txt', size: 0, mtimeMs: 0 });
    expect(normalizeRemoteOpDirEntries(null)).toEqual([]);
  });
});

describe('buildFileBrowserGridItems', () => {
  const entries = [
    entry({ relPath: 'zeta.png', type: 'file', size: 128 * 1024 }),
    entry({ relPath: 'docs', type: 'directory', mtimeMs: NOW - 1000 }),
    entry({ relPath: 'AGENTS.md', type: 'file', size: 18_636, mtimeMs: NOW - 86_400_000 }),
    entry({ relPath: 'apps', type: 'directory', mtimeMs: NOW - 86_400_000 * 3 }),
    entry({ relPath: 'sessions.db', type: 'file', size: 4_800_000 }),
  ];

  it('目录在前,名称排序不区分大小写', () => {
    const items = buildFileBrowserGridItems(entries, 'name', NOW);
    expect(items.map((i) => i.name)).toEqual(['apps', 'docs', 'AGENTS.md', 'sessions.db', 'zeta.png']);
  });

  it('mtime 排序在同类内降序,目录仍在前', () => {
    const items = buildFileBrowserGridItems(entries, 'mtime', NOW);
    expect(items.map((i) => i.name)).toEqual(['docs', 'apps', 'AGENTS.md', 'sessions.db', 'zeta.png']);
  });

  it('size 排序:文件按大小降序,目录维持名称序在前', () => {
    const items = buildFileBrowserGridItems(entries, 'size', NOW);
    expect(items.map((i) => i.name)).toEqual(['apps', 'docs', 'sessions.db', 'zeta.png', 'AGENTS.md']);
  });

  it('缩略图策略与 meta 文案', () => {
    const items = buildFileBrowserGridItems(entries, 'name', NOW);
    const byName = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(byName['apps'].thumb).toBe('folder');
    expect(byName['zeta.png'].thumb).toBe('image');
    expect(byName['AGENTS.md'].thumb).toBe('doc');
    expect(byName['sessions.db'].thumb).toBe('generic');
    expect(byName['AGENTS.md'].metaLabel).toMatch(/^18\.2 KB · Yesterday \d{2}:\d{2}$/);
    expect(byName['docs'].metaLabel).toMatch(/^Today \d{2}:\d{2}$/);
  });
});

describe('formatFileBrowserDate', () => {
  it('today/yesterday/same-year/cross-year shapes', () => {
    expect(formatFileBrowserDate(NOW - 60_000, NOW)).toMatch(/^Today /);
    expect(formatFileBrowserDate(NOW - 86_400_000, NOW)).toMatch(/^Yesterday /);
    expect(formatFileBrowserDate(new Date(2026, 4, 12).getTime(), NOW)).toBe('05-12');
    expect(formatFileBrowserDate(new Date(2025, 11, 31).getTime(), NOW)).toBe('2025-12-31');
    expect(formatFileBrowserDate(0, NOW)).toBe('');
  });
});

describe('summarizeFileBrowserGrid', () => {
  it('两类都有/单类/空 三种文案', () => {
    const mixed = buildFileBrowserGridItems(
      [entry({ relPath: 'a', type: 'directory' }), entry({ relPath: 'b.txt', type: 'file' })],
      'name',
      NOW,
    );
    expect(summarizeFileBrowserGrid(mixed)).toBe('1 个文件夹、1 个文件');
    expect(summarizeFileBrowserGrid(mixed.filter((i) => i.kind === 'dir'))).toBe('1 个文件夹');
    expect(summarizeFileBrowserGrid(mixed.filter((i) => i.kind === 'file'))).toBe('1 个文件');
    expect(summarizeFileBrowserGrid([])).toBe('文件夹为空');
  });
});

describe('buildWorkdirPathLevels', () => {
  it('根目录只有一层且为 current', () => {
    expect(buildWorkdirPathLevels('/Users/alice/Code/Tools/xdt-maker', '')).toEqual([
      { label: 'xdt-maker', relPath: '', current: true },
    ]);
  });

  it('深路径按「当前 → 根」排列', () => {
    expect(buildWorkdirPathLevels('/Users/alice/Code/Tools/xdt-maker', 'apps/mobile/src')).toEqual([
      { label: 'src', relPath: 'apps/mobile/src', current: true },
      { label: 'mobile', relPath: 'apps/mobile', current: false },
      { label: 'apps', relPath: 'apps', current: false },
      { label: 'xdt-maker', relPath: '', current: false },
    ]);
  });

  it('Windows 风格 workdir 也能取到 basename', () => {
    expect(buildWorkdirPathLevels('C:\\Code\\proj', '')[0].label).toBe('proj');
  });
});

describe('parentRelPath / joinRelPath', () => {
  it('相对路径导航基本运算', () => {
    expect(parentRelPath('')).toBeNull();
    expect(parentRelPath('apps')).toBe('');
    expect(parentRelPath('apps/mobile')).toBe('apps');
    expect(joinRelPath('', 'apps')).toBe('apps');
    expect(joinRelPath('apps', 'mobile')).toBe('apps/mobile');
  });
});

describe('fileThumbKind', () => {
  it('图片/文本/其它分派', () => {
    expect(fileThumbKind('a.PNG')).toBe('image');
    expect(fileThumbKind('b.ts')).toBe('doc');
    expect(fileThumbKind('noext')).toBe('generic');
    expect(fileThumbKind('c.db')).toBe('generic');
  });

  it('名字里带 `?` / `#` 的真实文件仍归 doc —— 它是预览页的上游分派门(review P1)', () => {
    // 预览页的分派是 `if (item.thumb === 'doc')` 才进 TextPreviewPage,否则直接 Unsupported。
    // thumb 由本函数算,而它经 isTextFilePreviewCandidate → remoteFilePreviewKind。
    // 后者原先按 URL 语义在 `?` / `#` 处截断,于是 macOS / Linux 上合法的
    // `report#draft.html` 被截成 `report` → unknown → generic → **连文本预览都进不去**,
    // 下游那些 HTML 渲染态判定根本没机会运行(bot 实捉:判定"实际不会运行")。
    expect(fileThumbKind('report#draft.html')).toBe('doc');
    expect(fileThumbKind('report?v=1.html')).toBe('doc');
    // 同理不该因为带 `?` 就把二进制误判成可读文本。
    expect(fileThumbKind('data.zip?x=1')).toBe('generic');
  });

  it('grid item 的 previewKind / thumb 都按真实文件名算(端到端上游门)', () => {
    const [item] = buildFileBrowserGridItems(
      [{ name: 'report#draft.html', relPath: 'docs/report#draft.html', type: 'file', size: 12, mtimeMs: 1 }],
      'name',
      Date.now(),
    );
    // 两个字段一起过关,预览页才会把它交给 TextPreviewPage 而不是 UnsupportedPage。
    expect(item.previewKind).toBe('text');
    expect(item.thumb).toBe('doc');
  });
});

describe('filterFileNameMatches', () => {
  const files = [
    'apps/mobile/src/components/MobilePrimitives.tsx',
    'apps/mobile/src/theme/mobilePrimitivesTheme.ts',
    'apps/mobile/docs/primitives-audit.md',
    'packages/maker-shared/src/queue.ts',
    'apps/desktop/src/other.ts',
  ];

  it('basename 前缀 > basename 包含 > 路径包含,限量返回', () => {
    const matches = filterFileNameMatches(files, 'primitives');
    expect(matches.map((m) => m.name)).toEqual([
      'primitives-audit.md',
      'mobilePrimitivesTheme.ts',
      'MobilePrimitives.tsx',
    ]);
    expect(matches[0].dirRelPath).toBe('apps/mobile/docs');
    expect(filterFileNameMatches(files, 'primitives', 1)).toHaveLength(1);
  });

  it('路径段命中排在最后;空查询返回空', () => {
    const matches = filterFileNameMatches(files, 'desktop');
    expect(matches.map((m) => m.name)).toEqual(['other.ts']);
    expect(filterFileNameMatches(files, '  ')).toEqual([]);
  });
});
