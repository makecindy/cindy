/**
 * markdownFencedCodeInline.test.ts
 * ---------------------------------------------------------------------------
 * 回归:代码块里的文字不得套行内 code 的底色。
 *
 * 起因(2026-07):MarkdownRenderer 的 code 渲染器用 `!className` 近似判断行内
 * code,而 className 只在**带语言标注**时由 rehype-highlight 下发。于是
 * ```(无语言)围栏与 4 空格缩进代码块的 `<code>` 落进行内分支,被套上
 * `bg-[var(--msg-md-inline-code-bg)]` + 内距——inline 元素多行折断时逐行画底,
 * 整块代码变成一行一个灰条;内容还会被送进文件路径检测(可能误变可点 chip)。
 *
 * 修法与 GitHub 一致:按祖先结构判定(`pre code` 一律复位),不看语言标注。
 * rehypeFencedCodeMarker 给 `pre > code` 打 data-fenced-code,渲染器据此分派。
 *
 * 这里跑真实 unified 管线(真 rehype-highlight + 真 marker 插件),用镜像 code
 * 渲染器复刻源码的判定式,并从源码里提取真实的 INLINE_CODE_CLASS 参与断言,
 * 避免底色 token 改名后测试变成空壳。判定式本身的 source-contract 锚在
 * markdownDiffBlock.test.ts 的 F4。
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import {
  FENCED_CODE_ATTR,
  FENCED_CODE_PROP,
  rehypeFencedCodeMarker,
} from '../components/chat/rehypeFencedCodeMarker';

const rendererPath = resolve(__dirname, '..', 'components', 'chat', 'MarkdownRenderer.tsx');
const rendererSrc = readFileSync(rendererPath, 'utf8');

/** 从源码提取真实的行内 code class 串,让底色 token 改名时测试跟着走。 */
function readInlineCodeClass(): string {
  const match = rendererSrc.match(/const INLINE_CODE_CLASS = '([^']+)'/);
  expect(match, 'INLINE_CODE_CLASS 常量未找到').toBeTruthy();
  return match![1];
}

const INLINE_CODE_CLASS = readInlineCodeClass();

/**
 * 镜像 MarkdownRenderer 的 code 分派:结构标记优先,className 次之。
 * 行内分支套真实 INLINE_CODE_CLASS;代码块分支保持 highlight 的 className。
 */
function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      rehypePlugins: [rehypeHighlight, rehypeFencedCodeMarker],
      components: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: ({ className, children, node, ...props }: any) => {
          const isFencedCode = node?.properties?.[FENCED_CODE_PROP] !== undefined;
          const isInline = !isFencedCode && !className;
          return createElement(
            'code',
            isInline
              ? { className: INLINE_CODE_CLASS }
              : { className: className ?? 'fenced-without-language', ...props },
            children,
          );
        },
      },
      children: markdown,
    }),
  );
}

/** 行内底色的判据:整个 class 串里的底色片段。 */
const INLINE_BG_CLASS = 'bg-[var(--msg-md-inline-code-bg)]';

/** 观测管线实际下发给每个 `<code>` 的两项判据,用于锚定 bug 的前提。 */
function probeCodeNodes(markdown: string): Array<{ className?: string; fenced: boolean }> {
  const seen: Array<{ className?: string; fenced: boolean }> = [];
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      rehypePlugins: [rehypeHighlight, rehypeFencedCodeMarker],
      components: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        code: ({ className, children, node }: any) => {
          seen.push({
            className,
            fenced: node?.properties?.[FENCED_CODE_PROP] !== undefined,
          });
          return createElement('code', null, children);
        },
      },
      children: markdown,
    }),
  );
  return seen;
}

describe('代码块内不套行内 code 底色', () => {
  it('INLINE_CODE_CLASS 确实带行内底色(否则下面的断言是空壳)', () => {
    expect(INLINE_CODE_CLASS).toContain(INLINE_BG_CLASS);
  });

  it('无语言标注的围栏(截图里的树形图形态)不套行内底色', () => {
    const html = render('```\n任务(Session)\n└─ 对话(Chat)\n   └─ 消息(Message)\n```');
    expect(html).toContain('<pre>');
    expect(html).not.toContain(INLINE_BG_CLASS);
    expect(html).toContain(FENCED_CODE_ATTR);
  });

  it('带语言标注的围栏同样不套行内底色(既有行为不回退)', () => {
    const html = render('```ts\nconst a = 1;\n```');
    expect(html).not.toContain(INLINE_BG_CLASS);
    expect(html).toContain('language-ts');
    expect(html).toContain(FENCED_CODE_ATTR);
  });

  it('4 空格缩进代码块也按代码块处理(它同样没有 className)', () => {
    const html = render('正文\n\n    任务(Session)\n    对话(Chat)\n');
    expect(html).toContain('<pre>');
    expect(html).not.toContain(INLINE_BG_CLASS);
    expect(html).toContain(FENCED_CODE_ATTR);
  });

  it('行内 code 仍然保留底色,且不被打上代码块标记', () => {
    const html = render('一句话里的 `path/to/file.ts` 标识');
    expect(html).toContain(INLINE_BG_CLASS);
    expect(html).not.toContain('<pre>');
    expect(html).not.toContain(FENCED_CODE_ATTR);
  });

  it('同一段里行内 code 与围栏共存时各走各的分支', () => {
    const html = render('先看 `a.ts`:\n\n```\nplain block\n```\n');
    expect(html).toContain(INLINE_BG_CLASS);
    expect(html).toContain(FENCED_CODE_ATTR);
    // 行内那个不带标记,代码块那个不带底色 —— 两者都只出现一次。
    expect(html.match(new RegExp(FENCED_CODE_ATTR, 'g'))?.length).toBe(1);
    expect(html.match(/bg-\[var\(--msg-md-inline-code-bg\)\]/g)?.length).toBe(1);
  });
});

describe('bug 前提锚定 —— className 不是可靠判据', () => {
  it('无语言围栏的 code 没有 className,只有结构标记能认出它是代码块', () => {
    const [probe, ...rest] = probeCodeNodes('```\nplain block\n```');
    expect(rest).toHaveLength(0);
    // 这两条就是旧判定 `!className` 误判的完整原因:className 缺席、结构在场。
    expect(probe.className).toBeUndefined();
    expect(probe.fenced).toBe(true);
  });

  it('带语言标注时 className 才出现(rehype-highlight 只在这时下发)', () => {
    const [probe] = probeCodeNodes('```ts\nconst a = 1;\n```');
    expect(probe.className).toContain('language-ts');
    expect(probe.fenced).toBe(true);
  });

  it('行内 code 两项判据都缺席 —— 这才是真的行内', () => {
    const [probe] = probeCodeNodes('一句话里的 `a.ts` 标识');
    expect(probe.className).toBeUndefined();
    expect(probe.fenced).toBe(false);
  });
});

describe('marker 插件只标记 pre 的直接 code 子节点', () => {
  it('未闭合围栏(流式中途)同样被标记 —— 底色不该在流式时闪现', () => {
    const html = render('```\n流式中途还没闭合\n');
    expect(html).toContain('<pre>');
    expect(html).toContain(FENCED_CODE_ATTR);
    expect(html).not.toContain(INLINE_BG_CLASS);
  });
});

describe('source contract — 插件注册位置', () => {
  it('rehypeFencedCodeMarker 注册在 rehype 链里,且排在 rehypeHighlight 之后', () => {
    const match = rendererSrc.match(/const REHYPE_PLUGINS: PluggableList = \[([\s\S]*?)\];/);
    expect(match, 'REHYPE_PLUGINS 未找到').toBeTruthy();
    const chain = match![1];
    const highlightAt = chain.indexOf('rehypeHighlight');
    const markerAt = chain.indexOf('rehypeFencedCodeMarker');
    expect(highlightAt).toBeGreaterThanOrEqual(0);
    expect(markerAt).toBeGreaterThan(highlightAt);
  });
});
