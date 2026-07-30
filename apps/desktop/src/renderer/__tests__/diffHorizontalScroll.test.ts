/**
 * diffHorizontalScroll.test.ts
 * ---------------------------------------------------------------------------
 * Regression tests for 2026-07-30 用户反馈的聊天区 diff 横滚两个毛病:
 *   1. 长行时横向滚动条看不见 —— 全局 thumb 默认透明(`.is-scrolling` 才显形),
 *      而横向"内容还没完"没有任何其它视觉线索,用户不知道能滚。
 *   2. 滚过去以后行背景(红/绿)只铺到一屏宽就断了 —— 行是 flex 容器,pre 宽度
 *      锁在容器 100%,长行内容溢出到行边界之外,行背景不跟着长。
 *
 * 两个组件共用同一套契约:容器 `.diff-hscroll` + pre `w-max min-w-full`。
 * 静态源码扫描,与 markdownDiffBlock.test.ts 同一约定(node env,不拖 jsdom)。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const chatDir = resolve(__dirname, '..', 'components', 'chat');
const diffViewSrc = readFileSync(resolve(chatDir, 'DiffView.tsx'), 'utf8');
const diffBlockSrc = readFileSync(resolve(chatDir, 'MarkdownDiffBlock.tsx'), 'utf8');
const globalsSrc = readFileSync(
  resolve(__dirname, '..', 'styles', 'globals.css'),
  'utf8',
);

const components: ReadonlyArray<[string, string]> = [
  ['DiffView', diffViewSrc],
  ['MarkdownDiffBlock', diffBlockSrc],
];

describe('横向滚动条常显', () => {
  for (const [name, src] of components) {
    it(`${name} 的滚动容器带 diff-hscroll + overflow-x-auto`, () => {
      expect(src).toMatch(/diff-hscroll/);
      expect(src).toMatch(/overflow-x-auto/);
    });
  }

  it('globals.css 里 .diff-hscroll 的横向 thumb 用 --msg-scrollbar(不是透明)', () => {
    expect(globalsSrc).toMatch(
      /\.diff-hscroll::-webkit-scrollbar-thumb:horizontal\s*\{\s*background-color:\s*var\(--msg-scrollbar\);\s*\}/,
    );
  });

  it('globals.css 里 .diff-hscroll 横向槽厚 12px,与全局纵向槽宽对齐', () => {
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

describe('行背景延伸到整个滚动宽度', () => {
  for (const [name, src] of components) {
    it(`${name} 的 pre 取 w-max 且 min-w-full`, () => {
      // w-max = width:max-content(行宽 = 最长行,底色跟着滚动区延伸)
      // min-w-full = min-width:100%(短 diff 不缩成窄条)
      const preMatch = src.match(/<pre className="([^"]*)"/);
      expect(preMatch, `${name} 的 <pre className="..."> 没找到`).toBeTruthy();
      const preClass = preMatch?.[1] ?? '';
      expect(preClass).toContain('w-max');
      expect(preClass).toContain('min-w-full');
    });
  }
});
