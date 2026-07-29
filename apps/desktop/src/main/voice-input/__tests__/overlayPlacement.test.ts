import { describe, expect, it } from 'vitest';

import {
  clampOverlayBoundsToWorkArea,
  computeOverlayPositionRatio,
  isBoundsCenterOnDisplay,
  normalizeFocusedWindowFrame,
  normalizeSavedOverlayPosition,
  resolveDraggedOverlayBounds,
  resolveOverlayInitialBounds,
  type OverlayPlacementDisplay,
  type SavedOverlayPosition,
} from '../overlayPlacement.js';

// 与 global.ts 保持一致的几何常量(避免 import 触发 electron 依赖)。
const WIDTH = 600; // OVERLAY_CARD_WIDTH 496 + 52 * 2
const HEIGHT = 236; // OVERLAY_CARD_ESTIMATED_HEIGHT 132 + 52 * 2
const CONTENT_INSET = 52;
const EDGE_PADDING = 24;
const SNAP_THRESHOLD_X = 48;

const SIZE = { width: WIDTH, height: HEIGHT };

const primary: OverlayPlacementDisplay = {
  id: 1,
  workArea: { x: 0, y: 25, width: 1920, height: 1055 },
};
const secondary: OverlayPlacementDisplay = {
  id: 2,
  workArea: { x: 1920, y: 0, width: 2560, height: 1440 },
};

const geometry = {
  contentInset: CONTENT_INSET,
  edgePadding: EDGE_PADDING,
};

function drag(
  startX: number,
  startY: number,
  dx: number,
  dy: number,
  displays: OverlayPlacementDisplay[] = [primary],
) {
  return resolveDraggedOverlayBounds({
    startBounds: { x: startX, y: startY, width: WIDTH, height: HEIGHT },
    startCursor: { x: startX + WIDTH / 2, y: startY + 20 },
    cursor: { x: startX + WIDTH / 2 + dx, y: startY + 20 + dy },
    displays,
    ...geometry,
    snapThresholdX: SNAP_THRESHOLD_X,
  });
}

describe('clampOverlayBoundsToWorkArea', () => {
  it('可见卡片保持在 workArea 内且保留 edgePadding,透明阴影允许探出', () => {
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: -500, y: -500, width: WIDTH, height: HEIGHT },
      workArea: primary.workArea,
      ...geometry,
    });
    // 窗口左缘允许到 workArea.x + (edgePadding - contentInset) = -28
    expect(clamped.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(clamped.y).toBe(primary.workArea.y + EDGE_PADDING - CONTENT_INSET);
    expect(clamped.width).toBe(WIDTH);
    expect(clamped.height).toBe(HEIGHT);
  });

  it('右下越界时 clamp 到对侧边界', () => {
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: 99999, y: 99999, width: WIDTH, height: HEIGHT },
      workArea: primary.workArea,
      ...geometry,
    });
    expect(clamped.x).toBe(primary.workArea.x + primary.workArea.width - WIDTH - (EDGE_PADDING - CONTENT_INSET));
    expect(clamped.y).toBe(primary.workArea.y + primary.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET));
  });

  it('workArea 小到放不下时退化为居中', () => {
    const tiny = { x: 0, y: 0, width: 400, height: 100 };
    const clamped = clampOverlayBoundsToWorkArea({
      bounds: { x: 999, y: 999, width: WIDTH, height: HEIGHT },
      workArea: tiny,
      ...geometry,
    });
    expect(clamped.x).toBe(Math.round((tiny.width - WIDTH) / 2));
    expect(clamped.y).toBe(Math.round((tiny.height - HEIGHT) / 2));
  });
});

describe('resolveDraggedOverlayBounds', () => {
  it('按 pointer delta 平移', () => {
    const result = drag(400, 400, 37, -21);
    expect(result).toEqual({ x: 437, y: 379, width: WIDTH, height: HEIGHT });
  });

  it('卡片中心进入中线吸附阈值时吸附到水平居中', () => {
    const centeredX = Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2);
    // 起点在中心右侧 100px,向左拖 60px 后中心距中线 40px < 48px → 吸附
    const result = drag(centeredX + 100, 400, -60, 0);
    expect(result.x).toBe(centeredX);
    expect(result.y).toBe(400);
  });

  it('超出吸附阈值时不吸附', () => {
    const centeredX = Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2);
    const result = drag(centeredX + 100, 400, -40, 0); // 中心距中线 60px > 48px
    expect(result.x).toBe(centeredX + 60);
  });

  it('拖出屏幕边缘时 clamp 在 workArea 内', () => {
    const result = drag(400, 400, -5000, -5000);
    expect(result.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(result.y).toBe(primary.workArea.y + EDGE_PADDING - CONTENT_INSET);
  });

  it('跨屏拖动时按目标屏 workArea clamp 与吸附', () => {
    // 拖到副屏中线附近
    const secondaryCenterX = Math.round(secondary.workArea.x + (secondary.workArea.width - WIDTH) / 2);
    const startX = 1000;
    const dx = secondaryCenterX + 30 - startX; // 目标中心距副屏中线 30px < 48px
    const result = drag(startX, 400, dx, 100, [primary, secondary]);
    expect(result.x).toBe(secondaryCenterX);
  });

  it('无 display 数据时原样返回候选位置(防御分支)', () => {
    const result = resolveDraggedOverlayBounds({
      startBounds: { x: 10, y: 10, width: WIDTH, height: HEIGHT },
      startCursor: { x: 0, y: 0 },
      cursor: { x: 5, y: 5 },
      displays: [],
      ...geometry,
      snapThresholdX: SNAP_THRESHOLD_X,
    });
    expect(result).toEqual({ x: 15, y: 15, width: WIDTH, height: HEIGHT });
  });
});

describe('resolveOverlayInitialBounds', () => {
  const fallbackBounds = { x: 660, y: 800, width: WIDTH, height: HEIGHT };

  function initial(
    savedPosition: SavedOverlayPosition | null,
    options?: {
      displays?: OverlayPlacementDisplay[];
      activeDisplay?: OverlayPlacementDisplay | null;
    },
  ) {
    const displays = options?.displays ?? [primary];
    return resolveOverlayInitialBounds({
      savedPosition,
      displays,
      activeDisplay: options?.activeDisplay === undefined ? displays[0] ?? null : options.activeDisplay,
      size: SIZE,
      ...geometry,
      fallbackBounds,
    });
  }

  /** 按 global.ts 落盘时的算法，为一个绝对坐标算出屏内相对比例。 */
  function ratioOf(x: number, y: number, display: OverlayPlacementDisplay) {
    return computeOverlayPositionRatio({ x, y, width: WIDTH, height: HEIGHT }, display.workArea);
  }

  it('无保存位置时使用默认位置', () => {
    expect(initial(null)).toEqual(fallbackBounds);
  });

  it('保存位置有效时记忆优先', () => {
    expect(initial({ x: 100, y: 200, displayId: 1, updatedAt: 1 }))
      .toEqual({ x: 100, y: 200, width: WIDTH, height: HEIGHT });
  });

  it('保存位置所在屏幕已不存在时回退默认位置', () => {
    // 中心在已拔掉的副屏，displayId 也找不到对应屏。
    expect(initial({ x: 3000, y: 500, displayId: 2, updatedAt: 1 })).toEqual(fallbackBounds);
  });

  it('displayId 记着但那块屏已拔掉时回退默认位置，即使旧坐标现在落进了另一块屏', () => {
    // 记忆属于副屏（已拔掉），旧坐标现在落在主屏范围内。不能因此把记忆改判给
    // 主屏并恢复那个陈旧坐标。
    expect(initial({ x: 300, y: 500, displayId: secondary.id, updatedAt: 1 }, {
      displays: [primary],
      activeDisplay: primary,
    })).toEqual(fallbackBounds);
  });

  it('同屏 workArea 未变时，带比例的记忆还原回原坐标（1px 取整误差内）', () => {
    const saved = {
      x: 400,
      y: 700,
      displayId: primary.id,
      ...ratioOf(400, 700, primary),
      updatedAt: 1,
    };
    const result = initial(saved, { displays: [primary], activeDisplay: primary });
    expect(Math.abs(result.x - saved.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y - saved.y)).toBeLessThanOrEqual(1);
  });

  it('同屏但分辨率变了时按比例走，不沿用旧的绝对坐标', () => {
    // 在 1920 宽的屏上水平居中存下；该屏换成 2560 宽后仍应居中，而不是停在
    // 旧坐标（那会变成偏左）。旧坐标中心仍落在新 workArea 内，所以这条正是
    // 「坐标看起来还有效但其实已经不对」的场景。
    const savedX = Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2);
    const widerPrimary: OverlayPlacementDisplay = {
      id: primary.id,
      workArea: { x: primary.workArea.x, y: primary.workArea.y, width: 2560, height: 1055 },
    };
    const result = initial({
      x: savedX,
      y: 700,
      displayId: primary.id,
      ...ratioOf(savedX, 700, primary),
      updatedAt: 1,
    }, { displays: [widerPrimary], activeDisplay: widerPrimary });
    const expectedX = Math.round(widerPrimary.workArea.x + (widerPrimary.workArea.width - WIDTH) / 2);
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
  });

  it('旧快照没有比例、坐标又已不在归属屏内时回退默认位置', () => {
    // 升级前存下的绝对坐标 + 之后的显示器重排：反推不出有意义的比例，夹到 0~1
    // 只会得到一个贴边的假位置，不如回退默认。
    expect(initial({ x: 3000, y: 500, displayId: primary.id, updatedAt: 1 }, {
      displays: [primary],
      activeDisplay: primary,
    })).toEqual(fallbackBounds);
  });

  it('同样场景下带比例的快照仍能还原记忆（这正是持久化比例的意义）', () => {
    const result = initial({
      x: 3000,
      y: 500,
      displayId: primary.id,
      ratioX: 0.5,
      ratioY: 0.86,
      updatedAt: 1,
    }, { displays: [primary], activeDisplay: primary });
    const expectedX = primary.workArea.x + primary.workArea.width * 0.5 - WIDTH / 2;
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
    expect(result).not.toEqual(fallbackBounds);
  });

  it('旧坐标落进另一块屏时，归属屏认 displayId 而不认坐标落点', () => {
    // 记忆存的是主屏（displayId 1）+ 比例 (0.25, 0.5)，但显示器重排后旧坐标
    // 落进了副屏范围。归属屏必须仍是主屏，且按比例还原到焦点屏（主屏）。
    const result = initial({
      x: secondary.workArea.x + 400,
      y: secondary.workArea.y + 400,
      displayId: primary.id,
      ratioX: 0.25,
      ratioY: 0.5,
      updatedAt: 1,
    }, { displays: [primary, secondary], activeDisplay: primary });
    const expectedX = primary.workArea.x + primary.workArea.width * 0.25 - WIDTH / 2;
    const expectedY = primary.workArea.y + primary.workArea.height * 0.5 - HEIGHT / 2;
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y - expectedY)).toBeLessThanOrEqual(1);
  });

  it('同屏但坐标已被重排作废时按保存的比例还原，而不是用失效坐标', () => {
    // 主屏 workArea 已右移，旧坐标 (100, 200) 不再落在它内部。
    const movedPrimary: OverlayPlacementDisplay = {
      id: primary.id,
      workArea: { x: 2560, y: 0, width: 1920, height: 1055 },
    };
    const result = initial({
      x: 100,
      y: 200,
      displayId: primary.id,
      ratioX: 0.5,
      ratioY: 0.8,
      updatedAt: 1,
    }, { displays: [movedPrimary], activeDisplay: movedPrimary });
    const expectedX = movedPrimary.workArea.x + movedPrimary.workArea.width * 0.5 - WIDTH / 2;
    const expectedY = movedPrimary.workArea.y + movedPrimary.workArea.height * 0.8 - HEIGHT / 2;
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y - expectedY)).toBeLessThanOrEqual(1);
  });

  it('跨屏时保存的比例优先于按坐标反推的比例', () => {
    const result = initial({
      // 坐标反推会得到 (0.25, 0.5)，但快照里明确记着 (0.8, 0.3)。
      x: Math.round(primary.workArea.x + primary.workArea.width * 0.25 - WIDTH / 2),
      y: Math.round(primary.workArea.y + primary.workArea.height * 0.5 - HEIGHT / 2),
      displayId: primary.id,
      ratioX: 0.8,
      ratioY: 0.3,
      updatedAt: 1,
    }, { displays: [primary, secondary], activeDisplay: secondary });
    const expectedX = secondary.workArea.x + secondary.workArea.width * 0.8 - WIDTH / 2;
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
  });

  it('保存位置轻微越界时 clamp 回可见区域', () => {
    const result = initial({ x: -200, y: 950, updatedAt: 1 }); // 中心仍在主屏内
    expect(result.x).toBe(primary.workArea.x + EDGE_PADDING - CONTENT_INSET);
    expect(result.y).toBe(primary.workArea.y + primary.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET));
  });

  it('非有限坐标回退默认位置', () => {
    expect(initial({ x: Number.NaN, y: 200, updatedAt: 1 })).toEqual(fallbackBounds);
  });

  it('焦点屏就是保存位置所在屏时原样恢复', () => {
    const saved = { x: 1920 + 300, y: 900, displayId: 2, updatedAt: 1 };
    expect(initial(saved, { displays: [primary, secondary], activeDisplay: secondary }))
      .toEqual({ x: saved.x, y: saved.y, width: WIDTH, height: HEIGHT });
  });

  it('焦点屏是另一块屏时，把保存位置按比例迁移过去', () => {
    // 主屏上卡片中心在 workArea 的 (25%, 50%) 处。
    const centerRatioX = 0.25;
    const centerRatioY = 0.5;
    const saved = {
      x: Math.round(primary.workArea.x + primary.workArea.width * centerRatioX - WIDTH / 2),
      y: Math.round(primary.workArea.y + primary.workArea.height * centerRatioY - HEIGHT / 2),
      displayId: primary.id,
      updatedAt: 1,
    };
    const result = initial(saved, { displays: [primary, secondary], activeDisplay: secondary });
    // 保存位置本身是整数像素，比例换算会带 1px 以内的取整误差。
    const expectedX = secondary.workArea.x + secondary.workArea.width * centerRatioX - WIDTH / 2;
    const expectedY = secondary.workArea.y + secondary.workArea.height * centerRatioY - HEIGHT / 2;
    expect(Math.abs(result.x - expectedX)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.y - expectedY)).toBeLessThanOrEqual(1);
  });

  it('迁移保留水平居中：主屏居中的记忆在副屏也居中', () => {
    const saved = {
      x: Math.round(primary.workArea.x + (primary.workArea.width - WIDTH) / 2),
      y: 800,
      displayId: primary.id,
      updatedAt: 1,
    };
    const result = initial(saved, { displays: [primary, secondary], activeDisplay: secondary });
    expect(result.x).toBe(Math.round(secondary.workArea.x + (secondary.workArea.width - WIDTH) / 2));
  });

  it('迁移到更小的屏时 clamp 进可见区域', () => {
    const small: OverlayPlacementDisplay = {
      id: 3,
      workArea: { x: -1280, y: 0, width: 1280, height: 800 },
    };
    // 副屏上贴着右下角的记忆，迁到小屏后仍需留出 edgePadding。
    const saved = {
      x: secondary.workArea.x + secondary.workArea.width - WIDTH - (EDGE_PADDING - CONTENT_INSET),
      y: secondary.workArea.y + secondary.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET),
      displayId: secondary.id,
      updatedAt: 1,
    };
    const result = initial(saved, { displays: [secondary, small], activeDisplay: small });
    expect(result.x).toBeLessThanOrEqual(
      small.workArea.x + small.workArea.width - WIDTH - (EDGE_PADDING - CONTENT_INSET),
    );
    expect(result.y).toBeLessThanOrEqual(
      small.workArea.y + small.workArea.height - HEIGHT - (EDGE_PADDING - CONTENT_INSET),
    );
    expect(result.x).toBeGreaterThanOrEqual(small.workArea.x + EDGE_PADDING - CONTENT_INSET);
  });

  it('拿不到焦点屏时退回保存位置所在屏（防御分支）', () => {
    const saved = { x: 1920 + 300, y: 900, displayId: 2, updatedAt: 1 };
    expect(initial(saved, { displays: [primary, secondary], activeDisplay: null }))
      .toEqual({ x: saved.x, y: saved.y, width: WIDTH, height: HEIGHT });
  });
});

describe('computeOverlayPositionRatio', () => {
  it('按卡片中心算屏内相对比例', () => {
    const bounds = {
      x: Math.round(primary.workArea.x + primary.workArea.width * 0.25 - WIDTH / 2),
      y: Math.round(primary.workArea.y + primary.workArea.height * 0.75 - HEIGHT / 2),
      width: WIDTH,
      height: HEIGHT,
    };
    const ratio = computeOverlayPositionRatio(bounds, primary.workArea);
    expect(ratio.ratioX).toBeCloseTo(0.25, 3);
    expect(ratio.ratioY).toBeCloseTo(0.75, 3);
  });

  it('中心在 workArea 之外时把比例夹进 0~1', () => {
    const ratio = computeOverlayPositionRatio(
      { x: -9999, y: 99999, width: WIDTH, height: HEIGHT },
      primary.workArea,
    );
    expect(ratio.ratioX).toBe(0);
    expect(ratio.ratioY).toBe(1);
  });
});

describe('isBoundsCenterOnDisplay', () => {
  it('中心落在现存屏幕内时为 true', () => {
    expect(isBoundsCenterOnDisplay({ x: 100, y: 200, width: WIDTH, height: HEIGHT }, [primary]))
      .toBe(true);
  });

  it('对应屏幕已拔掉时为 false', () => {
    expect(isBoundsCenterOnDisplay(
      { x: secondary.workArea.x + 300, y: 500, width: WIDTH, height: HEIGHT },
      [primary],
    )).toBe(false);
  });
});

describe('normalizeFocusedWindowFrame', () => {
  it('接受合法 frame', () => {
    expect(normalizeFocusedWindowFrame({ x: 10, y: 20, width: 800, height: 600 }))
      .toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });

  it('负坐标合法（副屏在主屏左侧时窗口 x 为负）', () => {
    expect(normalizeFocusedWindowFrame({ x: -1200, y: -30, width: 640, height: 480 }))
      .toEqual({ x: -1200, y: -30, width: 640, height: 480 });
  });

  it('缺字段 / 非法值 / 零尺寸返回 null', () => {
    expect(normalizeFocusedWindowFrame(null)).toBeNull();
    expect(normalizeFocusedWindowFrame('frame')).toBeNull();
    expect(normalizeFocusedWindowFrame({ x: 0, y: 0, width: 800 })).toBeNull();
    expect(normalizeFocusedWindowFrame({ x: 0, y: 0, width: 0, height: 600 })).toBeNull();
    expect(normalizeFocusedWindowFrame({ x: 0, y: 0, width: 800, height: -600 })).toBeNull();
    expect(normalizeFocusedWindowFrame({ x: Number.NaN, y: 0, width: 800, height: 600 })).toBeNull();
  });
});

describe('normalizeSavedOverlayPosition', () => {
  it('接受合法快照', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, displayId: 3, ratioX: 0.5, ratioY: 0.8, updatedAt: 4 }))
      .toEqual({ x: 1, y: 2, displayId: 3, ratioX: 0.5, ratioY: 0.8, updatedAt: 4 });
  });

  it('缺字段 / 非法值返回 null', () => {
    expect(normalizeSavedOverlayPosition(null)).toBeNull();
    expect(normalizeSavedOverlayPosition('x')).toBeNull();
    expect(normalizeSavedOverlayPosition({ x: 'a', y: 2 })).toBeNull();
    expect(normalizeSavedOverlayPosition({ x: 1 })).toBeNull();
  });

  it('displayId / updatedAt 非法时降级而不丢整条记录', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, displayId: 'nope' }))
      .toEqual({ x: 1, y: 2, displayId: undefined, ratioX: undefined, ratioY: undefined, updatedAt: 0 });
  });

  it('旧快照没有比例字段时保持 undefined（由坐标反推）', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, displayId: 3, updatedAt: 4 }))
      .toEqual({ x: 1, y: 2, displayId: 3, ratioX: undefined, ratioY: undefined, updatedAt: 4 });
  });

  it('比例超出 0~1 或非有限数时丢弃该字段', () => {
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, ratioX: 1.5, ratioY: -0.2, updatedAt: 4 }))
      .toEqual({ x: 1, y: 2, displayId: undefined, ratioX: undefined, ratioY: undefined, updatedAt: 4 });
    expect(normalizeSavedOverlayPosition({ x: 1, y: 2, ratioX: Number.NaN, ratioY: 0.5, updatedAt: 4 }))
      .toEqual({ x: 1, y: 2, displayId: undefined, ratioX: undefined, ratioY: 0.5, updatedAt: 4 });
  });
});
