/**
 * loginScale.ts — 桌面登录 stage 缩放公式(demo v3.1 用户拍板,逐字落码)。
 *
 * 权威来源:docs/cindy-login-hifi.html `desktopScale()`(demo:1809-1815,
 * implementation-plan.md「参数权威链」收口项):
 *   高度缩放基准 = 整设计画布高 2098(保留设计稿上下留白比例,构图占比与稿一致);
 *   宽度拉伸 → 元素大小不变(仅 slogan 左移),宽度不参与缩放;
 *   panelGuard = (w - 24) / 680 为唯一宽度介入:极端窄高组合下保障 680 宽功能面板不被裁。
 *
 * 行为合约(计划 Step 2 单测锚点):
 *   (1280, 800) → ≈0.3813;(800, 600) → ≈0.2860;宽度拉伸不改 scale。
 */

import { HERO, LOGIN_GROUP, WORDMARK } from './loginDesignTokens';

/** 设计画布尺寸(figma §5.1 桌面通用画板 1819×2098)。 */
export const LOGIN_STAGE_WIDTH = 1819;
export const LOGIN_STAGE_HEIGHT = 2098;

/** demo desktopScale 逐字移植:min(1, h/LOGIN_STAGE_HEIGHT, (w-24)/680)。 */
export function desktopScale(w: number, h: number): { scale: number } {
  const heightFit = h / LOGIN_STAGE_HEIGHT;
  const panelGuard = (w - 24) / 680; // 唯一宽度介入:极端窄高组合下保障 680 宽功能面板不被裁
  return { scale: Math.min(1, heightFit, panelGuard) };
}

/**
 * Slogan 窄窗左移量(demo applyDesktopScale 逐字移植,adaptation §1.1 条 8):
 * 只平移不缩放。1647.22 = Slogan 右缘(1194 + 453.22),909.5 = 画布中线(1819/2),
 * 20 = 右侧安全边距;可见半宽按当前 scale 反算回设计坐标系。
 * 返回负值 translateX 像素(设计坐标系);无溢出时为 0。
 */
export function sloganShiftX(viewportWidth: number, scale: number): number {
  const visibleHalf = viewportWidth / 2 / scale;
  const overflow = 1647.22 - 909.5 + 20 - visibleHalf;
  return overflow > 0 ? -Math.ceil(overflow) : 0;
}

/**
 * 面板恒定缩放(用户拍板 2026-07-23,design.md §11):1819×2098 为 2x 稿,
 * 0.5 = 标准 1:1 逻辑尺寸——输入框/文字在任何窗口下保持设计标准大小,
 * 不再随窗口高度线性缩小(desktopScale 仅品牌层继续使用)。
 */
export const PANEL_FIXED_SCALE = 0.5;

export interface PanelPlacement {
  /** 恒定 PANEL_FIXED_SCALE。 */
  scale: number;
  /** 面板水平中心(屏幕 px,配合 translateX(-50%))。 */
  centerX: number;
  /** 面板顶边(屏幕 px,已含品牌避让与视口 clamp)。 */
  topY: number;
}

/**
 * 面板定位(用户拍板 2026-07-23,design.md §11):
 *   - 尺寸恒定 0.5(登录整体组 680×620 设计px → 340×310 逻辑px);
 *   - 垂直锚点跟随品牌层 desktopScale 画布(组中心 y=groupY+310 映射到屏幕),
 *     再依次 clamp:① 品牌避让——面板顶 ≥ 立绘底(设计 y=1209,figma §4.11)+24;
 *     ② 功能优先——面板底 ≤ 视口底-24(压过品牌避让,小窗允许叠上立绘渐隐区,
 *     面板层 z-[9990] 本就盖品牌层 z-[9980]);额外底部内容通过 bottomReserve
 *     参与此 clamp;③ 顶部保底 24。
 *   - 水平:组中心 x=910 与画布中线 909.5 的 0.5 设计px 偏移按恒定缩放折算。
 */
export function panelPlacement(
  w: number,
  h: number,
  groupY: number,
  bottomReserve = 0,
): PanelPlacement {
  const { scale: brandScale } = desktopScale(w, h);
  // 登录整体组高(figma §5.1;面板 500 + gap 40 + 圆钮 80 = 620,面板增高后同步跟随)
  const panelHeight = LOGIN_GROUP.height * PANEL_FIXED_SCALE;
  const anchorCenterY =
    h / 2 + (groupY + LOGIN_GROUP.height / 2 - LOGIN_STAGE_HEIGHT / 2) * brandScale;
  const brandBottomY = h / 2 + (1209 - LOGIN_STAGE_HEIGHT / 2) * brandScale;
  let topY = anchorCenterY - panelHeight / 2;
  topY = Math.max(topY, brandBottomY + 24);
  // 额外底部内容(例如本地模式入口)属于登录组的一部分，必须在这里预留空间；
  // 否则视口底 clamp 会把它和 social row 压到同一条垂直区域。
  topY = Math.min(topY, h - 24 - panelHeight - bottomReserve);
  topY = Math.max(topY, 24);
  return {
    scale: PANEL_FIXED_SCALE,
    centerX: w / 2 + (910 - LOGIN_STAGE_WIDTH / 2) * PANEL_FIXED_SCALE,
    topY,
  };
}

export interface BrandPlacement {
  /** 品牌画布缩放(常态 = desktopScale;压缩档小于它)。 */
  scale: number;
  /** 画布垂直位移(屏幕 px,负值上移;常态 0)。 */
  translateY: number;
}

function brandPlacementForPanelTop(
  h: number,
  base: number,
  panelTop: number,
  protectedBottomDesignY: number,
  panelGap: number,
): BrandPlacement {
  const blockTop = h / 2 + (HERO.y - LOGIN_STAGE_HEIGHT / 2) * base;
  const blockBottom = h / 2 + (protectedBottomDesignY - LOGIN_STAGE_HEIGHT / 2) * base;
  // The collision boundary is the actual protected brand element, not a
  // viewport-height mode switch. This keeps the layout continuous around
  // neighboring heights (for example 768px and 769px).
  const limit = panelTop - panelGap;
  const overflow = blockBottom - limit;
  if (overflow <= 0) return { scale: base, translateY: 0 };
  const maxShift = blockTop - 12;
  if (overflow <= maxShift) return { scale: base, translateY: -overflow };
  // 压缩档:受保护品牌范围恰好塞进 [12, limit];画布仍中心缩放,
  // 位移把立绘顶放到 12。登录短窗保护字标底部(1191),所以立绘尾部
  // 比字标多出的 18 设计单位可以自然地落入面板下方。
  const protectedHeight = protectedBottomDesignY - HERO.y;
  const scale2 = Math.max(limit - 12, 0) / protectedHeight;
  const blockTop2 = h / 2 + (HERO.y - LOGIN_STAGE_HEIGHT / 2) * scale2;
  return { scale: scale2, translateY: 12 - blockTop2 };
}

/**
 * 品牌块整体让位(用户拍板 2026-07-23 第二轮,design.md §11):
 * 字标任何窗口必须完整可见,且优先保护立绘脸部/黑猫——后者由「构图冻结」保证:
 * 品牌块(立绘 275..1209,字标底 1191 / Slogan 底 995 均在其内)只作为整体
 * 移动/缩放,字标与立绘的设计相对位(压胸口渐隐区)永不改变。三级规则:
 *   ① 常态:v3.1 desktopScale + 画布居中(translateY=0),大窗零变化;
 *   ② 面板上侵:有登录底部预留时以字标底部为碰撞边界,允许立绘尾部
 *      (立绘底部比字标底部低 18 个设计单位)自然落入面板下方;不再按窗口高度硬切档;
 *   ③ 极矮窗:上移仍不够 → 受保护的品牌范围等比压缩至恰好塞进
 *      [12, 面板顶-当前安全间距]。
 * 面板锚点取 yDefault(sso 态差 2 设计px,由 12px gap 吸收)。
 */
export function brandPlacement(w: number, h: number, bottomReserve = 0): BrandPlacement {
  const { scale: base } = desktopScale(w, h);
  const { topY: panelTop } = panelPlacement(w, h, 1229, bottomReserve);
  const protectsWordmark = bottomReserve > 0;
  return brandPlacementForPanelTop(
    h,
    base,
    panelTop,
    protectsWordmark ? WORDMARK.inner.y + WORDMARK.inner.height : HERO.y + HERO.size,
    protectsWordmark ? 0 : 12,
  );
}

/**
 * Splash 品牌块让位:品牌画布与 Splash 状态面板都使用 desktopScale,
 * 因此不能复用登录页固定 0.5 面板的 bottom clamp。Splash 面板顶边在同一
 * 设计画布坐标系的 LOGIN_GROUP.yDefault,仅保留品牌块与状态面板之间的
 * 12px 屏幕安全间距;这样小窗口不会因为登录 footer reserve 被过度压缩。
 */
export function splashBrandPlacement(w: number, h: number): BrandPlacement {
  const { scale: base } = desktopScale(w, h);
  const splashPanelTop = h / 2 + (LOGIN_GROUP.yDefault - LOGIN_STAGE_HEIGHT / 2) * base;
  return brandPlacementForPanelTop(h, base, splashPanelTop, HERO.y + HERO.size, 12);
}
