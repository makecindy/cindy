import { describe, expect, it } from 'vitest';

import {
  computePanelDropIntent,
  computePanelDropZone,
  computeTriggerRange,
  isDroppableRect,
  isPointerInTargetZone,
} from '../PanelDragController';

/**
 * 拖面板原型的落点判定单测 —— 高亮/提交共用同一区间(所见即所得)。
 * 手势/拖影是 dev-only 交互原型,黑盒验;这里只锁纯判定逻辑不回归。
 */
describe('computeTriggerRange', () => {
  // 目标面板矩形 [800, 1400],默认入界余量 12。
  const LEFT = 800;
  const RIGHT = 1400;

  it('源在目标左侧 → 只内缩目标左边缘(共享边),右缘到底', () => {
    expect(computeTriggerRange(LEFT, RIGHT, true)).toEqual({ left: 812, right: 1400 });
  });

  it('源在目标右侧 → 只内缩目标右边缘(共享边),左缘到底', () => {
    expect(computeTriggerRange(LEFT, RIGHT, false)).toEqual({ left: 800, right: 1388 });
  });

  it('自定义余量生效', () => {
    expect(computeTriggerRange(LEFT, RIGHT, true, 50)).toEqual({ left: 850, right: 1400 });
  });
});

describe('isPointerInTargetZone', () => {
  const range = { left: 812, right: 1400 };

  it('区间内 → true(含两端)', () => {
    expect(isPointerInTargetZone(812, range)).toBe(true);
    expect(isPointerInTargetZone(1000, range)).toBe(true);
    expect(isPointerInTargetZone(1400, range)).toBe(true);
  });

  it('区间外 → false(共享边内缩生效:811 仍在目标矩形里但不点亮)', () => {
    expect(isPointerInTargetZone(811, range)).toBe(false);
    expect(isPointerInTargetZone(1401, range)).toBe(false);
    expect(isPointerInTargetZone(0, range)).toBe(false);
  });

  it('非法区间(right ≤ left)→ false,不抛错', () => {
    expect(isPointerInTargetZone(500, { left: 900, right: 800 })).toBe(false);
    expect(isPointerInTargetZone(700, { left: 700, right: 700 })).toBe(false);
  });
});

describe('isDroppableRect', () => {
  it('正常面板矩形够格当落点', () => {
    expect(isDroppableRect(300, 800)).toBe(true);
  });

  it('折叠(w-0)/隐藏(全 0)/窄条的面板没有身体,不算落点', () => {
    expect(isDroppableRect(0, 800)).toBe(false); // 右栏折叠 w-0
    expect(isDroppableRect(0, 0)).toBe(false); // display:none
    expect(isDroppableRect(300, 0)).toBe(false);
    expect(isDroppableRect(20, 800)).toBe(false); // 低于最小身体尺寸
  });
});

describe('插件面板二维停靠落点', () => {
  const paneRect = {
    left: 100,
    top: 100,
    width: 400,
    height: 600,
    right: 500,
    bottom: 700,
  };
  const rootRect = paneRect;
  const base = {
    paneRect,
    rootRect,
    sourceKind: 'ghost:alpha',
    targetKind: 'ghost:beta',
    sourceRootIndex: 0,
    targetRootIndex: 1,
    sourceIsRootPane: true,
    targetIsRootPane: true,
  };

  it('插件拖到目标上/下边缘 → 形成纵向 grid', () => {
    expect(computePanelDropIntent({ ...base, pointerX: 300, pointerY: 110 })).toBe('stack-before');
    expect(computePanelDropIntent({ ...base, pointerX: 300, pointerY: 690 })).toBe('stack-after');
  });

  it('插件拖到目标左/右边缘 → 回到根横排', () => {
    expect(computePanelDropIntent({ ...base, pointerX: 105, pointerY: 400 })).toBe('root-before');
    expect(computePanelDropIntent({ ...base, pointerX: 495, pointerY: 400 })).toBe('root-after');
  });

  it('插件拖到目标中心 → 交换槽位', () => {
    expect(computePanelDropIntent({ ...base, pointerX: 300, pointerY: 400 })).toBe('swap');
  });

  it('内置面板与根 pane 或整个插件 column 做根级交换', () => {
    expect(
      computePanelDropIntent({
        ...base,
        pointerX: 300,
        pointerY: 400,
        sourceKind: 'chat-main',
        targetKind: 'right-tabs',
      }),
    ).toBe('swap');
    expect(
      computePanelDropIntent({
        ...base,
        pointerX: 300,
        pointerY: 400,
        sourceKind: 'chat-main',
        targetIsRootPane: false,
      }),
    ).toBe('swap');
    expect(
      computePanelDropIntent({
        ...base,
        pointerX: 300,
        pointerY: 400,
        sourceKind: 'chat-main',
        sourceRootIndex: 1,
        targetRootIndex: 1,
        targetIsRootPane: false,
      }),
    ).toBeNull();
  });

  it('纵向列里的插件可从内置区域左右边缘抽回横排，但中心不交换', () => {
    const nestedSource = {
      ...base,
      sourceIsRootPane: false,
      targetKind: 'chat-main',
    };
    expect(computePanelDropIntent({ ...nestedSource, pointerX: 105, pointerY: 400 })).toBe(
      'root-before',
    );
    expect(computePanelDropIntent({ ...nestedSource, pointerX: 300, pointerY: 400 })).toBeNull();
  });

  it('高亮区域与停靠方向一致：上下/左右各占目标一半', () => {
    expect(computePanelDropZone('stack-before', paneRect, rootRect)).toMatchObject({
      left: 106,
      top: 106,
      width: 388,
      height: 294,
    });
    expect(computePanelDropZone('root-after', paneRect, rootRect)).toMatchObject({
      left: 300,
      top: 106,
      width: 194,
      height: 588,
    });
  });

  it('内置面板交换插件 grid 时高亮整个根级列，而不是单个插件 pane', () => {
    const columnRect = { left: 80, top: 80, width: 440, height: 640, right: 520, bottom: 720 };
    expect(computePanelDropZone('swap', paneRect, columnRect, true)).toMatchObject({
      left: 86,
      top: 86,
      width: 428,
      height: 628,
    });
  });
});
