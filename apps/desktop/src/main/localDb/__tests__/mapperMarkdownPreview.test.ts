import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { markdownPreviewText } from '../../../shared/markdownPreviewText';

vi.mock('../../../shared/markdownPreviewText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/markdownPreviewText')>();
  return { ...actual, markdownPreviewText: vi.fn(actual.markdownPreviewText) };
});

import { extractMessagePreview, finalizePlainPreview, sessionToCamel } from '../mapper';
import type { SessionRowWithCount } from '../mapper';

describe('sidebar Markdown preview', () => {
  // Unit regression: repeated task-list reads must reuse the same pure preview
  // without retaining stale text or mixing assistant citation handling with user text.
  // Existing format tests do not cover repeat reads; two identical rows reproduce
  // the redundant parse found by the Windows 569-task CPU profile.
  it('reuses an unchanged preview and recomputes changes and role-specific output', () => {
    const marker = '\uE200cite\uE202turn99search0\uE201';
    const text = `**Cache regression** ${marker}`;
    const row = { createdAt: 1, updatedAt: 1, totalCostUsd: 0,
      listPreview: text, listPreviewRole: 'assistant' } as SessionRowWithCount;
    const before = vi.mocked(markdownPreviewText).mock.calls.length;
    expect(sessionToCamel(row).preview).toBe('Cache regression');
    expect(sessionToCamel(row).preview).toBe('Cache regression');
    expect(vi.mocked(markdownPreviewText).mock.calls.length - before).toBe(1);
    expect(sessionToCamel({ ...row, listPreview: '**Changed preview**' }).preview).toBe('Changed preview');
    expect(sessionToCamel({ ...row, listPreviewRole: 'user' }).preview).toBe(`Cache regression ${marker}`);
    expect(sessionToCamel(row).preview).toBe('Cache regression');
  });

  it('reuses previews larger than the cache key bound across task list refreshes', () => {
    const text = `**Large preview** ${'repeated markdown [link](https://example.com) '.repeat(120)}`;
    const before = vi.mocked(markdownPreviewText).mock.calls.length;
    const first = finalizePlainPreview(text, 'assistant');
    const second = finalizePlainPreview(text, 'assistant');
    expect(second).toBe(first);
    expect(vi.mocked(markdownPreviewText).mock.calls.length - before).toBe(1);
  });

  it('does not confuse a short preview with a long preview cache digest', () => {
    const longText = `**Long cache entry** ${'details '.repeat(600)}`;
    const shortText = `${longText.length}:${createHash('sha256').update(longText).digest('base64url')}`;
    const longPreview = finalizePlainPreview(longText, 'assistant');

    expect(finalizePlainPreview(shortText, 'assistant')).toBe(shortText);
    expect(finalizePlainPreview(longText, 'assistant')).toBe(longPreview);
  });

  it('keeps recently used long previews and evicts old entries at the character budget', () => {
    const makeText = (index: number) => `entry-${index}: ${'plain content '.repeat(4680)}`;
    const parser = vi.mocked(markdownPreviewText);
    const originalParser = parser.getMockImplementation()!;
    parser.mockImplementation((text) => text.slice(0, 140));
    try {
      const before = parser.mock.calls.length;
      const oldest = makeText(0);
      const recent = makeText(1);
      finalizePlainPreview(oldest, 'user');
      finalizePlainPreview(recent, 'user');
      finalizePlainPreview(oldest, 'user');
      for (let index = 2; index < 64; index += 1) {
        finalizePlainPreview(makeText(index), 'user');
      }

      const afterFill = parser.mock.calls.length;
      finalizePlainPreview(oldest, 'user');
      expect(parser.mock.calls.length).toBe(afterFill);
      finalizePlainPreview(recent, 'user');
      expect(parser.mock.calls.length).toBe(afterFill + 1);
      expect(afterFill - before).toBe(64);
    } finally {
      parser.mockImplementation(originalParser);
    }
  });

  it('does not cache preview input larger than the per-entry character limit', () => {
    const text = 'unbounded preview boundary '.repeat(2500);
    const before = vi.mocked(markdownPreviewText).mock.calls.length;
    const first = finalizePlainPreview(text, 'user');
    const second = finalizePlainPreview(text, 'user');

    expect(second).toBe(first);
    expect(vi.mocked(markdownPreviewText).mock.calls.length - before).toBe(2);
  });

  const markdown =
    '[PR #3943](https://github.com/makecindy/cindy/pull/3943) 已合并，CI 无失败、review 已通过。';
  const plain = 'PR #3943 已合并，CI 无失败、review 已通过。';

  it('keeps link labels and the conclusion in live and serialized previews', () => {
    expect(finalizePlainPreview(markdown, 'assistant')).toBe(plain);
    expect(extractMessagePreview(JSON.stringify(markdown), 'assistant')).toBe(plain);
    expect(extractMessagePreview(JSON.stringify({ text: markdown }), 'user')).toBe(plain);
  });

  it('handles bracketed code spans that made the old link lexer backtrack', () => {
    const markdown = '[' + '`````a`````'.repeat(15) + ']';
    const expected = ('[' + ('a' + '`'.repeat(10)).repeat(14) + 'a]').slice(0, 140);
    expect(finalizePlainPreview(markdown, 'user')).toBe(expected);
    expect(extractMessagePreview(JSON.stringify({ text: markdown }), 'user')).toBe(expected);
  });

  it('normalizes existing raw cached previews on read', () => {
    const session = sessionToCamel({
      createdAt: 1,
      updatedAt: 1,
      totalCostUsd: 0,
      listPreview: markdown,
      listPreviewRole: 'assistant',
    } as SessionRowWithCount);
    expect(session.preview).toBe(plain);
  });

  it('counts readable characters rather than a long link destination', () => {
    const text = `看过了，[PR #4069](https://example.com/${'a'.repeat(250)}) 已修复。`;
    expect(finalizePlainPreview(text, 'assistant')).toBe('看过了，PR #4069 已修复。');
    expect(finalizePlainPreview(`**${'字'.repeat(160)}**`, 'assistant')).toBe('字'.repeat(140));
  });

  it.each([
    [
      '## 结果\n\n> **已完成**，`APPROVED / CLEAN`。\n- [x] 检查通过',
      '结果 已完成，APPROVED / CLEAN。 检查通过',
    ],
    [
      '[**PR**](https://example.com/a_(b)) 和 [文档][doc]\n\n[doc]: https://example.com',
      'PR 和 文档',
    ],
    [
      '![效果图](https://example.com/image.png)\n\n```ts\nconst ok = true;\n```',
      '效果图 const ok = true;',
    ],
    ['| 项目 | 状态 |\n| --- | --- |\n| CI | **通过** |', '项目 状态 CI 通过'],
    [
      'src/my_file.ts、foo_bar_baz、2 * 3、[普通括号]',
      'src/my_file.ts、foo_bar_baz、2 * 3、[普通括号]',
    ],
    ['尚未写完 **结果', '尚未写完 **结果'],
    ['<script>alert(1)</script>\n\n正文', '正文'],
    ['<img src="https://example.com/image.png" alt="效果图">', '效果图'],
    [
      '完成 <img src="cindy-media://blobs/image" alt="Light &amp; Dark"> 通过',
      '完成 Light & Dark 通过',
    ],
    ['<img src="javascript:alert(1)" alt="不支持的图片">', null],
    ['<img src="https://example.com/image.png">', null],
    ['<script><img src="https://example.com/image.png" alt="隐藏内容"></script>', null],
    ['![reference alt][image]\n\n[image]: https://example.com/image.png', 'reference alt'],
    ['&amp; &#x1f600; &lt;tag&gt;', '& 😀 <tag>'],
    ['---', null],
  ])('extracts readable content from %s', (text, expected) => {
    expect(finalizePlainPreview(text, 'assistant')).toBe(expected);
  });
});
it('uses component prose instead of internal operation JSON in answer previews', () => {
  const source = '```cindy-ui\n' + JSON.stringify({ seq: 1, op: 'create', id: 'heading', kind: 'heading', props: { text: '费用比较' } }) + '\n' + JSON.stringify({ seq: 2, op: 'create', id: 'stat', kind: 'stat', props: { label: '按年', value: 180, prefix: '¥' } }) + '\n' + JSON.stringify({ seq: 3, op: 'create', id: 'extra', kind: 'check', props: { label: '附加服务', default: false } }) + '\n```';
  const result = extractMessagePreview(JSON.stringify(source), 'assistant');
  expect(result).toContain('费用比较');
  expect(result).toContain('¥180');
  expect(result).not.toContain('"seq"');
  expect(result).toContain('☐ 附加服务');
  expect(result).not.toContain('false');
});
