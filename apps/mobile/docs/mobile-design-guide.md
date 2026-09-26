# Cindy 手机版设计指南

> 状态:权威设计规范。新增 / 修改任何 UI 前先读本文。
> 定位:这是 `docs/design-rules/cindy-design-system.md` 的**轻量移动版**——共享 Cindy 品牌与业务语义,但不照搬桌面的 ColorRegistry 重型架构。手机端用一套 light/dark 双色板 + 收敛阶梯 + RN 主题 hook。
> 色值由移动端**独立决定**(2026-09-26 起为「象牙白」色板,见 `DESIGN.md §15.13`):语义与桌面一一对应,具体色阶、对比度与暖度不与桌面同步。

---

## 1. 视觉哲学

承接桌面:**灰度为主、零阴影、pill 几何、字重克制**。在此之上叠加移动端约束:

- **iOS 优先**,触控优先,跟随系统 light / dark 自动切换(`useColorScheme`)。
- **灰度环境**:除品牌 teal(就绪态)、Heart Orange(运行/thinking 态)和已登记的 Beta 渠道红色状态徽标外,界面全是黑白之间的灰阶。不引入任何品牌蓝 / 绿 / 红等装饰色。
- **圆角走四档阶梯**(与 `src/theme/tokens.ts` 的 `radius` 一致,守护测试拦截阶梯外值):`micro`(4,缩略图内 chip、勾选指示器等微元素)/ `control`(8,卡片内层控件)/ `container`(12,卡片 / 容器)/ `pill`(9999,交互元素)。**禁止**阶梯外中间值(0 / 3 / 6 / 28 等)与字面量圆角。根规范 `docs/design-rules/DESIGN.md` §5 的三档制约束的是桌面 surface;其「Mobile」节明确把 §15.13 / §16 之外的 mobile 布局细节委托给 `apps/mobile` 的实现,mobile 圆角阶梯以 `tokens.ts` 为准。
- **零阴影**:层次靠背景色差 + 1px 边框,不用 `shadow*` / `elevation`。
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
| `betaChannelBadgeBackground` | `#DF0C27` | `#DF0C27` | Beta 渠道开关已打开时,当前版本旁的状态徽标底色 |
| `betaChannelBadgeForeground` | `#FFFFFF` | `#FFFFFF` | Beta 渠道状态徽标文字,与底色对比度 4.98:1 |
| `permAutoAccent` | `#417CDD` | `#417CDD` | 自动审批权限模式强调 |
| `errorText` | `#0F0F0F` | `#EDEDED` | 错误说明文字(跟随 textPrimary) |
| `errorBorder` | `#858581` | `#8A8A8A` | 错误边框(跟随 borderStrong) |
| `overlay` | rgba(38,38,38,.35) | rgba(0,0,0,.45) | modal / lightbox 背板 |

**规则:**
- **语义不变色**(`statusReady` / `statusAccent` / `betaChannelBadgeBackground` / `betaChannelBadgeForeground`)跨 light / dark 一致——它们是状态语义,不随主题漂移。Beta 红色只用于设置页当前版本旁的渠道徽标,不得扩展为装饰色、错误色或 CTA。
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

**登记例外**(只有这些可以偏离上表,新增例外先改本节):首页列表与队友行的节奏行高(18/28、15/26、13/22);代码 / diff 的紧凑行高;对话 Markdown 标题与长文 24 行高;与相邻图标 / 按钮对齐的文字;行内强调(Markdown strong 700、搜索命中、价格折扣);登录品牌画布(见根规范 §3 豁免表)。

**机器会拦什么**:阶梯外字号 / 行高 / 字重与裸数字、缺行高、浅色字配粗字重(`typographyTokenDiscipline.test.ts`);字号阶梯本身、文字三档与占位字对比度、深浅双模式同键(`themeTokens.test.ts`)。**拦不住、靠 review 的**:角色选错(比如把说明文字放 12 号、把标题写成 500)、例外被滥用。评审时对照上表逐行看。

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

另有一类**对齐例外**:文字要与相邻图标、按钮或行内正文对齐时,行高跟随被对齐对象(如行内引用 chip、任务标签、消息操作行的时间、生成中状态、伙伴记忆日期)。

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

iOS 新增与改造界面遵循 [iOS 原生界面规范](../../../docs/design-rules/ios-native-design.md)。该规范区分系统容器、原生控件和 Cindy 业务内容；取代原先“复杂内容面板一律使用 SheetSurface”的规定。

- 首页和简单页继续使用系统导航栏。任务页采用原生操作控件与透明标题布局，按首页实际导航中心对齐；保留返回锚点及 testID。
- iOS 弹层优先使用系统 BottomSheet，表单和操作分组优先原生 Form / Section 或分组 List。左滑任务选项已有 BottomSheet + List，可参考其关闭生命周期。任务详情与搜索的高度、材质及入口顺序见新规范。
- 消息、Markdown、代码和复杂业务内容可继续用 RN 与主题 token；业务图标保留原有 Lucide。系统导航符号由原生控件提供。不得用“原生外壳”概括成“整页已原生化”。
- 系统管理的圆角、字体、材质与反馈保留系统默认，不强制套自绘圆角档位或零阴影约束；自绘内容继续遵守本文 token 规则。
- 模型／权限、Context、账号切换等存量自绘面板列为渐进迁移项，不因本规范批量重写。Android 与必要兼容回退继续复用现有基础组件，不降低业务能力。
- 首页筛选继续使用原生 UIMenu；左侧抽屉和文件浏览顶部的存量实现不代表已经迁移，需分别审查。

首页「所有任务」下拉只负责范围筛选：点设备名直接切换到该设备的任务，不得为补充管理动作改成设备子菜单或增加一次确认。设备详情、重命名与删除集中在左侧抽屉的「设备管理」页；列表不画进入箭头或重命名图标。所有设备无论在线、离线或未开启远程控制，都能点进资料详情，再重命名或删除；右滑显示重命名、左滑显示删除，删除需系统确认。iOS 使用系统原生列表与滑动操作。删除使用服务端接口，在线设备当前需先离线才能删除，不以本地隐藏代替删除。iOS 原生菜单与自绘回退、Android 遵守同一交互边界。

---

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
  - **模型下拉对齐桌面 provider-aware 结构**:同一 model 可挂多家「供应商(来源)」,选行 = 选「来源 + 模型」,选择经 device-link 把 `model + providerId` 路由到被控端。**复用 `@cindy/model-providers` 的 `buildProviderSections` 作分段唯一真相**(`src/session/providerModelSections.ts`),被控端供应商目录经隧道 `maker:provider:list` 取(`src/device-link/useDeviceProviders.ts`);0 供应商 / 旧被控端回退 capabilities 扁平列表。**来源 mark 与桌面同源**:三个内置供应商(Claude / Codex / XD)用官方单色 SVG mark(path 常量在 `src/components/vendorIconPaths.ts`,与桌面 ClaudeMark / CodexMark / XDIncMark 逐字同源),自定义供应商回退首字母 monogram(`MobileProviderMark`)。早期「手机故意不搬品牌 SVG、全用 monogram」的决策已在「模型选择列表与桌面完全对齐」改造(2026-07)中推翻:react-native-svg 本就在依赖里,复制 path 常量零成本,而跨端一眼可辨的来源图标价值更高。唯一保留差异:monogram 容器用 pill 圆角(桌面 4px 方盒)——圆角遵守手机二元规则,不引入中间值。
  - **Agent 身份与厂牌分槽**:`MobileAgentMark` / `MobileVendorIcon` 只表示运行时 Agent，使用 Claude Code 像素脸或 Codex CLI `>_` 多瓣花；Anthropic / OpenAI 来源与模型品牌继续由 `MobileProviderMark` / `MobileModelIconMark` 表示。两类 mark 即使名称相近也不得互换。
- **设备「已撤销访问权限」状态**:控制端(手机)被某台被控电脑撤销访问时,设备 chip 用 `Lock` 图标(`colors.textSecondary`)替代状态圆点 —— 与「离线 / 未开启远控」的灰圆点明确区分,读作「被锁在外」,且不引入非调色板色(遵守 §1 灰度 + teal/orange 约束)。**无桌面对端**:桌面是被控方(管理「允许哪些控制器」),没有「控制器被撤销」这一侧视图,故此处不套用「与桌面同图标」规则。点按该 chip 弹 `RevokedAccessTip`(说明 + 「重试访问」),重试复用 device-link 探测路径(成功经 `withAccessRevokedHandling` 清除本地撤销标记);重连 / 回前台也会静默重试自愈。
- 移动端可以比桌面**更省**:紧凑工具栏里的触发器只放图标、不带文字标签(桌面 PermissionSelector 是图标+文字,手机为省空间只留图标);但展开后的下拉面板仍按桌面给出图标 + 文字 + 选中态的完整选项。
- 尺寸走 `iconSize`:`xs 12 · sm 14 · md 16 · lg 18 · xl 22 · xxl 26`(`md`/`lg` 最常用)。避免 17 个散乱尺寸。
- `strokeWidth` 统一约 2。
- 颜色走 token(`colors.textPrimary` / `textSecondary` / `statusAccent` / `permAutoAccent` 等),不写死。
- 会话 Agent 身份图标走 `MobileVendorIcon`；provider / model 厂牌图标分别走 `MobileProviderMark` / `MobileModelIconMark`。
- **底部浮窗按平台承载**：iOS 新增与迁移优先系统 sheet，详情默认中等高度、短工具按内容高度，具体见 iOS 规范。Android 和尚未迁移的兼容实现继续复用 `SheetModal` / `SheetSurface`，不另造自绘外壳；其二级内容保留单 Modal 内导航。不同面板之间等待关闭回调后再呈现，避免叠加遮罩。

---

## 7. Do / Don't

**Do**
- 页面背景用 `surface`,抬层用 `surfaceElevated`,chip/选中用 `surfaceChip`。
- 交互元素 pill(9999),容器 12,二选一。
- 颜色 / 字号 / 行高 / 圆角 / 图标尺寸全部走 token。
- 主题色走 `useThemedStyles` / `useTheme`,跟随系统 light/dark。
- 复用 `MobilePrimitives`,优先减法。

**Don't**
- ❌ 写死 hex / rgba / `'Courier'`(dark 下不变色 / 字体不统一)。
- ❌ `shadow*` / `elevation`(零阴影)。
- ❌ 中间圆角(0 / 3 / 4 / 8 / 28)。
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
- [ ] 无 `shadow*` / `elevation`、无中间圆角、**UI chrome 字重 ≤ 600**(已登记豁免域除外:原生 Markdown strong `src/session/MessageRenderer.tsx`、登录品牌画布 `app/(auth)/login.tsx` / `src/components/LoginSkinControls.tsx` / `src/auth/loginSkinLayout.ts` —— 这两处保留 `bold '700'`,验收时不要按 ≤ 600 降档)。
- [ ] 复用了 `MobilePrimitives`,没有重复造按钮/卡片/空态。
- [ ] 在模拟器 light + dark(Cmd+Shift+A)都目检过。

---

**交叉引用**:桌面 `docs/design-rules/cindy-design-system.md` §2(颜色)/ §3(排版)/ §10(token 架构)。本文是其轻量移动版;色值由移动端独立决定,规则见 `DESIGN.md §15.13`。
