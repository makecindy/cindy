/**
 * markdownCjkStrongDelimiter.test.ts
 * ---------------------------------------------------------------------------
 * CJK 全角标点相邻时 `**` 加粗定界失效的修复回归:
 *
 * CommonMark 的 emphasis 侧翼(flanking)规则把全角标点(。：，“”（）等)算作
 * 「标点」:`**` 内侧挨全角标点、外侧挨普通字符时,开/闭侧翼不成立,整对星号
 * 退化成字面量。AI 中文输出的高频写法——「**小标题：**正文」「**“术语”**」
 * 「**（注）**」——全部中招,正文里残留原始 `**`。mobile 自研 parser
 * (messageMarkdown.ts 用正则配对)不受该规则约束,desktop 是唯一例外端。
 *
 * 修复:MarkdownRenderer 两条插件链在 remarkGfm 之后注册 remarkCjkFriendly
 * (官方示例顺序),放宽侧翼判定——全角标点不再当「标点」。只影响
 * emphasis/strong 定界,不碰 `~~` 删除线与公式。
 *
 * 1. 管线级真实渲染:镜像 MarkdownRenderer 的插件配置,验证历史失败样例产出
 *    <strong>,且字面量/代码/链接/删除线/公式行为不回退。
 * 2. source-contract 锚定:grep MarkdownRenderer 源码,确保两条插件链都注册
 *    remarkCjkFriendly(静默回退时 typecheck / lint 都拦不住)。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [[remarkGfm, { singleTilde: false }], remarkCjkFriendly, remarkMath],
      children: markdown,
    }),
  );
}

describe('CJK 加粗定界(remarkCjkFriendly)', () => {
  it.each([
    ['全角冒号收尾', '这是**重点：**内容', '重点：'],
    ['全角句号收尾', '这是**重点。**内容', '重点。'],
    ['全角括号包裹', '这是**（重点）**内容', '（重点）'],
    ['中文引号包裹', '这是**“重点”**内容', '“重点”'],
    ['全角逗号开头', '这是**，重点**内容', '，重点'],
    ['引号包词嵌句中', '称**“双循环”**为', '“双循环”'],
    ['行首小标题', '**注意：**内容', '注意：'],
    ['混合长句', '先看：**“后续不能再卖”——这就是终点站。**从第一轮', '“后续不能再卖”——这就是终点站。'],
  ])('历史失败样例可解析为 <strong>:%s', (_name, input, strongText) => {
    const html = renderMarkdown(input);
    expect(html).toContain(`<strong>${strongText}</strong>`);
  });

  it.each([
    ['纯中文', '这是**重点**内容'],
    ['英文', 'this is **bold** text'],
    ['英文加粗后跟半角逗号', 'this is **bold**, text'],
    ['全角括号在外侧', '（**重点**）内容'],
  ])('原本可解析的写法不回退:%s', (_name, input) => {
    expect(renderMarkdown(input)).toContain('<strong>');
  });

  it('两侧带空格的星号保持字面量(「2 ** 3 ** 4」不误判)', () => {
    const html = renderMarkdown('计算 2 ** 3 ** 4 的结果');
    expect(html).not.toContain('<strong>');
  });

  it('转义的星号保持字面量', () => {
    const html = renderMarkdown('\\*\\*转义\\*\\*');
    expect(html).not.toContain('<strong>');
  });

  it('行内代码里的星号保持字面量', () => {
    const html = renderMarkdown('`**code**`');
    expect(html).toContain('<code>**code**</code>');
    expect(html).not.toContain('<strong>');
  });

  it('链接地址里的星号不参与加粗判定', () => {
    const html = renderMarkdown('[glob](https://example.test/**index.**html)');
    expect(html).toContain('href="https://example.test/**index.**html"');
    expect(html).not.toContain('<strong>');
  });

  it('`~~` 删除线行为不受影响', () => {
    const html = renderMarkdown('这段 ~~已废弃~~ 的说法');
    expect(html).toContain('<del>已废弃</del>');
  });

  it('公式里的星号不参与加粗判定', () => {
    const html = renderMarkdown('公式 $a**b$ 结束');
    expect(html).not.toContain('<strong>');
  });
});

describe('MarkdownRenderer — remarkCjkFriendly source contract', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx'),
    'utf8',
  );

  it('两条 remark 插件链都在 remarkGfm 之后注册 remarkCjkFriendly', () => {
    const pluginArrays = source.match(/const REMARK_PLUGINS\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    const privilegedArrays = source.match(/const REMARK_PLUGINS_PRIVILEGED\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    for (const plugins of [pluginArrays, privilegedArrays]) {
      expect(plugins).toContain('remarkCjkFriendly');
      expect(plugins.indexOf('remarkGfm')).toBeLessThan(plugins.indexOf('remarkCjkFriendly'));
    }
  });
});
