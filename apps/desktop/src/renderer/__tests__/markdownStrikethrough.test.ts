/**
 * markdownStrikethrough.test.ts
 * ---------------------------------------------------------------------------
 * GFM 删除线的单波浪线降级回归:
 *
 * remark-gfm 默认 singleTilde:true(模仿 github.com),会把「4~6……4~6」这类
 * 区间写法中间整段误判成删除线。MarkdownRenderer 两条插件链都必须以
 * `[remarkGfm, { singleTilde: false }]` 注册——只认标准 GFM 的 `~~text~~`,
 * 单个 `~` 保持字面量,与 mobile 自研 parser(messageMarkdown.ts 只匹配 `~~`)
 * 对齐。
 *
 * 1. 管线级真实渲染:镜像 MarkdownRenderer 的 gfm 配置,验证 `~~` 仍产出
 *    <del> 而单 `~` 不产出。
 * 2. source-contract 锚定:grep MarkdownRenderer 源码,确保两条插件链的
 *    singleTilde:false 不被静默移除(回退是 silent regression:typecheck /
 *    lint 都拦不住,只有含 `~` 的正文才会暴露)。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function renderGfm(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [[remarkGfm, { singleTilde: false }]],
      children: markdown,
    }),
  );
}

describe('GFM strikethrough(singleTilde:false)', () => {
  it('标准 `~~text~~` 仍渲染为 <del>', () => {
    const html = renderGfm('这段 ~~已废弃~~ 的说法');
    expect(html).toContain('<del>已废弃</del>');
  });

  it('单 `~` 区间写法不被误判成删除线(「4~6……4~6」保持字面量)', () => {
    const html = renderGfm('模型面对 46级~行的空备注只能猜,这次猜错了。旁证:同表「建材·植被类」的 46级~行备注写了不同内容');
    expect(html).not.toContain('<del>');
    expect(html).toContain('46级~行的空备注');
  });

  it('同一段里单 `~` 与 `~~` 共存时只有 `~~` 生效', () => {
    const html = renderGfm('区间 4~6 之间 ~~这段删掉~~ 区间 7~9 之间');
    expect(html).toContain('<del>这段删掉</del>');
    expect(html).toContain('4~6');
    expect(html).toContain('7~9');
  });
});

describe('MarkdownRenderer — singleTilde source contract', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx'),
    'utf8',
  );
  // 插件链清单的单一事实源（渲染与修订校验同源），见文件头说明。
  const pipelineSource = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'markdownPluginPipeline.ts'),
    'utf8',
  );

  it('两条 remark 插件链都以 singleTilde:false 注册 remarkGfm', () => {
    const pluginArrays = pipelineSource.match(/const MARKDOWN_REMARK_PLUGINS\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    const privilegedArrays = pipelineSource.match(/const MARKDOWN_REMARK_PLUGINS_PRIVILEGED\b[^=]*= \[[\s\S]*?\];/)?.[0] ?? '';
    expect(pluginArrays).toContain('[remarkGfm, { singleTilde: false }]');
    expect(privilegedArrays).toContain('[remarkGfm, { singleTilde: false }]');
  });
});
