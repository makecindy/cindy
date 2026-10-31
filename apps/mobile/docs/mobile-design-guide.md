# Cindy 手机版设计指南

> 状态:权威设计规范。新增 / 修改任何 UI 前先读本文。
> 定位:这是根规范 `docs/design-rules/DESIGN.md` 的**轻量移动版**——共享 Cindy 品牌与业务语义,但不照搬桌面的 ColorRegistry 重型架构。手机端用一套 light/dark 双色板 + 收敛阶梯 + RN 主题 hook。
> 色值由移动端**独立决定**(2026-09-26 起为「象牙白」色板,见 `DESIGN.md §15.13`):语义与桌面一一对应,具体色阶、对比度与暖度不与桌面同步。

---

## 1. 视觉哲学

承接桌面:**灰度为主、默认零阴影、pill 几何、字重克制**。在此之上叠加移动端约束:

- **iOS 优先**,触控优先,跟随系统 light / dark 自动切换(`useColorScheme`)。
- **灰度环境**:除已登记、各有限定用途的语义色外(品牌 teal 就绪态、Heart Orange 运行 / thinking 态、自动审批与伙伴未读的信息蓝、额度条、失败状态红和 Beta 渠道红色状态徽标等,见 §2 色表与根规范 `DESIGN.md` §2 / §15.13),界面全是黑白之间的灰阶。不引入未登记的装饰色;新增有色用途先在根规范 `DESIGN.md` §2 / §10 登记。
  - 唯一的个性化例外:用户在设置里主动选择的「我的消息气泡颜色」,只染用户自己的消息气泡,默认仍是灰阶;规则见根规范 `DESIGN.md`「Personal message bubble colors」。
  - 模型选择器的账号额度条沿用桌面语义：剩余 ≥30% 用 `textSecondary`，10% < 剩余 <30% 用 `quotaBarWarn`，剩余 ≤10% 用 `quotaBarCrit`。额度专用语义在根规范 `DESIGN.md` §2 / §10 登记，不借用房主皇冠或任务错误 token。颜色只用于额度条，百分比文字继续保留；iOS / Android 共用真实比例绘制，不设置最小填充长度，0% 留空。
- **圆角走四档阶梯**(与 `src/theme/tokens.ts` 的 `radius` 一致,守护测试拦截阶梯外值):`micro`(4,缩略图内 chip、勾选指示器等微元素)/ `control`(8,卡片内层控件)/ `container`(12,卡片 / 容器)/ `pill`(9999,交互元素)。**禁止**阶梯外中间值(0 / 3 / 6 / 28 等)与字面量圆角。根规范 `docs/design-rules/DESIGN.md` §5 的圆角清单约束的是桌面 surface;mobile 圆角阶梯以 `tokens.ts` 为准。两端档位差异(如 `micro 4` 不等于桌面只给键帽的 4px)是 `design-governance.md` §10「Mobile 用途差异」的待裁决项,裁决前保持现状。
- **默认零阴影**:层次靠背景色差 + 1px 边框。2026-09-27 用户明确要求的局部例外：首页主菜单抽屉（含伙伴入口）用右侧容器圆角与柔和投影，颜色走 homeDrawerShadow，外壳承载阴影、内层裁切内容；不扩展到页面卡片或任务列表侧栏，见 DESIGN.md §6。
- **字重克制**:按角色用 400 / 500 / 600(见 §3「字重与字色按角色搭配」)。**UI chrome 无 700+**。唯一例外是根规范 `docs/design-rules/DESIGN.md` §3「排版豁免登记表」已登记的域——原生 Markdown strong(`src/session/MessageRenderer.tsx` 的 `markdownStrong` → `fontWeight.bold`)与登录品牌画布(`app/(auth)/login.tsx`、`src/components/LoginSkinControls.tsx`、`src/auth/loginSkinLayout.ts`)。这些是用户内容语义与品牌画布,不算 chrome;chrome 本身的上限仍是 600。
- **手机只做减法**(详见 `mobile-current-execution-plan.md`):主层信息量不超过桌面主层;视觉轻、触控够(可见图标小,hitSlop 补足热区)。

---

## 2. 颜色 token

颜色分两层:**随主题切换的 `ThemeColors`** 与**主题无关的不变量**。组件**永远写 token,不写 hex**(写死 hex 的组件在 dark 下不会变色)。

源:`src/theme/tokens.ts`(`lightColors` / `darkColors` / `palettes`)。

浅色为象牙白(页面、卡片、描边带一点暖,正文中性),深色为纯中性近黑(2026-09-26 用户定稿)。下表是常用的底色 / 文字 / 描边;完整清单以 `tokens.ts` 为准,移动端专用层见 `DESIGN.md §15.13`。

| token | light | dark | 用途 |
|---|---|---|---|
| `surface` | `#F9F9F6` | `#121212` | 页面背景 |
| `surfaceElevated` | `#FFFFFC` | `#1E1E1E` | 抬一层:Card / 弹窗 / 输入框 |
| `surfaceListRow` | `#FFFFFC` | `#1E1E1E` | 列表行 |
| `surfaceTranslucent` | rgba(249,249,246,.78) | rgba(18,18,18,.78) | 吸顶栏半透明 |
| `surfaceChip` | `#EAEAE6` | `#2A2A2A` | chip / pill / 选中行填充 |
| `border` | `#CCCCC8` | `#383838` | 1px 分隔线 / 边框 |
| `borderTranslucent` | rgba(204,204,200,.62) | rgba(56,56,56,.62) | 半透明边框 |
| `borderStrong` | `#858581` | `#8A8A8A` | 强调边框 / 次要图标点(≥ 3:1) |
| `textPrimary` | `#0F0F0F` | `#EDEDED` | 主标题 / 主正文 |
| `textSecondary` | `#4D4D4A` | `#BDBDBD` | 次要文字 / 多数图标 |
| `textTertiary` | `#686864` | `#999999` | 三级文字 / 时间、计数等 metadata |
| `textPlaceholder` | `#858581` | `#757575` | **仅限**输入框占位字与同源的语音态提示(≈3.5:1,低于 4.5:1 的登记例外) |
| `cta` | `#0F0F0F` | `#EDEDED` | 主操作填充(**dark 反相为近白**) |
| `ctaText` | `#FFFFFF` | `#121212` | CTA 上的文字 |
| `homeListFab` | `#0F0F0F` | `#E6E6E6` | 素雅新建对话 FAB:dark 比 cta 略收,避免主入口在深底上过跳 |
| `statusReady` | `#19D2C1` | `#19D2C1` | 就绪 / 在线点(品牌 teal,**语义不变**) |
| `statusAccent` | `#EA6B17` | `#EA6B17` | 运行 / thinking + 完全访问权限(Heart Orange,**语义不变**) |
| `quotaBarWarn` | `#F3A115` | `#F3A115` | 账号额度条剩余不足 30%、高于 10% 的填充，其他用途不复用 |
| `quotaBarCrit` | `#D91F37` | `#D91F37` | 账号额度条剩余不超过 10% 的填充，其他用途不复用 |
| `betaChannelBadgeBackground` | `#DF0C27` | `#DF0C27` | Beta 渠道开关已打开时,当前版本旁的状态徽标底色 |
| `betaChannelBadgeForeground` | `#FFFFFF` | `#FFFFFF` | Beta 渠道状态徽标文字,与底色对比度 4.98:1 |
| `permAutoAccent` | `#417CDD` | `#417CDD` | 自动审批权限模式强调 |
| `botUnread` | `#417CDD` | `#417CDD` | **仅限**伙伴列表的未读点(桌面 `--bot-unread-bg` 的移动端镜像,见 `DESIGN.md` Bot Unread Badge) |
| `errorText` | `#0F0F0F` | `#EDEDED` | 错误说明文字(跟随 textPrimary) |
| `errorBorder` | `#858581` | `#8A8A8A` | 错误边框(跟随 borderStrong) |
| `overlay` | rgba(38,38,38,.35) | rgba(0,0,0,.45) | modal / lightbox 背板 |

**规则:**
- **语义不变色**(`statusReady` / `statusAccent` / `betaChannelBadgeBackground` / `betaChannelBadgeForeground` / `botUnread`)跨 light / dark 一致——它们是状态语义,不随主题漂移。Beta 红色只用于设置页当前版本旁的渠道徽标,不得扩展为装饰色、错误色或 CTA。
- **浅色卡片主要靠描边分层**:页面提亮到 `#F9F9F6` 后,近白卡片相对页面只剩 1.05 的色差(桌面 1.12)。新增浮起面(卡片 / 列表行 / 浮层 / 输入容器)**必须带 1px `border`**,不要只靠 `surfaceElevated` 的填充色差;需要“沉下去”的块(选中底、展开块、代码卡)用比页面更暗的档。
- **文字三档由深到浅**:正文 → 二级 → 三级,在所在底色上都 ≥ 4.5:1(`themeTokens.test.ts` 守护)。占位字单独用 `textPlaceholder`,比三级更淡但 ≥ 3:1,只给输入框占位字用。新增文字不要拿 `textTertiary` 当“更弱的二级”以外的用途,也不要为了“更淡”自行调低透明度。
- **CTA 在 dark 反相为近白**:`cta` 近白底 + `ctaText` 深字。注意别让近白 pill 看起来像 disabled——新增主操作 / 选中态后在 dark 下目检。
- **显示模式由用户设置**:设置 → 外观 → 显示模式(跟随系统 / 浅色 / 深色,默认跟随系统)。组件只读 `useTheme()`,不要自己调 `useColorScheme()`。
- **Home 对话列表用 base token**:列表背景 / 分隔 / 文字使用 `surface` / `border` / `text*`,菜单选中用 `surfaceChip`,不另起暗色调色板;菜单 / FAB 只用 1px `border` 分层、零阴影,保持桌面「单一 flat Surface + 1px Board」哲学。
- 不要在组件里硬编码 hex / rgba;找不到合适 token 时跟维护者确认是否新增,而不是写死。

---

## 3. 字体与排版

排版是过去最乱的一块(各屏自造了 ~19 个字号 + ~13 个行高)。现在收敛到一套阶梯,**优先用 token 不写裸数字**。

源:`src/theme/tokens.ts` 的 `typeScale` / `lineHeight` / `fontWeight` + `src/theme/monoFont.ts`。

### 文字规范速查(新增或修改任何文字前先看这张表)

2026-09-26 / 27 用户定稿。**先判断这段文字的角色,再整行照抄字号、行高、字重、字色**,不要按「看起来要大一点 / 淡一点」单独调某一项。

| 角色 | 字号 / 行高(token) | 字重 | 字色 | 例子 |
|---|---|---|---|---|
| 页面、弹窗、面板大标题 | 20 / 25(`title`) | 600 | `textPrimary` | 弹窗标题、首页顶栏「所有任务」 |
| 导航栏、面板顶栏标题 | 16 / 22(`body`) | 600 | `textPrimary` | 设置页顶栏「设置」 |
| 列表 / 卡片标题 | 18 / 26(`subtitle`) | 500 | `textPrimary` | 首页任务标题、队友名 |
| 行标题、选项、按钮、菜单项 | 16 / 22(`body`) | 500 | `textPrimary`(主按钮 `ctaText`) | 设置行标题、操作按钮 |
| 行右侧取值 | 16 / 22(`body`) | 400 | `textSecondary` | 「跟随系统」「0 个词条」 |
| 对话消息正文 | 17 / 26(`bodyLarge`) | 400 | `textPrimary` | 用户 / Agent 消息 |
| 次级正文 | 15 / 20(`bodySmall`) | 400(面板操作项 500) | 预览 `textSecondary`;操作项 `textPrimary` | 列表预览、面板操作项、搜索框 |
| 说明、提示、报错(成句的话) | 13 / 18(`footnote`) | 400 | `textSecondary` | 开关下的说明、表单报错 |
| 分组小标签 | 13 / 18(`footnote`,紧凑处可 12) | 600 | `textTertiary` | 设置分组标题「通知」 |
| 时间、计数、状态词(短元数据) | 12 / 18(`caption`) | 400 | `textTertiary` | 「2 小时」「3 个文件」 |
| 徽标、字母标记 | 11 / 16(`micro`) | 600 | 专用前景色,或 chip 底上 `textSecondary` | Beta 徽标、订阅徽标 |
| 输入框占位字 | 同所在输入框 | 400 | `textPlaceholder` | 「今天我们做点什么呢~」 |
| 等宽代码 | 15 / 20(`bodySmall`)+ `monoFont` | 400 | `textPrimary` | 代码块、行内代码 |

**四条硬规则**(违反会被守护测试拦下,拦截点见表后):

1. **字色只有五档中性色**:正文 `textPrimary`、二级 `textSecondary`、三级 `textTertiary`、占位字 `textPlaceholder`、深底上的字 `ctaText`。不要新增一次性灰,不要拿 `surface` 当字色,不要调透明度「做淡」。
2. **颜色越浅,字重不能越粗**:三级色只配 400(分组小标签除外);二级色只配 400 / 500(徽标、字母标记除外)。
3. **字号只用 11 档阶梯**:11 / 12 / 13 / 15 / 16 / 17 / 18 / 20 / 24 / 30 / 40。成句的话至少 13。
4. **每个文字样式都配行高**,按上表成对;单行输入框不设行高。

**登记例外**(只有这些可以偏离上表,新增例外先改本节):话题内“New”分界标签使用 `threadUnreadDivider` 红色、13/18 常规字重(2026-10-29 用户指定,与 0.5pt 横线同色);首页列表与队友行的节奏行高(18/28、15/26、13/22);代码 / diff 的紧凑行高;对话 Markdown 标题与长文 24 行高;与相邻图标 / 按钮对齐的文字;行内强调(Markdown strong 700、搜索命中、价格折扣);登录品牌画布(见根规范 §3 豁免表)。

**机器会拦什么**:阶梯外字号 / 行高 / 字重与裸数字、缺行高、浅色字配粗字重(`typographyTokenDiscipline.test.ts`);文字用了五档中性字色与已登记语义色以外的 token、占位字没用 `textPlaceholder`(`textColorDiscipline.test.ts`,存量按次数登记、只许减少);字号阶梯本身、文字三档与占位字对比度、深浅双模式同键(`themeTokens.test.ts`)。**拦不住、靠 review 的**:角色选错(比如把说明文字放 12 号、把标题写成 500)、例外被滥用。评审时对照上表逐行看。

### 字号 `typeScale`(按角色选,2026-09-27 用户定稿收拢为 11 档)

| token | px | 角色 |
|---|---|---|
| `micro` | 11 | 徽标、极小标签 |
| `caption` | 12 | 短元数据:时间、计数、状态词、chip 文字。**不放成句的话** |
| `footnote` | 13 | 说明、提示、报错、备注、分组小标签。**成句的话至少 13** |
| `bodySmall` | 15 | 次级正文:列表预览、紧凑行、面板操作项、搜索框、输入框,以及等宽代码 |
| `body` | 16 | 界面主文字:行标题、按钮、菜单项、导航栏标题 |
| `bodyLarge` | 17 | 对话消息正文(专用) |
| `subtitle` | 18 | 列表 / 卡片标题(首页任务、队友) |
| `title` | 20 | 页面、弹窗、面板大标题 |
| `headline` | 24 | 大数字、大名称 |
| `largeTitle` | 30 | 引导页等超大标题 |
| `hero` | 40 | 登录页品牌标题(已登记例外) |

已删除 14(`listBody`,并入 15)与 19(`listTitle`,并入 20);原 15 号 `code` 更名为 `bodySmall`。11 / 12 / 13 / 15 / 16 / 17 / 20 与 iOS 系统正文字号一致,18 / 24 / 30 / 40 为移动端自定。阶梯外字号由守护测试拦截。

### 行高 `lineHeight`(与字号配对)

**每个文字样式都必须配行高**(2026-09-27 用户定稿,`typographyTokenDiscipline.test.ts` 守护)。标准配对:

| 字号 | 11 | 12 | 13 | 15 | 16 | 17 | 18 | 20 | 24 | 30 | 40 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 行高 | 16 | 18 | 18 | 20 | 22 | 26 | 26 | 25 | 30 | 36 | 44 |

直接用 `textStyles.*` 预设最省事。标准之外只允许已登记的场景,不要为单个页面再造行高:
- 首页列表与队友行的节奏值(18/28 标题、15/26 预览、13/22 元数据),对话流 Markdown 标题;
- 代码、diff、媒体 hint 等「行高即盒高」的紧凑场景(`micro` / `bodySmall` 行高);
- 长文阅读的 `bodyRelaxed`(24):登录副标题、伙伴记忆。

另有一类**对齐例外**:文字要与相邻图标、按钮或行内正文对齐时,行高跟随被对齐对象(如行内引用 chip、任务标签、消息操作行的时间、伙伴记忆日期)。

**单行输入框(TextInput)不设行高**:iOS 上会让占位字与光标偏位。多行编辑区可以配标准行高。登录品牌画布按其登记例外处理。

### 字重 `fontWeight`

`regular '400'` · `medium '500'` · `semibold '600'` · `bold '700'`(**仅限已登记豁免域**,见下)。**UI chrome 不超过 600。**

#### 字重与字色按角色搭配(2026-09-26 用户定稿)

按元素的**角色**选字重,不按字号选:

| 角色 | 常用字号 | 字重 | 字色 |
|---|---|---|---|
| 页面 / 导航栏 / 弹窗 / 面板标题 | `body`–`largeTitle` | `semibold` 600 | `textPrimary` |
| 列表行、选项、卡片标题、按钮文字(含首页任务标题) | `bodySmall`–`subtitle` | `medium` 500 | `textPrimary`(主按钮用 `ctaText`) |
| 正文、描述、输入内容 | `bodySmall`–`bodyLarge` | `regular` 400 | `textPrimary`;描述性文字用 `textSecondary` |
| 辅助说明 | `caption` / `footnote` | `regular` 400 | `textSecondary` |
| 时间、元数据 | `micro` / `caption` | `regular` 400 | `textTertiary` |
| 输入框占位字 | 同所在输入框 | `regular` 400 | `textPlaceholder` |
| 分组小标签(eyebrow / 区块标题)、徽标与字母标记 | `micro`–`footnote` | `semibold` 600 | 分组小标签用 `textTertiary`;徽标 / 字母标记用专用前景色,或在 chip 底上用 `textSecondary` |

搭配规则:
- **颜色越浅,字重不能越粗**:`textTertiary` 只配 400(唯一例外是分组小标签的 600);`textSecondary` 只配 400 或 500(例外:chip 底上的徽标与字母标记可用 600,它们按图形元素处理)。
- 标题与正文靠**字号 + 字重**拉开;同一字号内的主次靠**颜色**拉开,不再用 500 / 600 细分。选中态同理(如分段选项选中只换色,字重保持 500)。
- 行内语义强调不受本表约束:Markdown strong(700,见下)、搜索命中高亮、价格折扣等局部加重保留现状。

`bold '700'` 只允许用在根规范 `docs/design-rules/DESIGN.md` §3「排版豁免登记表」登记的两处:原生 Markdown strong(`src/session/MessageRenderer.tsx` 的 `markdownStrong`)与登录品牌画布(`app/(auth)/login.tsx`、`src/components/LoginSkinControls.tsx`、`src/auth/loginSkinLayout.ts`)。除此之外一律不得使用 700,新增用途必须先改根规范的登记表。

### 等宽 `monoFont`

`Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })`。**禁止**写死 `'Courier'`。

### 旧值 → 新 token 映射(迁移时套用)

- 字号:`10→micro` ·`14→bodySmall(15)` ·`19→title(20)` ·`22/23/28→headline`;成句的说明文字不要落在 12,用 `footnote`。
- 行高:`16→caption(18)` ·`20→body(22)或 bodySmall(20)` ·`23→body(22)` ·`24/25/26→subtitle(26)` ·`28/30/31→headline(30)`。
- 字重:`'700'` → 按上面的角色表选 400 / 500 / 600。**已登记豁免域除外**(原生 Markdown strong、登录品牌画布)——那两处保留 `bold '700'`,不要按此条降档。
- 等宽:`'Courier'` 与内联 `Platform.select` → `monoFont`。

---

## 4. 组件约定

### 优先复用 primitives

新组件先去 `src/components/MobilePrimitives.tsx` 找,不要自造按钮 / 行 / 卡片 / 空态。已有:

- 按钮 / 行:`MainWindowActionButton` · `MainWindowActionGroup` · `MainWindowOptionButton` · `MainWindowRowButton` · `MainWindowCardButton`
- 头部 / 条:`ScreenHeader` · `SummaryStrip`
- 指示 / 标签:`StatusDot` · `ActionPill` · `InfoPill` · `MainWindowMetric`
- 空态:`MainWindowEmptyState`
- 其它共享:`CenteredScreen` · `ConnectionBanner` · `MobileVendorIcon`

文本 / 卡片 / 分隔线目前仍在各屏重复定义——这是已知优化点(见执行计划),新代码尽量收敛、不要再新增一份同义样式。

### 设置类分组:说明文字写在卡片外(2026-10-19 用户定稿)

设置页及其二级页统一用 `src/session/SettingsGroupRows.tsx` 的 `SettingsGroup`。对齐 iOS Section footer / Android 列表辅助文字:

- **卡片里只放「名称 + 取值 / 开关 / 箭头」**。成句的说明写在分组下方的 `footer`(13/18 400 `textSecondary`);操作结果、权限被拒、保存失败等临时提示走 `messages`,接在说明后面。行组件不提供 `hint` / `detail`。
- **一组只配一段说明**。同组几行各需说明时拆成几个分组。
- **点不了的入口不摆出来**:检查更新等当前不可用的动作直接不显示,原因写进 footer,不留灰按钮加解释。
- 原地执行的动作行(检查更新、清空日志)传 `chevron={false}`,只有进入子页 / 外链的行画箭头。
- 例外:列表条目自身的元数据(如词典别名)和录入流程里紧贴控件的步骤状态,可以留在行内。
- **「+」面板里的表单(开启协同 / 创建 Worker 等 `ContextSheet*`)同一规则**:`ContextSheetGroup` 的 `footer` 承载说明与校验提示(报错传 `footerTone="error"`),`ContextSheetRow` 用 `value` 放右侧取值、不再把说明塞进行内 `detail`;iOS 下拉行自带行名、分段控件选项自明,分组不再加标题(Android 药丸没有行名,保留分组标题);底部主按钮撑满宽度。iOS 上「+」面板的分组标题用 13/18 600 `textTertiary`(系统默认分组标题在新版 iOS 是大号粗体,由 `ComposerSectionSettingsHeader` 统一换掉);面板底与卡片保持系统玻璃样式,不改实色,以免丢掉原生 sheet 的玻璃过渡动画。

### 主题接入模式(强制)

样式随主题变化,**不能再用模块级静态 `StyleSheet.create`**。统一两种写法:

```tsx
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { spacing, radius, typeScale, lineHeight } from '@/theme/tokens';

// ① 样式里的颜色:模块级工厂 + hook
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { borderColor: c.border, paddingHorizontal: spacing.lg },
    title: { color: c.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.subtitle },
  });

function Foo() {
  const styles = useThemedStyles(makeStyles);       // 按 scheme 缓存,热路径零分配
  const { colors } = useTheme();                    // ② JSX 内联色
  return (
    <View style={styles.row}>
      <ChevronLeft color={colors.textPrimary} size={iconSize.lg} />
    </View>
  );
}
```

> ⚠️ **`makeStyles` 必须是模块级常量**(身份稳定)。在组件体内内联定义会让 `useThemedStyles` 的 WeakMap 缓存每次 miss,退化成每帧新建 sheet,拖垮 `MessageRenderer` 这类热路径。
> 叶子 helper 函数若要用颜色,把 `colors: ThemeColors` 作为参数传进去,别从模块级 `colors` 取。

### iOS 外壳 vs Cindy 内容

- **任务行滑动（2026-10-24 用户裁决，iOS / Android）**：右滑提供已读与置顶，全滑默认标记已读；左滑提供选项与归档，全滑归档。跨端组合沿用已有方案：已读沿用灵动岛的青绿色单勾（Lucide `Check` / SF Symbols `checkmark`），归档沿用手机版的蓝色归档盒（`Archive` / `archivebox`），置顶为橙色图钉，选项为中性灰省略号。Mobile 的已读底色独立加深以保证白色图标对比度，数值由 `swipeActionRead` 管理；不把灵动岛深色背景上的高亮色直接复制到手机浅色背景。

- **项目标题滑动（iOS / Android）**：仅标题整行横移，展开的子任务不随之移动。左滑露出「新建任务」，超过屏宽 55% 松手打开预填项目电脑与目录的新建页；发送后才创建任务。右滑露出「全部任务」「搜索」，必须点按，搜索限定当前项目并聚焦输入框。点标题继续展开／收起，已有滑开行时先收起操作；自定义排序仍为长按后纵向拖动。项目与任务共用滑动互斥注册表，滚动收行，左屏缘保留返回手势。动作沿用普通任务的圆形到胶囊形态，按钮直径为 56pt，间距使用 spacing.md、图标使用 iconSize.swipeAction；使用双模式 token，并通过标题的无障碍动作提供等价入口。只对有明确电脑和目录的项目启用，不把对话或 Cindy Make 聚合组视为单一目录。实现见 `src/session/SwipeableProjectHeader.tsx`、`HomeSurface.tsx`。
- **首页导航共用组件（2026-10-13，2026-10-24 收为单一首页）**：iOS 首页调用 platform/chrome/HomeStackHeader，统一系统导航栏、菜单按钮与居中标题宽度；顶部模糊背景由首页路由绘制一层。页面只提供标题内容、菜单动作和右侧工具；任务标题保留长名称避让。列表、安全区、滚动指示器和下拉刷新只计算一次顶部占位。手机不再有任务／伙伴两种首页与切换转场，伙伴以任务首页的伙伴段呈现。普通页面、聊天身份栏、面板及 Android 导航暂未纳入这一批，不视为全端迁移完成。

iOS 新增与改造界面遵循 [iOS 原生界面规范](../../../docs/design-rules/ios-native-design.md)。该规范区分系统容器、原生控件和 Cindy 业务内容；取代原先“复杂内容面板一律使用 SheetSurface”的规定。

- 首页和简单页继续使用系统导航栏。任务页采用原生操作控件与透明标题布局，按首页实际导航中心对齐；保留返回锚点及 testID。
- iOS 弹层优先使用系统 BottomSheet，表单和操作分组优先原生 Form / Section 或分组 List。左滑任务选项已有 BottomSheet + List，可参考其关闭生命周期。任务详情与搜索的高度、材质及入口顺序见新规范。
- 消息、Markdown、代码和复杂业务内容可继续用 RN 与主题 token；业务图标保留原有 Lucide。系统导航符号由原生控件提供。不得用“原生外壳”概括成“整页已原生化”。
- 系统管理的圆角、字体、材质与反馈保留系统默认，不强制套自绘圆角档位或零阴影约束；自绘内容继续遵守本文 token 规则。
- 模型／权限、Context、账号切换等存量自绘面板列为渐进迁移项，不因本规范批量重写。Android 与必要兼容回退继续复用现有基础组件，不降低业务能力。
- 首页筛选继续使用原生 UIMenu；左侧抽屉和文件浏览顶部的存量实现不代表已经迁移，需分别审查。
- Android 首页任务行「选项」采用现有 Expo UI 的 Compose `ModalBottomSheet`
  （`SessionActionSheetFrame.android.tsx`）：原生容器负责拖动、遮罩、系统返回与关闭动画，
  任务标题、Lucide 图标和标签操作继续复用 RN 内容及双模式 token。关闭动画完成且容器卸载后，
  才通过 `onClosed` 打开重命名或删除确认；不得用固定延时推测原生动画结束。
  窄屏、横屏和标签展开时内容可滚动，系统容器保留平台几何，自绘内容仍遵守本文排版规则。
  账号切换、权限、标签、消息操作、分支和浏览器菜单等单层面板通过 `SheetModal.nativePresentation`
  复用 Material 容器。折叠屏分区、浮动布局、二级返回与未保存表单继续保留兼容外壳，
  不把不同关闭回调合并。设置、模型、权限和 Context 的普通行保留 RN 实现，
  复用既有主题、排版、禁用态、独立配置按钮与业务回调，不为静态表单逐行嵌套 Compose Host。
  Android 模型目录通过 `FlatList` 按可见范围分批挂载 RN 行，分组标题与模型共用列表；
  使用 `SheetSurface.renderScrollContent` 替换内容滚动层，不能嵌套同向 `ScrollView`。
  搜索或来源变化须滚回首条结果，配置入口与模型选择仍是独立点击目标。
  新建任务的设备、工作区和远程目录选择复用 RN `NewTaskSelectionRow`；设备使用原生底部弹层，
  目录仍在同一兼容弹层内逐级返回，盘符通过原生菜单切换，继续调用被控端目录接口。
  开关和普通文本输入原本已是原生控件；富文本编辑器不属于此次迁移。
- **Android 交互跟随 iOS**（2026-09-27 产品裁决）：入口位置、顺序、分组、显示哪些信息与输入校验以 iOS 为准；外观保持 Android 平台实现，不照搬玻璃。贴着控件弹出的菜单统一走 `NativePullDownMenu`，Android 通过 `AnchoredPullDownMenu.android` 使用现有 Expo UI 的 Material `DropdownMenu`，保留分组标题、勾选、禁用、危险操作、子菜单返回行及 `keepPresented`。弹出定位、滚动、焦点及动画交给系统；外部点击和系统返回收起原生菜单。触发器整块是一个读屏按钮，触发控件禁用时不挂菜单。例外是伙伴私聊气泡的长按菜单：气泡里有引用、链接和横向滚动，菜单不能接管整块触摸，改由调用方用同一个 RNGH 长按手势识别后，以受控方式（`open` / `onOpenChange`）打开 `AnchoredPullDownMenu`。自绘实现保留用于兼容，不使用能力不足的基础 PopupMenu 替代。
  原生菜单首次使用时创建 Compose 容器，随后随触发器复用；收起只修改 `expanded`，保留系统关闭动画，避免每次点击重建整棵原生树。锚点的 RN 外层使用 `pointerEvents="none"`，防止关闭后的容器挡住触发器；弹出窗口独立接收菜单点击。验收必须覆盖关闭后再次打开、外部点击和菜单项选择，不能只验证首次呈现。
  可勾选菜单项在原生弹出窗口中使用 `RNHostView` 承载一个 RN `menuitem`，通过 `accessibilityState.checked` 表达选中、未选中和半选，禁用态与整行点击共用同一节点；勾号只是装饰，不能代替无障碍语义。现有 Compose modifier 未提供完整三态设置，不增加第二个可点击复选框。回归见 `androidMaterialMenu.test.tsx`，模拟器须核验真实节点。

首页「所有任务」下拉只负责范围筛选：点设备名直接切换到该设备的任务，不得为补充管理动作改成设备子菜单或增加一次确认。设备详情、重命名与删除集中在左侧抽屉的「设备管理」页；列表不画进入箭头或重命名图标。所有设备无论在线、离线或未开启远程控制，都能点进资料详情，再重命名或删除；右滑显示重命名、左滑显示删除，删除需系统确认。iOS 使用系统原生列表与滑动操作。删除使用服务端接口，在线设备当前需先离线才能删除，不以本地隐藏代替删除。iOS 原生菜单与自绘回退、Android 遵守同一交互边界。

---

### 伙伴列表行与伙伴卡片(2026-09-29 定稿)

伙伴页的行与聊天里的卡片各有一个共享组件,新入口直接复用,不要另画一套:

- **列表行 `CompanionListRow`**:私聊与群聊同一种行。行高 78,头像 44(群为双人叠放 `BotGroupDuoAvatar`),
  分隔线只画在文字列下方(从 72 到屏幕右缘)、最后一行不画；右上保留时间，第二行显示预览。
  收起头像统一为 48；列表和收起态均在右下角使用 10 实心点 + 2 隔离边，与 Desktop 共用尺寸及判定。
  状态优先级为待确认、异常、工作中、已完成且未读、普通未读、无状态；读到答复后清完成点，阅读不能清待确认点。
  不叠工作外圈或右侧重复蓝点；有准确未读数量时保留数字。离线头像降透明度；同名伙伴加「· 电脑名」。
  首次读取慢时显示同几何的骨架行。
- **聊天顶栏 `ChatIdentityHeader`**:私聊与群聊共用。返回 + 32 标记 + 标题 16/22 600 + 副标题 12/18
  三级色 + 设置;点身份区与设置打开同一份资料 / 设置。私聊副标题保留设备名,离线时前面加「离线 ·」。
  伙伴 Todo 使用顶栏中的独立待办入口,只在宿主返回该能力链接时显示;复用44px玻璃按钮与原身份布局,
  不替代设置,不影响群聊,不新增手机例行任务管理。
- **卡片外壳**:`surfaceElevated` 底 + 1px `border` + `radius.container` + 内边距 16。眉题 13/18 medium 二级色,
  标题 16/22 medium,状态行 13/18 二级色;只有运行中(`statusAccent` 呼吸)与失败(`statusError`)带颜色。
- **卡片按钮 `CompanionCardButton`**:高 38(hitSlop 补到 44)、pill、15/20 medium,**文字始终居中**;一行里等宽
  平分,次要在左、主操作在右;次要按钮用 `surfaceChip` 填充不加描边。不要在卡片里写 `textAlign: 'left'` 的按钮。
- **动效**:新消息与卡片用 `CompanionEntering` / `CompanionFadeIn`(RN `Animated`,原生驱动,只动 opacity /
  transform,系统减弱动效时静止);工作中用 `CompanionPresenceRing` + `ThinkingDots`,不另写循环动画。

### 待发送气泡（2026-10-21 定稿，任务与伙伴私聊共用）

`PendingSendBubble` 是自己刚发出、还没被确认的消息。稿件：`Designs/cindy/send-bubble`（选定 B 方案）。

- **一直是实色**：点发送当帧上屏，与正式气泡同款；网络往返、排队、等电脑都不变灰。只有「正在下方输入框编辑」时淡化。
- **状态只放两处**：气泡左侧图标（转圈 = 发送中 / 上传中，队列图标 = 排队中，时钟 = 等电脑或网络，红色感叹号 `statusError` = 失败），以及气泡下方那一行。送达后正式消息的「复制 / …」占的就是这一行，所以前后行高不变、列表不跳。
- **本机刚发出的消息**：0.6 秒内不出任何状态，慢了才淡入转圈；入场上浮一次，确认时不重播。
- **下方那一行**：排队中「排队中 | 插话 编辑 取消」；失败「未发送 | 重试 删除」，有具体原因时原因写在下面；等待「等电脑连上后发送 | 取消」。文字 13/18，按钮命中区补到 44。报错文字保持黑白（`errorText`），只有左侧图标是红色。
- **带图**：每张图自己转圈；只有那张没传上去的图上显示重传按钮。

## 5. 间距 / 圆角 / 触控 / 安全区

- **间距 `spacing`**:`xs 4 · sm 8 · md 12 · lg 16 · xl 24 · xxl 32`(基数 4)。避免 `2 / 6 / 13 / 17` 这类裸数字;1-2pt 的微调若实在需要,集中、少量、写注释。
- **圆角 `radius`**:四档阶梯——`micro 4` / `control 8` / `container 12` / `pill 9999`(定义与各档用途见 `src/theme/tokens.ts`,守护测试 `designTokenDiscipline.test.ts` 拦截字面量与 token 算术)。**禁止**阶梯外值。
- **触控目标**:主操作命中区 ≥ 44×44(iOS HIG)。可见图标可小(14–18),用 `hitSlop` 或不可见外层把热区补到 44。
- **安全区**:屏幕根用 `SafeAreaView`(react-native-safe-area-context);需要精确 inset 用 `useSafeAreaInsets()`。键盘遮挡用 `KeyboardAvoidingView` + inset,务必开软键盘实测。

---

## 6. 图标

- 库:**lucide-react-native**(统一,不混用其它图标库)。
- **图标选择必须与桌面版保持一致**:同一动作 / 语义,手机和桌面用**同一个** lucide 图标。新增图标前先去桌面对应组件确认它用的是哪个(如权限模式用 `Hand`/`CodeXml`/`ClipboardList`/`Sparkles`/`TriangleAlert`,见桌面 `new-chat/PermissionSelector.tsx`),**不要**另选近似图标(如别用 `Shield` 系列代替)。这样跨端心智模型一致。
  - 已沉淀的对齐映射:权限模式的图标 + 语义色见 `src/session/permissionPresentation.ts`(严格对照桌面 PermissionSelector:`auto`→`permAutoAccent`、`bypassPermissions`→`statusAccent`,其余中性)。
  - **伙伴私聊回复**：消息下方的回复按钮使用 `ChatReplyIcon`，与 Desktop 共用同一款扁圆、下尾的纯气泡路径。复用原「添加到对话」操作，并从伙伴更多菜单移除重复入口；普通任务的「添加到对话」仍用 `MessageSquarePlus`。手机尚未提供的群聊／话题引用回复入口不因此新增。实现见 `src/session/CompanionMessageActions.tsx`。
  - **模型下拉对齐桌面 provider-aware 结构**:同一 model 可挂多家「供应商(来源)」,选行 = 选「来源 + 模型」,选择经 device-link 把 `model + providerId` 路由到被控端。**复用 `@cindy/model-providers` 的 `buildProviderSections` 作分段唯一真相**(`src/session/providerModelSections.ts`),被控端供应商目录经隧道 `maker:provider:list` 取(`src/device-link/useDeviceProviders.ts`);0 供应商 / 旧被控端回退 capabilities 扁平列表。**来源 mark 与桌面同源**:三个内置供应商(Claude / Codex / XD)用官方单色 SVG mark(path 常量在 `src/components/vendorIconPaths.ts`,与桌面 ClaudeMark / CodexMark / XDIncMark 逐字同源),自定义供应商回退首字母 monogram(`MobileProviderMark`)。早期「手机故意不搬品牌 SVG、全用 monogram」的决策已在「模型选择列表与桌面完全对齐」改造(2026-07)中推翻:react-native-svg 本就在依赖里,复制 path 常量零成本,而跨端一眼可辨的来源图标价值更高。唯一保留差异:monogram 容器用 pill 圆角(桌面 4px 方盒)——圆角走 §5 手机圆角阶梯,不引入阶梯外值。
  - **Agent 身份与厂牌分槽**:`MobileAgentMark` / `MobileVendorIcon` 只表示运行时 Agent，使用 Claude Code 像素脸或 Codex CLI `>_` 多瓣花；Anthropic / OpenAI 来源与模型品牌继续由 `MobileProviderMark` / `MobileModelIconMark` 表示。两类 mark 即使名称相近也不得互换。
- **设备「已撤销访问权限」状态**:控制端(手机)被某台被控电脑撤销访问时,设备 chip 用 `Lock` 图标(`colors.textSecondary`)替代状态圆点 —— 与「离线 / 未开启远控」的灰圆点明确区分,读作「被锁在外」,且不引入非调色板色(遵守 §1 灰度 + teal/orange 约束)。**无桌面对端**:桌面是被控方(管理「允许哪些控制器」),没有「控制器被撤销」这一侧视图,故此处不套用「与桌面同图标」规则。点按该 chip 弹 `RevokedAccessTip`(说明 + 「重试访问」),重试复用 device-link 探测路径(成功经 `withAccessRevokedHandling` 清除本地撤销标记);重连 / 回前台也会静默重试自愈。
- 移动端可以比桌面**更省**:紧凑工具栏里的触发器只放图标、不带文字标签(桌面 PermissionSelector 是图标+文字,手机为省空间只留图标);但展开后的下拉面板仍按桌面给出图标 + 文字 + 选中态的完整选项。
- 尺寸走 `iconSize`:`xs 12 · sm 14 · md 16 · lg 18 · xl 22 · xxl 26`(`md`/`lg` 最常用)。避免 17 个散乱尺寸。
- `strokeWidth` 统一约 2。
- 颜色走 token(`colors.textPrimary` / `textSecondary` / `statusAccent` / `permAutoAccent` 等),不写死。
- 会话 Agent 身份图标走 `MobileVendorIcon`；provider / model 厂牌图标分别走 `MobileProviderMark` / `MobileModelIconMark`。
- **底部浮窗按平台承载**：iOS 新增与迁移优先系统 sheet，详情默认中等高度、短工具按内容高度，具体见 iOS 规范。Android 和尚未迁移的兼容实现继续复用 `SheetModal` / `SheetSurface`，不另造自绘外壳；其二级内容保留单 Modal 内导航。不同面板之间等待关闭回调后再呈现，避免叠加遮罩。
- **创建群表单（2026-10-28 用户修正）**：iOS 使用展开的系统 page sheet 与 UIKit 导航栏，正文采用不透底的主题 surface。左侧为系统关闭图标按钮，右侧为文字创建按钮，均保留中性玻璃底；创建不用蓝色或 prominent 填充。标题、按钮几何与交互由导航栏负责，不在内容里用自定义标题行模拟 toolbar。表单可滚动并避让键盘，呈现完成后聚焦群名；有草稿或提交中禁止滑动关闭，显式关闭沿用丢弃确认。

---

## 7. Do / Don't

**Do**
- 页面背景用 `surface`,抬层用 `surfaceElevated`,chip/选中用 `surfaceChip`。
- 圆角按 §5 阶梯选档:交互元素 pill(9999)、卡片 / 容器 12、卡片内层控件 8、微元素 4。
- 颜色 / 字号 / 行高 / 圆角 / 图标尺寸全部走 token。
- 主题色走 `useThemedStyles` / `useTheme`,跟随系统 light/dark。
- 复用 `MobilePrimitives`,优先减法。

**Don't**
- ❌ 写死 hex / rgba / `'Courier'`(dark 下不变色 / 字体不统一)。
- ❌ 未登记的阴影（首页主菜单抽屉例外见 §1）。
- ❌ 阶梯外圆角(0 / 3 / 6 / 28 等)与字面量圆角。
- ❌ UI chrome 字重 > 600(已登记豁免域除外:原生 Markdown strong、登录品牌画布)。
- ❌ 在组件体内内联定义 `makeStyles`(破坏缓存)。
- ❌ 渐变、装饰性插画、品牌色泛滥。

---

## 8. Token 速查 + 选择规则

**背景层选择**:页面=`surface`;浮起的卡片/输入框/弹窗=`surfaceElevated`;chip/pill/选中行=`surfaceChip`;hover/pressed 用透明度(`pressed: { opacity: .72 }`)而非新色。

**文字层级**:主=`textPrimary`;次=`textSecondary`;三级=`textTertiary`;占位字=`textPlaceholder`;深底上的字=`ctaText`(不要用 `surface` 当字色)。主界面中性字色只有这五档,不要新增一次性灰。字重按 §3「字重与字色按角色搭配」选,浅色字不配粗字重。

**CTA**:主操作填充 `cta` + 文字 `ctaText`(dark 自动反相);次要操作用边框 + `textPrimary`。

**字号角色**:见 §3 字号表——短元数据 `caption`、成句说明 `footnote`、次级正文与代码 `bodySmall`(代码配 `monoFont`)、主文字 `body`、对话 `bodyLarge`、列表标题 `subtitle`、页面标题 `title`。

### 迁移 / 新建 checklist
- [ ] 每段文字都能在 §3「文字规范速查」里找到角色,字号 / 行高 / 字重 / 字色整行一致(例外已登记)。
- [ ] 颜色全走 `useThemedStyles(makeStyles)` + `useTheme().colors`,无裸 hex/rgba。
- [ ] `makeStyles` 在**模块级**定义。
- [ ] 字号 / 行高 / 字重 / 圆角 / 图标尺寸全走 token,无裸数字(必要微调写注释)。
- [ ] 等宽用 `monoFont`。
- [ ] 无未登记的阴影（首页主菜单抽屉例外见 §1）、无阶梯外圆角、**UI chrome 字重 ≤ 600**(已登记豁免域除外:原生 Markdown strong `src/session/MessageRenderer.tsx`、登录品牌画布 `app/(auth)/login.tsx` / `src/components/LoginSkinControls.tsx` / `src/auth/loginSkinLayout.ts` —— 这两处保留 `bold '700'`,验收时不要按 ≤ 600 降档)。
- [ ] 复用了 `MobilePrimitives`,没有重复造按钮/卡片/空态。
- [ ] 在模拟器 light + dark(Cmd+Shift+A)都目检过。

---

**交叉引用**:桌面权威规范 `docs/design-rules/DESIGN.md` §2(颜色)/ §3(排版)/ §10(token 架构),设计文档目录见 `docs/design-rules/cindy-design-system.md`。本文是其轻量移动版;色值由移动端独立决定,规则见 `DESIGN.md §15.13`。

### 群邀请 V9（2026-10-28 用户批准）

邀请身份区采用居中 88pt 成员头像集合；1–5 槽沿现有群头像叠放语义，并将可见轮廓居中。
新增 `typeScale.inviteTitle`（22）仅用于邀请群名，配 `lineHeight.listTitle`（28）、semibold；
人数和邀请人仍为 13/18。其他字号角色不改。内容与主操作左右 24pt，输入框外层为 Cindy
50pt 胶囊、内部左右 16pt；编辑、选择、粘贴、清除和键盘由 iOS 原生 TextInput 承担，
胶囊不是 UIKit 默认 borderStyle。输入只用内容高度 detent，大字/横屏使用 large 并可滚动。
加入中保留身份、关闭和修改链接的位置，关闭与修改仅禁用；主 CTA 用不降对比度的原生
ActivityIndicator。未知结果保留原有退出/修改/同 operationId 重试语义。永久或未知有效期
不占位，只有真实有限期显示日期。Android 保留现有键盘适配 sheet，仅复用上述身份和操作。
原生验收由主控统一完成；独立 SwiftUI 设计样张不等于产品 RN 运行证据。
