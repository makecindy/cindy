# Cindy 手机版设计指南

> 状态:权威设计规范。新增 / 修改任何 UI 前先读本文。
> 定位:这是 `docs/design-rules/cindy-design-system.md` 的**轻量移动版**——同一套 Ollama 视觉语言,但不照搬桌面的 351-token ColorRegistry 重型架构。手机端用一套 light/dark 双色板 + 收敛阶梯 + RN 主题 hook。
> 色值与桌面 Ollama Light / Dark **保持一致**,保证跨端观感统一。

---

## 1. 视觉哲学

承接桌面:**灰度为主、零阴影、pill 几何、字重克制**。在此之上叠加移动端约束:

- **iOS 优先**,触控优先,跟随系统 light / dark 自动切换(`useColorScheme`)。
- **灰度环境**:除品牌 teal(就绪态)和 Heart Orange(运行/thinking 态)两个语义色外,界面全是黑白之间的灰阶。不引入任何品牌蓝 / 绿 / 红等装饰色。
- **圆角走四档阶梯**(与 `src/theme/tokens.ts` 的 `radius` 一致,守护测试拦截阶梯外值):`micro`(4,缩略图内 chip、勾选指示器等微元素)/ `control`(8,卡片内层控件)/ `container`(12,卡片 / 容器)/ `pill`(9999,交互元素)。**禁止**阶梯外中间值(0 / 3 / 6 / 28 等)与字面量圆角。根规范 `docs/design-rules/DESIGN.md` §5 的三档制约束的是桌面 surface;其「Mobile」节明确把 §15.13 / §16 之外的 mobile 布局细节委托给 `apps/mobile` 的实现,mobile 圆角阶梯以 `tokens.ts` 为准。
- **零阴影**:层次靠背景色差 + 1px 边框,不用 `shadow*` / `elevation`。
- **字重克制**:只用 400 / 500,极少量大写微标签可用 600。**UI chrome 无 700+**。唯一例外是根规范 `docs/design-rules/DESIGN.md` §3「排版豁免登记表」已登记的域——原生 Markdown strong(`src/session/MessageRenderer.tsx` 的 `markdownStrong` → `fontWeight.bold`)与登录品牌画布(`app/(auth)/login.tsx`、`src/components/LoginSkinControls.tsx`、`src/auth/loginSkinLayout.ts`)。这些是用户内容语义与品牌画布,不算 chrome;chrome 本身的上限仍是 600。
- **手机只做减法**(详见 `mobile-current-execution-plan.md`):主层信息量不超过桌面主层;视觉轻、触控够(可见图标小,hitSlop 补足热区)。

---

## 2. 颜色 token

颜色分两层:**随主题切换的 `ThemeColors`** 与**主题无关的不变量**。组件**永远写 token,不写 hex**(写死 hex 的组件在 dark 下不会变色)。

源:`src/theme/tokens.ts`(`lightColors` / `darkColors` / `palettes`)。

| token | light | dark | 用途 |
|---|---|---|---|
| `surface` | `#f8f8f6` | `#1f1f1e` | 页面背景 |
| `surfaceElevated` | `#ffffff` | `#2c2c2a` | 抬一层:Card / 弹窗 / 输入框 |
| `surfaceTranslucent` | rgba(248,248,246,.78) | rgba(31,31,30,.78) | 吸顶栏半透明 |
| `surfaceChip` | `#e5e5e5` | `#3c3c3a` | chip / pill / 选中行填充 |
| `border` | `#d7d7d4` | `#3c3c3a` | 1px 分隔线 / 边框(桌面 Board) |
| `borderTranslucent` | rgba(215,215,212,.62) | rgba(60,60,58,.62) | 半透明边框 |
| `borderStrong` | `#a3a3a3` | `#525252` | 强调边框 / 次要图标点 |
| `textPrimary` | `#262626` | `#d4d4d4` | 主标题 / 主正文 |
| `textSecondary` | `#525252` | `#a3a3a3` | 次要文字 / 图标 |
| `textTertiary` | `#737373` | `#737373` | 三级文字 / placeholder / metadata |
| `cta` | `#1f1f1f` | `#ffffff` | 主操作填充(**dark 反相为白 pill**) |
| `ctaText` | `#fbfbfa` | `#1f1f1e` | CTA 上的文字 |
| `homeListFab` | `#262626` | `#ECEDEF` | 素雅新建对话 FAB:dark 用柔白而非纯白 cta,避免主入口在深底上过跳 |
| `statusReady` | `#00D9C5` | `#00D9C5` | 就绪 / 在线点(品牌 teal,**语义不变**) |
| `statusAccent` | `#ff6600` | `#ff6600` | 运行 / thinking + 完全访问权限(Heart Orange,**语义不变**) |
| `permAutoAccent` | `#000050` | `#00D9C5` | 自动审批权限模式强调(对齐桌面 `--perm-auto-selected-text`) |
| `errorText` | `#262626` | `#d4d4d4` | 错误文字(跟随 textPrimary) |
| `errorBorder` | `#a3a3a3` | `#525252` | 错误边框(跟随 borderStrong) |
| `overlay` | rgba(38,38,38,.24) | rgba(0,0,0,.45) | modal / lightbox 背板 |

**规则:**
- **语义不变色**(`statusReady` / `statusAccent`)跨 light / dark 一致——它们是状态语义,不随主题漂移。
- **CTA 在 dark 反相为白**:`cta` 白底 + `ctaText` 深字。注意别让白 pill 看起来像 disabled——新增主操作 / 选中态后在 dark 下目检。
- **Home 对话列表用 base token**:列表背景 / 分隔 / 文字使用 `surface` / `border` / `text*`,菜单选中用 `surfaceChip`,不另起暗色调色板;菜单 / FAB 只用 1px `border` 分层、零阴影,保持桌面「单一 flat Surface + 1px Board」哲学。
- 不要在组件里硬编码 hex / rgba;找不到合适 token 时跟维护者确认是否新增,而不是写死。

---

## 3. 字体与排版

排版是过去最乱的一块(各屏自造了 ~19 个字号 + ~13 个行高)。现在收敛到一套阶梯,**优先用 token 不写裸数字**。

源:`src/theme/tokens.ts` 的 `typeScale` / `lineHeight` / `fontWeight` + `src/theme/monoFont.ts`。

### 字号 `typeScale`

| token | px | 典型用途 |
|---|---|---|
| `micro` | 11 | 极小标签 / 路径碎片 |
| `caption` | 12 | metadata / eyebrow / 标签 |
| `footnote` | 13 | 小正文 / 等宽代码块 |
| `code` | 15 | inline code / 命令 |
| `body` | 16 | 主正文 / 导航 |
| `subtitle` | 18 | 副标题 / 强调正文 |
| `title` | 20 | 页面 / 区块标题 |
| `headline` | 24 | 大标题 / metric 数值 |
| `hero` | 40 | 大空状态 / splash |

### 行高 `lineHeight`(与字号配对)

`caption 18` ·`code 20` ·`body 22` ·`subtitle 26` ·`headline 30`。

### 字重 `fontWeight`

`regular '400'` · `medium '500'`(默认) · `semibold '600'`(仅限大写微标签等少量强调) · `bold '700'`(**仅限已登记豁免域**,见下)。**UI chrome 不超过 600。**

`bold '700'` 只允许用在根规范 `docs/design-rules/DESIGN.md` §3「排版豁免登记表」登记的两处:原生 Markdown strong(`src/session/MessageRenderer.tsx` 的 `markdownStrong`)与登录品牌画布(`app/(auth)/login.tsx`、`src/components/LoginSkinControls.tsx`、`src/auth/loginSkinLayout.ts`)。除此之外一律不得使用 700,新增用途必须先改根规范的登记表。

### 等宽 `monoFont`

`Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })`。**禁止**写死 `'Courier'`。

### 旧值 → 新 token 映射(迁移时套用)

- 字号:`10→micro` ·`14→footnote` ·`17→body` ·`22/23/28→headline`。
- 行高:`16→caption(18)` ·`20→body(22)或 code(20)` ·`23→body(22)` ·`24/25/26→subtitle(26)` ·`28/30/31→headline(30)`。
- 字重:`'700'→semibold('600')`(仅大写微标签,否则 `'500'`)。**已登记豁免域除外**(原生 Markdown strong、登录品牌画布)——那两处保留 `bold '700'`,不要按此条降档。
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
- **底部浮窗统一走 SheetSurface 模式**:可拖动底部浮窗(把手 half/full/下拉 dismiss)的「面板表面」抽在 `src/session/SheetSurface.tsx`(grabber + header + pinnedTop/footer 插槽 + 滚动区 + `useContextSheetDrag` 拖动编排,snap 受控)。单层浮窗 = Modal + backdrop + 一层 Surface(`ContextSheet` 即此薄壳);需要「浮窗上再叠一层」时**不要嵌套 Modal**(iOS 同级双 Modal 第二个不显示、Android 每个 Modal 是独立原生 Dialog、返回键派发不可控),在**同一个 Modal 里叠第二层 Surface**(translateY 滑入 + 自带加深 backdrop + 返回两段式),先例见 `ModelPickerSheet`(模型列表一级 + 模型选项/权限二级,视图状态机在 `modelPickerSheetModel.ts` 可单测)。新浮窗一律复用 SheetSurface,不再手写 sheet 结构。

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

**文字层级**:主=`textPrimary`;次=`textSecondary`;三级/placeholder=`textTertiary`。

**CTA**:主操作填充 `cta` + 文字 `ctaText`(dark 自动反相);次要操作用边框 + `textPrimary`。

**字号角色**:正文 `body`;标题 `title`/`headline`;metadata/标签 `caption`;代码 `code`/`footnote` + `monoFont`。

### 迁移 / 新建 checklist
- [ ] 颜色全走 `useThemedStyles(makeStyles)` + `useTheme().colors`,无裸 hex/rgba。
- [ ] `makeStyles` 在**模块级**定义。
- [ ] 字号 / 行高 / 字重 / 圆角 / 图标尺寸全走 token,无裸数字(必要微调写注释)。
- [ ] 等宽用 `monoFont`。
- [ ] 无 `shadow*` / `elevation`、无中间圆角、**UI chrome 字重 ≤ 600**(已登记豁免域除外:原生 Markdown strong `src/session/MessageRenderer.tsx`、登录品牌画布 `app/(auth)/login.tsx` / `src/components/LoginSkinControls.tsx` / `src/auth/loginSkinLayout.ts` —— 这两处保留 `bold '700'`,验收时不要按 ≤ 600 降档)。
- [ ] 复用了 `MobilePrimitives`,没有重复造按钮/卡片/空态。
- [ ] 在模拟器 light + dark(Cmd+Shift+A)都目检过。

---

**交叉引用**:桌面 `docs/design-rules/cindy-design-system.md` §2(颜色)/ §3(排版)/ §10(token 架构)。本文是其轻量移动版,色值跟随桌面 Ollama Light / Dark。
