/**
 * 设计 token —— 移动端唯一颜色 / 尺寸真相源。
 *
 * 本文件**刻意不依赖 react-native**(便于 node 环境单测直接 import 校验调色板 / 阶梯)。
 * 需要 Platform 的 `monoFont` 单独放在 `./monoFont.ts`;消费 token 统一从 `@/theme` barrel 取。
 *
 * 颜色分两层:
 *  - `ThemeColors`:随 light / dark 切换的色板(见 lightColors / darkColors),组件通过
 *    `useTheme().colors` 或 `useThemedStyles(makeStyles)` 消费,**永远写 token 不写 hex**。
 *  - spacing / radius / typeScale / lineHeight / fontWeight / iconSize:主题无关的不变量阶梯。
 *
 * 底色 / 字色 / 描边为移动端独立色板(2026-09-26 用户定稿):共享 Cindy 品牌与业务语义,
 * 色阶与对比度由移动端自定(DESIGN.md §15.13)。浅色为象牙白、正文保持中性;深色为纯中性
 * 近黑。品牌红、状态色、任务标签、语法高亮、登录皮肤与开屏不在此列,仍按各自登记值。
 */

export type ThemeMode = 'light' | 'dark';

/** 随主题切换的颜色 token。light / dark 必须有完全一致的 key 集合。 */
export interface ThemeColors {
  taskTagRed: string;
  taskTagOrange: string;
  taskTagYellow: string;
  taskTagGreen: string;
  taskTagBlue: string;
  taskTagPurple: string;
  taskTagGray: string;
  taskTagPink: string;
  taskTagCoral: string;
  taskTagTeal: string;
  taskTagIndigo: string;
  taskTagWhite: string;
  taskTagWhiteCheck: string;

  /** 页面 Surface 背景 */
  surface: string;
  /** 抬一层的 Card / 弹窗 / 输入框 */
  surfaceElevated: string;
  /** Surface 半透明(吸顶栏等,solid 非模糊——chrome/composer 热路径专用,守护测试禁 BlurView) */
  surfaceTranslucent: string;
  /** 侧栏/抽屉类面板毛玻璃底色(R1 audit 模式1,blur≈50 等效;BlurView tint 用) */
  surfaceTranslucentSidebar: string;
  /** Chat 顶栏玻璃底色(M3:只给会话页顶部 chrome,不污染侧栏 / sheet) */
  chatHeaderSurface: string;
  /** Chat 顶栏底部分割线(M3:dark 为极弱白线) */
  chatHeaderDivider: string;
  /** 浮层卡 sheet surface 底色(R1 audit 模式3,solid 玻璃感由 backdrop blur 承担,surface 不叠 blur 规避 Android 滚动热路径) */
  surfaceGlassPanel: string;
  /** List 行/任务行专用底色(不污染 chat code card / elevated surface) */
  surfaceListRow: string;
  /** List 展开项目 block 专用底色 */
  surfaceListExpanded: string;
  /** List 行首品牌箭头 active 小图形色(非按钮红) */
  activeGlyph: string;
  /** Chat / task code card 专用底色 */
  chatCodeSurface: string;
  /** Chat / task code card 专用描边 */
  chatCodeBorder: string;
  /**
   * markdown 行内 code 文字色 —— 移动端走「零底色 + 文字压暗」形态(参照 Codex
   * 客户端)。**与桌面刻意不同**:桌面是 CSS,按 GitHub 的半透明淡底 + 6px 圆角实现
   * (--msg-md-inline-code-bg);移动端聊天流是 RN 嵌套 Text,只认 backgroundColor 不认
   * borderRadius,淡底在那边只能是直角方块,成段中文里一排方块比没有底色更糟。
   * 两端不同是结论,不是漏改 —— 改这里之前先看这条。
   *
   * 取值(见 themeTokens.test.ts):两模式都取 textTertiary —— light #686864 对 surface
   * 5.31:1,dark #999999 对 surface 6.58:1,都过 AA 且明显比正文浅,压暗可辨。
   * 刻意**不**复用 textSecondary:二级文字(#4D4D4A / #BDBDBD)离正文太近,标识符看不出压暗。
   */
  chatInlineCodeText: string;
  /**
   * 代码高亮语法色(6 档)。色值对齐桌面端所用的 GitHub highlight.js 主题
   * (light = `highlight.js/styles/github.css`,dark = globals.css 里的 GitHub Dark
   * 覆盖),两端观感一致。移动端不引入 highlight.js —— 依赖会改 runtime
   * fingerprint 触发冷更,词法分析走仓内 `session/codeHighlight.ts`。
   * 这 6 档是语义豁免色(语法着色本身就是彩色),不受黑白系约束。
   */
  syntaxKeyword: string;
  syntaxString: string;
  syntaxComment: string;
  syntaxNumber: string;
  syntaxFunction: string;
  /** 属性名 / 字段名(hljs 的 attr;GitHub 主题里与 number 同色)。 */
  syntaxProperty: string;
  /** Composer / input focus caret。二次改稿 2026-07-18 晚:撤红改蓝,对齐 Mac caret-accent */
  inputCaret: string;
  /** Bottom sheet root 玻璃面 */
  sheetSurface: string;
  /** Bottom sheet action group / row 面 */
  sheetActionSurface: string;
  /** Bottom sheet action group / row 描边 */
  sheetActionBorder: string;
  /** Bottom sheet action row 正文色 */
  sheetActionText: string;
  /** Bottom sheet / composer grabber 色 */
  sheetGrabber: string;
  /** App 内品牌 splash 背景红(仅限 splash,不进入普通 CTA 红名单) */
  brandSplashBackground: string;
  /** App 内品牌 splash 前景白(logo/script/loading) */
  brandSplashForeground: string;
  /** App 内品牌 splash 二级文案 */
  brandSplashMuted: string;
  /** Beta 测试渠道已开启徽标红底(用户指定,跨主题不变) */
  betaChannelBadgeBackground: string;
  /** Beta 测试渠道已开启徽标白字(与红底对比度 4.98:1) */
  betaChannelBadgeForeground: string;
  /** Chip / pill / 选中行填充 */
  surfaceChip: string;
  /** 1px 分隔线 / 边框(桌面 Board) */
  border: string;
  /** 半透明边框 */
  borderTranslucent: string;
  /** 强调边框 / 次要图标点 */
  borderStrong: string;
  /** 主标题 / 主正文 */
  textPrimary: string;
  /** 次要文字 / 图标 */
  textSecondary: string;
  /** 三级文字 / placeholder / metadata */
  textTertiary: string;
  /** CTA / 主操作填充 —— 中性反相(常规按钮非红;红只留警告/报错。用户红色新规 2026-07-17,取代 U3+U8 全态红契约) */
  cta: string;
  /** CTA 上的文字 */
  ctaText: string;
  /** 就绪 / 在线状态点(品牌 teal,语义不变) */
  statusReady: string;
  /**
   * 录音中状态指示红(#D91F37,与 statusError 同值、对齐桌面;区分「停止录音」与中性色的
   * 「停止任务」)。红色系分工:状态指示(点/波形)用 statusError / statusRecording;
   * 破坏性按钮文字用 destructive;错误说明文案用 errorText(黑白系)。
   */
  statusRecording: string;
  /** 运行 / thinking 强调 + 完全访问权限(Heart Orange,语义不变) */
  statusAccent: string;
  /** 房主皇冠标识金色；与 Desktop --warning-fg 对齐，Light / Dark 均保持醒目。 */
  warningFg: string;
  /** 会话状态点 — 等待用户回复/选择(TapTap 蓝,对齐桌面 --card-status-awaiting 与灵动岛 needs-interaction) */
  statusAwaiting: string;
  /**
   * 会话状态点 — 任务出错(状态指示红 #D91F37,对齐桌面 --card-status-error;红专职表示出错)。
   * 仅用于状态指示(状态点/徽标),不用于按钮文字(那是 destructive)也不用于成段错误文案
   * (那是 errorText,黑白系)。
   */
  statusError: string;
  /** 会话状态点 — 完成未读(绿,对齐桌面 --card-status-done;橙专职 running) */
  statusDone: string;
  /** 自动审批权限模式强调色(Auto Approval 蓝 #417CDD,L=D 同值,设计定稿 2026-07-17;取代 M2 的 #1D4ED8/#19D2C1 拆值) */
  permAutoAccent: string;
  /**
   * 错误说明文案的黑白系前景 —— **刻意跟随 textPrimary,不是红色**(黑白反色设计里成段
   * 错误文案不点红,错误语义由文案与上下文承担;"error" 是历史命名)。勿用于按钮文字
   * (破坏性按钮用 destructive)、勿用于状态指示(用 statusError / statusRecording)。
   */
  errorText: string;
  /**
   * 破坏性操作按钮(退出登录/删除等)的**文字红**(#f43d3f),跨主题一致。只上按钮/菜单项
   * 文字;状态指示红是另一档 #D91F37(statusError / statusRecording),不要混用。
   */
  destructive: string;
  /** Shared-task plan B destructive confirmation fill / label (approved 2026-09-20). */
  sharedTaskConfirmBackground: string;
  sharedTaskConfirmForeground: string;
  /** 错误边框(跟随 borderStrong) */
  errorBorder: string;
  /**
   * Modal / sheet scrim 遮罩底色(双模式恒深——LIGHT 模式也用深色遮罩,不跟主题变浅;
   * 用户定稿 2026-07-21)。BlurBackdrop scrim 叠层与各 sheet 背板统一消费。
   * 注意:侧栏/抽屉毛玻璃底色另有 surfaceTranslucentSidebar(light 近白),不受本 token 影响。
   */
  overlay: string;
  /** 素雅新建对话 FAB:dark 用柔白 #E6E6E6 而非 cta 近白,避免主入口在深底上过跳 */
  homeListFab: string;
  /** List FAB 描边:light 无描边(transparent),dark 按 301:1073 帧白色 hairline */
  homeListFabBorder: string;
  /** 会话行右滑「置顶/取消置顶」按钮底色(Heart Orange,与 statusAccent 同值但语义独立) */
  swipeActionPin: string;
  /** 会话行左滑「选项」按钮底色(iOS systemGray 感的中性灰) */
  swipeActionNeutral: string;
  /** 会话行左滑「归档」按钮底色(iOS 系统蓝;不用 statusAwaiting 青——其上白字对比不足) */
  swipeActionArchive: string;
  /** swipe 按钮上的文字/图标色:两个主题都是白(按钮底色恒为深色系,不能用会反相的 ctaText) */
  swipeActionText: string;
  /** 登录皮肤色板(light/dark 二态;暗色实现 PR 起随主题切换,见 LoginSkinColors) */
  login: LoginSkinColors;
}

/**
 * 登录皮肤色板(light/dark 二态)。
 *
 * 暗色实现 PR 前提变更:原「跨 light/dark 恒定」已废(DESIGN.md §16.2 决策记录
 * 2026-07-23),登录皮随基础 light/dark 二态切换、不跟具体扩展主题。dark 值经
 * Figma 组件库 Dark symbol 核验(DESIGN.md §16.1 双态表;个别标注推导值待 Figma
 * 精确)。与桌面 `--login-*` token(themes/colors.ts)同名同值。
 * 组件消费:useThemedStyles 工厂内走 `colors.login.*`(per-mode 编译缓存天然生效),
 * JSX 内联色走 `useTheme().colors.login.*`——不要再直接 import 模块级常量。
 */
export interface LoginSkinColors {
  /** 登录画布底(亮 #EDEDED / 暗 #1F1F1E,figma 532:585 暗色帧实测;纯平,PR#104 拍板) */
  bgBase: string;
  /** 品牌红 accent(区域徽标/字标红元素;禁止用作页面背景——wave4 改判;跨模式不变) */
  brandAccent: string;
  /** 品牌深红 pressed/hover(跨模式不变) */
  brandAccentPressed: string;
  /** 登录面板底(亮 #FBFBFB / 暗 #312F2F) */
  panelBg: string;
  /** 面板 1px inside 描边(亮 #D4D4D4 / 暗 #434343) */
  panelBorder: string;
  /** 输入框底(亮 #EEEEEE / 暗 #2C2A2A;figma Dark_normal 输入 symbol) */
  controlBg: string;
  /** 方式行/返回钮底(亮与输入框同 #EEEEEE;暗 #2A2828 分化;figma 549:850/549:897) */
  actionControlBg: string;
  /** 返回钮描边(亮白 / 暗 #434343;figma 549:897) */
  backBorder: string;
  /** 控件 default 描边(亮 #D4D4D4 / 暗 #434343) */
  controlBorder: string;
  /** 控件 focus/filled 描边(亮 #2A2828 / 暗 #EEEEEE 反相;figma Dark_highlight) */
  controlBorderActive: string;
  /** disabled 控件描边(两模式同构 #B4B4B4,§16.5 disabled 特例) */
  controlBorderDisabled: string;
  /** 控件已填文本(亮 #252222 / 暗 #EEEEEE) */
  controlText: string;
  /** placeholder/倒计时文案(亮 #D4D4D4 / 暗 #6F6F6F;figma 539:754) */
  controlPlaceholder: string;
  /** 面板标题(亮 #252222 / 暗 #D4D4D4) */
  titleText: string;
  /** 副标题/说明文案(两模式同值 #6F6F6F) */
  secondaryText: string;
  /** 主按钮/第三方圆钮底(亮深 #2A2828 / 暗白 #EEEEEE 反相;圆钮图标保品牌色) */
  primaryButtonBg: string;
  /** 主按钮/圆钮描边(亮 #434343 / 暗 #FFFFFF) */
  primaryButtonBorder: string;
  /** 主按钮文字(亮 #D4D4D4 / 暗 #2A2828 反相) */
  primaryButtonText: string;
  /** disabled 按钮白 70% 叠层(两模式同构,§16.5 disabled 特例) */
  disabledButtonOverlay: string;
  /** disabled 主按钮底(两模式同构深底 #2A2828,暗色不反相;figma Disable) */
  disabledButtonBg: string;
  /** disabled 主按钮文字(两模式同构 #D4D4D4,配合 opacity 0.8) */
  disabledButtonText: string;
  /** Text_link 重发链接(亮墨黑 #2A2828 / 暗浅色 #EEEEEE;figma 539:752 dark_重新发送) */
  linkText: string;
  /** Text_link pressed(亮 U-9 #1A1818 / 暗 #C0BEBE 推导,待 Figma 精确) */
  linkPressed: string;
  /** 登录错误文字(#D91F37 语义豁免,跨模式不变;不复用 statusError) */
  loginError: string;
  /** SLOGAN 矢量墨色(亮 #2A2828;暗色画布用白字版 #EDEDED 推导,待 Figma 精确) */
  sloganInk: string;
  /** wave4 双背景渐变的品牌红基色(跨模式同值;层 opacity 见 loginGradients) */
  gradientTint: string;
  /** 主钮/圆钮 pressed 叠层(亮黑 50% / 暗黑 10%;figma white_button Pressed) */
  overlayButtonPressed: string;
  /** 浅底控件(方式行/返回钮)pressed 叠层(两模式黑 8%) */
  overlayControlPressed: string;
  /** 浅底钮白描边/区域徽标(两模式 #FFFFFF;推导,待 Figma 精确) */
  invertedButtonBorder: string;
  /** 大 loading 环轨(亮 rgba(42,40,40,.18) / 暗 rgba(212,212,212,.18) 推导,待 Figma) */
  loadingRingTrack: string;
  /** Apple 圆钮底色(亮 #000000 / 暗 #FFFFFF;ADR Black/White 官方按钮配色,Guideline 4,用户标准图 2026-07-24) */
  appleCircleBg: string;
  /** Apple logo 标色(亮 #FFFFFF / 暗 #000000;与圆钮底反相,ADR 官方 Logo-only) */
  appleLogoInk: string;
  /** 协议 radio 未选中圈底(亮 #F1F0F1 / 暗 #2A2828;figma 600:626/602:1091) */
  consentRadioBg: string;
  /** 协议 radio 未选中 2px 描边(亮 #434343 / 暗 #F1F0F1,双模式反色) */
  consentRadioBorder: string;
  /** 协议 radio 选中圈底(亮 #2A2828 / 暗 #F1F0F1;选中态为对勾非圆点) */
  consentRadioCheckedBg: string;
  /** 协议 radio 选中对勾(亮白 / 暗墨;figma 600:628/602:1093) */
  consentRadioCheck: string;
  /** 协议弹窗全屏遮罩(两模式同值黑 85%;figma 602:820/602:1248) */
  consentOverlay: string;
  /** 弹窗次级钮底(亮 #EEEEEE / 暗 #434141;figma wave5 双色小按钮 602:863/602:1311) */
  secondaryButtonBg: string;
  /** 弹窗次级钮 1px 描边(亮白 / 暗 #565454) */
  secondaryButtonBorder: string;
  /** 弹窗次级钮文字(亮墨 / 暗浅,双模式反色) */
  secondaryButtonText: string;
  /** 弹窗次级钮 pressed 叠层(亮浅底黑10% / 暗 Dark_button_Normal 黑20%;wave5 §11.1) */
  overlaySecondaryPressed: string;
  /** 注销提示气泡底(figma 678:1075):固定亮 #FFFFFF / 暗 #1F1F1E,与桌面 --login-deletion-bubble-bg 逐值一致(取 agent 输入框底与最深深色底的值);浮层压立绘,必须不透明 */
  deletionBubbleBg: string;
  /** 注销提示气泡 1px 描边(figma 678:1075):固定亮 #D7D7D4 / 暗 #3C3C3A,与桌面 --login-deletion-bubble-border 逐值一致 */
  deletionBubbleBorder: string;
}

/** 登录皮肤双态色板(与桌面 --login-* dark 值同源,DESIGN.md §16.1) */
export const loginPalettes: Record<ThemeMode, LoginSkinColors> = {
  light: {
    bgBase: '#EDEDED',
    brandAccent: '#DF0C27',
    brandAccentPressed: '#A61629',
    panelBg: '#FBFBFB',
    panelBorder: '#D4D4D4',
    controlBg: '#EEEEEE',
    actionControlBg: '#EEEEEE',
    backBorder: '#FFFFFF',
    controlBorder: '#D4D4D4',
    controlBorderActive: '#2A2828',
    controlBorderDisabled: '#B4B4B4',
    controlText: '#252222',
    controlPlaceholder: '#D4D4D4',
    titleText: '#252222',
    secondaryText: '#6F6F6F',
    primaryButtonBg: '#2A2828',
    primaryButtonBorder: '#434343',
    primaryButtonText: '#D4D4D4',
    disabledButtonOverlay: 'rgba(255, 255, 255, 0.7)',
    disabledButtonBg: '#2A2828',
    disabledButtonText: '#D4D4D4',
    linkText: '#2A2828',
    linkPressed: '#1A1818',
    loginError: '#D91F37',
    sloganInk: '#2A2828',
    gradientTint: '#F70121',
    overlayButtonPressed: 'rgba(0, 0, 0, 0.5)',
    overlayControlPressed: 'rgba(0, 0, 0, 0.08)',
    invertedButtonBorder: '#FFFFFF',
    loadingRingTrack: 'rgba(42, 40, 40, 0.18)',
    appleCircleBg: '#000000',
    appleLogoInk: '#FFFFFF',
    consentRadioBg: '#F1F0F1',
    consentRadioBorder: '#434343',
    consentRadioCheckedBg: '#2A2828',
    consentRadioCheck: '#FFFFFF',
    consentOverlay: 'rgba(0, 0, 0, 0.85)',
    secondaryButtonBg: '#EEEEEE',
    secondaryButtonBorder: '#FFFFFF',
    secondaryButtonText: '#2A2828',
    overlaySecondaryPressed: 'rgba(0, 0, 0, 0.1)',
    deletionBubbleBg: '#FFFFFF',
    deletionBubbleBorder: '#D7D7D4',
  },
  dark: {
    bgBase: '#1F1F1E',
    brandAccent: '#DF0C27',
    brandAccentPressed: '#A61629',
    panelBg: '#312F2F',
    panelBorder: '#434343',
    controlBg: '#2C2A2A',
    actionControlBg: '#2A2828',
    backBorder: '#434343',
    controlBorder: '#434343',
    controlBorderActive: '#EEEEEE',
    controlBorderDisabled: '#B4B4B4',
    controlText: '#EEEEEE',
    controlPlaceholder: '#6F6F6F',
    titleText: '#D4D4D4',
    secondaryText: '#6F6F6F',
    primaryButtonBg: '#EEEEEE',
    primaryButtonBorder: '#FFFFFF',
    primaryButtonText: '#2A2828',
    disabledButtonOverlay: 'rgba(255, 255, 255, 0.7)',
    disabledButtonBg: '#2A2828',
    disabledButtonText: '#D4D4D4',
    linkText: '#EEEEEE',
    linkPressed: '#C0BEBE',
    loginError: '#D91F37',
    sloganInk: '#EDEDED',
    gradientTint: '#F70121',
    overlayButtonPressed: 'rgba(0, 0, 0, 0.1)',
    overlayControlPressed: 'rgba(0, 0, 0, 0.08)',
    invertedButtonBorder: '#FFFFFF',
    loadingRingTrack: 'rgba(212, 212, 212, 0.18)',
    appleCircleBg: '#FFFFFF',
    appleLogoInk: '#000000',
    consentRadioBg: '#2A2828',
    consentRadioBorder: '#F1F0F1',
    consentRadioCheckedBg: '#F1F0F1',
    consentRadioCheck: '#2A2828',
    consentOverlay: 'rgba(0, 0, 0, 0.85)',
    secondaryButtonBg: '#434141',
    secondaryButtonBorder: '#565454',
    secondaryButtonText: '#EEEEEE',
    overlaySecondaryPressed: 'rgba(0, 0, 0, 0.2)',
    deletionBubbleBg: '#1F1F1E',
    deletionBubbleBorder: '#3C3C3A',
  },
};

/**
 * Default Light —— 移动端象牙白。
 * 页面 #F9F9F6(比桌面 #F2F2ED 更亮,暖度 B = R−3)/ 卡片 #FFFFFC / 选中底 #EAEAE6 /
 * 分隔线 #CCCCC8;正文 #1A1A1A 中性。由页面派生的半透明层(surfaceTranslucent /
 * chatHeaderSurface / sheetSurface)是页面色加透明度,改页面时一起改。
 * 近白页面只给卡片留 1.05 的抬升(桌面 1.12),浮起面(卡片 / 列表行 / 浮层 / 输入容器)
 * 必须带 1px `border` 分层;需要下沉的块放到页面之下:选中底、展开块,以及代码卡 #F1F1EC。
 * 文字由深到浅:正文 → 二级 #4D4D4A → 三级 #686864,在所在底色上均 ≥ 4.5:1。
 * CTA 中性反相:#1A1A1A 底 + 白字。
 */
export const lightColors: ThemeColors = {
  surface: '#F9F9F6',
  taskTagRed: '#ed615f',
  taskTagOrange: '#eea34e',
  taskTagYellow: '#e5c744',
  taskTagGreen: '#70b568',
  taskTagBlue: '#609bd4',
  taskTagPurple: '#ab7bc6',
  taskTagGray: '#969696',
  taskTagPink: '#df83b0',
  taskTagCoral: '#de8970',
  taskTagTeal: '#53a89d',
  taskTagIndigo: '#7c83cf',
  taskTagWhite: '#ffffff',
  taskTagWhiteCheck: '#525252',

  surfaceElevated: '#FFFFFC',
  surfaceTranslucent: 'rgba(249, 249, 246, 0.78)',
  surfaceTranslucentSidebar: 'rgba(255, 255, 252, 0.90)',
  chatHeaderSurface: 'rgba(249, 249, 246, 0.90)',
  chatHeaderDivider: '#CCCCC8',
  surfaceGlassPanel: '#FFFFFC',
  surfaceListRow: '#FFFFFC',
  surfaceListExpanded: '#EAEAE6',
  activeGlyph: '#DF0C27',
  chatCodeSurface: '#F1F1EC',
  chatCodeBorder: '#CCCCC8',
  chatInlineCodeText: '#686864',
  // GitHub light(highlight.js github.css)原值,与桌面端逐值一致。
  syntaxKeyword: '#D73A49',
  syntaxString: '#032F62',
  syntaxComment: '#6A737D',
  syntaxNumber: '#005CC5',
  syntaxFunction: '#6F42C1',
  syntaxProperty: '#005CC5',
  inputCaret: '#417CDD',
  sheetSurface: 'rgba(249, 249, 246, 0.96)',
  sheetActionSurface: '#FFFFFC',
  sheetActionBorder: '#CCCCC8',
  sheetActionText: '#1A1A1A',
  sheetGrabber: '#C2C2BE',
  brandSplashBackground: '#DF0C27',
  brandSplashForeground: '#FFFFFF',
  brandSplashMuted: 'rgba(255, 255, 255, 0.82)',
  betaChannelBadgeBackground: '#DF0C27',
  betaChannelBadgeForeground: '#FFFFFF',
  surfaceChip: '#EAEAE6',
  border: '#CCCCC8',
  borderTranslucent: 'rgba(204, 204, 200, 0.62)',
  borderStrong: '#858581',
  textPrimary: '#1A1A1A',
  textSecondary: '#4D4D4A',
  textTertiary: '#686864',
  cta: '#1A1A1A',
  ctaText: '#FFFFFF',
  statusReady: '#19D2C1',
  statusRecording: '#D91F37',
  statusAccent: '#EA6B17',
  warningFg: '#F3A115',
  statusAwaiting: '#19D2C1',
  statusError: '#D91F37',
  statusDone: '#2AAE5B',
  permAutoAccent: '#417CDD',
  errorText: '#1A1A1A',
  destructive: '#f43d3f',
  sharedTaskConfirmBackground: '#ac3535',
  sharedTaskConfirmForeground: '#fffefa',
  errorBorder: '#858581',
  // overlay:遮罩双模式恒深(light 原 0.24 太浅近白;0.50 实机过重,用户定稿 0.35,2026-07-21)。
  // 侧栏/抽屉毛玻璃底色另有 surfaceTranslucentSidebar,不受影响。
  overlay: 'rgba(38, 38, 38, 0.35)',
  // homeListFab:反相中性,不染品牌红(lead 裁决 2026-07-17:染红=扩张红名单,超 U8
  // 已批决策表范围;日后要红 FAB 须单独过用户关卡)。light 对齐 textPrimary / cta 近黑 #1A1A1A。
  homeListFab: '#1A1A1A',
  homeListFabBorder: 'transparent',
  swipeActionPin: '#EA6B17',
  swipeActionNeutral: '#8e8e93',
  swipeActionArchive: '#3b82f6',
  swipeActionText: '#fbfbfa',
  login: loginPalettes.light,
};

/**
 * Default Dark —— 纯中性近黑。
 * 页面 #121212 / 卡片 #1E1E1E / 选中底 #2A2A2A / 分隔线 #383838,不加暖。
 * 文字:正文 #EDEDED → 二级 #BDBDBD → 三级 #999999,在所在底色上均 ≥ 4.5:1。
 * CTA 中性反相:#EDEDED 底 + #121212 字。
 */
export const darkColors: ThemeColors = {
  surface: '#121212',
  taskTagRed: '#ed615f',
  taskTagOrange: '#eea34e',
  taskTagYellow: '#e5c744',
  taskTagGreen: '#70b568',
  taskTagBlue: '#609bd4',
  taskTagPurple: '#ab7bc6',
  taskTagGray: '#969696',
  taskTagPink: '#e79fc1',
  taskTagCoral: '#e6a08c',
  taskTagTeal: '#75bfb4',
  taskTagIndigo: '#999fdf',
  taskTagWhite: '#ffffff',
  taskTagWhiteCheck: '#525252',
  surfaceElevated: '#1E1E1E',
  surfaceTranslucent: 'rgba(18, 18, 18, 0.78)',
  surfaceTranslucentSidebar: 'rgba(10, 10, 10, 0.85)',
  chatHeaderSurface: 'rgba(18, 18, 18, 0.80)',
  chatHeaderDivider: 'rgba(255, 255, 255, 0.08)',
  surfaceGlassPanel: 'rgba(36, 36, 36, 0.95)',
  surfaceListRow: '#1E1E1E',
  surfaceListExpanded: '#121212',
  activeGlyph: '#A61629',
  chatCodeSurface: '#1A1A1A',
  chatCodeBorder: '#383838',
  chatInlineCodeText: '#999999',
  // GitHub Dark,取自桌面 globals.css 的 .dark .n* 覆盖(#ff7b72 / #a5d6ff /
  // #8b949e / #79c0ff / #d2a8ff)。
  syntaxKeyword: '#FF7B72',
  syntaxString: '#A5D6FF',
  syntaxComment: '#8B949E',
  syntaxNumber: '#79C0FF',
  syntaxFunction: '#D2A8FF',
  syntaxProperty: '#79C0FF',
  inputCaret: '#417CDD',
  sheetSurface: 'rgba(28, 28, 28, 0.96)',
  sheetActionSurface: '#262626',
  sheetActionBorder: '#383838',
  sheetActionText: '#EDEDED',
  sheetGrabber: '#5C5C5C',
  brandSplashBackground: '#DF0C27',
  brandSplashForeground: '#FFFFFF',
  brandSplashMuted: 'rgba(255, 255, 255, 0.82)',
  betaChannelBadgeBackground: '#DF0C27',
  betaChannelBadgeForeground: '#FFFFFF',
  surfaceChip: '#2A2A2A',
  border: '#383838',
  borderTranslucent: 'rgba(56, 56, 56, 0.62)',
  borderStrong: '#8A8A8A',
  textPrimary: '#EDEDED',
  textSecondary: '#BDBDBD',
  textTertiary: '#999999',
  cta: '#EDEDED',
  ctaText: '#121212',
  statusReady: '#19D2C1',
  statusRecording: '#D91F37',
  statusAccent: '#EA6B17',
  warningFg: '#F3A115',
  statusAwaiting: '#19D2C1',
  statusError: '#D91F37',
  statusDone: '#2AAE5B',
  permAutoAccent: '#417CDD',
  errorText: '#EDEDED',
  destructive: '#f43d3f',
  sharedTaskConfirmBackground: '#ec9898',
  sharedTaskConfirmForeground: '#272727',
  errorBorder: '#8A8A8A',
  overlay: 'rgba(0, 0, 0, 0.45)',
  // homeListFab:反相中性(lead 裁决,见 lightColors 注释);dark 用 #E6E6E6 柔白(比 cta 略收)。
  homeListFab: '#E6E6E6',
  homeListFabBorder: '#FFFFFF',
  swipeActionPin: '#EA6B17',
  swipeActionNeutral: '#636366',
  swipeActionArchive: '#3b82f6',
  swipeActionText: '#fbfbfa',
  login: loginPalettes.dark,
};

export const palettes: Record<ThemeMode, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

// —— 以下为主题无关(light / dark 一致)的不变量阶梯 ——

/** 间距阶梯,基数 4。 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * 圆角四档,对齐桌面 docs/design-rules/cindy-design-system.md 三档(8 内层控件 / 12 容器 / pill)+ 移动端微元素档:
 * - micro(4):缩略图内 chip、行内高亮等微元素;
 * - control(8):卡片内层控件 / 小按钮 / 缩略图;
 * - container(12):卡片 / 弹窗 / 输入容器;
 * - pill(9999):胶囊交互元素与细条 / 圆点(RN 自动截半)。
 * 阶梯外圆角禁止(守护测试拦截);组件几何专用值(如 composer 聚焦卡片)须带注释豁免。
 */
export const radius = {
  micro: 4,
  control: 8,
  container: 12,
  pill: 9999,
} as const;

/**
 * 收敛后的字号阶梯(对标桌面 hierarchy,保持克制)。
 * micro..headline 为工作号;listBody/listTitle 为 CINDY List 页专用档;
 * largeTitle 是首页大标题(iOS large title 风格);hero 留给 login 品牌位。
 * 阶梯外字号一律禁止——需要新号先回本文件扩档,不许在组件里写字面量(有守护测试拦截)。
 */
export const typeScale = {
  micro: 11,
  caption: 12,
  footnote: 13,
  listBody: 14,
  code: 15,
  body: 16,
  bodyLarge: 17,
  subtitle: 18,
  listTitle: 19,
  title: 20,
  headline: 24,
  largeTitle: 30,
  hero: 40,
} as const;

/**
 * 与字号配对的行高。除标准配对外只有三个场景档:
 * - bodyLarge(17/26):对话消息流正文(对齐 iOS 对话类 app 的 17pt 惯例,行高略松以改善长文可读性);
 * - bodyRelaxed(16/24):login 副标题等宽松正文;
 * - listBody/listTitleCompact(14/20、19/27):CINDY List 页 M2 施工图专用;
 * - listTitle(18/28、20/28):既有首页列表标题类,行高撑触控行。
 * micro(16) 同时服务紧凑 caption 场景(diff 行、媒体 hint 等行高即盒高的地方)。
 */
export const lineHeight = {
  micro: 16,
  caption: 18,
  listBody: 20,
  code: 20,
  body: 22,
  bodyRelaxed: 24,
  bodyLarge: 26,
  title: 25,
  subtitle: 26,
  listTitleCompact: 27,
  listTitle: 28,
  headline: 30,
  largeTitle: 36,
  hero: 44,
} as const;

/** 字重:克制到 4 档。默认 medium;semibold 仅限大写微标签等少量强调;bold 限 login 品牌 hero 标题与消息流 markdown 强调(对齐桌面 <strong> 的 700)。 */
export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * 排版 preset —— 每档字号与其标准行高的配对,组件里 `...textStyles.body` 一次展开,
 * 保证字号 / 行高永远成对不漂移;字重按需用 `fontWeight` token 叠加。
 * 非标准配对(如 subtitle 字号 + listTitle 行高)手动组合两个 token,但禁止字面量。
 */
export const textStyles = {
  micro: { fontSize: typeScale.micro, lineHeight: lineHeight.micro },
  caption: { fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  footnote: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  listBody: { fontSize: typeScale.listBody, lineHeight: lineHeight.listBody },
  code: { fontSize: typeScale.code, lineHeight: lineHeight.code },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.body },
  bodyRelaxed: { fontSize: typeScale.body, lineHeight: lineHeight.bodyRelaxed },
  bodyLarge: { fontSize: typeScale.bodyLarge, lineHeight: lineHeight.bodyLarge },
  subtitle: { fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle },
  listTitle: { fontSize: typeScale.listTitle, lineHeight: lineHeight.listTitleCompact },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title },
  headline: { fontSize: typeScale.headline, lineHeight: lineHeight.headline },
  largeTitle: { fontSize: typeScale.largeTitle, lineHeight: lineHeight.largeTitle },
  hero: { fontSize: typeScale.hero, lineHeight: lineHeight.hero },
} as const;

/**
 * lucide 图标尺寸阶梯。xs..xxl 为工作档;action 是工具栏 / lightbox 操作图标档
 * (18 与 22 之间的真实需求档,语义命名避免 size 名整体重排);
 * display / hero 留给空态大图标与导航级大 chevron。
 * 阶梯外尺寸一律禁止——需要新档先回本文件扩档(守护测试拦截)。
 */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  action: 20,
  listGlyph: 21,
  xl: 22,
  /** 滑动操作圆钮(56px)内 glyph 的 XD-Maker 原档考古值,通栏回退用户实机验收锁定(2026-07-21)。 */
  swipeAction: 23,
  xxl: 26,
  display: 32,
  hero: 44,
  /** 文件浏览网格的大图标档(文件夹/通用文件 glyph),与列表 lucide 描边图标同语言放大。 */
  glyph: 64,
} as const;

/**
 * lucide 图标 strokeWidth 阶梯。收敛前仓库里散落 14 种碎片值(1.5~3),
 * 视觉上无法区分意图;收敛为四档:thin(大圆形图标的轻盈描边)、
 * regular(默认,lucide 出厂值)、medium(选中态 Check 等强调)、bold(微图标增粗保清晰)。
 */
export const iconStroke = {
  thin: 1.75,
  regular: 2,
  medium: 2.2,
  bold: 2.5,
} as const;

/**
 * 文件浏览网格「真实内容迷你页」缩略图的微缩文本档位。
 * 不进 typeScale:它不是供阅读的排版,是把文档首屏画成缩略图的装饰性渲染
 * (对标 iOS Files 文档缩略图),阅读态字号永远走 typeScale。
 */
export const docThumbSnippetType = {
  fontSize: 4,
  lineHeight: 6,
} as const;

/**
 * @deprecated 亮色单值别名,仅供 node 单测与历史引用过渡。
 *
 * 暗色实现 PR 起登录皮随 light/dark 二态切换(前提变更,DESIGN.md §16.2 决策
 * 记录 2026-07-23),权威 = `loginPalettes` + `ThemeColors.login`。组件消费一律走
 * `colors.login.*`(useThemedStyles 工厂)/`useTheme().colors.login.*`(JSX 内联),
 * **不要**再 import 本常量——它永远是亮色,暗色下用它 = 静默单模式 bug。
 */
export const loginColors = loginPalettes.light;

/**
 * wave4 背景双渐变参数(代码复现非资产;归一化百分比锚定物理 viewport,
 * 不随 750 stage 缩放、不随键盘 translate——implementation-plan Step 5 冻结)。
 * 落码时以 wave4 帧(368:1375)截图对照为准,允许微调参数,字段语义冻结。
 */
export const loginGradients = {
  /** 红径向层(379:518):#F70121 α1→α0@0.747,中心帧右上角外侧,层 opacity 6% */
  radial: { centerX: 1.28, centerY: 0.07, alphaStop: 0.747, layerOpacity: 0.06 },
  /** 红线性层(379:520):#F70121 α0→α1 向左下 (86.5%,85.8%)→(0%,100.7%),层 opacity 5% */
  linear: { fromX: 0.865, fromY: 0.858, toX: 0, toY: 1.007, layerOpacity: 0.05 },
} as const;

/**
 * 登录皮肤尺寸常量(figma px,750 移动设计稿坐标系;实现按布局引擎换算,
 * 不进通用 spacing/radius 阶梯——36/40/50/60 圆角与 80/440/680 尺寸不属于
 * 现有阶梯,token-decision-table §4 决策)。
 */
export const loginSizes = {
  stageWidth: 750,
  stageTallHeight: 1624,
  stageShortHeight: 1334,
  panelWidth: 680,
  panelHeight: 440,
  panelRadius: 36,
  /** 面板 440 + gap 40 + 圆钮行 80 */
  flowHeight: 560,
  controlWidth: 540,
  controlHeight: 80,
  controlRadius: 40,
  socialSize: 80,
  socialGap: 70,
  backSize: 60,
  methodRowHeight: 100,
  methodRowRadius: 60,
  panelSocialGap: 40,
} as const;

/**
 * Motion token(全局动效档位,ms)——与桌面端 DESIGN.md §14.4 的 --motion-* 同名
 * 同值,双端同构。新增动效一律引用这些档位,不要在组件里硬编码时长。
 * spinnerCycle 与 sidebarTitleMarqueePerViewport 是 §14.4 登记的语义例外,
 * 不是额外交互时长档位。
 */
export const motionDuration = {
  /** hover / 即时反馈、轻浮层退场 */
  instant: 80,
  /** 颜色 / 透明度状态切换、轻浮层入场 */
  fast: 150,
  /** 尺寸变化:展开折叠、面板收展 */
  base: 200,
  /** 重浮层(弹窗 / sheet)入场 */
  enter: 250,
  /** 重浮层(弹窗 / sheet)退场 */
  exit: 150,
  /** 功能性 loading spinner 完整一圈(§14.4 窄例外) */
  spinnerCycle: 1000,
  /** Desktop 侧栏溢出标题每个可视宽度的阅读时长(双端 token 同构,移动端不消费) */
  sidebarTitleMarqueePerViewport: 2400,
} as const;

/**
 * Motion 缓动曲线控制点(cubic-bezier 四元组,与桌面同值)。RN 侧消费:
 * `Easing.bezier(...motionEasing.out)`。本文件不依赖 react-native,故只存数据。
 */
export const motionEasing = {
  /** 入场 / 展开 */
  out: [0.16, 1, 0.3, 1],
  /** 退场 */
  in: [0.4, 0, 1, 1],
  /** 位置 / 尺寸插值 */
  move: [0.4, 0, 0.2, 1],
} as const;

/** Shared size for floating iOS navigation/menu controls (points). */
export const navigationChrome = {
  target: 44,
  // Match navigation foreground polarity; backing stays local to the glass shape.
  clear: {
    light: {
      foreground: '#000000',
      scrim: 'rgba(255, 255, 255, 0.35)',
      selected: 'rgba(0, 0, 0, 0.10)',
    },
    dark: {
      foreground: '#FFFFFF',
      scrim: 'rgba(0, 0, 0, 0.35)',
      selected: 'rgba(255, 255, 255, 0.18)',
    },
  },
} as const;
