# @cindy/design-tokens

Cindy 设计 token 的 **DTCG 影子层**（reference → semantic → component）。

本包只是字典，**零运行时接线**：Desktop / Mobile / 任何产品 package 都不得依赖它。Desktop 生产生成切换在路线图 **DS-8**，Mobile 在 **DS-10**；切换前各端仍从原生产源取值，本包的当前色值必须与 DS-2b 冻结快照逐值一致。标准组件已经存在不代表本包已被生产消费。

## 弃坑条款

治理合同 §7：影子包在约定复查期内没有真实消费者时应删除。

- **复查日期：2026-11-01**
- DS-4 / [#3920](https://github.com/makecindy/cindy/pull/3920) 已合入，薄 component 层随 Button 建立；DS-4b / [#4010](https://github.com/makecindy/cindy/pull/4010) 已合入，仅恢复设置输入局部主题覆盖，不代表全仓 alias 已收口。零运行时接线红线仍到 DS-8。
- 届时若仍无生产生成切换且无人维护，按治理合同 §7 评估是否删除

## 当前数据源

影子字典分类与建层的唯一数据源是 DS-2b 冻结快照：

`apps/desktop/src/renderer/themes/__tests__/fixtures/desktop-color-defaults.json`

不重新解析 `colors.ts`。重新生成：在本包目录执行 `pnpm generate`（脚本 `src/generate.ts`）。连续两次生成必须字节一致。守卫测试会核对。

## 三层

| 层 | 路径 | 内容 |
| --- | --- | --- |
| reference | `src/reference/color.json` | semantic / component 角色实际引用的原始色值（不铺全色板） |
| semantic | `src/semantic/color.json` | DESIGN.md §10 Tier-1 的 surface / border / text / accent 四族 + status 语义；每个角色 light/dark = 冻结快照现值 |
| component | `src/component/color.json` | DS-4 起随消费组件建立。**刻意很薄**：DS-4 的 Button hover / pressed 是 `color-mix` 运行期派生值（暗色下 `--surface-hover` 与 `--surface-chip` 同值，alias 会让悬停不可见），按治理合同 §3.4 只在 `classification.json` 登记、不建模；本层只收 `button-cta-hover` 这类能落回 semantic 的纯 alias |

依赖单向：component → semantic → reference。不装 Terrazzo（DS-8）。

色值一律用标准 DTCG 颜色对象（`$type: "color"` + `{colorSpace, components[, alpha]}`）：
HSL triplet（`60 12.5% 97%`）→ `{"colorSpace":"hsl","components":[60,12.5,97]}`；
hex / rgba / transparent → srgb 分量（0–1）+ 可选 alpha。不用自定义 `$type`
（`"other"` 不是标准 DTCG 类型——Terrazzo 2.7.1 实测会静默丢弃这类 token，
DS-8 接线时无法生成 CSS 变量；裸 triplet 字符串也会被解析成黑色）。

加严保护值按治理合同 §1.1 标记 **protected**，分两种 mode：Tier-1 slot（U2 二级信息色 `text-secondary` / `text-secondary-cross`）按 §3.2「名称与用途延续」**照常 semantic 建模** + protected 元数据——保护限制的是改值须经裁决，不是禁止迁移；Tier-3 singleton（`annotation-accent`、CINDY 皮肤族品牌红 `login-brand-accent` / `login-brand-accent-pressed`）按「保留原位，逐项裁决，默认不动」只登记、不建模。皮肤族其余值在 cindy-light/dark 主题 override 里，不在本快照默认值中。

语义豁免色（DESIGN.md §10 theme-invariant 族：`destructive` / `error-*` / `warning-*` / `focus-ring*`）与 protected 不同：**照常 semantic 建模**，但在 `classification.json` 携带 `exemption` 元数据（外部主题不可覆盖、跨主题恒定）。DS-8 生成主题入口时据此区分可覆写 semantic 与必须保留原值的豁免族；治理合同 §3.2 要求 Tier-3 豁免色按此迁移。DESIGN.md §10 豁免表其余未建模项（`diff-*` / `login-error-fg` 等）进 shadow 层时再登记。

## 生产接管合同（目标，尚未接线）

当前生产数值权威与影子字典须分开理解：

| 范围 | 当前上游 | 接管边界 |
| --- | --- | --- |
| Desktop 颜色 | [colors.ts](../../apps/desktop/src/renderer/themes/colors.ts) 默认注册 + [builtin](../../apps/desktop/src/renderer/themes/builtin/) 内置主题覆盖；用户主题按 [theme-service.ts](../../apps/desktop/src/renderer/themes/theme-service.ts) 优先读取本地显式值 | DS-8 逐族接管默认值与需要集中维护的内置静态覆盖，保留旧 ID、默认 alias 与局部覆盖作用域；不覆盖用户主题或回写磁盘 |
| Desktop 非颜色 | [globals.css](../../apps/desktop/src/renderer/styles/globals.css)、[tailwind.config.ts](../../apps/desktop/tailwind.config.ts)、[useFontSettings.ts](../../apps/desktop/src/renderer/hooks/useFontSettings.ts) 及实际组件局部样式 | DS-8 将真实需要的排版、间距、圆角/尺寸、动效静态值纳入现有三层；字号缩放、compact、color-mix 等运行期计算留代码 |
| Mobile 颜色 / 非颜色 | [tokens.ts](../../apps/mobile/src/theme/tokens.ts)，[ThemeProvider.tsx](../../apps/mobile/src/theme/ThemeProvider.tsx) 选模式；局部布局与平台字体/计算仍在消费者和适配文件 | DS-10 从同一 DTCG 生成共享语义 + Mobile 静态覆盖；`tokens.ts` 只留现有 API / 适配，不手写另一份同义数值 |
| 影子字典 | DS-2b `desktop-color-defaults.json` fixture → `src/generate.ts` → 当前三层 JSON | DS-8 接管族改为 DTCG 上游，fixture 退为独立回归预期，禁止继续从测试快照反向生成生产真相 |

转换须在同一批的真实消费链完成：逐族记录旧源、DTCG 唯一可编辑源、输出、消费者和未切换项。已接管族的旧手写源改为适配/生成消费；未切换族继续保留原权威，保护 singleton 必须逐项说明保留原因，不宣称已全量集中。

- 当前零接线守卫继续运行，本批不删改。DS-8 按实际接管范围，将对应的“不得消费”断言转换为生成新鲜度、逐值/逐主题一致、真实加载至组件消费和旧 ID/局部覆盖/加载幂等/磁盘不变断言；未接管范围仍禁止提前接线。DS-10 同样只转换 Mobile 对应边界，不能一次删除所有零接线保护。
- Terrazzo 继续锁 **2.7.1**，到 DS-8 有生产输出时才安装；同一 DTCG 解析/生成流程，不并装第二套 Token 工具。
- 生成文件不可手改；DESIGN 中精确值摘要也由同一流程更新明确标记的区域，规则说明仍人工维护。下表仅说明落点，当前未新建这些目录。

| 消费者 | 拟定输出 / 职责 | 阶段 |
| --- | --- | --- |
| Desktop ColorRegistry | `apps/desktop/src/renderer/themes/generated/` 提供默认/内置静态数据，原注册与主题加载 API 保留；内置覆盖源拟放本包 `src/themes/` | DS-8 |
| CSS 非颜色变量 | `apps/desktop/src/renderer/styles/generated/tokens.css`；颜色仍由主题加载器注入，避免两处手写 | DS-8 |
| Tailwind / 字号缩放 | `styles/generated/token-mappings.ts` 提供数值子集；现有 Tailwind 色名继续映射主题 CSS 变量 | DS-8 |
| Mobile TS | `apps/mobile/src/theme/generated/tokens.ts`；本包 `src/platforms/mobile/` 维护必要静态平台覆盖，单向引用共享用途角色，不强加包依赖 | DS-10 |
| DESIGN 机器摘要 | §10 Tier-1 与 §16.1 登录表、需要展示的非颜色摘要由同一流程生成 | DS-8 对应族接管时 |

Mobile 是否触发冷更，以实际 runtime fingerprint 输入变化为准，**不能仅因使用 TS 生成子集就宣称必然冷更，也不能预先宣称一定没有冷更**。若改变指纹，按 [Mobile 冷更边界](../../docs/dev-rules/mobile-development.md) 和治理 §4 单列高风险改动，经指定把关人针对冷更明确确认后才能合并。

## 双端语义样本（源码核对，角色拟定）

采样：**2026-09-07，main `36638ff33ca8b28e259b247a47054a696d6c4ee4`**。本节是用途与消费链合同，不是精确值维护表；源码数值仍以上述现行上游为准。未启动 Desktop / iOS / Android，Light/Dark 实机均未验证；不将源码核对算作视觉验收。

生产链已穿透：

- **D 输入**：[CCAgentSessionView:5101](../../apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx#L5101) → [ChatInput](../../apps/desktop/src/renderer/components/new-chat/ChatInput.tsx) → [SendButton:45](../../apps/desktop/src/renderer/components/new-chat/SendButton.tsx#L45)。
- **M 输入**：[会话页:10443](../../apps/mobile/app/sessions/[sessionId].tsx#L10443) → [MobileComposerInputRow:318](../../apps/mobile/src/session/MobileComposerInputRow.tsx#L318) → [ComposerRichInput](../../apps/mobile/src/session/ComposerRichInput.tsx) → [composerRichInputHtml](../../apps/mobile/src/session/composerRichInputHtml.ts)。该页传 `inputElement`，实际走 WebView；InputRow 原生 TextInput 是 fallback。发送仍在会话页 `renderComposerSendSlot`（:6813）。
- **D 正文**：[CCAgentSessionView:4391](../../apps/desktop/src/renderer/features/cc-agent/CCAgentSessionView.tsx#L4391) → [MessageStream:5912](../../apps/desktop/src/renderer/components/chat/MessageStream.tsx#L5912) → [UserMessage:1546](../../apps/desktop/src/renderer/components/chat/UserMessage.tsx#L1546) / [AssistantMessage:323](../../apps/desktop/src/renderer/components/chat/AssistantMessage.tsx#L323)。助手正文继续进入 [MarkdownRenderer](../../apps/desktop/src/renderer/components/chat/MarkdownRenderer.tsx)；用户正文为 `renderContent` 的文字/链接/引用/chip，不走该 Markdown 样式。
- **M 正文**：[会话页:9076](../../apps/mobile/app/sessions/[sessionId].tsx#L9076) → [MessageRenderer:4823](../../apps/mobile/src/session/MessageRenderer.tsx#L4823)，正文样式由该组件生成（:7698），页面另传外围样式。流式与完成态均走原生 Markdown；iOS 可选文字走 UITextView，其他情况走 RN Text（:499—547），不是 `selectableMarkdownHtml`。

下表 D 颜色上游统一指 `colors.ts` + 内置/用户覆盖，D 非颜色指 globals / Tailwind / 字号缩放及列出的局部代码；M 颜色指 `tokens.ts` palettes → ThemeProvider，M 非颜色指 tokens 与列出的平台适配。**共享候选仅表示用途可复用，不表示两端值等价**。`composer.*` / `message.*` 均为拟定 component 角色，`typography.*` 为拟定 semantic 角色；本批不创建 JSON、不替换已存在 ID。

| 用途 / 拟定角色 ID | Desktop 当前消费者 / 引用 | Mobile 当前消费者 / 引用 | 分类、理由与实施落点 |
| --- | --- | --- | --- |
| 输入文字 `composer.text` | ChatInput:2144—2145 → `chat-input-text`；colors:839 是独立默认，非 `text-primary` alias | 会话页:10490 → `colors.textPrimary` → HTML:93/59 的 `--text` | 共享用途候选，默认不等价；D 保留局部 ID，M 保留平台值；DS-8/10 分别生成，不能统一配色 |
| 占位 `composer.placeholder` | globals:397 / ChatInput:8451 → `chat-input-placeholder-subtle`；colors:835 从 `chat-input-placeholder`（默认 `text-placeholder`）color-mix 派生 | 会话页:10489 → `textTertiary` → HTML:68/95；原生 fallback 才用 `placeholderTextColor` | 共享用途 + D 运行期透明度派生；只将基础静态角色入源，混合逻辑留代码，DS-8/10 |
| 输入背景 `composer.surface` | ChatInput:8116/8163 → `chat-input-bg`，默认 `surface-elevated` | InputRow:542 → `chatCodeSurface`；WebView 背景透明 | 共享用途 + 平台覆盖；M `theme.background` 虽传入但 HTML 未消费，不能当生产证据；DS-8/10 保留现状 |
| 输入外边框 `composer.border` | ChatInput:8117/8164 → `chat-input-border`，默认 `border-default` | InputRow:543—545 → `sheetActionBorder` + 原生 hairline | 共享用途 + 静态平台色 / 运行期像素适配；HTML `theme.border=colors.border` 只画 chip 边框；DS-8/10 不混淆作用域 |
| 焦点描边 `composer.focusBorder` / 光标 `composer.caret` | ChatInput:8119/8166 → `chat-input-border-focus`（默认 `text-tertiary`，CINDY 有透明度覆盖）；globals:127/414 → `caret-accent` | 会话页:10488 → `inputCaret` → HTML:59/98 caret-color；outline:none；原生 fallback 用 cursorColor/selectionColor | 光标用途共享，焦点边框保留平台差异；M 字段名 focus 不代表 focus ring。聊天描边也不是通用 Input 环；DS-8/10 等值保留，新增焦点观感须裁决 |
| 输入排版 `typography.composer` | ChatInput:2144 → `text-15 leading-[1.467]`；globals `--text-15` 与 compact 派生 | HTML:59—66 → [composerTextMetrics](../../apps/mobile/src/session/composerTextMetrics.ts):21—26 的 `typeScale.code` / `lineHeight.body` | 共享用途，平台排版/缩放保留；输入并非 M 正文 bodyLarge。DS-8/10 将静态基础纳源，缩放/compact 留代码 |
| 输入尺寸/间距 `composer.geometry` | ChatInput:8115 卡片圆角与 padding、输入高度在组件内 | InputRow:544 单行 pill、:558—559 multiline 专用圆角、:566—569 card `radius.control`；composerTextMetrics:45—55 的平台上下 padding | 平台静态覆盖 + 展开/屏幕/光学运行期计算；D/M 不强制同几何。DS-8/10 纳入被选静态值；动态规则保留，新增外观待裁决 |
| 发送可用 `composer.send.surface` / `.text` / `.hover` / `.pressed` | SendButton:55—57 → `send-btn-bg/icon/hover-bg/pressed-bg`；colors:1011 起 | 会话页:11646/6838 → `cta/ctaText`；:6826/11663 `sendButtonPressed` 由 RouteActionButton:10850—10852 在按下时叠 opacity 0.86；发送中 indicator 独立读 `textSecondary` | 共享动作用途，M 无对应 hover，pressed 通过透明度表达；保留旧局部覆盖，DS-8/10 |
| 发送禁用 `composer.send.disabledSurface` / `.disabledText` / `.disabledOpacity` | SendButton:59 在 `disabled && !isStreaming` 时仍读可用色，加 opacity-40；**不消费**注册的 `send-btn-disabled-bg/icon` | 会话页:11656/6838 读 `surfaceChip/border/textSecondary`，通用禁用样式:11664 再叠 opacity 0.45 | 共享状态用途，派生方式不等价；静态透明度候选与状态条件分开，DS-8/10 保留真实效果，不按 registry 猜接线 |
| 发送触控 `composer.send.geometry` | SendButton:54 会话 h-7/w-7，新建入口另有 30px；pill | 会话页:11646—11654 为 34×34 / `radius.pill`；:6823 引用 :639 的 `COMPOSER_CONTROL_HIT_SLOP` 扩点击区，仍受 InputRow 父布局边界限制 | 平台几何覆盖；DS-10 按触控与无障碍保持 M 命中区域，不能套用 D 图标按钮尺寸；不以相同圆形推断同尺寸 |
| 用户 / 助手正文 `message.user.text` / `message.assistant.text` | UserMessage:1551 → `msg-user-text`，AssistantMessage:324 → `msg-assistant-text`；colors:1255/1259 默认都 alias `text-primary` | MessageRenderer:7698 → `colors.textPrimary`（用户/助手共用正文样式） | 共享正文用途，D 两个局部覆盖必须各自保留，不能抬升为全局或删除；DS-8 接源、DS-9 核真实消费、DS-10 接 M |
| 正文排版 `typography.messageBody` | UserMessage:1550 / AssistantMessage:323 → `text-15 leading-[1.6]`，受用户字号和 compact（globals:330）影响 | MessageRenderer:7698 → `typeScale.bodyLarge/lineHeight.bodyLarge`（当前 17/26） | 共享用途 + 平台静态覆盖与缩放；用途一致不等于像素一致，DS-8/10 等值接管，DS-9 验证 D 长文与流式 |
| 行内代码 `message.inlineCode.text` / `.surface` / `typography.inlineCode` | 仅助手 MarkdownRenderer:285/1785 → 继承正文颜色，`msg-md-inline-code-bg`、`font-mono text-14`、局部圆角；上游 colors:1301 / Tailwind fontFamily | MessageRenderer:7964—7974 → `chatInlineCodeText`、`typeScale.code/lineHeight.code`、[monoFont](../../apps/mobile/src/theme/monoFont.ts)，有意无底色 | 用途共享、外观/字体平台覆盖；M 原生嵌套 Text 圆角限制已有代码说明。DS-9 保留 D 局部色、DS-10 保留 M 无底色；改观感须先裁决，字体平台选择仍在代码 |

### 平台覆盖的唯一来源与责任

上述每个需保持 Mobile 静态差异的候选角色，拟在同一 DTCG 的 `src/platforms/mobile/` 下以 `platform.mobile.<上述角色 ID>` 登记覆盖关系（例如 `platform.mobile.typography.messageBody`、`platform.mobile.composer.border`），单向引用共享用途角色，再生成 Mobile 子集；共享角色不反向依赖平台层。现有 DTCG key 风格/旧 ID 不改名，新角色最终命名与类型随 DS-8/10 建模核对。这些 **候选 ID 尚不存在**，表中当前代码是采样依据，不是第二份未来可编辑源。

DS-10 至少逐项登记：输入/正文/行内代码排版、输入框/发送几何与触控、输入背景/外边框/光标、可用与禁用发送色和透明度；各项记录引用的共享角色、覆盖理由、唯一源与输出。行内代码无底色、无独立焦点描边、鼠标态无对应原生态等“没有该效果”的平台行为留代码登记，不能为了填满 Token 表制造数值。`radius.micro/control` 的用途不能机械对应 Desktop 三档。

静态与动态须分开：composerTextMetrics:30/36 的基础 padding/offset、触控尺寸与断点等静态常数是平台覆盖候选，DS-10 纳入唯一上游；:45—55 的平台选择、加减计算，以及屏宽/展开状态的分支留代码，不能以“平台适配”为由永久手写第二份静态值。主题切换通过 ComposerRichInput:128—145/175—177 的 `setConfig` → HTML:92—98 更新 CSS 变量，不重建初始 HTML。

运行期适配仍留代码：主题选择/注入、color-mix、字号缩放/compact、iOS/Android 字体选择与输入光学 padding、hairline、展开与屏幕触控布局。工程责任由相应 DS-8/10 执行者在开工时认领，视觉决定由用户/设计师作出；本次核对人为 DS-5 执行者 Codex，未据此认领长期 surface owner。未决与最晚阻塞阶段集中见 [治理 §10](../../docs/design-rules/design-governance.md#10-待裁决登记)，保留平台差异即可推进等值接管，新增外观不得静默批准。

## 分类登记

`src/classification.json` 覆盖冻结快照全部 id，四类互斥完备：

1. **literal** — 直接数值，reference 层候选
2. **alias** — `var(--…)` / `hsl(var(--…))`，semantic/component 候选
3. **hsl-triplet** — `-hsl` 后缀族，与对应 hex 必须指同一颜色（DS-8 起由生成器保证）
4. **runtime-derived-or-protected** — 运行期计算值、非颜色、双模式不全、加严保护值；只登记存在、负责人与去向，不建模
