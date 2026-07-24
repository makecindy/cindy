/**
 * loginSkinLayout —— 移动端登录皮肤 750 坐标 stage 布局引擎 + 面板内几何常量 +
 * 42s 倒计时纯函数(PR4a,implementation-plan Step 5 WHAT1/WHAT3;**纯数据/纯函数,
 * 零 react-native**,node vitest 可直接 import 校验)。
 *
 * 参数权威链(照抄,禁止目测):
 *  - stage 缩放与两档插值/两档外策略 = U-8a 裁决「照 demo」——
 *    docs/cindy-login-hifi.html `phoneLayout()`(wave3.5 内层修正 2026-07-19,
 *    347:2884 / 358:434 实测 inner 几何)与 stage 解析(designHeight clamp [600,1800]);
 *  - 面板内组件几何 = figma-component-spec §4/§5.1,与桌面
 *    apps/desktop/src/renderer/components/login/loginDesignTokens.ts 同源对齐;
 *  - 倒计时 = implementation-plan Step 3a 契约(v5 冻结显示数学,42s 双端拍板)。
 */

/** 750 设计稿坐标系下的绝对几何框(单位:设计 px)。 */
export interface LoginStageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** resolveLoginStage 的完整输出:缩放系数 + 设计高 + 品牌三要素几何 + Log_in 组 y。 */
export interface LoginStageLayout {
  /** 物理 viewport 宽(输入原样带出,便于消费端换算 safe area) */
  viewportWidth: number;
  /** 物理 viewport 高 */
  viewportHeight: number;
  /** 750 stage → 物理 px 的缩放系数(= viewportWidth / 750) */
  scale: number;
  /** clamp 到 [600,1800] 的设计高(= viewportHeight / scale) */
  designHeight: number;
  /** 立绘(login-hero)几何 */
  cindy: LoginStageBox;
  /** SLOGAN 矢量几何(368:1394 资产,几何沿 wave3.5 旧表) */
  slogan: LoginStageBox;
  /** WORD_MARK 可见图形框(黑红新资产 423×145 在框内 contain 等比适配) */
  word: LoginStageBox;
  /** Log_in 组(680×560)顶边 y(设计 px) */
  loginY: number;
}

/** stage 宽恒 750(750 移动设计稿坐标系)。 */
export const LOGIN_STAGE_WIDTH = 750;
/** designHeight clamp 下限(demo stage 解析 600)。 */
export const LOGIN_STAGE_MIN_DESIGN_HEIGHT = 600;
/** designHeight clamp 上限(demo stage 解析 1800)。 */
export const LOGIN_STAGE_MAX_DESIGN_HEIGHT = 1800;

/** 短屏档(designHeight=1334;inner 几何 347:2884 实测,wave3.5 旧表)。 */
export const LOGIN_STAGE_SHORT = {
  designHeight: 1334,
  cindy: { x: 75, y: 107, w: 599, h: 720 },
  slogan: { x: 462.55, y: 480.33, w: 254.01, h: 72.8 },
  word: { x: 199, y: 594.48, w: 352.93, h: 120.54 },
  loginY: 734,
} as const;

/**
 * 长屏档(designHeight=1624;358:434 实测)。立绘 y=116 双区统一
 * (〔已拍板 2026-07-19〕国区 116 vs 国际区旧帧 96 为设计稿内部不一致,取最新批次帧)。
 */
export const LOGIN_STAGE_LONG = {
  designHeight: 1624,
  cindy: { x: 0, y: 116, w: 750, h: 902 },
  slogan: { x: 387, y: 686, w: 321, h: 92 },
  word: { x: 175, y: 814, w: 401, h: 137 },
  loginY: 973,
} as const;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function lerpBox(a: LoginStageBox, b: LoginStageBox, t: number): LoginStageBox {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}

/**
 * 纯函数:物理 viewport → 750 stage 布局(U-8a「照 demo」逐式落码)。
 * - scale = viewportWidth / 750;designHeight = viewportHeight / scale,clamp [600,1800];
 * - dh < 1334:功能区优先——视觉区按 v=max(0.25,(dh-600)/734) 以 (375,0) 为锚连续压缩,
 *   loginY = max(0, dh-600)(功能区 680×560 + 底距不缩放、锚定底部);
 * - 1334 ≤ dh ≤ 1624:t=(dh-1334)/290 全字段线性插值(含 loginY);
 * - dh > 1624:t clamp 1(长屏几何原样)。
 */
export function resolveLoginStage(
  viewportWidth: number,
  viewportHeight: number,
): LoginStageLayout {
  const scale = viewportWidth / LOGIN_STAGE_WIDTH;
  const designHeight = Math.max(
    LOGIN_STAGE_MIN_DESIGN_HEIGHT,
    Math.min(LOGIN_STAGE_MAX_DESIGN_HEIGHT, viewportHeight / scale),
  );
  const base = { viewportWidth, viewportHeight, scale, designHeight };
  if (designHeight < LOGIN_STAGE_SHORT.designHeight) {
    // spec §3.3 功能区优先:面板/输入/按钮不缩放、锚定底部;视觉区按余量连续压缩
    const v = Math.max(0.25, (designHeight - 600) / 734);
    const cs = (b: LoginStageBox): LoginStageBox => ({
      x: 375 + (b.x - 375) * v,
      y: b.y * v,
      w: b.w * v,
      h: b.h * v,
    });
    return {
      ...base,
      cindy: cs(LOGIN_STAGE_SHORT.cindy),
      slogan: cs(LOGIN_STAGE_SHORT.slogan),
      word: cs(LOGIN_STAGE_SHORT.word),
      loginY: Math.max(0, designHeight - 600),
    };
  }
  const t = Math.max(
    0,
    Math.min(
      1,
      (designHeight - LOGIN_STAGE_SHORT.designHeight) /
        (LOGIN_STAGE_LONG.designHeight - LOGIN_STAGE_SHORT.designHeight),
    ),
  );
  return {
    ...base,
    cindy: lerpBox(LOGIN_STAGE_SHORT.cindy, LOGIN_STAGE_LONG.cindy, t),
    slogan: lerpBox(LOGIN_STAGE_SHORT.slogan, LOGIN_STAGE_LONG.slogan, t),
    word: lerpBox(LOGIN_STAGE_SHORT.word, LOGIN_STAGE_LONG.word, t),
    loginY: lerp(LOGIN_STAGE_SHORT.loginY, LOGIN_STAGE_LONG.loginY, t),
  };
}

/* ── §3.6 平板/横竖屏 surface 构图(PR4b Step 5b WHAT3;adaptation-spec §3.6 +
      demo resolveMobileStage()/ipadPortrait()/ipadLandscape() 仲裁,纯函数零 RN) ── */

/** 登录 surface 构图模式(§3.6 条4 断点三分支)。 */
export type LoginSurfaceMode = 'phone' | 'pad-portrait' | 'pad-landscape';

/** 横屏左右构图断点(§3.6 条4:landscape ∧ w≥1000pt ∧ h≥690pt;dp/pt 归一)。 */
export const PAD_LANDSCAPE_MIN_WIDTH = 1000;
export const PAD_LANDSCAPE_MIN_HEIGHT = 690;
/** iPad 竖屏构图断点(§3.6 条4:portrait ∧ w≥700pt;Split View 320pt 窄窗落回手机规则)。 */
export const PAD_PORTRAIT_MIN_WIDTH = 700;

/**
 * §3.6 条4 断点判定(demo resolveMobileStage auto 分支同式):
 * - landscape(w>h) ∧ w≥1000 ∧ h≥690 → 横屏左右构图;
 * - landscape 但不满足上行(手机横屏、横向分屏窄窗)→ 回退竖排手机 stage 弹性规则;
 * - portrait ∧ w≥700 → iPad 竖屏 stage;其余(手机/320pt 分屏)→ 手机两档插值规则。
 */
export function resolveLoginSurfaceMode(
  viewportWidth: number,
  viewportHeight: number,
): LoginSurfaceMode {
  const landscape = viewportWidth > viewportHeight;
  if (
    landscape &&
    viewportWidth >= PAD_LANDSCAPE_MIN_WIDTH &&
    viewportHeight >= PAD_LANDSCAPE_MIN_HEIGHT
  ) {
    return 'pad-landscape';
  }
  if (!landscape && viewportWidth >= PAD_PORTRAIT_MIN_WIDTH) return 'pad-portrait';
  return 'phone';
}

/** 平板 stage 规格(基准画布 + 五要素几何 + Log_in 组落位 + splash spinner)。 */
export interface LoginPadStageSpec {
  width: number;
  height: number;
  cindy: LoginStageBox;
  slogan: LoginStageBox;
  word: LoginStageBox;
  /** Log_in 组(680×560 设计系)在 stage 坐标的落位 x/y */
  loginX: number;
  loginY: number;
  /** Log_in 组内容追加缩放(相对 750 手机稿控件尺寸) */
  loginGroupScale: number;
  /** splash spinner(stage 坐标;demo msSpin) */
  spinner: { x: number; y: number; size: number };
  /** splash 期立绘/字标簇垂直偏移(stage 坐标;0 = 无位移变体) */
  splashOffset: number;
}

/**
 * iPad/平板竖屏 stage(§3.6 条2:基准 744×1133,控件 ≈0.794117 等比;
 * 五要素可见图形框 = demo ipadPortrait() 仲裁值——wave3 帧(358:473/484/779/485/487)
 * 的字标/SLOGAN 框按旧资产绘制,新黑红资产的可见框以 demo 呈现收口;
 * splashOffset 158 = (1133-656.81)/2-80,demo 注释同式)。
 */
export const LOGIN_PAD_PORTRAIT_STAGE: LoginPadStageSpec = {
  width: 744,
  height: 1133,
  cindy: { x: 99, y: 80, w: 546, h: 656.814514 },
  slogan: { x: 465.42, y: 434.6, w: 247.03, h: 70.8 },
  word: { x: 237.6, y: 514.11, w: 269.51, h: 92.05 },
  loginX: 105,
  loginY: 621,
  loginGroupScale: 0.794117,
  spinner: { x: 352, y: 804, size: 40 },
  splashOffset: 158,
} as const;

/**
 * iPad/平板横屏左右构图 stage(§3.6 条3:基准 1180×820,实测画布 358:833;
 * 控件 ≈0.655357 等比;五要素可见图形框 = demo ipadLandscape() 仲裁值
 * (wave3 帧 358:805/808/806/810 框按旧资产绘制,同上收口);
 * splashOffset 0 = 358:833 定稿横屏无位移变体,spinner 48×48 @(853,479)(368:908))。
 */
export const LOGIN_PAD_LANDSCAPE_STAGE: LoginPadStageSpec = {
  width: 1180,
  height: 820,
  cindy: { x: 86, y: 73, w: 481.430176, h: 579.000061 },
  slogan: { x: 279.54, y: 478.53, w: 339.16, h: 97.2 },
  word: { x: 736.73, y: 192.57, w: 297.32, h: 101.55 },
  loginX: 662,
  loginY: 328,
  loginGroupScale: 0.655357,
  spinner: { x: 853, y: 479, size: 48 },
  splashOffset: 0,
} as const;

/** 横屏构图 scale 下限(§3.6 条3 权威链收口:仅下限 0.85、无上限——原 1.30 上限作废)。 */
export const PAD_LANDSCAPE_MIN_SCALE = 0.85;

/**
 * 统一 surface 布局输出:三构图共用的消费面
 * (stage 坐标系尺寸 + 缩放/居中偏移 + 五要素 + Log_in 组落位 + splash 参数)。
 */
export interface LoginSurfaceLayout {
  mode: LoginSurfaceMode;
  viewportWidth: number;
  viewportHeight: number;
  /** stage 坐标系宽/高(phone: 750×designHeight;pad: 744×1133 / 1180×820) */
  stageWidth: number;
  stageHeight: number;
  /** stage → 物理 px 缩放(phone: w/750;pad-portrait: min(w/744,h/1133);
      pad-landscape: max(0.85, min(w/1180, h/820)),demo 公式、无上限) */
  scale: number;
  /** stage 原点物理偏移(phone: 0;pad: 居中) */
  offsetX: number;
  offsetY: number;
  cindy: LoginStageBox;
  slogan: LoginStageBox;
  word: LoginStageBox;
  /** Log_in 组(680×560 设计系)在 stage 坐标的落位与内容追加缩放 */
  loginX: number;
  loginY: number;
  loginGroupScale: number;
  /** splash 期立绘/字标簇垂直偏移(stage 坐标;pad-landscape 恒 0) */
  splashOffset: number;
  /** splash spinner(stage 坐标) */
  spinner: { x: number; y: number; size: number };
  /** phone 构图的完整两档插值输出(pad 构图为 null) */
  phone: LoginStageLayout | null;
}

function padSurface(
  mode: 'pad-portrait' | 'pad-landscape',
  spec: LoginPadStageSpec,
  viewportWidth: number,
  viewportHeight: number,
): LoginSurfaceLayout {
  const raw = Math.min(viewportWidth / spec.width, viewportHeight / spec.height);
  // 竖屏:min(w/744,h/1133) 等比居中;横屏:max(0.85, min(w/1180, h/820)),无上限
  const scale = mode === 'pad-landscape' ? Math.max(PAD_LANDSCAPE_MIN_SCALE, raw) : raw;
  return {
    mode,
    viewportWidth,
    viewportHeight,
    stageWidth: spec.width,
    stageHeight: spec.height,
    scale,
    offsetX: (viewportWidth - spec.width * scale) / 2,
    offsetY: (viewportHeight - spec.height * scale) / 2,
    cindy: spec.cindy,
    slogan: spec.slogan,
    word: spec.word,
    loginX: spec.loginX,
    loginY: spec.loginY,
    loginGroupScale: spec.loginGroupScale,
    splashOffset: spec.splashOffset,
    spinner: spec.spinner,
    phone: null,
  };
}

/** phone splash spinner 尺寸(demo msSpin 64×64,x=343 → 750 系居中)。 */
export const LOGIN_PHONE_SPLASH_SPINNER_SIZE = 64;

/**
 * 纯函数:物理 viewport → 登录 surface 构图(§3.6 断点 + 三构图布局统一出口)。
 * phone 分支复用 resolveLoginStage 两档插值;splash 簇偏移 = demo phoneStage
 * off = round((designHeight - cindy.h)/2 - cindy.y),spinner 居字标下方 44。
 */
export function resolveLoginSurface(
  viewportWidth: number,
  viewportHeight: number,
): LoginSurfaceLayout {
  const mode = resolveLoginSurfaceMode(viewportWidth, viewportHeight);
  if (mode === 'pad-portrait') {
    return padSurface(mode, LOGIN_PAD_PORTRAIT_STAGE, viewportWidth, viewportHeight);
  }
  if (mode === 'pad-landscape') {
    return padSurface(mode, LOGIN_PAD_LANDSCAPE_STAGE, viewportWidth, viewportHeight);
  }
  const stage = resolveLoginStage(viewportWidth, viewportHeight);
  const splashOffset = Math.round(
    (stage.designHeight - stage.cindy.h) / 2 - stage.cindy.y,
  );
  return {
    mode,
    viewportWidth,
    viewportHeight,
    stageWidth: LOGIN_STAGE_WIDTH,
    stageHeight: stage.designHeight,
    scale: stage.scale,
    offsetX: 0,
    offsetY: 0,
    cindy: stage.cindy,
    slogan: stage.slogan,
    word: stage.word,
    loginX: LOGIN_GROUP.x,
    loginY: stage.loginY,
    loginGroupScale: 1,
    splashOffset,
    spinner: {
      x: 343,
      y: Math.round(stage.word.y + stage.word.h + splashOffset + 44),
      size: LOGIN_PHONE_SPLASH_SPINNER_SIZE,
    },
    phone: stage,
  };
}

/* ── 面板内组件几何(figma §4/§5.1,750 设计 px;与桌面 loginDesignTokens 同源。
      键名刻意用 font/radius 而非 fontSize/borderRadius:这些是设计稿几何数据,
      不是样式声明,同时避开 typography/design token 守护测试的字面量扫描。) ── */

/** Log_in 组(demo loginGroup(35, loginY, 1, "mobile"):x=35,680×560)。 */
export const LOGIN_GROUP = { x: 35, width: 680, height: 560 } as const;
/** 标题(figma §5.1:y=31 h=38 32 Bold 居中)。 */
export const LOGIN_TITLE = { y: 31, height: 38, font: 32 } as const;
/** 副标题(figma §5.1:x=41 y=75 w=599 20 Regular 居中)。 */
export const LOGIN_SUBTITLE = { x: 41, y: 75, width: 599, height: 23, font: 20 } as const;
/** 输入/主按钮(figma §4.1/§4.3:540×80 r40;文本 x=31 §4.1)。 */
export const LOGIN_CONTROL = {
  x: 70,
  inputY: 158,
  buttonY: 300,
  width: 540,
  height: 80,
  radius: 40,
  font: 24,
  textPadLeft: 31,
} as const;
/** 主按钮 loading spinner(247:1546:24×24 @(487,27))。 */
export const LOGIN_SPINNER = { size: 24, x: 487, y: 27 } as const;
/** 第三方圆钮行(figma §4.5:y=480(面板 440+gap 40)、80×80 r50、icon 48、gap 70)。 */
export const LOGIN_SOCIAL = { y: 480, size: 80, gap: 70, icon: 48 } as const;
/** 返回按钮(figma §4.6:@(20,20) 60×60 r40)。 */
export const LOGIN_BACK = { x: 20, y: 20, size: 60, radius: 40, icon: 24 } as const;
/** 错误提示:占满主按钮底(380)→面板底(440)整段,文案在段内垂直居中(2026-07-24 拍板)。 */
export const LOGIN_ERROR_TEXT = { y: 380, width: 680, height: 60, font: 20 } as const;
/**
 * 方式行(figma §4.9 + demo method-row:540×100 r60;标题 24 Bold/副行 20 左对齐 x=67;
 * 左 icon 24 box @(27,37)/person 18×20 @(30,39);右 share 18 @(490,40);
 * 行起点:邮箱 discovery 来源 158 / sso-org 入口来源 148,行距 120——demo 呈现仲裁)。
 */
export const LOGIN_METHOD_ROW = {
  x: 70,
  width: 540,
  height: 100,
  radius: 60,
  textX: 67,
  textWidth: 409,
  titleFont: 24,
  subtitleFont: 20,
  leftIcon: { x: 27, y: 37, size: 24 },
  personIcon: { x: 30, y: 39, width: 18, height: 20 },
  rightIcon: { x: 490, y: 40, size: 18 },
  firstRowTopDefault: 158,
  firstRowTopSsoOrg: 148,
  rowStep: 120,
} as const;
/** 大 loading 环(figma §5.2:64×64 @(308,158 browser / 193 preparing))。 */
export const LOGIN_LOADING_RING = { x: 308, yBrowser: 158, yPreparing: 193, size: 64 } as const;
/** Text_link / 倒计时(figma §4.7:@(70,238) 540×50 20)。 */
export const LOGIN_TEXT_LINK = { x: 70, y: 238, width: 540, height: 50, font: 20 } as const;

// 态叠层 / 浅底钮白描边 / loading 环底圈色:原 LOGIN_PRESSED_OVERLAY /
// LOGIN_INVERTED_BORDER / LOGIN_RING_TRACK 字面常量已随暗色实现 PR 并入
// `LoginSkinColors` 双态色板(overlayButtonPressed / overlayControlPressed /
// invertedButtonBorder / loadingRingTrack,@/theme/tokens loginPalettes)——
// 叠层方向随 light/dark 反转,单值字面量无法承载,消费一律走 colors.login.*。

/** disabled 态文字不透明度(figma §4.3 disable 态文字 80%)。 */
export const LOGIN_DISABLED_TEXT_OPACITY = 0.8;

/* ── 42s 倒计时纯函数(implementation-plan Step 3a 契约,v5 冻结显示数学) ── */

/** 双端拍板 42s(figma §4.7 `42 秒后可重新发送` 247:1614)。 */
export const RESEND_COUNTDOWN_SECONDS = 42;
/** tick 周期 1000ms(每 tick 重算,非递减计数)。 */
export const RESEND_COUNTDOWN_TICK_MS = 1000;

/** 起算:request-code 成功返回时刻 → 绝对 deadline(系统休眠/挂起恢复自校正)。 */
export function createResendDeadline(now: number): number {
  return now + RESEND_COUNTDOWN_SECONDS * 1000;
}

/** 显示数学(v5 冻结):remaining = max(0, ceil((deadline - now)/1000));首帧显示 42。 */
export function resendCountdownRemaining(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** 倒计时模板渲染:「{n} 秒后可重新发送」的 {n} 占位替换(catalog 5 语共用)。 */
export function formatResendCountdown(template: string, remaining: number): string {
  return template.replace('{n}', String(remaining));
}
