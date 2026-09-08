import { describe, expect, it } from 'vitest';

import { extractMessagePreview, finalizePlainPreview, sessionToCamel } from '../mapper';
import type { SessionRowWithCount } from '../mapper';

describe('sidebar Markdown preview', () => {
  const markdown =
    '[PR #3943](https://github.com/makecindy/cindy/pull/3943) 已合并，CI 无失败、review 已通过。';
  const plain = 'PR #3943 已合并，CI 无失败、review 已通过。';

  it('keeps link labels and the conclusion in live and serialized previews', () => {
    expect(finalizePlainPreview(markdown, 'assistant')).toBe(plain);
    expect(extractMessagePreview(JSON.stringify(markdown), 'assistant')).toBe(plain);
    expect(extractMessagePreview(JSON.stringify({ text: markdown }), 'user')).toBe(plain);
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
    ['---', null],
  ])('extracts readable content from %s', (text, expected) => {
    expect(finalizePlainPreview(text, 'assistant')).toBe(expected);
  });
});
