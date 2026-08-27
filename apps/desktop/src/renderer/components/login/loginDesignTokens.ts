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

/**
 * 登录整体组(figma §5.1:x=570;sso-org 族 y=1227,其余 1229——demo loginY())。
 *
 * height = 面板 500 + gap 40 + 第三方圆钮 80 = 620(新稿 700:783;旧稿 560 = 面板 440
 * 时代)。面板增高 60 后组内面板外元素整体下移 60(SOCIAL.y 480→540、
 * CONSENT_ROW.y 582→642),组高随之 +60。
 */
export const LOGIN_GROUP = {
  x: 570,
  yDefault: 1229,
  ySsoOrg: 1227,
  width: 680,
  height: 620,
} as const;

/**
 * 注销状态提示气泡(figma 678:1075「注销状态」组件集;桌面实例 679:1172 落位于帧 678:750)。
 *
 * ⚠ 全部数值是 **1819×2098 设计画布单位(2x 稿)**,不是 CSS px——渲染时与登录组同乘
 * `PANEL_FIXED_SCALE`(=0.5),屏幕上得到宽 335 / 顶距 36 CSS px,与登录面板
 * (680×0.5=340)基本同宽,与设计稿里 670 vs 680 的关系一致。
 * (2026-07-26 修正:初版把这些设计单位当 CSS px 直接用,气泡在屏幕上宽了整一倍。)
 *
 * 内部几何由组件子元素坐标反算自洽:标题 text @(20,20) h=23、正文 text @(20,48) h=23
 * → padding 20、标题↔正文 5、行高 23、底距 20,无钮变体总高 91 = 20+23+5+23+20。
 */
export const LOGIN_DELETION_BUBBLE = {
  /** 距窗口顶固定间距(顶对齐,不随窗口高度变化;figma y=72) */
  top: 72,
  width: 670,
  radius: 22,
  padding: 20,
  font: 20,
  lineHeight: 23,
  titleBodyGap: 5,
  bodyLinkGap: 22,
  /** 「我知道了」热区上下 padding(视觉间距由等量负 margin 抵消) */
  linkHitPadding: 11,
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

/**
 * 面板与面板内组件几何(figma §5.1/§4;wave4 面板描边 1px inside 368:1383)。
 *
 * height 440 → 500(新稿三端一致 680×500:桌面 700:791 / 长屏 705:886 / 短屏 705:1062):
 * 增的 60 恰好是面板内新增的「跳过登录」容器高(SKIP_ENTRY),面板内其余元素
 * (标题 31 / 副标题 75 / 输入框 158 / 主按钮 300 / error 380)坐标一律不动。
 * 本常量供 LoginPage 全部步骤共用——面板高度在步骤间必须恒定,否则 identifier↔验证码
 * 等切换会出现 30 CSS px 的高度跳变(规则 7:杜绝视觉跳变);Splash 借用面板时不跟随
 * 500,见 SPLASH_PANEL.height。
 */
export const PANEL = { width: 680, height: 500, radius: 36 } as const;
export const TITLE = { y: 31, height: 38, fontSize: 32 } as const;
/** 副标题:540@70 ≤2 行顶对齐,槽高 = 行高 × 最大行数(DESIGN.md §16.2,2026-07-24 拍板)。 */
export const SUBTITLE = { x: 70, y: 75, width: 540, fontSize: 20, lineHeight: 23, maxLines: 2 } as const;
/**
 * 区域徽标(figma §4.10 胶囊 h30 r40)。v2 inline 组方案(用户裁定 2026-07-25):
 * 标题文字 shrink-to-fit 单行 + 徽标紧随其后 gap 2 设计px,组整体相对面板水平居中——
 * 修复旧固定跨度方案(标题 span 固定 236 @185 + 徽标绝对 @425)在 en/ja/ko 下
 * 标题与徽标重叠的问题;GLOBAL_TITLE_SPAN 随之废弃删除。
 *
 * 宽度自适应(2026-07-27 拍板):原 width 固定 70 是为 "Global" 一词量身定的。
 * 按「不对称命名」翻转后 global 版不再挂徽标(默认版本不必自证是全球版),徽标
 * 只服务 cn(CN)/dev(Dev),文案短得多,固定宽会在胶囊里留大片空白。改由 paddingX
 * 撑开:11 = 原几何反推((70 − "Global" 6 拉丁字符 @16 Bold ≈ 48) / 2),既保住
 * figma 的左右留白密度,又让胶囊跟随文案收窄。fontSize 一并从组件内硬编码收进
 * token(几何值单点,呼应 DESIGN.md §16.2「几何常量固化在常量文件」)。
 */
export const REGION_PILL = { height: 30, radius: 40, gap: 2, paddingX: 11, fontSize: 16 } as const;
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
// §4.5;y 480 → 540(面板 440→500,圆钮行距面板底恒 40:新稿容器 y=540)
export const SOCIAL = { y: 540, size: 80, gap: 70, radius: 50, iconSize: 48 } as const;
export const BACK = { x: 20, y: 20, size: 60, radius: 40 } as const; // §4.6
/**
 * 错误提示:占满主按钮底(380)→「跳过登录」容器顶(430)整段,文案垂直居中。
 * 新稿 error_text 容器 680×50 @y380(705:1067),y 不因面板增高/新增跳过入口而移动;
 * 高度回到 50(2026-07-24 的 h60「占满到面板底」是面板 440 时代的等价写法)。
 * 与 SKIP_ENTRY 首尾相接、同时可见互不重叠(文案视觉间距 ≈30 设计px)。
 */
export const ERROR_TEXT = { y: 380, width: 680, height: 50, fontSize: 20 } as const;
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
/**
 * 「跳过登录」文字**按钮**(新稿容器 705:1068 / 700:910:面板内 680×60 @y430;
 * 文本 96×29 @(292,15) Regular 24 下划线,水平+垂直居中——文本中心 340 = 容器中心)。
 * 组件 = LoginSkipEntry(**不是** LoginTextLink:文字按钮与文字链接是两种组件,
 * 前者不做 hover/pressed 变色;用户拍板 2026-07-27)。
 *
 * 槽位 430..490,面板底余 10(= 500 - 490,新稿下内边距);上接 ERROR_TEXT(380..430),
 * 两者同时可见时首尾相接不重叠。字号取稿值 24(≠ TEXT_LINK 的 20,故单列常量);
 * 颜色走 --login-secondary-text(#6F6F6F 双模同值,与稿一致)。
 *
 * width 680 / height 60 是**布局容器**,容器自身不可点;hitPaddingX = 可点区在实际
 * 文字渲染宽度基础上左右各扩的设计px(热区随语言自适应,zh 4 字与 en「Skip Sign-In」
 * 宽度不同;用户拍板 2026-07-27)。
 */
export const SKIP_ENTRY = {
  x: 0,
  y: 430,
  width: 680,
  height: 60,
  fontSize: 24,
  hitPaddingX: 30,
} as const;
/** sso-org 帮助行:顶对齐 ≤2 行,y=输入框底 238+6,两行至 290 < 主按钮 300(DESIGN.md §16.2 折行分级 2)。 */
export const SSO_ORG_HINT = { x: 70, y: 244, width: 540, fontSize: 20, lineHeight: 23, maxLines: 2 } as const;
/**
 * 最近组织浮层：紧贴输入框下沿并与输入框等宽，作为浮层覆盖后续提示与主按钮。
 * 它与输入框同处登录组坐标系，因此大小窗口共享同一个锚点与缩放，不再依赖
 * 面板下方是否还有视口空间。最大高度收在面板内，88 设计px 的最小行高经
 * 0.5 桌面缩放后得到 44px 可点击行，其余条目在无可见滚动条的自身滚动区内访问。
 */
export const SSO_ORG_HISTORY = {
  x: CONTROL.x,
  y: CONTROL.inputY + CONTROL.height + 8,
  width: CONTROL.width,
  maxHeight: PANEL.height - (CONTROL.inputY + CONTROL.height + 8) - 10,
  rowMinHeight: 88,
  radius: 22,
  rowRadius: 16,
  fontSize: 20,
  lineHeight: 23,
  paddingX: CONTROL.textPadLeft,
  paddingY: 16,
} as const;

/**
 * 协议同意行(figma 600:660「服务条款」行:680×40,radio 24 @x156 + 文字 20 @x186.5)。
 * 行顶相对登录组顶 = 642(新稿 700:807 帧内 y1871 - 组 y1229;即组底 620 下方 22 设计px,
 * 面板 440→500 后整行随组下移 60,与圆钮行的 22 间距不变);
 * 行内容(radio + 声明文字)水平居中,radio 与文字间距 = 186.5 - (156+24) = 6.5。
 * 文字宽随语言变化,落码用 flex 居中而非固定 x(几何语义与稿等价)。
 */
export const CONSENT_ROW = {
  y: 642,
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
 * design.md §8.1 条 5)。面板本体 = 登录同款白面板(680×440 r36 @570,1229,复用
 * LoginPanel 组件 + LOGIN_GROUP 落位,高度自持见下);以下为面板内 Splash 专属元素
 * 几何(面板内坐标)。
 */
export const SPLASH_PANEL = {
  /**
   * 面板高度 440:**不跟随登录面板的 500**。登录面板增的 60 只为承载面板内的
   * 「跳过登录」入口(SKIP_ENTRY),Splash 五帧没有该入口、设计稿也未改版,跟随会
   * 在启动态凭空多出 50 CSS px 空白。Splash 与登录面板不同 stage、不同缩放
   * (desktopScale vs PANEL_FIXED_SCALE),尺寸本就不重合,拆开不破坏 handoff 连续性。
   */
  height: 440,
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
