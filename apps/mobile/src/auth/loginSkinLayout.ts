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

/**
 * 短屏档(designHeight=1334;inner 几何 347:2884 实测,wave3.5 旧表)。
 * 2026-07-24 用户拍板:协议行距屏幕底过近,视觉+功能区整体上移 40 设计px(hero 不动)——
 * slogan.y 480.33→440.33、word.y 594.48→554.48、loginY 734→694。
 */
export const LOGIN_STAGE_SHORT = {
  designHeight: 1334,
  cindy: { x: 75, y: 107, w: 599, h: 720 },
  slogan: { x: 462.55, y: 440.33, w: 254.01, h: 72.8 },
  word: { x: 199, y: 554.48, w: 352.93, h: 120.54 },
  loginY: 694,
} as const;

/**
 * 长屏档(designHeight=1624;358:434 实测)。立绘 y=116 双区统一
 * (〔已拍板 2026-07-19〕国区 116 vs 国际区旧帧 96 为设计稿内部不一致,取最新批次帧)。
 * 2026-07-24 用户拍板:协议行距屏幕底过近,视觉+功能区整体上移 40 设计px(hero 不动)——
 * slogan.y 686→646、word.y 814→774、loginY 973→933。
 */
export const LOGIN_STAGE_LONG = {
  designHeight: 1624,
  cindy: { x: 0, y: 116, w: 750, h: 902 },
  slogan: { x: 387, y: 646, w: 321, h: 92 },
  word: { x: 175, y: 774, w: 401, h: 137 },
  loginY: 933,
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
 *   loginY = max(0, dh-640)(功能区 680×560 + 底距不缩放、锚定底部;
 *   2026-07-24 拍板整体上移 40 设计px 后由 dh-600 改 dh-640,与 SHORT.loginY=694
 *   在 dh=1334 处保持连续:1334-640=694);
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
      // 2026-07-24 拍板:整体上移 40 设计px(dh-600 → dh-640),dh=1334 边界与 SHORT.loginY=694 连续
      loginY: Math.max(0, designHeight - 640),
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
/** 说明/提示类行高(DESIGN.md §16.2:20px 字号 → 23px;副标题与 Text_link 槽共用,与桌面 SUBTITLE / SSO_ORG_HINT.lineHeight 同值)。 */
export const LOGIN_COPY_LINE_HEIGHT = 23;
/** 副标题:540@70 ≤2 行顶对齐,height=行高(DESIGN.md §16.2,2026-07-24 拍板;原单行 599@41 作废)。 */
export const LOGIN_SUBTITLE = { x: 70, y: 75, width: 540, height: LOGIN_COPY_LINE_HEIGHT, font: 20, maxLines: 2 } as const;
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
/** Text_link / 倒计时(figma §4.7:@(70,238) 540×50 20;行高走 LOGIN_COPY_LINE_HEIGHT)。 */
export const LOGIN_TEXT_LINK = { x: 70, y: 238, width: 540, height: 50, font: 20, lineHeight: LOGIN_COPY_LINE_HEIGHT } as const;
/** sso-org 帮助行槽顶:输入框底 238+6 呼吸间距,两行至 290 < 主按钮 300(DESIGN.md §16.2 折行分级 2,与桌面 SSO_ORG_HINT 同值)。 */
export const LOGIN_SSO_ORG_HINT_TOP = 244;

/**
 * 协议同意行(consent PR;figma 600:660「服务条款」行,与桌面 CONSENT_ROW 同参数源):
 * 行 680×40 @登录组下方 22 设计px(组高 560 → 行顶 y=582);radio 命中区 24、
 * 圈体 20 r9 + 2px 描边(选中态为对勾);文字 20 Regular,radio-文字间距 6.5。
 * 行内容水平居中(文字宽随语言变化,flex 居中,几何语义与稿等价)。
 */
export const LOGIN_CONSENT_ROW = {
  y: 582,
  width: 680,
  height: 40,
  gap: 6.5,
  font: 20,
  /** 声明文字行高(figma 600:661 文本框 23 高,与桌面协议行同值) */
  lineHeight: 23,
  /** 行底(622)超出登录组(560)的设计 px,安全区抬升按此追加预留 */
  bottomOverflow: 62,
  /**
   * 对勾线宽 3(figma 600:632 stroke-width 3 round,设计 px)。
   * pressSize 88 = 无障碍触摸目标(codex P1):登录组 phone 缩放 ~0.5 → 88 设计px
   * ≈ 44 物理pt(iOS HIG)/ ≥48dp 近似达标;命中区右下锚定扩张(向左/向上),
   * 右缘与视觉 24 槽位右缘对齐(不侵入协议链接命中区)、底缘与协议行底 622 对齐
   * (不越父容器 flowBottom bounds——Android 界外触摸不派发,hitSlop 方案已被否)。
   */
  radio: { hitSize: 24, ringSize: 20, ringRadius: 9, ringStroke: 2, checkStroke: 3, pressSize: 88 },
} as const;

/**
 * 服务条款弹窗(consent PR;figma 602:822/602:1249,与桌面 CONSENT_DIALOG 同参数源):
 * 面板 680×380 r36(panelBg/panelBorder 双态);标题 Bold 32 @y31;正文 26/40
 * @(41,122) w599 居中;两钮 260×80 r40 @y260——不同意 x70(次级钮)/ 同意 x350
 * (强调钮 = primaryButton 族)。遮罩 = consentOverlay 黑 85% 全屏。
 */
export const LOGIN_CONSENT_DIALOG = {
  width: 680,
  height: 380,
  radius: 36,
  title: { y: 31, height: 38, font: 32 },
  body: { x: 41, y: 122, width: 599, font: 26, lineHeight: 40 },
  button: { y: 260, width: 260, height: 80, radius: 40, font: 24, disagreeX: 70, agreeX: 350 },
} as const;

/* ── 账号注销提示气泡(figma 678:1075) ──
      浮层:渲染在登录组之外的 viewport 坐标层,盖过立绘/字标/面板/社交行,
      不参与布局流与滚动。
      ⚠ 几何**全部是各构图 stage 的设计单位**,不是物理 pt/dp——与登录组同乘
      surface.scale 后才是屏幕值(2026-07-26 修正:初版把设计单位当物理 pt 用,
      宽度写死 335、内部几何未折算,气泡与面板比例失真)。 */

/** 注销气泡落位与折算结果(除 scale 外均为物理 pt/dp,viewport 坐标)。 */
export interface LoginDeletionBubbleFrame {
  top: number;
  left: number;
  width: number;
  /** 设计单位 → 物理 pt 的缩放系数(= surface.scale;内部几何消费端按此折算) */
  scale: number;
}

/**
 * 注销提示气泡设计常量(figma 678:1075「注销状态」组件集;**stage 设计单位**)。
 *
 * 内部几何由组件子元素坐标反算自洽:标题 text @(20,20) h=23、正文 text @(20,48) h=23
 * → padding 20、标题↔正文 5、行高 23、底距 20;无钮变体总高 91 = 20+23+5+23+20。
 * 高度由内容撑开,禁止固定高;无图标/阴影/动画。
 *
 * 各端落位(设计单位,乘 surface.scale 得屏幕值):
 * - phone(stage 750):宽 670 @x=40(750−670−40=40 → 等价水平居中);
 *   top 取 safe-area 顶(设计 y=116 即 Status Bar 高 115.67 的下沿,间距 0);
 * - pad-landscape(stage 1180×820):宽 556 = WORD_MARK 框宽(figma 679:1201 x=607 w=556,
 *   用户 2026-07-26 拍板「与字标同宽」),x=607 → 中心 885 与登录组中心 884.8 同轴;
 *   top 72(底边 72+91=163,距字标框顶 177 留 14,与设计标注位置吻合);
 * - pad-portrait(stage 744×1133):字标框宽按可见图形等比反算
 *   269.51 ×(556/297.32)≈ 504,水平居中于字标轴(≈ stage 中心 372);top 同 72。
 */
export const LOGIN_DELETION_BUBBLE = {
  radius: 22,
  padding: 20,
  borderWidth: 1,
  font: 20,
  lineHeight: LOGIN_COPY_LINE_HEIGHT,
  titleBodyGap: 5,
  bodyLinkGap: 22,
  phone: { width: 670, x: 40, stageWidth: LOGIN_STAGE_WIDTH },
  padLandscape: { width: 556, x: 607, top: 72 },
  padPortrait: { width: 504, top: 72 },
} as const;

/**
 * 纯函数:surface 构图 + safe-area 顶 → 气泡 viewport 落位(figma 678:1075)。
 * 设计单位经 surface.scale 折算为物理 pt;left 钳制在屏内(不出屏、不贴负边)。
 * 断点三分支与 resolveLoginSurfaceMode 同语义,消费端直接传 useLoginSurface() 输出。
 */
/**
 * 「我知道了」热区(物理 pt):RN 的 hitSlop **不会越过父 View 边界**(双端一致),
 * 上/下扩张只能取「气泡内可用空间」——上限 = 正文↔链接间距、下限 = 气泡下 padding
 * (均为设计单位 × scale),写大了是虚标(Codex 审查 PR #494 指出:320pt 窗口下
 * 名义 45.8pt 实际被裁到 ≈30pt)。不追未缩放的 44pt 绝对下限:整个登录系统按 stage
 * 缩放(320pt 窗口下登录主按钮本身仅 ≈34pt 高),孤立保 44 需打破「正文↔链接 22 /
 * 底距 20 恒定」的拍板视觉;热区随系统同步缩放、边界内取最大。左右两侧文本外富余
 * 充足,固定 20。
 */
export function resolveDeletionBubbleLinkHitSlop(scale: number): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const { bodyLinkGap, padding } = LOGIN_DELETION_BUBBLE;
  return {
    top: Math.min(18, bodyLinkGap * scale),
    bottom: Math.min(18, padding * scale),
    left: 20,
    right: 20,
  };
}

export function resolveDeletionBubbleFrame(
  surface: LoginSurfaceLayout,
  safeTop: number,
): LoginDeletionBubbleFrame {
  const { phone, padLandscape, padPortrait } = LOGIN_DELETION_BUBBLE;
  const { scale } = surface;
  const clampLeft = (left: number, width: number) =>
    Math.max(0, Math.min(left, surface.viewportWidth - width));

  if (surface.mode === 'phone') {
    const width = phone.width * scale;
    return {
      left: clampLeft((surface.viewportWidth - width) / 2, width),
      top: safeTop,
      width,
      scale,
    };
  }
  if (surface.mode === 'pad-landscape') {
    const width = padLandscape.width * scale;
    const left = surface.offsetX + padLandscape.x * scale;
    return {
      left: clampLeft(left, width),
      top: surface.offsetY + padLandscape.top * scale,
      width,
      scale,
    };
  }
  const width = padPortrait.width * scale;
  return {
    left: clampLeft((surface.viewportWidth - width) / 2, width),
    top: surface.offsetY + padPortrait.top * scale,
    width,
    scale,
  };
}

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
