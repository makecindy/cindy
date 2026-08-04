// @vitest-environment jsdom
/**
 * diffHorizontalScroll.test.tsx
 * ---------------------------------------------------------------------------
 * Regression tests for 2026-07-30 用户反馈的聊天区 diff 横滚两个毛病:
 *   1. 长行时横向滚动条看不见 —— 全局 thumb 默认透明(`.is-scrolling` 才显形),
 *      而横向"内容还没完"没有任何其它视觉线索,用户不知道能滚。
 *   2. 滚过去以后行背景(红/绿)只铺到一屏宽就断了 —— 行是 flex 容器,pre 宽度
 *      锁在容器 100%,长行内容溢出到行边界之外,行背景不跟着长。
 *
 * DiffView 与 MarkdownDiffBlock 共用同一套契约:滚动容器带 `.diff-hscroll`
 * (横向条常显)+ `overflow-x-auto`,其中的 pre 取 `w-max min-w-full`(行宽 =
 * 最长行,底色跟着滚动区延伸)。
 *
 * 这里走真实渲染而不是源码扫描:两个类必须落在**同一个滚动容器**上、pre 必须
 * 在该容器**里面**,契约才算成立 —— 正则扫源码会被组件里的注释文字命中,
 * className 被删了也照过(#1044 review 指出的假阳性)。
 * 只有 globals.css 的规则存在性仍靠静态断言:jsdom 不加载样式表。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DiffView } from '@/components/chat/DiffView';
import { MarkdownDiffBlock } from '@/components/chat/MarkdownDiffBlock';

const globalsSrc = readFileSync(
  resolve(__dirname, '..', 'styles', 'globals.css'),
  'utf8',
);

/** 长到必然触发横滚的一行,两个组件共用。 */
const LONG = `const label = "${'x'.repeat(200)}";`;

afterEach(() => cleanup());

const cases: ReadonlyArray<[string, () => HTMLElement]> = [
  [
    'DiffView',
    () =>
      render(<DiffView oldString={`${LONG}\nkeep\n`} newString={`${LONG}!\nkeep\n`} />)
        .container,
  ],
  [
    'MarkdownDiffBlock',
    () => render(<MarkdownDiffBlock raw={`- ${LONG}\n+ ${LONG}!\n  keep`} />).container,
  ],
];

describe('滚动容器契约', () => {
  for (const [name, renderCase] of cases) {
    it(`${name} 的横滚容器同时带 diff-hscroll 与 overflow-x-auto`, () => {
      const container = renderCase();
      const scrollers = container.querySelectorAll('.diff-hscroll');
      // 只允许一个横滚容器:多一个说明结构被拆开,底色/滚动条契约要重新审
      expect(scrollers).toHaveLength(1);
      expect(scrollers[0].className).toContain('overflow-x-auto');
    });

    it(`${name} 的 pre 在该容器内,且取 w-max min-w-full`, () => {
      const container = renderCase();
      const scroller = container.querySelector('.diff-hscroll');
      expect(scroller).toBeTruthy();
      const pre = scroller?.querySelector('pre');
      expect(pre, 'pre 必须在滚动容器内(横滚才作用于内容)').toBeTruthy();
      // w-max = width:max-content(行宽 = 最长行,底色跟着滚动区延伸)
      // min-w-full = min-width:100%(短 diff 不缩成窄条)
      expect(pre?.className).toContain('w-max');
      expect(pre?.className).toContain('min-w-full');
    });

    it(`${name} 的行仍带 --diff-*-bg 底色(整行填充没被改掉)`, () => {
      const container = renderCase();
      const html = container.innerHTML;
      expect(html).toContain('bg-[var(--diff-del-bg)]');
      expect(html).toContain('bg-[var(--diff-add-bg)]');
    });
  }
});

describe('globals.css 里的 .diff-hscroll 规则', () => {
  it('横向 thumb 用 --msg-scrollbar(不是透明)', () => {
    expect(globalsSrc).toMatch(
      /\.diff-hscroll::-webkit-scrollbar-thumb:horizontal\s*\{\s*background-color:\s*var\(--msg-scrollbar\);\s*\}/,
    );
  });

  it('横向槽厚 12px,与全局纵向槽宽对齐', () => {
    expect(globalsSrc).toMatch(
      /\.diff-hscroll::-webkit-scrollbar:horizontal\s*\{\s*height:\s*12px;\s*\}/,
    );
    expect(globalsSrc).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*12px;\s*\}/);
  });

  it('全局 auto-hide 体系没被改坏:默认 thumb 仍透明,.is-scrolling 才显形', () => {
    expect(globalsSrc).toMatch(
      /::-webkit-scrollbar-thumb\s*\{\s*background-color:\s*transparent;/,
    );
    expect(globalsSrc).toMatch(
      /\.is-scrolling::-webkit-scrollbar-thumb\s*\{\s*background-color:\s*var\(--msg-scrollbar\);\s*\}/,
    );
  });
});
