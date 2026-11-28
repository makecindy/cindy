// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：useDraftHeaderWrapMotion（新建页品牌行的折行 FLIP）；观察
 *   折行时按钮排与输入区各自被要求从哪一帧开始动。
 * - 规则依据：docs/design-rules/DESIGN.md §15.7（折行后按钮排与 logo 对齐、动效不压品牌区）
 *   与 #10102 的实机反馈（同步内折行时输入区压到高出来的按钮排下面）。
 * - 现有覆盖缺口：该 hook 之前没有单测挂具，折行几何只能实机看；这里用假元素直接喂几何。
 * - 最小失败输入：一次宽度跳变同时跨过品牌行折行点与按钮排自身的内折行点——按钮排从
 *   30px 变 68px，输入区若仍从旧位置起动画，前一段就会重叠。
 * - tier：unit，假几何与假 ResizeObserver，无真实布局。
 */
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useDraftHeaderWrapMotion } from '../useDraftHeaderWrapMotion';

interface Geometry {
  chipsLeft: number;
  chipsTop: number;
  chipsHeight: number;
  contentTop: number;
}

const LOGO_HEIGHT = 30;

/** A plain element whose layout numbers the test owns. */
function element(geometry: () => Geometry, key: 'chips' | 'content') {
  const node = document.createElement('div');
  Object.defineProperty(node, 'offsetLeft', { get: () => (key === 'chips' ? geometry().chipsLeft : 0) });
  Object.defineProperty(node, 'offsetTop', { get: () => (key === 'chips' ? geometry().chipsTop : geometry().contentTop) });
  Object.defineProperty(node, 'offsetHeight', { get: () => (key === 'chips' ? geometry().chipsHeight : 0) });
  return node;
}

let geometry: Geometry;
let triggers: Array<() => void>;
const framesOf = (animate: ReturnType<typeof vi.fn>) =>
  animate.mock.calls[0][0] as Array<Record<string, string>>;

beforeEach(() => {
  geometry = { chipsLeft: 400, chipsTop: 20, chipsHeight: 30, contentTop: 65 };
  triggers = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { triggers.push(callback); }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
    marginTop: '0px',
    transform: 'none',
    getPropertyValue: (property: string) => {
      if (property === '--motion-base') return '200ms';
      if (property === '--motion-ease-move') return 'ease';
      return '';
    },
  }) as unknown as CSSStyleDeclaration);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount() {
  const chips = element(() => geometry, 'chips');
  const content = element(() => geometry, 'content');
  const animation = () => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation;
  const chipsAnimate = vi.fn(() => animation());
  const contentAnimate = vi.fn(() => animation());
  chips.animate = chipsAnimate as unknown as Element['animate'];
  content.animate = contentAnimate as unknown as Element['animate'];
  renderHook(() => useDraftHeaderWrapMotion(
    { current: document.createElement('div') }, { current: chips }, { current: content }, LOGO_HEIGHT));
  return { chipsAnimate, contentAnimate };
}

it('lands the input on the new layout when the button row grows taller as it wraps', () => {
  const { chipsAnimate, contentAnimate } = mount();

  // A width jump that crosses both wrap points: the row stacks and the button block
  // grows from one line to two (30 → 68), pushing the input down by the same 38px.
  geometry = { chipsLeft: 0, chipsTop: 60, chipsHeight: 68, contentTop: 103 };
  triggers.at(-1)?.();

  // The button row slides from where it was drawn.
  expect(chipsAnimate).toHaveBeenCalledOnce();
  expect(framesOf(chipsAnimate)[0].transform).toBe('translate(400px, -40px)');
  // The input is already where it belongs: animating it from the old position would put
  // it under the taller button block for the first half of the move.
  expect(contentAnimate).not.toHaveBeenCalled();
});

it('still slides the input when only the wrap position changes', () => {
  const { chipsAnimate, contentAnimate } = mount();

  // Same one-line button block, but the wrap pushes the input down by 30px: the existing
  // two-leg slide must stay.
  geometry = { chipsLeft: 0, chipsTop: 60, chipsHeight: 30, contentTop: 95 };
  triggers.at(-1)?.();

  expect(chipsAnimate).toHaveBeenCalledOnce();
  expect(contentAnimate).toHaveBeenCalledOnce();
  expect(framesOf(contentAnimate)[0].marginTop).toBe('-30px');
});
