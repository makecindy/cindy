import { describe, expect, it } from 'vitest';

import {
  brandPlacement,
  desktopScale,
  panelPlacement,
  PANEL_FIXED_SCALE,
  sloganShiftX,
} from '../loginScale';

/**
 * 缩放公式行为单测(implementation-plan Step 2 WHAT1 锚点数值,demo v3.1 拍板)。
 * 公式 = min(1, h/2098, (w-24)/680);高度基准 = 整画布高,宽度不参与缩放。
 */
describe('desktopScale(demo v3.1 拍板公式)', () => {
  it('(1280, 800) → ≈0.3813(高度基准 800/2098)', () => {
    expect(desktopScale(1280, 800).scale).toBeCloseTo(0.3813, 4);
  });

  it('(800, 600) → ≈0.2860(高度基准 600/2098)', () => {
    expect(desktopScale(800, 600).scale).toBeCloseTo(0.286, 4);
  });

  it('宽度拉伸不改 scale(高度不变时 1280→2560 宽,scale 恒等)', () => {
    const base = desktopScale(1280, 800).scale;
    expect(desktopScale(2560, 800).scale).toBe(base);
    expect(desktopScale(1600, 800).scale).toBe(base);
  });

  it('scale 封顶 1(超大窗口不放大)', () => {
    expect(desktopScale(4000, 4000).scale).toBe(1);
  });

  it('panelGuard 仅在极端窄高组合介入((300,2200) → (300-24)/680)', () => {
    expect(desktopScale(300, 2200).scale).toBeCloseTo(276 / 680, 6);
  });
});

describe('sloganShiftX(窄窗左移只平移不缩放,demo applyDesktopScale 移植)', () => {
  it('宽窗不左移(可见半宽覆盖 Slogan 右缘)', () => {
    const { scale } = desktopScale(1920, 800);
    expect(sloganShiftX(1920, scale)).toBe(0);
  });

  it('窄窗产生负向平移(数值 = 溢出量向上取整)', () => {
    const { scale } = desktopScale(560, 800); // 高度基准 scale≈0.3813,半宽 280/0.3813≈734.3 < 757.72
    const shift = sloganShiftX(560, scale);
    expect(shift).toBeLessThan(0);
    const visibleHalf = 560 / 2 / scale;
    expect(shift).toBe(-Math.ceil(1647.22 - 909.5 + 20 - visibleHalf));
  });
});

describe('panelPlacement(面板恒定 1x,用户拍板 2026-07-23,design.md §11)', () => {
  it('scale 恒为 0.5,与窗口尺寸无关', () => {
    expect(panelPlacement(1280, 800, 1229).scale).toBe(PANEL_FIXED_SCALE);
    expect(panelPlacement(800, 600, 1229).scale).toBe(PANEL_FIXED_SCALE);
    expect(panelPlacement(4000, 4000, 1229).scale).toBe(PANEL_FIXED_SCALE);
  });

  it('(1280, 800) 品牌避让主导:top = 立绘底(400+160×0.3813)+24 ≈ 485.01', () => {
    const { topY } = panelPlacement(1280, 800, 1229);
    expect(topY).toBeCloseTo(400 + 160 * (800 / 2098) + 24, 2);
  });

  it('(800, 600) 视口底 clamp 主导(功能优先压过品牌避让):top = 600-24-280 = 296', () => {
    expect(panelPlacement(800, 600, 1229).topY).toBe(296);
  });

  it('底部有本地模式操作区时，视口 clamp 为 footer 预留安全空间', () => {
    const placement = panelPlacement(800, 600, 1229, 124);
    expect(placement.topY).toBe(172);
    expect(placement.topY + 560 * placement.scale + 124).toBe(576);
  });

  it('高窗时锚点主导(不触发任何 clamp):(1300, 1400) top = 锚点中心-140', () => {
    const s14 = 1400 / 2098;
    const anchorTop = 700 + (1229 + 280 - 1049) * s14 - 140;
    expect(panelPlacement(1300, 1400, 1229).topY).toBeCloseTo(anchorTop, 2);
  });

  it('水平中心 = 视口中线 + 组中心偏移 0.5 设计px × 0.5', () => {
    expect(panelPlacement(1280, 800, 1229).centerX).toBeCloseTo(640.25, 6);
  });
});

describe('brandPlacement(品牌块整体让位,用户拍板 2026-07-23 第二轮,design.md §11)', () => {
  it('① 常态(1280,800):块底 461 < 面板顶 485-12,零让位 = v3.1 原值', () => {
    const r = brandPlacement(1280, 800);
    expect(r.scale).toBe(desktopScale(1280, 800).scale);
    expect(r.translateY).toBe(0);
  });

  it('② 上移档(800,600):面板顶 296,块底 300+160×s 越界 → 整块上移,不压缩', () => {
    const s6 = 600 / 2098;
    const r = brandPlacement(800, 600);
    expect(r.scale).toBe(s6); // 不压缩
    expect(r.translateY).toBeCloseTo(-(300 + 160 * s6 - (296 - 12)), 2);
  });

  it('③ 压缩档(800,500):上移到顶仍不够 → 块高压进 [12, 面板顶-12]', () => {
    const r = brandPlacement(800, 500);
    const limit = 500 - 24 - 280 - 12; // 面板顶(视口底 clamp) - gap = 184
    expect(r.scale).toBeCloseTo((limit - 12) / 934, 6);
    const blockTop2 = 250 + (275 - 1049) * r.scale;
    expect(r.translateY).toBeCloseTo(12 - blockTop2, 2);
  });

  it('让位后块底恰好贴面板顶-12(上移档守恒式)', () => {
    const s6 = 600 / 2098;
    const r = brandPlacement(800, 600);
    const blockBottomAfter = 300 + 160 * s6 + r.translateY;
    expect(blockBottomAfter).toBeCloseTo(296 - 12, 2);
  });

  it('品牌让位与登录 footer 使用同一 bottom reserve，避免面板上移后再次遮挡品牌', () => {
    const panelTop = panelPlacement(800, 600, 1229, 124).topY;
    const r = brandPlacement(800, 600, 124);
    const blockBottomAfter = 300 + 160 * r.scale + r.translateY;
    expect(blockBottomAfter).toBeLessThanOrEqual(panelTop - 12);
  });
});
