/**
 * loginDesignTokens.ts — 登录皮肤布局常量 + 颜色消费单点。
 *
 * 尺寸常量:token-decision-table.md §4 指定落点(desktop renderer 本文件);
 * 数值权威 = figma-component-spec.md §4/§5.1(带 nodeId)+ demo 呈现仲裁
 * (id-tabs 几何、Slogan 位移等设计稿未单列项)。
 *
 * 颜色:全部经 CSS var 消费(规则 16,组件内禁 raw hex)。本对象是登录组件
 * 取色的唯一入口——token 注册在 themes/colors.ts(wave4 组 PR0a;组件色组
 * PR1,token-decision-table §3)。
 */

/** 桌面画布(figma §5.1,1819×2098)。 */
export const STAGE = { width: 1819, height: 2098 } as const;

/** 五要素绝对定位(figma §5.1 + wave4 §8.1)。 */
export const HERO = { x: 443, y: 275, size: 934 } as const; // 347:971 立绘
export const WORDMARK = {
  // 容器 680×180 @(570,1029);wave4 黑红位图内层 423×145 @(128,17) → 绝对 (698,1046)
  frame: { x: 570, y: 1029, width: 680, height: 180 },
  inner: { x: 698, y: 1046, width: 423, height: 145 }, // 368:1381
} as const;
export const SLOGAN = {
  // 外框 460×134 @(1191,863),vector 453.22×129.12 @(3,3) → 绝对 (1194,866);368:1394
  x: 1194,
  y: 866,
  width: 453.22,
  height: 129.12,
} as const;

/** 登录整体组(figma §5.1:x=570;sso-org 族 y=1227,其余 1229——demo loginY())。 */
export const LOGIN_GROUP = {
  x: 570,
  yDefault: 1229,
  ySsoOrg: 1227,
  width: 680,
  height: 560,
} as const;

/**
 * 登录面板下方的本地模式操作区。
 *
 * 这块区域不再脱离登录 stage 固定在窗口底部：stage 会为它预留空间，避免小窗口
 * 中与第三方登录圆钮重叠。reservedHeight 包含 stage 与操作区间距、两行文案的
 * 最大高度，以及窗口底部安全边距。
 */
export const LOGIN_LOCAL_MODE = {
  gap: 16,
  reservedHeight: 124,
  descriptionLineHeight: 18,
} as const;

/** 面板与面板内组件几何(figma §5.1/§4;wave4 面板描边 1px inside 368:1383)。 */
export const PANEL = { width: 680, height: 440, radius: 36 } as const;
export const TITLE = { y: 31, height: 38, fontSize: 32 } as const;
/** 副标题:540@70 ≤2 行顶对齐,槽高 = 行高 × 最大行数(DESIGN.md §16.2,2026-07-24 拍板)。 */
export const SUBTITLE = { x: 70, y: 75, width: 540, fontSize: 20, lineHeight: 23, maxLines: 2 } as const;
/**
 * Global 徽标(figma §4.10 胶囊 70×30 r40)。v2 inline 组方案(用户裁定 2026-07-25):
 * 标题文字 shrink-to-fit 单行 + 徽标紧随其后 gap 2 设计px,组整体相对面板水平居中——
 * 修复旧固定跨度方案(标题 span 固定 236 @185 + 徽标绝对 @425)在 en/ja/ko 下
 * 标题与徽标重叠的问题;GLOBAL_TITLE_SPAN 随之废弃删除。
 */
export const GLOBAL_PILL = { width: 70, height: 30, radius: 40, gap: 2 } as const;
export const CONTROL = {
  x: 70,
  inputY: 158,
  buttonY: 300,
  width: 540,
  height: 80,
  radius: 40,
  fontSize: 24,
  textPadLeft: 31, // §4.1 文本 x=31
} as const;
export const SPINNER = { size: 24, x: 487, y: 27 } as const; // 247:1546 @load
export const SOCIAL = { y: 480, size: 80, gap: 70, radius: 50, iconSize: 48 } as const; // §4.5
export const BACK = { x: 20, y: 20, size: 60, radius: 40 } as const; // §4.6
// 错误提示:占满主按钮底(380)→面板底(440)整段,文案垂直居中(2026-07-24 拍板;原 h50 偏上)
export const ERROR_TEXT = { y: 380, width: 680, height: 60, fontSize: 20 } as const;
export const METHOD_ROW = {
  x: 70,
  width: 540,
  height: 100,
  radius: 60,
  textX: 67,
  textWidth: 409,
  leftIcon: { x: 27, y: 37, size: 24 },
  personIcon: { x: 30, y: 39, width: 18, height: 20 },
  rightIcon: { x: 490, y: 40, size: 18 },
} as const; // §4.9 + demo method-row
export const LOADING_RING = { x: 308, yBrowser: 158, yPreparing: 193, size: 64 } as const; // §5.2
export const TEXT_LINK = { x: 70, y: 238, width: 540, height: 50, fontSize: 20 } as const; // §4.7
/** sso-org 帮助行:顶对齐 ≤2 行,y=输入框底 238+6,两行至 290 < 主按钮 300(DESIGN.md §16.2 折行分级 2)。 */
export const SSO_ORG_HINT = { x: 70, y: 244, width: 540, fontSize: 20, lineHeight: 23, maxLines: 2 } as const;

/**
 * 协议同意行(figma 600:660「服务条款」行:680×40,radio 24 @x156 + 文字 20 @x186.5)。
 * 行顶相对登录组顶 = 帧内 y1811 - 组 y1229 = 582(即组底 560 下方 22 设计px);
 * 行内容(radio + 声明文字)水平居中,radio 与文字间距 = 186.5 - (156+24) = 6.5。
 * 文字宽随语言变化,落码用 flex 居中而非固定 x(几何语义与稿等价)。
 */
export const CONSENT_ROW = {
  y: 582,
  width: 680,
  height: 40,
  gap: 6.5,
  fontSize: 20,
  radio: {
    /** 命中区 24×24;圈体 20×20 @(2,2) r9 + 2px 描边(600:626) */
    hitSize: 24,
    ringSize: 20,
    ringRadius: 9,
    ringStroke: 2,
  },
} as const;

/**
 * 服务条款弹窗(figma 602:822 Log_in_bg 680×380 r36;标题 Bold 32 @y31;
 * 正文 26/40 @(41,122) w599;两钮 260×80 r40 @y260:不同意 x70 / 同意 x350)。
 * 面板复用 login-panel-bg/border;同意钮 = login-primary-button-*;
 * 不同意钮 = login-secondary-button-*(wave5 双色小按钮)。
 */
export const CONSENT_DIALOG = {
  width: 680,
  height: 380,
  radius: 36,
  title: { y: 31, height: 38, fontSize: 32 },
  body: { x: 41, y: 122, width: 599, fontSize: 26, lineHeight: 40 },
  button: { y: 260, width: 260, height: 80, radius: 40, fontSize: 24, disagreeX: 70, agreeX: 350 },
} as const;

/** 顶部拖拽条 overlay 高度(附录 C §1.4 条4 工程定案:46px 独立层,不占文档流)。 */
export const DRAG_BAR_HEIGHT = 46;

/** 验证码重发倒计时时长(Step 3a 契约:双端 42s,绝对 deadline 模型)。 */
export const RESEND_COUNTDOWN_MS = 42_000;

/**
 * Splash 统一面板(wave4 五帧 379:581/525/607/633/655 实测,figma §10.3;
 * design.md §8.1 条 5)。面板本体 = 登录同款白面板(680×440 r36 @570,1229,
 * PANEL/LOGIN_GROUP 复用);以下为面板内 Splash 专属元素几何(面板内坐标)。
 */
export const SPLASH_PANEL = {
  /** spinner 64×64 @面板内(308,188),内弧 #6F6F6F(login-secondary-text) */
  spinner: { x: 308, y: 188, size: 64 },
  /** 更新/下载进度条 轨 501×16 r12 @(90,346)(379:580) */
  progress: { x: 90, y: 346, width: 501, height: 16, radius: 12 },
  /** 明细行 20px Regular @(41,375) 599×23(379:574,与副文案同栏宽居中) */
  stats: { x: 41, y: 375, width: 599, height: 23, fontSize: 20 },
} as const;

/**
 * 颜色消费单点(CSS var 引用;注册见 themes/colors.ts)。
 * wave4 组 = PR0a;组件色组 = PR1 按 token-decision-table §3 注册。
 */
export const LOGIN_COLORS = {
  /** 白底体系底色(固定 #EDEDED 与主题解耦,用户拍板 2026-07-22;login-bg-base) */
  bgBase: 'var(--login-bg-base)',
  gradientRadial: 'var(--login-bg-gradient-radial)',
  gradientLinear: 'var(--login-bg-gradient-linear)',
  panelBg: 'var(--login-panel-bg)',
  panelBorder: 'var(--login-panel-border)',
  controlBg: 'var(--login-control-bg)',
  /** 方式行/返回钮底(暗色与输入框底分化,figma 549:850/549:897;色值见 themes/colors.ts) */
  actionControlBg: 'var(--login-action-control-bg)',
  /** 返回钮描边(亮白/暗深灰,figma 549:897;色值见 themes/colors.ts) */
  backBorder: 'var(--login-back-border)',
  controlBorder: 'var(--login-control-border)',
  controlBorderActive: 'var(--login-control-border-active)',
  controlBorderDisabled: 'var(--login-control-border-disabled)',
  controlText: 'var(--login-control-text)',
  controlPlaceholder: 'var(--login-control-placeholder)',
  titleText: 'var(--login-title-text)',
  secondaryText: 'var(--login-secondary-text)',
  primaryButtonBg: 'var(--login-primary-button-bg)',
  primaryButtonBorder: 'var(--login-primary-button-border)',
  primaryButtonText: 'var(--login-primary-button-text)',
  disabledOverlay: 'var(--login-disabled-button-overlay)',
  /** disabled 主按钮底/字(两模式同构深底浅字,暗色不反相;figma Disable 态) */
  disabledButtonBg: 'var(--login-disabled-button-bg)',
  disabledButtonText: 'var(--login-disabled-button-text)',
  invertedButtonBorder: 'var(--login-inverted-button-border)',
  errorFg: 'var(--login-error-fg)',
  brandAccent: 'var(--login-brand-accent)',
  linkText: 'var(--login-link-text)',
  /**
   * Text_link pressed/hover(figma §4.7:pressed U-9 裁决 #1A1818;hover wave3
   * 实测 358:792,lead 裁决 2026-07-20 决策表滞后修订追加)。伪类态无法走 inline
   * style,实际消费在 LoginControls LoginTextLink 的 hover:/active: 类字面量
   * (引用同名 CSS var);此两键保留作 token 登记锚与非伪类场景入口。
   */
  linkPressed: 'var(--login-link-pressed)',
  /** Splash 统一面板进度条(PR2b 新增 component alias,权威 = wave4 379:525/§8.1) */
  splashProgressTrack: 'var(--login-splash-progress-track)',
  splashProgressFill: 'var(--login-splash-progress-fill)',
  linkHover: 'var(--login-link-hover)',
  /**
   * Apple 登录圆钮底(App Store Guideline 4:亮 = ADR Black button 黑圆白标 /
   * 暗 = ADR White button 白圆黑标,无描边;用户标准图 2026-07-24)
   */
  appleCircleBg: 'var(--login-apple-circle-bg)',
  /** 协议同意族(consent PR:radio 四态 + 弹窗遮罩 + 次级小按钮;figma wave5) */
  consentRadioBg: 'var(--login-consent-radio-bg)',
  consentRadioBorder: 'var(--login-consent-radio-border)',
  consentRadioCheckedBg: 'var(--login-consent-radio-checked-bg)',
  consentRadioCheck: 'var(--login-consent-radio-check)',
  consentOverlay: 'var(--login-consent-overlay)',
  secondaryButtonBg: 'var(--login-secondary-button-bg)',
  secondaryButtonBorder: 'var(--login-secondary-button-border)',
  secondaryButtonText: 'var(--login-secondary-button-text)',
} as const;
