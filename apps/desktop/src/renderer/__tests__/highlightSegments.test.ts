// @vitest-environment node
/**
 * highlightSegments — vitest unit tests
 *
 * 不依赖 jsdom / RTL —— 直接断言 React element tree 的结构,
 * 用 isValidElement / element.props 校验,与项目现有"renderer 纯函数测试"
 * 风格一致。
 */

import { describe, it, expect } from 'vitest';
import { isValidElement, type ReactNode } from 'react';

import { highlightSegments } from '@/features/cc-agent/lib/highlightSegments';

/* ---------------- helpers ---------------- */

/**
 * 把 highlightSegments 返回的 ReactNode 摊平成 segments 数组,每个 segment 标
 * 注 `kind: 'plain' | 'mark'` + 文本内容,便于断言。
 */
function flatten(node: ReactNode): Array<{ kind: 'plain' | 'mark'; text: string }> {
  if (node == null || node === false) return [];
  if (typeof node === 'string') {
    return node.length > 0 ? [{ kind: 'plain', text: node }] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((c) => flatten(c));
  }
  if (isValidElement(node)) {
    // 我们只期望 <mark> 元素,内容是单字符 string
    const props = node.props as { children?: ReactNode };
    const child = props.children;
    const text = typeof child === 'string' ? child : '';
    return [{ kind: 'mark', text }];
  }
  return [];
}

function reconstruct(node: ReactNode): string {
  return flatten(node)
    .map((s) => s.text)
    .join('');
}

/* ---------------- tests ---------------- */

describe('highlightSegments — base', () => {
  it('returns empty string for empty title', () => {
    expect(highlightSegments('', [])).toBe('');
    expect(highlightSegments('', [0, 1])).toBe('');
  });

  it('returns original title (string) when indices empty', () => {
    const out = highlightSegments('hello', []);
    expect(out).toBe('hello');
  });

  it('reconstructs original title exactly', () => {
    const cases: Array<[string, number[]]> = [
      ['hello world', [0, 6]],
      ['Refactor session header', [9, 10, 11]],
      ['x', [0]],
      ['abcdef', [0, 1, 2, 3, 4, 5]],
    ];
    for (const [title, indices] of cases) {
      expect(reconstruct(highlightSegments(title, indices))).toBe(title);
    }
  });

  it('marks the right characters', () => {
    const segs = flatten(highlightSegments('hello world', [6, 7]));
    // 'hello ' plain, 'wo' mark(相邻命中合并为一个 span), 'rld' plain
    expect(segs).toEqual([
      { kind: 'plain', text: 'hello ' },
      { kind: 'mark', text: 'wo' },
      { kind: 'plain', text: 'rld' },
    ]);
  });

  it('handles single-char title with full match', () => {
    const segs = flatten(highlightSegments('x', [0]));
    expect(segs).toEqual([{ kind: 'mark', text: 'x' }]);
  });

  it('handles match at first position', () => {
    const segs = flatten(highlightSegments('abc', [0]));
    expect(segs).toEqual([
      { kind: 'mark', text: 'a' },
      { kind: 'plain', text: 'bc' },
    ]);
  });

  it('handles match at last position', () => {
    const segs = flatten(highlightSegments('abc', [2]));
    expect(segs).toEqual([
      { kind: 'plain', text: 'ab' },
      { kind: 'mark', text: 'c' },
    ]);
  });

  it('handles every-character highlight', () => {
    // 全命中合并成一个 mark span，渲染等价。
    expect(flatten(highlightSegments('abc', [0, 1, 2]))).toEqual([
      { kind: 'mark', text: 'abc' },
    ]);
  });
});

describe('highlightSegments — defensive', () => {
  it('skips out-of-bounds indices silently', () => {
    const segs = flatten(highlightSegments('abc', [0, 5, 10]));
    expect(segs).toEqual([
      { kind: 'mark', text: 'a' },
      { kind: 'plain', text: 'bc' },
    ]);
  });

  it('skips out-of-order indices (smaller-than-cursor)', () => {
    // [2, 1, 3] — 1 与已合并的 [2,3) 相邻，归并为一个 span 覆盖 b、c、d。
    const segs = flatten(highlightSegments('abcd', [2, 1, 3]));
    expect(segs).toEqual([
      { kind: 'plain', text: 'a' },
      { kind: 'mark', text: 'bcd' },
    ]);
  });

  it('accepts custom highlightClassName via options', () => {
    const out = highlightSegments('abc', [1], { highlightClassName: 'custom-x' });
    const segs = Array.isArray(out) ? out : [out];
    const markEl = segs.find((s) => isValidElement(s));
    expect(markEl).toBeDefined();
    expect(isValidElement(markEl) && (markEl.props as { className: string }).className).toBe('custom-x');
  });

  it('keeps surrogate pairs intact when an index lands on a low surrogate', () => {
    // emoji 命中（fuzzyTitleMatch 会给出低代理位下标）：
    // 旧实现把代理对拆成两个 half-surrogate mark（乱码）；现在合并回完整码点。
    const segs = flatten(highlightSegments('a😀b', [1, 2]));
    expect(segs).toEqual([
      { kind: 'plain', text: 'a' },
      { kind: 'mark', text: '😀' },
      { kind: 'plain', text: 'b' },
    ]);
  });

  it('extends an index on the high surrogate to the full pair', () => {
    const segs = flatten(highlightSegments('a😀b', [1]));
    expect(segs).toEqual([
      { kind: 'plain', text: 'a' },
      { kind: 'mark', text: '😀' },
      { kind: 'plain', text: 'b' },
    ]);
  });

  it('reconstructs titles containing astral characters exactly', () => {
    const title = 'a😀b𠀀c';
    const out = highlightSegments(title, [1, 2, 4, 5]);
    expect(reconstruct(out)).toBe(title);
  });
});
