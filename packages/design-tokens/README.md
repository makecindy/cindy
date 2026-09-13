# @cindy/design-tokens

Desktop 已接管设计数值的 DTCG 编辑源。Terrazzo **2.7.1** 在构建期校验并生成；产品运行时只读取生成的本地子集，**不 import 此包或生成器**。Mobile 保持原实现与原生输入，尚未接管。

## 修改与生成

1. 在 `src/reference/` 修改标准 DTCG 值，或在 `src/semantic/`、`src/component/`、`src/themes/` 调整已批准的角色关系。`desktop-bindings.json` 只登记输出映射、保留项和文档用途，不存第二份数值。
2. 运行 `pnpm --filter @cindy/design-tokens generate`。同一 Terrazzo parse/build 流程生成全部输出及 DESIGN §3/§10/§16.1 已接管的精确摘要；品牌保护项单独保留，不读取测试 fixture。
3. 运行 `pnpm --filter @cindy/design-tokens generate -- --check`（或包脚本 `check:generated`）、本包测试、Desktop 冻结/主题/字号测试与适用门禁。生成两次必须稳定；缺文件、手改或过期输出失败。
4. 本次迁移不改冻结预期。有意改风格仍须按治理合同交真实证据与设计批准，批准后显式更新独立预期；不能通过重跑生成器自动刷新 fixture。

`src/{build-layers,snapshot,dtcg}.ts` 保留 DS-3 历史导入/测试 oracle；不在生产生成器依赖图中。`classification.json` 是冻结基线的历史分类，不再把其中“候选/未建模”误读为当前接管状态；当前逐项范围以 `desktop-bindings.json` 为准。

## 源与消费者

| 唯一编辑源 | 生成输出 | 实际消费者 |
| --- | --- | --- |
| reference/color + semantic/color + component/color | `themes/colors.ts` 的 GENERATED defaults 区 | 原注册 API/顺序/描述，主题解析，Button/Input、Diff、图表等全部旧 ID 消费者；同源生成额度条 CSS 首帧别名，不留手写副本 |
| reference/themes + themes/builtin | 11 个 `builtin/*.ts` 的 GENERATED theme 区 | 原主题身份、声明模式与加载 API；logo 等资源仍在适配层 |
| reference/shared + semantic/shared | `shared/windowBackdrop.ts` 的 GENERATED 区 | 主题与窗口共用的 CINDY 背板，原模块依赖不变 |
| reference/foundations + semantic/foundations | `styles/generated/tokens.css`、`token-mappings.ts`、`tailwind.config.ts` GENERATED 区 | globals 实际导入；通用字号/行高/字体/字重、spacing 尺度、圆角、标准 Input 尺寸、motion 与默认 transition |
| 同上默认字号 | `shared/generated/appearance-tokens.ts` | main/preload/renderer 共用 appearanceSettings；不改偏好限值、归一化与存储 |

构建专用 Tailwind 映射原位生成到配置文件，运行期只输出缩放/合并所需映射。旧 xl..5xl 配置保留缩放能力，源码仍禁止新增这些字号类；没有扩大排版或 DS-7 颜色豁免。

Effort/price 静态表也由 colors.ts 生成并导出，`effortTierColors.ts` import/re-export 并保留原插值、钳制、未知档回退。依赖变为单向 effort→colors→registry；独立导入会初始化无 DOM 的 registry，模块缓存保证重复导入不重注册。low/minimal/t1、max/ultra 及各档 Light/Dark 通过同一 reference 取值。

## 兼容与类型

- 标准类型：color、dimension（px/rem）、number、duration、cubicBezier、fontFamily、fontWeight、shadow。null 在模式绑定中显式保留，dark:null 继续走原 light 回退。
- 数值层单向：component→semantic→reference；内置主题覆盖只引用 reference/semantic。遗留 CSS alias 的直接目标及 var/hsl 包装由扩展元数据保留；Terrazzo 的终值用于校验，输出继续是符号引用。守卫核验符号目标与 DTCG 目标连接，不能把它们全部固化成 hex。
- `com.cindy.desktop` 格式元数据只记录大小写、精度、透明度/阴影语法，不存第二份值；`com.cindy.governance` 保留保护与语义豁免标签。保护标签限制改值，不放宽主题导入或颜色门禁。
- **历史 HSL 不按名称纠正**：Light text-primary 是 #262626，其 HSL 是 `0 0% 9%`；Dark surface-hover 是 #3c3c3a，其 HSL 是 `60 2% 17%`。它们不是精确同色。本批保留全部实际 triplet/alpha/小数格式；新导入仍遵守 DESIGN §10 的精确换算，CINDY twin/格式冻结照旧。
- 用户 `colors.radius`、局部/全局覆盖、未知 ID、导入、重复加载、磁盘字节与原主题顺序均保留。生成不读写用户主题目录。

## 已接管与保留

基线为 **541 ID / 11 内置主题**。当前 522 注册项接管，19 项原位保留：7 个 Markdown `inherit`、2 个登录背景 `none`、7 个 color-mix 运行期表达式，以及 annotation-accent / login-brand-accent / login-brand-accent-pressed 三个 register-only 保护 singleton。静态阴影、透明度、radius 和 splash 动效已建模，不能统称动态值漏掉。

动态模型 OKLCH 配色、effort 插值、字体选择/缩放/compact、reduced-motion、Diff 测量/Worker/缓存、数据几何及业务计时继续留在原代码。通用 Tailwind 尺度已接源，不代表所有局部任意值、第三方编辑器/终端/登录画布几何或各业务组件已完成设计迁移；这些保持现有登记与后续批次边界，不新增标准档位。

## 验证、回退与交接

生产测试在没有 fixture 的临时仓副本生成两次，逐输出注入缺失/手改/过期反例，并验证真实源改值进入输出。Desktop 独立冻结继续从实际 registry/builtin 提取；主题兼容、字号、模块加载与运行矩阵分别验证，不把静态测试称作实机通过。

SC-01—12、实机证据、未测平台和人工审核状态持续登记在桌面唯一主计划；截图不入 Git。DS-8 已合并 [#4268](https://github.com/makecindy/cindy/pull/4268)（merge `2e74488d21`）；DS-7 已合并 [#4215](https://github.com/makecindy/cindy/pull/4215)，合并提交 `4f03ea9a7b5f6425e517acd91071df6d397c6079`。旧 DS-6/7 附件不能充当本版本证据。

回退须整体恢复 DS-8 源/生成物/消费者及过渡守卫，保留上游工作；不回写用户数据或只抽掉生成源。G1 仅完成 Desktop 阶段；DS-9 已获授权实施桌面核心呈现，Mobile 新方案明确后再定消费接口。原影子层 2026-11-01 复查改为检查实际维护与消费情况，不取消维护责任。

## DS-5 历史双端样本（非未来 Mobile 合同）

以下是 DS-5 时点的取样。Mobile 正在重构，目录、布局与 API 仅供追溯，不约束新方案；平台源与共享角色须待新方案明确后共同确认。旧行号可能已漂移，应读取当前代码。

采样：**2026-09-07，main `36638ff33ca8b28e259b247a47054a696d6c4ee4`**。本节保留当时用途与消费链采样，不是未来 Mobile API 合同或精确值维护表；源码数值仍以上述现行上游为准。未启动 Desktop / iOS / Android，Light/Dark 实机均未验证；不将源码核对算作视觉验收。

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
| 发送触控 `composer.send.geometry` | SendButton:54 会话 h-7/w-7，新建入口另有 30px；pill | 会话页:11646—11654 为 34×34 / `radius.pill`；:6823 引用 :639 的 `COMPOSER_CONTROL_HIT_SLOP` 扩点击区，仍受 InputRow 父布局边界限制 | 平台几何覆盖；Mobile 后续独立阶段 按触控与无障碍保持 M 命中区域，不能套用 D 图标按钮尺寸；不以相同圆形推断同尺寸 |
| 用户 / 助手正文 `message.user.text` / `message.assistant.text` | UserMessage:1551 → `msg-user-text`，AssistantMessage:324 → `msg-assistant-text`；colors:1255/1259 默认都 alias `text-primary` | MessageRenderer:7698 → `colors.textPrimary`（用户/助手共用正文样式） | 共享正文用途，D 两个局部覆盖必须各自保留，不能抬升为全局或删除；DS-8 接源、DS-9 核真实消费、Mobile 后续独立阶段 接 M |
| 正文排版 `typography.messageBody` | UserMessage:1550 / AssistantMessage:323 → `text-15 leading-[1.6]`，受用户字号和 compact（globals:330）影响 | MessageRenderer:7698 → `typeScale.bodyLarge/lineHeight.bodyLarge`（当前 17/26） | 共享用途 + 平台静态覆盖与缩放；用途一致不等于像素一致，DS-8/10 等值接管，DS-9 验证 D 长文与流式 |
| 行内代码 `message.inlineCode.text` / `.surface` / `typography.inlineCode` | 仅助手 MarkdownRenderer:285/1785 → 继承正文颜色，`msg-md-inline-code-bg`、`font-mono text-14`、局部圆角；上游 colors:1301 / Tailwind fontFamily | MessageRenderer:7964—7974 → `chatInlineCodeText`、`typeScale.code/lineHeight.code`、[monoFont](../../apps/mobile/src/theme/monoFont.ts)，有意无底色 | 用途共享、外观/字体平台覆盖；M 原生嵌套 Text 圆角限制已有代码说明。DS-9 保留 D 局部色、Mobile 后续独立阶段 保留 M 无底色；改观感须先裁决，字体平台选择仍在代码 |
