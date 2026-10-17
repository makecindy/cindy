import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 插件链与全局样式的源码契约（guard 层）。
 *
 * 单测不得读取源码文本做字面量断言（docs/dev-rules/engineering-conventions.md §3.2），
 * 纯跨文件契约集中在这里：
 *  - `markdownPluginPipeline.ts` 是聊天页与审查页共用的插件链单一事实源；各行为测试
 *    （CJK 加粗 / 围栏代码 / 公式 / 删除线）只验渲染行为，注册顺序契约收口在本文件。
 *  - `styles/globals.css` 两条契约：审查片段的间距选择器、公式标记不得写字面哨兵色。
 */

const pipelineSource = readFileSync(
  resolve(__dirname, '..', 'components', 'chat', 'markdownPluginPipeline.ts'),
  'utf8',
);
const globalsCss = readFileSync(resolve(__dirname, '..', 'styles', 'globals.css'), 'utf8');

/** `function buildRehypePlugins(…) { … }` 到 `export const MARKDOWN_REHYPE_PLUGINS` 之前。 */
function rehypeChain(): string {
  const match = pipelineSource.match(
    /function buildRehypePlugins\([\s\S]*?\n(?=export const MARKDOWN_REHYPE_PLUGINS)/,
  );
  expect(match, 'buildRehypePlugins 未找到').toBeTruthy();
  return match![0];
}

function remarkChain(name: 'MARKDOWN_REMARK_PLUGINS' | 'MARKDOWN_REMARK_PLUGINS_PRIVILEGED'): string {
  return (
    pipelineSource.match(new RegExp(`const ${name}\\b[^=]*= \\[[\\s\\S]*?\\];`))?.[0] ?? ''
  );
}

describe('markdownPluginPipeline — remark 链注册契约', () => {
  it('两条 remark 插件链都在 remarkGfm 之后注册 remarkCjkFriendly', () => {
    for (const plugins of [
      remarkChain('MARKDOWN_REMARK_PLUGINS'),
      remarkChain('MARKDOWN_REMARK_PLUGINS_PRIVILEGED'),
    ]) {
      expect(plugins).toContain('remarkCjkFriendly');
      expect(plugins.indexOf('remarkGfm')).toBeLessThan(plugins.indexOf('remarkCjkFriendly'));
    }
  });

  it('两条 remark 插件链都以 singleTilde:false 注册 remarkGfm', () => {
    for (const plugins of [
      remarkChain('MARKDOWN_REMARK_PLUGINS'),
      remarkChain('MARKDOWN_REMARK_PLUGINS_PRIVILEGED'),
    ]) {
      expect(plugins).toContain('[remarkGfm, { singleTilde: false }]');
    }
  });

  it('remarkMath 注册进两条 remark 插件链', () => {
    expect(remarkChain('MARKDOWN_REMARK_PLUGINS')).toContain('remarkMath');
    expect(remarkChain('MARKDOWN_REMARK_PLUGINS_PRIVILEGED')).toContain('remarkMath');
  });

  it('remarkStrictInlineMath 注册且排在 remarkMath 之后(松散配对降级)', () => {
    const pluginArrays = remarkChain('MARKDOWN_REMARK_PLUGINS');
    expect(pluginArrays.indexOf('remarkStrictInlineMath')).toBeGreaterThan(
      pluginArrays.indexOf('remarkMath'),
    );
    expect(remarkChain('MARKDOWN_REMARK_PLUGINS_PRIVILEGED')).toContain('remarkStrictInlineMath');
  });
});

describe('markdownPluginPipeline — rehype 链注册契约', () => {
  it('rehypeKatex 注册且排在 rehypeHighlight 之前，审查页数学标记插件夹在中间', () => {
    const chain = rehypeChain();
    const katexIdx = chain.indexOf('rehypeKatex');
    const highlightIdx = chain.indexOf('rehypeHighlight');
    expect(katexIdx).toBeGreaterThan(-1);
    expect(highlightIdx).toBeGreaterThan(katexIdx);
    // 审查页专用插件必须紧跟 rehypeKatex（它处理的是 KaTeX 输出）。
    const marksIdx = chain.indexOf('rehypeReviewMathMarks');
    expect(marksIdx).toBeGreaterThan(katexIdx);
    expect(marksIdx).toBeLessThan(highlightIdx);
  });

  it('rehypeFencedCodeMarker 注册在 rehype 链里,且排在 rehypeHighlight 之后', () => {
    const chain = rehypeChain();
    const highlightAt = chain.indexOf('rehypeHighlight');
    const markerAt = chain.indexOf('rehypeFencedCodeMarker');
    expect(highlightAt).toBeGreaterThanOrEqual(0);
    expect(markerAt).toBeGreaterThan(highlightAt);
  });
});

describe('globals.css — 审查片段与公式契约', () => {
  it('审查片段的首尾间距选择器存在（片段间距不塌成 0）', () => {
    // 每个片段（含未改动的 context 段）都包一层：CSS 才能用 :not(:first-child) /
    // :not(:last-child) 分辨“预览首尾”与“片段边界”——否则段落上的
    // `first:mt-0 last:mb-0` 会在每个边界重新生效，间距塌成 0。
    expect(globalsCss).toContain(
      '.cindy-review-segment:not(:first-child) > .msg-markdown > :first-child',
    );
    expect(globalsCss).toContain(
      '.cindy-review-segment:not(:last-child) > .msg-markdown > :last-child',
    );
  });

  it('公式标记颜色不写字面哨兵色（token-only）', () => {
    // 公式标记的颜色全部由 rehype 插件换成 diff token 类；globals.css **不写**
    // 字面哨兵色（写了就撞硬编码色审计，哨兵不是设计色，不该占豁免表名额）。
    // 早期那两条属性选择器兜底已删（实测在审查页不生效），这里钉住不再回退。
    expect(globalsCss).not.toMatch(/\[style\*='color:[^']*'\]\s*\{/);
    // 不要再引入 :has() 上溯 —— 它会命中 \frac 外层容器。
    expect(globalsCss).not.toContain(':has(.sout)');
  });
});
