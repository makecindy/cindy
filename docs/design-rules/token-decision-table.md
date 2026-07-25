# Cindy 登录新设计 token 决策表

> 范围：仅为登录 / 浏览器跳转 / 回调页设计稿（逐屏规格见设计阶段工作文件 `DESIGN-login`，不入仓库）中出现的色值与关键尺寸做 token 决策。本文不改源码。本表自 2026-07-24 起随 `docs/design-rules/` 入仓维护（原 `docs/login-redesign/` 路径已随开源清理移除）。
>
> **⚠ 角色定位（2026-07-24）**：本表是**实现前的决策记录 + 后续增补台账**，其「现有体系盘点」「建议新增 N 个」「示例代码」反映的是各 wave 决策时点的状态，登录 token 体系落码后**未逐段回写**——现行 token 清单、命名与双态值以 `DESIGN.md §16.1` 和 `apps/desktop/src/renderer/themes/colors.ts` 为准（例：原案名 `login-brand-bg` 落码时已改名 `login-brand-accent`；旧登录页 9 个 `login-*` alias 已随换肤退役）。查「某个值该不该新 token / 复用谁」的判定理由用本表；查「现在到底有哪些 token、值是多少」不要用本表。
>
> 已读取现有体系：`DESIGN.md` 第 2 节 / 第 10 节、`apps/desktop/src/renderer/themes/colors.ts`、`apps/desktop/src/renderer/themes/registry.ts`、`apps/mobile/src/theme/tokens.ts`、`apps/mobile/src/theme/index.ts`、`apps/mobile/src/theme/ThemeProvider.tsx`。
>
> **⚠ wave4 改判（2026-07-20,PR0-docs 回写）**：登录流程全端从品牌红全屏底改为白底体系。本表内 `#DF0C27` 及同族红底背景 token 的语义**改判为 accent 专用**（Global pill、字标红元素等品牌点缀）,**禁止表达页面/画板背景**——token 命名与注释不得含 background/背景 语义（此判仍现行,落码 token 名为 `login-brand-accent`,原案名 `login-brand-bg` 已弃用）。
>
> 〔wave4 段历史部分作废（2026-07-24 目录整编标注）〕：本段原钉死的画布落码方案——页面底消费 `var(--surface)`、两层 `#F70121` 渐变代码复现、`--login-window-border-outer/-inner` token——已被后续实现与实机走查推翻。**现行结论**：画布底走 `--login-bg-base` 双态（亮 `#EDEDED` / 暗 `#1F1F1E`）,两模式**纯平**,`--login-bg-gradient-radial/-linear` 仅保留 override 锚、值恒 `none`,window-border token 已删除。现行权威 = `DESIGN.md §16.1 / §16.5` 与 `apps/desktop/src/renderer/themes/colors.ts`;本段与本表任何段落均**不再**对冲突拥有优先级,冲突一律以 `DESIGN.md §16` 为准。
>
> **⚠ wave5 增补（2026-07-24,组件库更新,权威 = `figma-component-spec §11`）**：(a) **hover 统一「叠白变亮」口径**——全按钮族 hover = normal 底叠 `rgba(255,255,255,0.08/0.1)`（深底 8% / 浅底 10%;唯一例外 `back` 亮色 hover 维持既有白 70%）,旧「白底钮 hover 叠黑」方向作废;pressed 叠黑分档含例外：深底强调钮 50%（`log_in_button`、`light_button_highlight`,不论尺寸）/ `Dark_button_Normal` 20% / 浅底钮 10% / 行类 8%——**落码逐组件对拍 `figma-component-spec §11.1`,不按类别名推断**;hover / pressed 叠层统一由 `--login-overlay-*` 二态 token 组承载（`DESIGN.md §16.5` 已采纳）,禁止新增字面 rgba 叠层;〔落码状态〕本口径当前仅文档层生效,as-built 组件仍消费改判前旧叠层值,同步随暗色实现 PR 的 overlay token 化落地（`DESIGN.md §16.5(1)`）。(b) 新组件 **radiobutton**（协议勾选）与**双色模式小按钮**（服务条款弹窗）带来的新色值决策已补入 §3 表尾;对应 token 建议随游客登录 / 协议 UI 实现 PR 注册,不提前占位。

## 1. 现有主题体系结论〔2026-07 决策时点快照,现状以 `colors.ts` 为准〕

- 桌面端颜色通过 `ColorRegistry.registerColor(id, { light, dark }, description)` 注册，组件消费 CSS variable `--<id>`。`colors.ts` 分为 semantic slot、component alias、singleton 三层。
- `DESIGN.md` 第 10 节明确：组件里不能硬编码 hex / rgba；能用 slot 就用 slot，找不到语义时新增 slot / alias / singleton；HSL token 必须以 `hsl(var(--xxx))` 消费，不能直接 `var(--xxx)`。
- 现有登录 token 只有旧登录页 alias：`login-bg`、`login-card-bg`、`login-card-border`、`login-divider`、`login-btn-bg`、`login-btn-text`、`login-btn-hover`、`login-help-text`、`login-error-text`。它们无法完整表达新设计的品牌红背景、固定白面板、输入状态、暗色回调卡片、反相按钮。
- 内置主题实际注册见 `registry.ts`：`default-light`、`atom-one-light`、`solarized-light`、`cindy-light`、`default-dark`、`eclipse`、`one-dark-pro`、`github-dark`、`monokai-pro`、`material-ocean-hc`、`cindy-dark`。新登录 UI 是品牌入口，建议大多数新增 login alias 在所有主题保持设计稿值，不随编辑器主题染色。
- 移动端 `ThemeColors` 是固定 key 集合，颜色字符串以 hex / rgba 暴露；spacing 为 `4/8/12/16/24/32`，radius 为 `4/8/12/9999`，typeScale 最大 `hero=40`。新登录稿的 `36/40/50/60` 圆角、`80/100/440/680` 尺寸不在现有阶梯中，不能用通用 spacing/radius 假装适配。

## 2. 新增 token 摘要〔决策时点提案,落码后的实际清单以 `DESIGN.md §16.1` + `colors.ts` 为准〕

建议新增 **47 个 token / constants**：

- **颜色 23 个**：`login-brand-bg`、`login-brand-bg-pressed`、`login-panel-bg`、`login-panel-border`、`login-control-bg`、`login-control-border`、`login-control-border-active`、`login-control-border-disabled`、`login-control-text`、`login-control-placeholder`、`login-title-text`、`login-secondary-text`、`login-primary-button-bg`、`login-primary-button-border`、`login-primary-button-text`、`login-inverted-button-bg`、`login-inverted-button-border`、`login-inverted-button-text`、`login-disabled-button-overlay`、`login-result-page-bg`、`login-global-badge-bg`、`login-link-text`、`login-link-hover`。
- **尺寸 25 个**：`login-stage-width`、`login-stage-height`、`login-desktop-hero-size`、`login-wordmark-frame-width`、`login-wordmark-frame-height`、`login-slogan-width`、`login-slogan-height`、`login-panel-width`、`login-panel-height`、`login-flow-height`、`login-panel-radius`、`login-control-width`、`login-control-height`、`login-control-radius`、`login-social-size`、`login-social-gap`、`login-back-size`、`login-code-link-height`、`login-method-row-height`、`login-method-row-radius`、`login-result-card-size`、`login-result-visual-size`、`login-mobile-width`、`login-mobile-tall-height`、`login-mobile-short-height`。

不建议新增通用 semantic slot。原因：这些值服务 Cindy 品牌登录入口和浏览器回调页，不应把 `#df0c27`、`#fbfbfb`、`36px` 圆角提升成全应用通用语言。颜色走 component alias；尺寸走 login component singleton constants。

## 3. 色值决策表

| Figma 值 | 出现场景 | 决策 | token / 类型 | 默认值建议 | 非默认主题 override 评估 |
|---|---|---|---|---|---|
| `#df0c27` | ~~移动背景~~〔已作废(wave4)：禁止表达页面背景〕、Global pill、字标红元素等品牌 accent | 新增(语义改判为 accent 专用) | `login-brand-bg` / component alias〔wave4 改判：命名/注释禁止 background 语义,PR0a 注册时按 accent 语义定名〕 | light/dark 均 `#df0c27`；HSL `352.3 89.8% 46.1%` 仅在需要 `hsl()` 时注册 companion | 全主题保持；这是 Cindy 品牌登录，不随代码编辑器主题变化 |
| `#a61629` | Color System 品牌深红；可作为 pressed/hover | 新增 | `login-brand-bg-pressed` / component alias | light/dark 均 `#a61629`；HSL `352.1 76.6% 36.9%` | 全主题保持；若当前稿没有 hover 节点，可先注册但只在 press/hover 需要时使用 |
| `#fbfbfb` | 登录白面板、回调 White 卡片 | 新增 | `login-panel-bg` / component alias | light `#fbfbfb`；dark 回调语义用 `#312f2f`，不要用此 token 的 dark 值承载两套模式时可拆 mode | 非默认主题不 override；100% 还原设计稿 |
| `#312f2f` | 回调 Dark 卡片 | 新增到同一 token dark 值或单独 mode map | `login-panel-bg` dark / component alias | dark `#312f2f`；HSL `0 2.1% 18.8%` | 只在回调 dark / dark preview 生效；非默认主题保持 |
| `#d4d4d4` | 输入边框、placeholder、主按钮文字、回调 White 边框、Dark 标题 | 新增别名分语义，不共用一个 token | `login-control-border`、`login-control-placeholder`、`login-primary-button-text`、`login-panel-border` | 均可解析到 `#d4d4d4`，HSL `0 0% 83.1%` | 不建议复用 `text-primary` dark 或旧 `border`，避免 light 主题被换成 `#d7d7d4` |
| `#eeeeee` | 输入背景、返回按钮背景、Dark 回调 CTA、移动 White 页面内容底 | 新增别名分语义 | `login-control-bg`、`login-inverted-button-bg`、`login-result-page-bg` light | `#eeeeee`，HSL `0 0% 93.3%` | 全主题保持；不是通用 `surface-chip`，CINDY light 主题的 chip 是 `#f4f4f4` |
| `#2a2828` | 主按钮 / 社交按钮背景、active 边框、Dark 回调页面底、Dark CTA 文本 | 新增别名分语义 | `login-primary-button-bg`、`login-control-border-active`、`login-inverted-button-text`、`login-result-page-bg` dark、`login-link-text` | `#2a2828`，HSL `0 2.4% 16.1%` | 全主题保持；CINDY dark `surface` 同值但语义不同 |
| `#434343` | 主按钮 / 社交按钮边框、Dark 回调卡片边框 | 新增 | `login-primary-button-border`、`login-panel-border` dark | `#434343`，HSL `0 0% 26.3%` | 全主题保持；可由 CINDY dark `border-default` 提供但 login alias 更稳 |
| `#252222` | 标题、输入已填文本 | 新增 | `login-title-text`、`login-control-text` | `#252222`，HSL `0 4.2% 13.9%` | 全主题保持；不复用 `text-primary`，因为 default light 是 `#262626`、CINDY light 是 `#3c3f43` |
| `#6f6f6f` | 副标题、回调正文 | 新增 | `login-secondary-text` | `#6f6f6f`，HSL `0 0% 43.5%` | 全主题保持；CINDY dark `text-secondary` 同值，light 不同 |
| `#ffffff` | Global 文字、返回按钮边框、Dark 回调按钮边框、状态栏变量 | 语义豁免或 alias | `login-inverted-button-border`；Global text 可用 `login-inverted-button-border` 或 dedicated constant | `#ffffff`，HSL `0 0% 100%` | 白色在这些场景是设计稿固定高对比值；不走 `surface-elevated`，避免主题污染 |
| `#d91f37` | 错误原因文字 | 复用现有名并改默认 / override | `login-error-text` / existing component alias | 建议把旧 `login-error-text` 从 `error-flat(#ef4444)` 调整为 `#d91f37`，HSL `352.3 75% 48.6%` | 全主题保持；错误色是登录设计稿专用，不应和通用 destructive 混同 |
| `#b4b4b4` | disabled 按钮边框 | 新增 | `login-control-border-disabled` / component alias | `#b4b4b4`，HSL `0 0% 70.6%` | 全主题保持 |
| `#4a4848` | Text_link hover(仅桌面) | 新增 | `login-link-hover` / component alias | `#4a4848`,light/dark 同值 | 全主题保持(豁免族);来源 figma §4.7 wave3 实测 `358:792`;〔lead 裁决 2026-07-20:决策表快照(2026-07-19)滞后于 wave3 追加,属表滞后修订非表外发明,与 U-9 pressed 同族同性质〕 |
| `rgba(255,255,255,0.7)` | disabled 按钮叠层 | 新增 | `login-disabled-button-overlay` / component alias singleton | light/dark 均 `rgba(255,255,255,0.7)` | 全主题保持；不要硬写在组件里 |
| `#c5c5c5` | Figma canvas / 工作区灰底 | 语义豁免，不进产品 UI | 无 | 无 | 不进实现 |
| `#fefefe` / `#f1f2f3` | 浏览器 shell 顶部模拟控件 | 语义豁免或资源内色 | 无或 `login-browser-chrome-*` 后续再加 | 当前仅浏览器 mock shell，生产系统浏览器不可控 | 不需要 app token |
| `#ededed`, `#f8f8f8`, `#dcdfe3`, `#3c3f43`, `#9a9da3`, `#bfc1c4`, `#d8d9db`, `#504f4f`, `#3b3a3a` | CINDY Light / Dark 主题基础色，不是登录帧直接结构色 | 复用现有 Cindy theme overrides | semantic slots：`surface`、`surface-elevated`、`border-default`、`text-primary`、`text-secondary`、`text-tertiary`、`text-disabled` | 已在 `cindy-light.ts` / `cindy-dark.ts` 作为主题色出现 | 非登录组件继续按主题体系消费；登录不要直接拿这些替代设计稿登录 alias |
| `#f1f0f1` | radiobutton 浅色圈底 / 暗模式选中底（wave5,`600:626`/`602:1093`）;亦为 wave4 帧底色 | 新增（随协议 UI 实现 PR 注册） | 建议 `login-radio-bg` / component alias（light `#f1f0f1`,dark 槽按 §16.1 口径核验后填） | `#f1f0f1` | 全主题保持；帧底色语义已由 `--login-bg-base` 承载,不复用本 token |
| `#434141` | 暗色模式普通小按钮底（wave5,`602:1294`） | 新增（随协议弹窗 / 小按钮 PR 注册） | 建议 `login-dialog-secondary-bg` dark 槽 / component alias | dark `#434141`（light 槽 `#eeeeee` 对应 `light_button_Normal`） | 全主题保持 |
| `#565454` | 暗色模式普通小按钮描边（wave5,`602:1294`） | 新增（随协议弹窗 / 小按钮 PR 注册） | 建议 `login-dialog-secondary-border` dark 槽 / component alias | dark `#565454`（light 槽 `#ffffff`） | 全主题保持 |
| `rgba(255,255,255,0.08)` / `rgba(255,255,255,0.1)` | hover 变亮叠层：深底 8% / 浅底 10%（wave5 统一口径,含 white_button 由黑 5% 改判;例外：`back` 亮色 hover 维持既有 `rgba(255,255,255,0.7)`,沿 `247:1637`） | 新增 | `--login-overlay-hover-*` 二态 token 组（`DESIGN.md §16.5` 已采纳命名族） | 逐组件对拍 `figma-component-spec §11.1`,不按深浅归纳直取 | 全主题保持；组件内禁止字面 rgba |
| `rgba(0,0,0,0.08/0.1/0.2/0.5)` | pressed 叠层四档：行类 8% / 浅底钮 10% / `Dark_button_Normal` 20% / 深底强调钮 50%（`log_in_button`、`light_button_highlight`,不论尺寸） | 新增 | `--login-overlay-pressed-*` 二态 token 组 | 逐组件对拍 `figma-component-spec §11.1` 档位表 | 全主题保持 |

## 4. 尺寸决策表

桌面 `ColorRegistry` 当前只管颜色。尺寸建议放在共享 login layout token / constants 模块中，例如：

- desktop renderer：`apps/desktop/src/renderer/components/login/loginDesignTokens.ts`
- mobile：`apps/mobile/src/theme/loginTokens.ts` 或 `apps/mobile/src/auth/loginDesignTokens.ts`
- browser callback main：独立 HTML renderer 使用同一份可序列化常量，避免手写散落数值

| Figma 值 | 出现场景 | 决策 | token / 类型 | 说明 |
|---:|---|---|---|---|
| `1819` | 桌面设计画布宽 | 新增 | `login-stage-width` / singleton constant | 仅设计坐标基准，不必直接等于窗口宽 |
| `2098` | 桌面设计画布高 | 新增 | `login-stage-height` / singleton constant | 与 `login-stage-width` 成组，用于 scale / transform 计算 |
| `934` | 桌面 Cindy 立绘尺寸 | 新增 | `login-desktop-hero-size` | `CINDY_Client` 正方形 |
| `680` | 桌面登录组宽、WORD_MARK 宽、回调卡片尺寸 | 新增 | `login-panel-width`、`login-wordmark-frame-width`、`login-result-card-size` | 语义不同，不建议只留一个 magic number |
| `180` | 桌面 / 移动 WORD_MARK frame 高 | 新增 | `login-wordmark-frame-height` | 字标外框高度，不等于内部实际图片高度 |
| `460 x 134` | SLOGAN frame | 新增 | `login-slogan-width`、`login-slogan-height` | 短屏移动端会缩放该 frame，但设计基准仍需保留 |
| `560` | 登录整体高度含第三方入口 | 新增 | `login-flow-height` | 面板 `440` + gap `40` + social `80` |
| `440` | 登录面板高度 | 新增 | `login-panel-height` | 浏览器等待 / 准备 / 错误态也用 |
| `36` | 面板 / 回调卡片圆角 | 新增 | `login-panel-radius` | 不复用 mobile `radius.container=12` |
| `540` | 输入框 / 按钮宽 | 新增 | `login-control-width` | 面板左右边距 70 推导，但以节点值为准 |
| `80` | 输入、按钮、社交圆钮高度 | 新增 | `login-control-height`、`login-social-size` | 控件和社交语义不同 |
| `40` | 输入 / 按钮圆角、Log_in gap、Global pill radius | 新增 / 复用局部 | `login-control-radius`；gap 可使用 `login-panel-social-gap-y` 或从 flow constants 推导 | `40` 不是通用 spacing 阶梯 |
| `50` | 社交按钮圆角、验证码链接高度 | 新增 | `login-social-radius` 可由 `login-social-size / 2` 推导；`login-code-link-height` 独立 | 社交圆钮建议用 `50%` 或 size/2，不必新 token；链接高度需 token |
| `60` | 返回按钮尺寸、方式选择行圆角 | 新增 | `login-back-size`、`login-method-row-radius` | 语义不同 |
| `100` | 企业 / 个人登录方式行高 | 新增 | `login-method-row-height` | 方式选择专用 |
| `70` | 控件左右边距、社交 gap、回调 CTA x | 新增 | `login-social-gap`；左右边距可由 `(680-540)/2` 推导 | 社交 gap 是真实布局参数 |
| `24` | spinner / 图标尺寸 | 复用现有图标尺寸或新增局部 | desktop 可用现有 icon size；mobile 可用 `iconSize` 若已有 `24` | 若现有阶梯没有 exact `24`，新增 `login-spinner-size` |
| `280` | 回调表情图容器 | 新增 | `login-result-visual-size` | 浏览器 HTML 也要用 |
| `750` | 移动画板宽 | 新增 | `login-mobile-width` | @2x 设计基准；实现可换算为 375pt |
| `1624` | 移动 tall 画板高 | 新增 | `login-mobile-tall-height` | 对应约 812pt |
| `1334` | 移动 short 画板高 | 新增 | `login-mobile-short-height` | 对应约 667pt |
| `115.672` | 状态栏 mock 高 | 不进产品 token | 无 | 只是 Figma iOS mock；真实 RN 走 safe-area |

尺寸新增清单中不包含可由其它 token稳定推导的值（例如社交半径 `80/2`、输入左右边距 `(680-540)/2`）。若实现希望所有数值全命名，可额外补 `login-panel-horizontal-padding=70`、`login-panel-title-y=31`、`login-panel-subtitle-y=75` 等布局常量，但它们更适合在组件局部用结构化对象表达。

## 5. 桌面 token 落地建议

### 5.1 `colors.ts`

〔历史示例,勿照抄（2026-07-24 标注）〕：下方代码块是决策时点的注册示意,**已由实际落码取代**——真实注册见 `apps/desktop/src/renderer/themes/colors.ts` 的 `--login-*` 双态族（品牌红 token 落码名为 `login-brand-accent`,原案名 `login-brand-bg` 弃用）。保留仅为记录「component alias + hex 直读」的决策形态。

```ts
// 历史示意（token 名/值以 colors.ts 现行注册为准）：
registerColor('login-brand-accent', { light: '#df0c27', dark: '#df0c27' }, 'Cindy login brand red accent (wave4 改判: accent 专用,禁止表达页面背景)');
registerColor('login-panel-bg', { light: '#fbfbfb', dark: '#312f2f' }, 'Cindy login panel / callback card bg');
registerColor('login-control-bg', { light: '#eeeeee', dark: '#eeeeee' }, 'Cindy login input bg');
```

不要新增 HSL companion，除非 shadcn 原语必须以 HSL 三元组消费。普通 CSS / Tailwind arbitrary var 均应使用 hex token（如 `background: var(--login-brand-accent)`）。

### 5.2 非默认主题

| 主题类别 | 建议 |
|---|---|
| Default Light / Default Dark | 新 login alias 直接解析为 Figma 值；不继承默认主题的旧黑白 login token |
| Cindy Light / Cindy Dark | 对已有 Cindy 主题基础色无冲突；login alias 保持 Figma 帧值 |
| Atom One Light / Solarized Light / Eclipse / One Dark Pro / GitHub Dark / Monokai Pro / Material Ocean HC | 不 override login alias。登录是品牌场景，主题只影响登录后工作区 |

如后续产品要求「登录页也跟随编辑器主题」，应重新设计所有主题下的品牌页视觉，而不是让现有 semantic slots 自动染色。

## 6. 移动端 token 落地建议

移动端当前 `ThemeColors` 是固定 key 集合。建议不要把 22 个登录颜色全部塞入通用 `ThemeColors` 顶层，避免污染非登录页面；改为导出专用 login token：

```ts
export const loginColors = {
  brandBg: '#df0c27', // wave4 改判: accent 专用(Global pill/字标红元素),禁止用作页面背景

  panelBg: '#fbfbfb',
  controlBg: '#eeeeee',
  controlBorder: '#d4d4d4',
  controlBorderActive: '#2a2828',
  titleText: '#252222',
  secondaryText: '#6f6f6f',
  primaryButtonBg: '#2a2828',
  primaryButtonBorder: '#434343',
  primaryButtonText: '#d4d4d4',
} as const;
```

回调页如果在 RN WebView / 系统浏览器外壳中复用，应使用 `loginResultColors.light` / `loginResultColors.dark`，不要从系统 `useColorScheme()` 自行推导灰阶。

## 7. 复用 / 新增 / 豁免总表

| 类型 | 数量 | 内容 |
|---|---:|---|
| 复用现有 token | 1 | `login-error-text` 复用名称，但建议调整到 Figma 错误红 `#d91f37`；CINDY theme 基础 slot 继续服务非登录 UI |
| 新增颜色 token | 22 | 见 §2 |
| 新增尺寸 constants | 25 | 见 §2 / §4 |
| 语义豁免 | 4 类 | Figma canvas 灰 `#c5c5c5`、浏览器 chrome mock 色、真实 iOS status bar mock 尺寸、回调图像资源内部裁切百分比 |

## 8. 风险与确认项

- 国际区移动 `347:2857` 当前占位文案是手机号 + 国家区号，和桌面国际区邮箱登录不一致。实现前需要设计确认是节点误配还是国际区移动确实走手机号。
- 回调页 dark/white 是浏览器页面自身主题，不一定等于 app 当前主题；实现时要保留强制 preview 能力。
- disabled 按钮的 `rgba(255,255,255,0.7)` 需要 token 化，否则会违反「不硬编码 rgba」规则。
- ~~如果后续新增 hover / pressed Figma 状态，应优先复用 `login-brand-bg-pressed` / `login-primary-button-bg`，不要把 hover 写成临时 hex。~~〔已关闭(wave5 2026-07-24)：hover / pressed 状态已全量补齐并统一为「hover 叠白变亮 / pressed 叠黑」，叠层走 `--login-overlay-*` 二态 token 组，见 §3 表尾与 `figma-component-spec §11.1`；`login-brand-bg-pressed` 仅保留品牌红 accent 按压语义，不作 hover 兜底。〕
