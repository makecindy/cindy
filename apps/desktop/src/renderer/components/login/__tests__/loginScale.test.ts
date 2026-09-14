import { describe, expect, it } from 'vitest';

import {
  brandPlacement,
  desktopScale,
  panelPlacement,
  PANEL_FIXED_SCALE,
  sloganShiftX,
  splashBrandPlacement,
} from '../loginScale';
import { CONTROL, HERO, LOGIN_GROUP, PANEL, SSO_ORG_HISTORY, WORDMARK } from '../loginDesignTokens';

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

  // 组高 620(面板 500 + gap 40 + 圆钮 80)→ 屏幕 310;各 clamp 锚点随之下调 30 屏幕 px。
  // 品牌避让档取 (1280,900):组高 620 后 (1280,800) 的视口底 clamp(466)已压过品牌避让(485)。
  it('(1280, 900) 品牌避让主导:top = 立绘底(450+160×0.4290)+24 ≈ 542.64', () => {
    const { topY } = panelPlacement(1280, 900, 1229);
    expect(topY).toBeCloseTo(450 + 160 * (900 / 2098) + 24, 2);
  });

  it('(800, 600) 视口底 clamp 主导(功能优先压过品牌避让):top = 600-24-310 = 266', () => {
    expect(panelPlacement(800, 600, 1229).topY).toBe(266);
  });

  it('底部有本地模式操作区时，视口 clamp 为 footer 预留安全空间', () => {
    const placement = panelPlacement(800, 600, 1229, 124);
    expect(placement.topY).toBe(142);
    expect(placement.topY + 620 * placement.scale + 124).toBe(576);
  });

  it('高窗时锚点主导(不触发任何 clamp):(1300, 1400) top = 锚点中心-155', () => {
    const s14 = 1400 / 2098;
    const anchorTop = 700 + (1229 + 310 - 1049) * s14 - 155;
    expect(panelPlacement(1300, 1400, 1229).topY).toBeCloseTo(anchorTop, 2);
  });

  it('水平中心 = 视口中线 + 组中心偏移 0.5 设计px × 0.5', () => {
    expect(panelPlacement(1280, 800, 1229).centerX).toBeCloseTo(640.25, 6);
  });

  it.each([
    ['小窗口', 800, 600],
    ['16 寸级大窗口', 1728, 1117],
  ])('%s下 SSO 候选层都锚定输入框下沿并收在面板内', (_label, width, height) => {
    const placement = panelPlacement(width, height, 1227);
    const inputBottom = placement.topY + (CONTROL.inputY + CONTROL.height) * placement.scale;
    const historyTop = placement.topY + SSO_ORG_HISTORY.y * placement.scale;
    const historyBottom = historyTop + SSO_ORG_HISTORY.maxHeight * placement.scale;
    const panelBottom = placement.topY + PANEL.height * placement.scale;

    expect(historyTop - inputBottom).toBe(8 * placement.scale);
    expect(historyBottom).toBeLessThanOrEqual(panelBottom);
  });
});

describe('brandPlacement(品牌块整体让位,用户拍板 2026-07-23 第二轮,design.md §11)', () => {
  // 组高 560→620 后面板顶整体上移 30 屏幕 px,各档触发窗口随之收紧:
  // 常态档取 (1280,1000)(原 (1280,800) 现已落进上移档),上移档取 (800,700)
  // (原 (800,600) 现已落进压缩档);公式与守恒式不变。
  it('① 常态(1280,1000):块底 576 < 面板顶 600-12,零让位 = v3.1 原值', () => {
    const r = brandPlacement(1280, 1000);
    expect(r.scale).toBe(desktopScale(1280, 1000).scale);
    expect(r.translateY).toBe(0);
  });

  it('② 上移档(800,700):面板顶 366,块底 350+160×s 越界 → 整块上移,不压缩', () => {
    const s7 = 700 / 2098;
    const r = brandPlacement(800, 700);
    expect(r.scale).toBe(s7); // 不压缩
    expect(r.translateY).toBeCloseTo(-(350 + 160 * s7 - (366 - 12)), 2);
  });

  it('③ 压缩档(800,500):上移到顶仍不够 → 块高压进 [12, 面板顶-12]', () => {
    const r = brandPlacement(800, 500);
    const limit = 500 - 24 - 310 - 12; // 面板顶(视口底 clamp) - gap = 154
    expect(r.scale).toBeCloseTo((limit - 12) / 934, 6);
    const blockTop2 = 250 + (275 - 1049) * r.scale;
    expect(r.translateY).toBeCloseTo(12 - blockTop2, 2);
  });

  it('让位后块底恰好贴面板顶-12(上移档守恒式)', () => {
    const s7 = 700 / 2098;
    const r = brandPlacement(800, 700);
    const blockBottomAfter = 350 + 160 * s7 + r.translateY;
    expect(blockBottomAfter).toBeCloseTo(366 - 12, 2);
  });

  it('短窗口以字标底部为碰撞边界,立绘尾部可自然落入面板下方', () => {
    const width = 1280;
    const height = 600;
    const panelTop = panelPlacement(width, height, 1229, 124).topY;
    const r = brandPlacement(width, height, 124);
    const blockTopAfter = height / 2 + (275 - 2098 / 2) * r.scale + r.translateY;
    const wordmarkBottomAfter = height / 2 + (1191 - 2098 / 2) * r.scale + r.translateY;
    const heroBottomAfter = height / 2 + (1209 - 2098 / 2) * r.scale + r.translateY;

    expect(blockTopAfter).toBeCloseTo(12, 6);
    expect(wordmarkBottomAfter).toBeLessThanOrEqual(panelTop + 1e-9);
    expect(heroBottomAfter).toBeGreaterThan(panelTop);
  });

  it('768px 与 769px 之间按可用空间连续变化,没有高度阈值 scale cliff', () => {
    const width = 1280;
    const reserve = 124;
    const at768 = brandPlacement(width, 768, reserve);
    const at769 = brandPlacement(width, 769, reserve);
    const panelTop768 = panelPlacement(width, 768, 1229, reserve).topY;
    const panelTop769 = panelPlacement(width, 769, 1229, reserve).topY;
    const expected768 = (panelTop768 - 12) / (WORDMARK.inner.y + WORDMARK.inner.height - HERO.y);
    const expected769 = (panelTop769 - 12) / (WORDMARK.inner.y + WORDMARK.inner.height - HERO.y);

    expect(at768.scale).toBeCloseTo(expected768, 6);
    expect(at769.scale).toBeCloseTo(expected769, 6);
    expect(at769.scale - at768.scale).toBeCloseTo(
      1 / (WORDMARK.inner.y + WORDMARK.inner.height - HERO.y),
      6,
    );

    for (const [height, placement, panelTop] of [
      [768, at768, panelTop768],
      [769, at769, panelTop769],
    ] as const) {
      const wordmarkBottom =
        height / 2 +
        (WORDMARK.inner.y + WORDMARK.inner.height - 2098 / 2) * placement.scale +
        placement.translateY;
      expect(wordmarkBottom).toBeLessThanOrEqual(panelTop + 1e-9);
    }
  });
});

describe('splashBrandPlacement(Splash 使用 desktopScale 的品牌块布局)', () => {
  it.each([
    ['4:3 小窗口', 800, 600],
    ['4:3 常见窗口', 1024, 768],
    ['16:9 窗口', 1280, 720],
    ['16:10 窗口', 1280, 800],
    ['16 寸级窗口', 1728, 1117],
  ])('%s保持原始 desktopScale,并与 Splash 面板保留安全间距', (_label, width, height) => {
    const base = desktopScale(width, height).scale;
    const placement = splashBrandPlacement(width, height);
    expect(placement.scale).toBe(base);

    const splashPanelTop = height / 2 + (LOGIN_GROUP.yDefault - 2098 / 2) * base;
    const brandBottom = height / 2 + (1209 - 2098 / 2) * base + placement.translateY;
    expect(brandBottom).toBeLessThanOrEqual(splashPanelTop - 12 + 1e-9);
  });
});
