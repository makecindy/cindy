/**
 * mention token 识别侧(切词 + 解析)。
 *
 * 与 renderer/lib/mentionRefFormat 的序列化侧必须保持对称:那边只把 `"` 转义成
 * `\"`(与 maker-core quotedMentionText 逐字节对齐),这里就只还原 `\"`,不能把
 * `\` 当通用转义前缀,否则 Windows 含空格路径的反斜杠会被吞掉。
 */
import { describe, expect, it } from 'vitest';

import { MENTION_TOKEN_SPLIT, parseMentionToken } from '../mentionRef';

function tokenize(text: string): string[] {
  return text.split(MENTION_TOKEN_SPLIT).filter((part) => part.startsWith('@'));
}

describe('MENTION_TOKEN_SPLIT', () => {
  it('裸形式在空白处收尾', () => {
    expect(tokenize('看看 @src/index.ts 这里')).toEqual(['@src/index.ts']);
  });

  it('引号形式整体命中,不被内部空格截断', () => {
    expect(tokenize('看看 @"my docs/file name.md" 这里')).toEqual([
      '@"my docs/file name.md"',
    ]);
  });

  it('一段文本里的多个 token 都能切出来', () => {
    expect(tokenize('@a.md 和 @"b c.md" 对比')).toEqual(['@a.md', '@"b c.md"']);
  });

  it('dir 的尾斜杠留在 token 内(引号内外都是)', () => {
    expect(tokenize('@src/renderer/')).toEqual(['@src/renderer/']);
    expect(tokenize('@"my docs/sub dir/"')).toEqual(['@"my docs/sub dir/"']);
  });
});

describe('parseMentionToken', () => {
  it('裸形式:去掉 @ 即为 path', () => {
    expect(parseMentionToken('@src/index.ts')).toEqual({
      ref: 'src/index.ts',
      quoted: false,
    });
  });

  it('引号形式:去引号并还原被转义的 "', () => {
    expect(parseMentionToken('@"my docs/file name.md"')).toEqual({
      ref: 'my docs/file name.md',
      quoted: true,
    });
    expect(parseMentionToken('@"a \\"quoted\\" name.md"')).toEqual({
      ref: 'a "quoted" name.md',
      quoted: true,
    });
  });

  it('Windows 含空格路径的反斜杠不被吞(不把 \\ 当通用转义前缀)', () => {
    expect(parseMentionToken('@"C:\\Users\\My Documents\\file.md"').ref).toBe(
      'C:\\Users\\My Documents\\file.md',
    );
  });
});
