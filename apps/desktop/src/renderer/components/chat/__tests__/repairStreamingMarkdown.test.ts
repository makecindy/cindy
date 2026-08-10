/**
 * repairStreamingMarkdown.test.ts
 * ---------------------------------------------------------------------------
 * 流式 markdown 临时修复:未闭合围栏补闭合、未配对强调符补齐、半截图片/链接
 * 降级为文本,以及一系列"不该修"的保守边界。
 */

import { describe, expect, it } from 'vitest';

import { repairStreamingMarkdown } from '../repairStreamingMarkdown';

describe('repairStreamingMarkdown', () => {
  it('完整 markdown 原样返回', () => {
    const src = '# t\n\n**bold** and *em* with `code`\n\n```js\nconst a = 1;\n```\n';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('未闭合代码围栏补 ``` 闭合', () => {
    expect(repairStreamingMarkdown('before\n```js\nconst a = 1;')).toBe(
      'before\n```js\nconst a = 1;\n```',
    );
    expect(repairStreamingMarkdown('```\nline\n')).toBe('```\nline\n```');
  });

  it('uses the opener character and length for synthetic closing fences', () => {
    expect(repairStreamingMarkdown('~~~ts\nconst a = 1;')).toBe(
      '~~~ts\nconst a = 1;\n~~~',
    );
    expect(repairStreamingMarkdown('````ts\nconst a = 1;')).toBe(
      '````ts\nconst a = 1;\n````',
    );
  });

  it('does not close a longer fence with a shorter same-character marker', () => {
    expect(repairStreamingMarkdown('````ts\ncode\n```')).toBe(
      '````ts\ncode\n```\n````',
    );
  });

  it('does not treat a literal fence opener with info text as a closing line', () => {
    const src = '```\n```ts\nconst value = 1;';
    expect(repairStreamingMarkdown(src)).toBe(`${src}\n\`\`\``);
  });

  it('accepts a real closing fence with trailing whitespace', () => {
    const src = '```\ncode\n```  ';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('围栏内的星号/方括号不触发行内修复', () => {
    const src = '```\na ** b [x](y';
    expect(repairStreamingMarkdown(src)).toBe('```\na ** b [x](y\n```');
  });

  it('未配对 ** 补闭合(正在生长的加粗立即成型)', () => {
    expect(repairStreamingMarkdown('text **bo')).toBe('text **bo**');
  });

  it('未配对 * 补闭合', () => {
    expect(repairStreamingMarkdown('text *em phrase')).toBe('text *em phrase*');
  });

  it('开符悬在文末 / 开符后是空白:不修(不构成 opener)', () => {
    expect(repairStreamingMarkdown('text **')).toBe('text **');
    expect(repairStreamingMarkdown('text ** not-open')).toBe('text ** not-open');
  });

  it('最后开符之后跨行:不修(只修同一行正在生长的强调)', () => {
    expect(repairStreamingMarkdown('**a\nb')).toBe('**a\nb');
  });

  it('行首 * 列表标记不计入斜体', () => {
    const src = '* item one\n* item two';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('转义 \\* 不计入', () => {
    const src = 'a \\*literal star';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('*** 复合强调超出保守范围:不动', () => {
    const src = 'a ***bold-em';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('inline code 半开时行内修复全部跳过', () => {
    const src = 'run `cmd **flag';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('半截图片降级为 alt 文本', () => {
    expect(repairStreamingMarkdown('see ![diagram](https://x/y.p')).toBe('see diagram');
    expect(repairStreamingMarkdown('see ![diagr')).toBe('see diagr');
  });

  it('半截链接降级为链接文本', () => {
    expect(repairStreamingMarkdown('see [docs](https://x/d')).toBe('see docs');
  });

  it('完整图片/链接不动', () => {
    const src = '![a](b.png) and [c](d)';
    expect(repairStreamingMarkdown(src)).toBe(src);
  });

  it('修复是幂等的(同一半成品重复修不叠加)', () => {
    const once = repairStreamingMarkdown('text **bo');
    expect(repairStreamingMarkdown(once)).toBe(once);
  });
});
