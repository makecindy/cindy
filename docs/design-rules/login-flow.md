# 登录链路

> 迁自 `DESIGN.md` §16，规范效力不变。文中 `§16.x` 指本文件，其余未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。

## 16. Login Flow (登录链路)

> 本节是登录全链路的设计系统规范，也是登录域唯一的现行规则来源：色值以 §16.1 色板表（由 `packages/design-tokens` 生成）为准，几何以 §16.2 常量表与 `loginDesignTokens.ts` / `loginSkinLayout.ts` 为准。[`token-decision-table.md`](./token-decision-table.md) 保留为 token / 尺寸的决策记录。原 `figma-component-spec.md`（Figma 组件逐态读取记录）已于 2026-10-23 移除：其现行值均已并入本节与代码常量，后续改版未再回写；代码注释里的 `figma §N` 指它的章节，可在 git 历史（移除前的提交 `70b32d7578`）查阅，Figma nodeId 仍直接写在注释里。`DESIGN-login`（逐屏规格）、`flow-map`（状态机）、`fidelity-matrix`（保真度验收矩阵）仍为设计阶段工作文件，不入仓库。
>
> **交付状态**：亮色与深色均已落地，深色字标 / slogan 资产随模式切换，组件经 `--login-overlay-*` 消费 hover / pressed 叠层。2026-10-27 起面板、控件、描边、主按钮与叠层并入 CINDY 主界面墨水口径（§16.1 / §16.5），原「部分叠层仍为 2026-07-24 改判前旧值」的缺口随之关闭。两模式均受 §10「Light / Dark 双模式交付门槛」约束。
>
> 本节独立于 §1–§15 默认皮肤与 CINDY 皮肤族——登录页是独立白底 / 深底反色体系，**不消费编辑器主题的 `--surface` / `--text-*` 等 slot**，只走本节定义的 `--login-*` token（文字、面板、控件、描边与主按钮的**值**与 CINDY 皮肤主界面相同，见 §16.1，但仍是独立 token，扩展主题改主界面颜色不会影响登录页）（light / dark 二态已注册于 `apps/desktop/src/renderer/themes/colors.ts`；见 §10）。`--login-*` 随基础 light / dark **二态**切换，但**不跟随具体扩展主题**（登录页只认 light / dark 模式；首次亮、后续跟随见 §16.5）。

### 16.1 视觉风格

登录页的颜色与 CINDY 皮肤主界面同一口径（亮色黑墨水 / 深色白墨水），但仍是独立 token 族，不跟随扩展主题：

- **面板、控件、描边与主按钮走主界面墨水口径（2026-10-27 用户裁决）**：面板 = 主界面卡片面 `surface-elevated`（亮 `#FDFDF8` / 暗 `#1F1F1F`，深色取卡片档 = 方案 A）；输入框、方式行、返回钮、协议弹窗「不同意」钮与协议单选底 = 墨水填充 `surface-chip`（黑 5% / 白 6%，叠在面板上）；所有描边 = 墨水线 `border-default`（黑 8% / 白 10%），协议单选未选态除外（次要档描边，见 §16.3）；聚焦 / 已填描边 = 正文档；主按钮、第三方圆钮、「同意」钮与单选选中 = 主界面反相 CTA（`#3C3F43` 底 `#FCFCFC` 字 / `#EEEEEE` 底 `#151515` 字，不另描边）；重发链接 = 正文档，hover 说明档、pressed 强调档；禁用主按钮 = 墨水填充 + 占位档文字（不叠白、不另描边）。原「墨黑–米白反色」实色（`#FBFBFB` / `#312F2F` 面板、`#EEEEEE` / `#2C2A2A` 控件、`#2A2828` 主按钮等）退役。对应关系由 `loginInkLadder.test.ts` 逐项守护，改主界面对应角色时登录页必须同步。
- **文字走墨水阶梯（2026-10-23 用户裁决）**：标题、输入已填字、副标题 / 倒计时 / 「跳过登录」、空态占位，以及回调页标题与正文，与主界面同用 §15.16 的墨水档——亮色黑、深色白加透明度：标题与已填字 = 正文档 88% / 82%，副标题与回调正文 = 次要档 56% / 55%，占位 = 占位档 32% / 30%。不再为登录页单独挑灰（原双模同值 `#6F6F6F` 在深色面板上只有约 2.6:1，已退役）。改主界面墨水档时登录页同步改，由 `loginInkLadder.test.ts` 守护。主按钮字随主界面反相 CTA 前景取实色。Mobile 登录皮暂保留原实色，另行收拢。
- **品牌红 `#DF0C27` 在登录画布内只用于区域徽标（旧称 Global pill，见 §16.3）与字标红元素等品牌 accent，跨模式不变**；画布外的红色范围以 §15.10 为准。**禁止作页面背景**（wave4 改判，见 `token-decision-table §3` 对 `#df0c27` 的语义判定），不渗入面板内部（呼应 §15.10 红色边界）。画布底走 `--login-bg-base`（亮 `#F2F2ED` / 深 `#181818`，与 CINDY 皮肤页底同值，固定不随扩展主题），红只经 `--login-brand-accent` 消费。错误红 `#D91F37` 同样跨模式不变（语义豁免，呼应 §10 豁免族）。
- **`--login-*` 调色板双态值** —— 注册于 `apps/desktop/src/renderer/themes/colors.ts`，下表由 `packages/design-tokens` 生成：

<!-- BEGIN GENERATED DS-8: login-colors -->
| token | light | dark | 核验源 |
| --- | --- | --- | --- |
| `--login-panel-bg` | `#FDFDF8` | `#1F1F1F` | 同 CINDY 主界面卡片 `surface-elevated`（2026-10-27 并入墨水口径；暗色取卡片档 = 方案 A） |
| `--login-panel-border` | `rgba(0, 0, 0, 0.08)` | `rgba(255, 255, 255, 0.10)` | 墨水线 黑 8% / 白 10%（同主界面 `border-default`） |
| `--login-control-bg`（输入框底） | `rgba(0, 0, 0, 0.05)` | `rgba(255, 255, 255, 0.06)` | 墨水填充 黑 5% / 白 6%（同主界面 `surface-chip`，叠在面板上） |
| `--login-action-control-bg`（方式行 / 返回钮底） | `rgba(0, 0, 0, 0.05)` | `rgba(255, 255, 255, 0.06)` | 与输入框同档（2026-10-27 起不再分化） |
| `--login-back-border`（返回钮描边） | `rgba(0, 0, 0, 0.08)` | `rgba(255, 255, 255, 0.10)` | 墨水线 黑 8% / 白 10% |
| `--login-control-border` | `rgba(0, 0, 0, 0.08)` | `rgba(255, 255, 255, 0.10)` | 墨水线 黑 8% / 白 10%（同主界面 `border-default`） |
| `--login-control-border-active`（focus / filled） | `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.82)` | 墨水正文档 黑 88% / 白 82% |
| `--login-control-text`（输入填充字，Bold） | `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.82)` | 墨水正文档 黑 88% / 白 82%（2026-10-23 并入墨水阶梯，同主界面 `text-primary`） |
| `--login-control-placeholder`（空态字） | `rgba(0, 0, 0, 0.32)` | `rgba(255, 255, 255, 0.30)` | 墨水占位档 黑 32% / 白 30%（2026-10-23 并入墨水阶梯，同主界面 `text-placeholder`） |
| `--login-title-text` | `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.82)` | 墨水正文档 黑 88% / 白 82%（2026-10-23 并入墨水阶梯） |
| `--login-secondary-text`（副标题 / 倒计时） | `rgba(0, 0, 0, 0.56)` | `rgba(255, 255, 255, 0.55)` | 墨水次要档 黑 56% / 白 55%（2026-10-23 并入墨水阶梯，同主界面 `text-secondary`；原双模同值 `#6F6F6F` 退役） |
| `--login-primary-button-bg` | `#3C3F43` | `#EEEEEE` | 同主界面反相 CTA `accent-cta-bg-pure` |
| `--login-primary-button-border` | `#3C3F43` | `#EEEEEE` | 与底同色（不另描边） |
| `--login-primary-button-text`（Bold） | `#FCFCFC` | `#151515` | 同主界面 `accent-pure-cta-fg` |
| `--login-link-text`（重发链接） | `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.82)` | 墨水正文档 黑 88% / 白 82% |
| `--login-link-hover` | `rgba(0, 0, 0, 0.70)` | `rgba(255, 255, 255, 0.66)` | 墨水说明档 黑 70% / 白 66% |
| `--login-link-pressed` | `rgba(0, 0, 0, 0.95)` | `rgba(255, 255, 255, 1.00)` | 墨水强调档 黑 95% / 白 100% |
| `--login-disabled-button-overlay`（已退役） | `rgba(0, 0, 0, 0.00)` | `rgba(255, 255, 255, 0.00)` | 已退役（2026-10-27）：禁用主按钮改为控件底 + 占位字，不再叠层；ID 与透明默认值保留，仅为兼容旧版导出的本地主题，组件不再消费 |
| `--login-splash-progress-track` / `--login-splash-progress-fill` | `rgba(0, 0, 0, 0.10)` / `rgba(0, 0, 0, 0.88)` | `rgba(255, 255, 255, 0.13)` / `rgba(255, 255, 255, 0.82)` | 轨 = 墨水弱档 黑 10% / 白 13%；填充 = 墨水正文档 |
| `--login-loading-ring-track`（loading 环轨道） | `rgba(0, 0, 0, 0.10)` | `rgba(255, 255, 255, 0.13)` | 墨水弱档 黑 10% / 白 13%；登录页 LoginLoadingRing 与 Splash 转圈环共用（Splash 侧自暗色实现 PR 起由字面 rgba 收敛至本 token） |
| `--login-error-fg` | `#D91F37` | `#D91F37` | 语义豁免不变 |
| `--login-bg-base`（画布底） | `#F2F2ED` | `#181818` | 2026-10-01 对齐 CINDY 皮肤页底（cindy-light / cindy-dark 的 `surface`，#2571 色阶改版值），登录前后背景同色；仍为固定值、不随扩展主题。两模式纯平定稿——暗色帧的双红晕层（532:588/589）曾按 1:1 几何落地，2026-07-24 实机走查拍板去除（亮色撤渐变=PR#104 拍板，两条决策相互独立） |
<!-- END GENERATED DS-8: login-colors -->

品牌保护项 `--login-brand-accent` / `--login-brand-accent-pressed` 仍按原决定保留 `#DF0C27` / `#A61629`，两模式相同；尚未接管，不由本表生成。上表已接管行从 DTCG 自动生成，核验源说明保留原批准依据。

余下 token（`-control-border-disabled` / `-inverted-button-border` / `-callback-*` 等）的现行双态值以 `colors.ts` 为准，决策理由见 `token-decision-table §3`；深色反相机制与 3 处组件改动见 §16.5。

- **社交圆钮深色 = 白圆**：与主按钮共用 `--login-primary-button-bg / -border`，深色自动反相为白圆 `#EEEEEE` + 白边，**圆内图标保持品牌色**（Google 彩 / WeChat 绿 / SSO），非反相（figma `white apple/google/wechat/SSO` symbol 核验）。

### 16.2 设计规则

**Desktop 登录成功回调页当前覆盖（2026-09-02）**：成功态移除「回到 Cindy」按钮，卡片收紧为 **560×500** 的内容流布局，并在底部显示本地化 3 秒倒计时；倒计时结束先移除倒计时文字，再调用 `window.close()`。失败 / Warning 保留原 **680×680** 卡片与返回操作。该条是当前产品 UX 对旧 Figma 成功态回调帧（680×680 + CTA）的明确覆盖，现行客户端实现以本条与代码测试为准。

**Token 体系**：`--login-*` 注册于 `apps/desktop/src/renderer/themes/colors.ts`（值由 `packages/design-tokens` 生成，见 §16.1）。组件经 `LOGIN_COLORS`（桌面 `loginDesignTokens.ts`）/ `loginColors`（手机 `theme/tokens.ts`）单点消费。**禁止硬编码 hex pair**（呼应 §10）——Desktop renderer 里新增的字面颜色由 `hardcoded-color-audit` 在 CI 阻断；Mobile 侧该脚本只报告，由 Mobile 自身的 token 守卫测试阻断（范围见 `design-governance.md` §8）。`--login-*` 随基础 **light / dark 二态**切换（对齐 `callback-*` 族与 §15 CINDY 皮肤族的双态做法），但**不跟随具体扩展主题**——登录页只认 light / dark 模式，扩展主题不 override `--login-*`（首次亮、后续跟随上次模式见 §16.5）。

**几何 / 布局常量**：固化在两个常量文件，数值权威 = 下表与常量文件本身（决策理由见 `token-decision-table §4`），不按截图目测补值。

| 常量 | 值 | 引用 |
|---|---|---|
| 登录整体组 | 680×**620**（面板 500 + gap 40 + 圆钮行 80）——2026-07-27 面板增高改版，原 560 作废 | figma §5.1（新稿 `700:783`） |
| 面板 | 680×**500**，r36，`--login-panel-bg` + inset 1px `--login-panel-border` —— 2026-07-27 改版，原 440 作废；增的 60 = 面板内新增的「跳过登录」槽，**面板内其余元素 y 坐标一律不动**。面板高度对登录全步骤恒定（步骤间不得跳变）；**Splash 借用同款面板时保持 440**（无该入口，见 §16.3 `LoginPanel`） | figma §4 / §5.1（新稿 `700:791` / `705:886` / `705:1062`） |
| 输入框 / 主按钮 | 540×80，r40，@(70, 158 / 300) | figma §4.1 / §4.3 |
| SSO 最近组织候选层 | 与输入框同宽同 x，顶边恒为输入框底 + 8；作为浮层覆盖后续 hint / 主按钮，不参与文档流。最大高度收在当前端登录面板内并自行滚动（桌面面板 500、手机面板 440），不得再定位到面板下方。候选层与输入框必须处于同一登录组坐标系，随桌面窗口 placement、phone 短/长屏、pad surface scale 与手机键盘避让整体移动，不另写按设备尺寸分支 | 2026-08-22 小屏实机修正 |
| 方式行 | 540×100，r60，@(70, 158 / 278)，左图标 24@(27,37)，右图标 @(490,40) | figma §4.9 |
| 返回钮 | 60×60，r40，@(20,20) | figma §4.6 |
| 重发 / Text_link 槽 | 540×50，20px，@(70,238) | figma §4.7 |
| 错误文本 | 680×50，20px，@(0,380)，`--login-error-fg` —— 槽顶不随面板增高移动；槽底 430 与下方「跳过登录」槽**首尾相接（间距 0）**，两者同时可见互不重叠（文案视觉间距 ≈30） | figma §4.8（新稿 `705:1067`） |
| 「跳过登录」文字按钮槽 | 680×60，@(0,430)（槽底 490，距面板底 10 = 新稿下内边距）；文字 24px Regular + 下划线、`--login-secondary-text`，相对 680 水平居中、槽内垂直居中。**680×60 只是布局容器、本身不可点**，命中区 = 当前语言实际文字渲染宽度 + 左右各扩（桌面 30 / 移动 50 设计px）、高度占满 60 槽 —— 详见 §16.3「登录文字按钮」 | figma 新稿 `705:1068`（文本 `705:1069`）/ `700:910` + 2026-07-27 拍板 |
| 第三方圆钮行 | y=**540**（面板底 500 + gap 40；2026-07-27 随面板增高由 480 顺移 60），80×80，r50，icon 48，gap 70。**行内不再有游客圆钮**（CN = Apple + SSO 两颗 / Global = Apple + Google + SSO 三颗，`count` 按 provider 动态） | figma §4.5（新稿 `700:796` / `705:1070`） |
| 协议同意行 | 680×40，@(0,**642**)（= 组底 620 下方 22；2026-07-27 随面板增高由 582 顺移 60，行底 682 溢出组底 62） | figma 新稿 `700:807` / `705:1075` |
| 标题 / 副标题 | 标题 y=31 h=38 32 Bold；副标题 x=70 y=75 w=540 20 Regular ≤2 行顶对齐（2026-07-24 拍板：宽度对齐控件列，原 figma 单行几何 599@41 作废） | figma §5.1 + 2026-07-24 拍板 |

桌面 `loginDesignTokens.ts`（1819×2098 画布）、手机 `loginSkinLayout.ts`（750 设计 px，键名用 `font` / `radius` 避开 typography 守护扫描）。两端面板内坐标同源同值，手机由外层统一 `transform` 缩放。

**平台差异**：桌面 = Web renderer（Electron，Win / Mac 同套）；手机 = React Native（iOS / Android，含 phone / pad-portrait / pad-landscape）。两端同几何参数源、同 token 语义（手机 `loginColors` 与桌面 `LOGIN_COLORS` 同名）；色值自 2026-10-23 / 10-27 起桌面已并入墨水口径，手机登录皮暂保留原实色、另行收拢，在此之前两端色值不同。实现宿主也不同（RN 用 `StyleSheet` + `Animated`，桌面用 CSS + Tailwind）。

**移动端 stage 几何（2026-07-27 换品牌簇基准；2026-07-29 修正：功能区落位同步取新稿标注值）**：手机的**品牌簇**（立绘 / SLOGAN / 字标）**与功能区落位 `loginY` 一并取新稿逐字段值**——两者是同一份稿的两半，必须同源。短屏 / 长屏两档之间仍走既有线性插值体系（`loginSkinLayout.resolveLoginStage`），**不另造缩放规则**。下表为设计单位（750 设计px 基准），消费时一律 × `surface.scale`（设计单位 ≠ 物理 pt，见 §16.4「几何」条）：

| 档                       | 立绘                 | SLOGAN（可见图形框）          | 字标（图像框）           | 登录组顶 `loginY`                                                                                                                                                     | 溯源                                                                     |
| ------------------------ | -------------------- | ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 短屏 `designHeight=1334` | 599×720 @(75,**60**) | 254.01×72.8 @(462.55,408.37)  | 335×115 @(208,487)       | **622**（新稿标注值；字标底 602 → 面板顶间距 **20** = 稿内值。组高 560 + 协议行溢出 62 → 内容底 1244，底部留白 90，比稿内 30 多 60，见下「面板 500→440 的 60 去向」） | 品牌簇 + `loginY` 同源 = 新稿 `705:915`（Log_in 组 @(35,622)）+ 避脸拍板 |
| 长屏 `designHeight=1624` | 750×902 @(0,106)     | 269.66×77.29 @(444.9,**568**) | 387×132.18 @(182,669.17) | **827**（新稿标注值；字标底 801.35 → 间距 **25.65** = 稿内值。内容底 1449，底部留白 175，比稿内 115 多 60，同上）                                                     | 品牌簇 + `loginY` 同源 = 新稿 `705:799`（Log_in 组 @(35,827)）+ 避脸拍板 |

- **面板 500→440 少掉的 60 去向（2026-07-29 审图拍板「方案 B」）**：新稿手机帧的面板是 **500 高**（含面板内「跳过登录」栏），而手机端已按产品决定剥离该入口、面板回 **440**、组回 **560**。少掉的 60 必须有个去处，两个候选经实机比例图审图：
  - **方案 B（采纳）**：`loginY` 取稿值 622 / 827，60 全部落到**底部留白**（90 / 175，比稿内多 60）。品牌簇的稿内顶部构图与间距完全保真。
  - **方案 A（未采纳）**：品牌簇整体下移 60（`loginY` 682 / 887），字标↔面板与底部留白**双双**回到稿值（20/30、25.65/115），代价是品牌簇整体比稿位低 60（叠加避脸上移后立绘顶 120 / 166）。
  - ⚠️ **禁止只改一半**：`loginY` 与品牌簇取自同一份稿，任一侧单独回退会让字标↔面板出现稿内不存在的间距（2026-07-28 实例：品牌簇换新稿、`loginY` 留 main 的 694 / 933 → 间距变 **92 / 131.65**，实机肉眼可见一条空白）。该组合已由 `loginSkinLayout.test.ts` 的「间距上界不变式」钉死（等于稿值，不是「小于面板顶」）。

- **SLOGAN 避脸（2026-07-27 用户审 demo 两次拍板）**：新稿原值下 SLOGAN 压在立绘脸上（像素级实测：立绘脸部 skin 连通域 x402..552 / y315..475，SLOGAN 资产 ink 5244px，双方按各自 `contain` 折算到 stage 求交 —— 长屏原值 `y=536.68` 时 ink ∩ 脸 = 290px、短屏 = 91px、中段 dh≈1400 最高 113px）。两档分别处理：
  - **长屏**：SLOGAN 下移 31.32（inner `y` 536.68 → **568**，容器 y 514 → 545.32；x / 宽高不动），底 645.29 距字标框顶 669.17 留 **23.88 ≈ 24 设计px** —— 24px 是这一档的**硬上限**，再下移即撞字标。
  - **短屏**：SLOGAN 在本档没有下移余量（底 481.17 距字标顶 487 仅 5.83），改为**立绘整体上移 27**（`y` 87 → **60**）。改后 dh ≤1450 全段 ink ∩ 脸 = **0**；dh 1500..1624 残留 3..9px（仅下巴尖，由长屏档自身落位 + 上面那条 24px 上限共同决定）。
  - **边界核对**：立绘资产不透明内容起于 y=86（上方为透明留白），短屏 `contain` 缩放 720/902 → 可见发顶 = 60 + 86×0.79823 = **128.65**，仍在 Status Bar 下沿（115.67）之下 12.98，**不侵入状态栏、无顶部裁切**；底部可见内容止于资产 y=696 且是淡出渐隐（alpha 69→21），上移后尾部由「藏在面板下 20.6」变成「露出面板上 6.4」——长屏本来就露 25，同款观感，无硬切边。

- **短屏以下（dh<1334）**：视觉区（立绘 / slogan / 字标）继续按 `v=max(0.25,(dh-600)/734)` 以 (375,0) 为锚连续压缩；功能区 680×**560** 不缩放、按**紧凑底距 18** 锚定底部并**钳到短屏档落位**：`loginY = min(622, max(0, dh-640))`。
  - **为什么是钳制、不是把锚常量改成 `dh-712`**：短屏档那 90 的底距是「面板 500→440 少掉 60 落到底部」的产物，只属于 dh≥1334；窄屏空间本就不足，若在那里也保留这 60，面板会上移压住被 `v` 压缩后的字标 —— 2026-07-29 review 实算：`dh-712` 会让 **dh∈[712,1222) 全段字标被不透明面板盖住**（dh=1000 压 40 设计px）。钳制式在 dh→1334⁻ 自然收敛到 622（边界连续），窄屏行为与 main 逐值一致。
  - **既定代价**：dh<822 时 stage 高度已不足以同时容纳压缩后的品牌簇与不缩放的功能区，字标与面板仍会交叠（dh=800 压 4、dh=700 压 90.5）——同一公式同一取值，**main 既有行为**，属「功能区优先」的取舍（Split View 320pt 窄窗等极端形态）。
  - **钳制自身的代价**：`loginY` 的斜率在 dh=1262 处由 1 变 0（值连续、斜率不连续）——dh∈[1262,1334) 面板定在 622 不再随屏高上移，底部留白由 18 涨到 90。该窗口仅 ≈37 物理px（@scale 0.52），离散的旋转 / 分屏切换基本撞不到，只有连续拖拽调窗（Android 分屏拖拽）可能感知到「面板定住」。
  - 守护：`loginSkinLayout.test.ts` 的「锚常量连续性不变式」（dh=1334 上下不跳变）+「间距不变式（短屏以下分支）」（dh∈[850,1334) 采样点面板顶不得压到字标底；最紧点在 dh=850，间距 4.96）。
- **2026-07-24「视觉 + 功能区整体上移 40 设计px」拍板已被本次新稿取代**（其产物 `loginY` 694 / 933 作废）：两档落位改取新稿自带的标注值（622 / 827），不再由「组底 + 底距」反推。**但 dh<1334 段仍沿用该拍板的紧凑底距 18（`dh-640`）**，只是额外钳到 622——理由见上条。
- **pad 两档（竖 744×1133 / 横 1180×820）本轮不动，但换稿时必须与 `loginY` 同批改**：pad 没有 figma 新稿帧，品牌簇与 `loginY` 目前都还是同一套 wave3 推导值，因此内部自洽 —— 字标底↔面板顶间距 **竖 14.84 / 横 33.88**（已由 `loginSkinLayout.test.ts`「pad 同源性不变式」钉住）。⚠️ **将来给 pad 换新稿基准时，品牌簇与 `loginY` 必须同批处理**：只改一半会原样重演 2026-07-29 那次 phone 侧的漂移（品牌簇换稿、`loginY` 留旧 → 间距变成稿内不存在的 92 / 131.65，实机可见空白）。换稿时上述不变式会先红，届时同步更新钉值并在本节记录依据。
- **~~pad 竖屏（stage 744×1133）为推导值，无 figma 源~~〔整段已作废 2026-07-28：面板不再增高，pad 竖屏几何与 `splashOffset` 全部保持 main 原值（`loginY` 621 / `splashOffset` 158），无需上移、无推导值〕**：新稿没有 pad 帧。面板增高后组底会从 1114.94 推到 1162.59 > stage 1133、触发安全区抬升压住字标，故把品牌簇与登录组**一起上移 60 × 0.794117 = 47.647 设计px**（`loginY` 621→573.353，立绘 / slogan / 字标同量上移；`splashOffset` 158→206 保持 splash 期簇位不变），三条不变量 = ① 组底仍落 1114.94、② 字标框底↔面板顶间距仍 14.84、③ splash 期簇位不变。**该值为推导，非设计源；用户 2026-07-27 接受推导，竖屏几何待设计侧回看确认**。pad 横屏（1180×820）组底 774.95 仍在 stage 内，几何原值不动。

**~~键盘停靠锚 = error 槽底（2026-07-27 拍板，移动端）~~〔已作废 2026-07-28：手机端跳过登录整体剥离，停靠锚仍为面板底，见本节末勘误〕**：停靠贴附锚由**面板底**改为**面板内 y=430（error 槽底）**——面板 440→500 后若继续用面板底，每次停靠会比改版前多顶 60 设计px（短屏更容易触发 clamped-fallback、把品牌层与标题挤掉）。**取舍**：键盘弹起时「跳过登录」槽（430..490）允许被遮挡——它不是输入链路的必需元素，收起键盘即可见；停靠引擎本身（10px 贴附 + safe-top 上限 + clamped-fallback 兜底）与悬浮相交判定锚（输入框 ∪ 主按钮）均不变。

**交互态**：hover（仅桌面）/ pressed（双端）/ disabled / loading 五态。态叠层挂伪元素（桌面 `::after`）/ overlay View（手机），文字与图标在叠层之上（`relative z-[1]`），**叠层不压文字**；全部叠层走 `--login-overlay-*` light / dark 二态 token，组件内禁止新增字面 rgba 叠层。取值口径见 §16.5 第 1 条。

**常驻动画 compositor-only**：spinner / loading 环动画挂 HTML（桌面）/ `Animated.View`（手机）外层 wrapper，SVG 图形保持静态（呼应 §14.4）；`prefers-reduced-motion` 直落静止。面板入场 handoff 动画是 §14.4 容器形变的窄变体（双端冻结 420ms 升起 + 渐显，`LOGIN_HANDOFF_TIMINGS.panelMs` / `panelInMs`）。

**Apple「Sign in with Apple」按钮**：iOS HIG 硬性要求使用 Apple 官方按钮样式，**不可皮肤化**——iOS 上 Apple 槽位保持原生 `ASAuthorizationAppleIDButton`，不套 `LoginSocialButton` 皮。这是合规底线，非视觉遗漏。其余社交圆钮（Google / WeChat / SSO）正常上皮。

**i18n**：登录文案走 `react-i18next`（桌面 `common.json` `login.*` 节）/ `loginMessages`（手机），5 语对齐 `zh-CN` / `zh-TW` / `en` / `ja` / `ko`。5 语全部翻准，不留空（空 key 静默回退英文）。

**多语言长文本与翻译长度预算（2026-07-24 拍板）**：

- **原则：登录链路里截断与省略号不可作为可见结果**。登录面板是 680×500 冻结几何（2026-07-27 改版后值）、槽位不撑高，长文案没有退路——所以约束加在**文案侧**：所有 `login.*` 文案（含 agent 代写 / 补翻的各语言文本）必须言简意赅、按槽位长度预算写作。线上出现可见省略号 = 该语言文案超预算 = **文案 bug（P1，修文案，不改布局）**。
- **长度预算自检**（写 / 翻文案时逐语言过一遍）：估宽公式——汉字 / 假名 / 谚文 ≈ 1×字号 px，拉丁字母 / 数字 / 空格 ≈ 0.5×字号 px；估宽 ≤ 槽宽 × 0.95 才算过。常用槽预算：

  | 槽                                 | 宽×字号                                                                                                                                                                                                                                                                                        |         ≈汉字上限 |     ≈拉丁字符上限 |
  | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------: | ----------------: |
  | 标题                               | 680 @32 Bold（徽标变体为 inline 组：标题 shrink-to-fit + 2px 间隔 + 区域徽标，徽标宽随文案自适应，按现役最宽的 `Dev`（实测 51.7，非本表估宽公式的 46——公式是文案自检用的保守估算，徽标宽度以实测为准）算可用宽 680−54=626；v3 2026-07-27，原「固定 70px 徽标」几何随 Global 徽标撤除一并作废） | 20（徽标变体 18） | 40（徽标变体 37） |
  | 副标题（≤2 行，2026-07-24 拍板）   | 540 @20 × 2 行                                                                                                                                                                                                                                                                                 |                50 |               102 |
  | Text_link / hint / 倒计时          | 540 @20                                                                                                                                                                                                                                                                                        |                25 |                51 |
  | 「跳过登录」文字按钮（2026-07-27） | 620 @24（= 槽 680 − 双侧 30 命中区扩张；移动端命中区扩 50 时可用宽 580）                                                                                                                                                                                                                       |     24（移动 22） |     49（移动 45） |
  | 主按钮 CTA                         | 448 @24 Bold（540 − 双侧 46 padding）                                                                                                                                                                                                                                                          |                17 |                35 |
  | 方式行标题 / 副题                  | 409 @24 / @20                                                                                                                                                                                                                                                                                  |           16 / 19 |           32 / 38 |

- **agent 翻译硬约束**：为 `login.*` 生成或修改任何语言文案时，必须按上表逐语言自检；超预算就换更短表述（ja / ko 往往比 zh 长，优先压缩语序与敬语冗余），**禁止**靠布局手段（缩字号 / 加折行 / 依赖截断）吸收超长文案。
- **折行与对齐机制分级**：
  1. **单行槽**（标题 / 链接 / 倒计时 / CTA / 方式行文字）：`nowrap + ellipsis` 仅作**防御性兜底**（防极端 locale 炸版），不是设计许可——见原则条。标题类顶对齐 + 显式 `lineHeight = 槽高`（防继承行高被 overflow 裁 descender，MT-7 教训）。
  2. **说明 / 提示类**（**副标题**、输入框 hint、错误文本、游客模式说明）：允许折行但 **≤2 行 + 行数 clamp**，**顶对齐、槽高 = 行高 × 最大行数、折行只向下伸展**；禁止「固定小槽 + flex 垂直居中」——那会让超行文本上下双向外溢压到相邻控件（2026-07-24 Enterprise SSO hint 压输入框实拍事故即此模式）。副标题原属单行槽，2026-07-24 拍板改判入本级（禁省略号、完整展示，几何 540@70 对齐控件列，双端已落码）。
  3. **弹窗族例外**（迁移弹窗等独立弹窗）：卡片 flex column 允许文本撑高、按钮钉底、pill 圆角跟随——仅弹窗族，不适用登录面板。

### 16.3 组件定义

桌面 `apps/desktop/src/renderer/components/login/LoginControls.tsx`（11 组件），手机 `apps/mobile/src/components/LoginSkinControls.tsx`（13 组件）。两端同名组件同参数源。逐组件契约（逐参数值以组件常量与 §16.2 几何表为准）：

| 组件                                               | 端      | 用途                                                                                                           | 关键 props                                                                        | token / 几何                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LoginPanel`                                       | 双      | 白面板容器                                                                                                     | `children`, `testId`, `height?`（**桌面，仅 Splash 使用**）                       | 680×**500** r36 `--login-panel-bg` + inset 1px border；桌面由 `LoginStage` 承载缩放。`height` 默认 = 面板 500 且登录侧一律用默认值；**Splash 五帧传 440**（无「跳过登录」入口、设计稿未改版，跟随 500 会在启动态凭空多出 50 CSS px 空白；两者不同 stage、不同缩放，拆开不破坏 handoff 连续性） |
| `LoginStage`                                       | 桌面    | 1819×2098 画布「面板宿主」层，等比缩放 + z 序                                                                  | `children`, `ssoOrgGroupY`, `groupStyle`                                          | 登录组 @(570, 1229 / 1227) 680×**620**；品牌层在 `LoginBrandStage`                                                                                                                                                                                                                             |
| `LoginTitleBlock`                                  | 双      | 标题 + 副标题                                                                                                  | `title`, `subtitle`, `regionPill?`（桌面）                                        | 标题 y=31 h=38 32 Bold `--login-title-text`；副标题 @(70,75) 540 宽 ≤2 行顶对齐 20 Regular `--login-secondary-text`（2026-07-24 拍板，原 599×23 单行作废）。区域徽标见下方专条                                                                                                                 |
| `LoginInput` / `LoginSkinInput`                    | 桌 / 手 | 通用输入框                                                                                                     | `value`, `onChange`, `placeholder`, `center?`, `error?`, `prefix?`                | @(70,158) 540×80 r40 `--login-control-bg`；边 placeholder→active；`center`=验证码居中变体                                                                                                                                                                                                      |
| `LoginSkinPhoneInput`                              | 手机    | 手机号 + 固定国家码前缀                                                                                        | `prefix`, …                                                                       | 同 `LoginSkinInput` 几何，前缀不可点                                                                                                                                                                                                                                                           |
| `LoginPrimaryButton`                               | 双      | 主按钮（五态）                                                                                                 | `label / children`, `onClick / onPress`, `disabled`, `loading / busy`             | @(70,300) 540×80 r40 `--login-primary-button-bg / -border / -text`；disabled 桌面见 §16.5（墨水填充 + 占位档文字），手机现为白 70% 叠层 + 边 `--login-control-border-disabled` + 文字 opacity 0.8；loading spinner 24@(487,27)                                                                                                                |
| `LoginSocialRow`                                   | 双      | 第三方圆钮行                                                                                                   | `children`, `count`                                                               | y=**540** 行内水平居中，80×80 gap 70；`count` 随 provider 动态（**不含游客圆钮**，2026-07-27 起该入口改为面板内文字按钮）                                                                                                                                                                      |
| `LoginSocialButton`                                | 双      | 第三方 / SSO 圆钮                                                                                              | `label`, `onClick`, `children`, `isLoading / busy`                                | 80×80 r50 `--login-primary-button-bg / -border`；icon 48 居中；仅 normal + hover（桌面）+ pressed，**无 disabled / loading 视觉态**                                                                                                                                                            |
| `LoginSocialGlyph`                                 | 手机    | 社交图标矢量（Apple / Google / WeChat / SSO；**apple 分支仅非 iOS 场景**——iOS 走官方按钮不进圆钮行，见 §16.2） | 内部                                                                              | Google / WeChat 品牌色不变；Apple / SSO 单色随圆钮底反相（暗色白圆上 `#2A2828`）                                                                                                                                                                                                               |
| `LoginBackButton`                                  | 双      | 返回                                                                                                           | `label`, `onClick`, `disabled`                                                    | @(20,20) 60×60 r40 `--login-action-control-bg` / `--login-back-border`；chevron 24                                                                                                                                                                                                             |
| `LoginTextLink`（桌）/ `LoginTextLinkSlot`（手）   | 桌 / 手 | 重发链接 / 提示文案（**文字链接**，不承载「跳过登录」）                                                        | `variant`（link / countdown，桌）, `tone`, `children`                             | @(70,238) 540×50 20；link 变体 `--login-link-text` 下划线可点、hover / pressed 变色；countdown 变体（桌面）`--login-secondary-text`（墨水次要档 黑 56% / 白 55%）不可点；手机 `LoginTextLinkSlot` / 倒计时暂保留 `controlPlaceholder` 实色，另行收拢                                                                                                                                                     |
| `LoginSkipEntry`（桌）/ `LoginSkipLoginLink`（手） | 桌 / 手 | 「跳过登录」入口（**文字按钮**，与上一行的文字链接是两种组件）                                                 | 桌：`children`, `onClick`, `disabled`, `testId`；手：`label`, `onPress`, `testID` | 槽 @(0,430) 680×60，文字 24 Regular + 下划线、`--login-secondary-text`（桌面：墨水次要档 黑 56% / 白 55%；手机端该入口已剥离，见 §16.5 勘误），**hover / pressed 不变色**；命中区 = 文字实宽 + 左右各扩（桌 30 / 手 50 设计px）、高占满 60 槽，容器不可点 —— 逐条口径见下方「登录文字按钮」                                                               |
| `LoginResendCountdown`                             | 手机    | 验证码重发（倒计时 / 重发二态）                                                                                | `deadline`, `countdownTemplate`, `resendLabel`, `onResend`                        | @(70,238)；`deadline=null` → 常驻可点无倒计时（SSO 验证码屏用）                                                                                                                                                                                                                                |
| `LoginMethodRow`                                   | 双      | 方式选择行（企业 / 个人）                                                                                      | `top`, `title`, `subtitle`, `icon`(enterprise / person), `onClick`                | 540×100 r60 `--login-action-control-bg` / `--login-control-border`；左图标 24@(27,37) / person 18×20@(30,39)；右 share 18@(490,40)；文字 @(67) 垂直居中                                                                                                                                        |
| `LoginErrorText`                                   | 双      | 错误提示                                                                                                       | `children`                                                                        | @(0,380) 680×50 20 `--login-error-fg`                                                                                                                                                                                                                                                          |
| `LoginLoadingRing`                                 | 双      | 大 loading 环（浏览器 / 准备态）                                                                               | `y`, `label`                                                                      | 64×64 @(308, 158 / 193)；轨道 `--login-loading-ring-track`，内弧 `--login-primary-button-bg`（Splash 转圈环 64×64@(308,188) 同轨道 token，内弧为 `--login-secondary-text`）                                                                                                                    |

**登录文字按钮（新组件类别，2026-07-27 拍板）**：登录域现在有**两种**纯文字操作组件，语义与视觉都不通用，**不得互相复用**：

|                 | **文字链接**（`LoginTextLink` / `LoginTextLinkSlot`）      | **文字按钮**（`LoginSkipEntry` / `LoginSkipLoginLink`）                                                                                                                                                         |
| --------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 语义            | 链接：跳转 / 重试 / 次要说明（重发验证码、sso-org 帮助行） | 按钮：触发一次产品级动作（跳过登录 → 进入本地模式）                                                                                                                                                             |
| 色              | `--login-link-text` 族（墨水正文档） | `--login-secondary-text`（墨水次要档 黑 56% / 白 55%，零新增 token；手机端无此入口，见 §16.5 勘误）                                                                                                                                      |
| hover / pressed | 变色（`--login-link-hover` / `-pressed`）                  | **不变色**——只靠下划线常显 + 指针形状（桌面 `cursor:pointer`）给反馈                                                                                                                                            |
| 字号 / 槽       | 20，槽 540×50 @(70,238)                                    | 24，槽 680×60 @(0,430)                                                                                                                                                                                          |
| 命中区          | 槽内整块                                                   | **文字实宽 + 左右各扩**（桌面 30 / 移动 50 设计px），高度占满 60 槽；680×60 容器只做居中定位、自身不可点（桌面 `pointer-events:none` + 内层 button `auto`；移动 `pointerEvents="box-none"` + 内层 `Pressable`） |

- **为什么命中区随语言自适应**：文字实际渲染宽度按语言不同（zh「跳过登录」96 设计px vs en `Skip Sign-In` 更宽），固定宽热区会在某些语言下偏窄或越界；扩张量固定、宽度 shrink-to-fit，热区随语言同步。
- **为什么放大 bounds 而不是用 hitSlop**：RN 的 `hitSlop` 不越父 View 边界（Android 界外触摸不派发），与协议 radio 同一套仓内约定（§16.4 hitSlop clamp 契约）。移动端命中区高度占满 60 槽（phone ~0.5 缩放 ≈30pt，与返回钮 60 设计px 同档），向上不侵入主按钮下沿、向下不越面板底。
- **防御性截断**：内层按钮 `maxWidth = 680` + `nowrap` + `ellipsis`（移动 `numberOfLines={1}`）仅为防极端 locale 把两侧撑出面板 `overflow:hidden` 被静默裁掉，**不是设计许可**——线上出现可见省略号 = 该语言文案超预算 = 文案 bug（P1，改文案不改布局，见 §16.2 长度预算表「跳过登录」行）。
- **focus ring**：当前与登录域其它按钮一致（未单独实现 focus 可见环），随登录域 focus 态统一处理时一并补。

**区域徽标（`LoginTitleBlock` 的 `regionPill`，桌面；figma §4.10 胶囊 h30 r40，2026-07-27 改判）**：标题右侧品牌红胶囊，`--login-brand-accent` 底 + `--login-inverted-button-border` 白字 16 Bold，inline 组内 gap 2、垂直居中于 38 行框。

- **挂哪些区域**：`cn` → `CN`；`dev` → `Dev`；**`global` 不挂**。这是产品叙事的硬规则而非视觉遗漏——Cindy 是「天生全球」的产品，默认版本不给自己贴标签自证是全球版，只有为特定法规单独构建的版本才被标注（不对称命名）。旧实现给 global 挂 `Global` 徽标，读出来反而是「存在一个本土主场版、这是它的出口型号」，与叙事相反。**给 global 恢复徽标即回退该决策，不得回退。**
- **为什么 cn / dev 仍标**：两者连的都不是 global 端点（cn 走国内端点、dev 走独立 dev 端点），登录页是用户确认自己连向哪个后端的位置；dev 另有并存场景——`CindyDev` 保持独立可执行名，可与正式包同机共存。⚠️ **不要把 cn 的理由写成「区分同机双装的 cn / global」**：2026-07-26 起两者可执行名同为 `Cindy`、安装目录与快捷方式同名互抢，该双装场景已**明确放弃支持**（见 `packages/maker-shared/src/brandIdentity.ts` 的 `executableNameByRegion` doc）。
- **宽度自适应**：由 `REGION_PILL.paddingX`（11）撑开，不再固定 70px——70 是为 `Global` 一词量身定的，`CN` / `Dev` 在固定宽里会留大片空白。11 由原几何反推（(70 − `Global` 6 拉丁字符 @16 Bold ≈ 48) / 2），保住 figma 的左右留白密度。
- **文案不翻译**：各语言同文的区域代号（承袭旧 `login.globalRegion` 的做法），但仍走 i18n（`login.regionPill.*`），以便日后改判为「中国大陆版」这类可译文案时不必回改组件。
- **手机端无此变体**：`apps/mobile` 的 `LoginTitleBlock` 不接 `regionPill`（移动端未做区域徽标）。

**组件库新增（2026-07-24 登记；协议 UI 已随 consent PR 落地，游客圆钮方案已由上述「跳过登录」文字按钮取代）**：

- **协议勾选 radio**（figma `radiobutton 600:627`，四态双模式）：24×24 命中区，圈 20×20 r9 + 2px 描边，选中为**对勾**（非圆点）。未选 = 墨水填充底 + 次要档描边，选中 = 主按钮反相实底 + 主按钮字色对勾（2026-10-27 墨水口径，见 §16.1）——选中反色与登录黑白反色体系同构。用于登录页 `服务条款` 协议行。
- **服务条款弹窗小按钮**（figma `light_button_*` / `Dark_button_*` 四母版，`602:846/863/1297/1311`）：260×80 r40 文字 Bold 24；强调钮（同意）= 主按钮反相 CTA，普通钮（不同意）= 墨水填充 + 墨水线 + 正文档文字（2026-10-27 墨水口径）。hover / pressed 见 §16.5 第 1 条。
- 既有组件扩容：`SSO 登录_企业` 与 `back` 均扩为含 Dark 三态的六态集（值已并入 §16.1 `--login-action-control-bg` / `--login-back-border` 口径），`white_button` 增 loading 五态。

### 16.4 登录链路逐屏

验证码重发倒计时统一为 **60 秒**，与服务端单目标冷却一致；Figma 中的 42 秒仅是倒计时过程示例。只有发码请求成功才开始或重置倒计时，短信登录的 `429 / RATE_LIMITED` 显示「操作过于频繁」错误，不视为已发送。桌面端与移动端均使用绝对截止时间，休眠恢复后按剩余时间校正。实现见[桌面倒计时](../../apps/desktop/src/renderer/components/login/useResendCountdown.ts)与[移动端倒计时](../../apps/mobile/src/auth/loginSkinLayout.ts)。

登录状态机权威 = `packages/auth-client` 源码（`AuthFlowState` / `LoginOutcome` 判别联合；`flow-map` 为辅助导航，个别 UI 段落滞后于区域定形态改版）。共享 step ∈ {`identifier`, `method-choice`, `verification-code`, `sso-verification`, `browser-redirect`, `account-selection`, `binding`, `completed`, `error`}（`sso-org` **不是**共享 step，是 `identifier` 下的页面局部 `ssoOrgMode` 子视图）；其中 `account-selection` / `binding` / `sso-verification` / `completed` 由服务端 `LoginOutcome.status`（`ok` / `select_account` / `binding_required` / `sso_verification_required`）分支决定，**不是固定步骤**——任意 outcome 调用都可能命中。逐屏职责与关键组件（逐屏坐标 / 文案见 `DESIGN-login §3` 国区 / `§4` 国际区 / `§5` 移动）：

| 屏（step）                                        | 职责                                                                                                                                                                                                                 | 关键组件                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identifier`                                      | 输入手机号 / 邮箱（国区 phone / 国际区 email），含 social 圆钮行（Apple / Google / SSO，**无游客圆钮**）+ SSO 入口 + 协议同意行；**面板内常驻「跳过登录」入口**（2026-07-27 起，**仅桌面**；手机端 2026-07-28 剥离） | `LoginInput` / `LoginSkinPhoneInput` + `LoginPrimaryButton` + `LoginSocialRow` + `LoginConsentRow` + `LoginSkipEntry` / `LoginSkipLoginLink`                                                                                                                                                                                                                                |
| `method-choice`                                   | 存在真正选择时：企业 SSO / 个人邮箱验证码，或多条 SSO 连接。探测结果只剩唯一 SSO 或唯一邮箱验证码时不展示本屏——前者投影 `browser-redirect`，后者直接发码进入 `verification-code`（跨区确认窗随 step 离开一并关掉）   | `LoginMethodRow`×2（top 158 / 278）+ `LoginTitleBlock`（`chooseMethod`）                                                                                                                                                                                                                                                                                                    |
| `verification-code`                               | 输入 6 位验证码，60s 重发倒计时                                                                                                                                                                                      | `LoginInput`(center) / `CodeInput` + `LoginTextLink` / `LoginResendCountdown` + `LoginPrimaryButton`                                                                                                                                                                                                                                                                        |
| `sso-verification`                                | SSO 登录后验证企业联系方式，两子态（`codeRequested` false = 只发码 / true = 输码 + 常驻重发，**无倒计时**）                                                                                                          | `LoginPrimaryButton`(sendCode) → `LoginInput`(center) + `LoginPrimaryButton`(completeSignIn / signIn) + `LoginTextLink` / `LoginResendCountdown`(deadline=null)                                                                                                                                                                                                             |
| `sso-org`（`identifier` 局部子视图，非共享 step） | 输入企业 ID / 组织 slug / 已验证域名跳转 SSO（`ssoOrgMode`）                                                                                                                                                         | `LoginInput` + `LoginPrimaryButton` + `LoginTextLinkSlot`（ssoOrgHint）                                                                                                                                                                                                                                                                                                     |
| `account-selection`                               | 服务端返回 ≥2 membership，用户选一个                                                                                                                                                                                 | account row + `LoginTitleBlock`（`chooseAccount`）                                                                                                                                                                                                                                                                                                                          |
| `binding`                                         | 身份未绑 membership，补绑 phone / email（`codeRequested` 两子态；**无重发钮**，桌面 harness 锁定）                                                                                                                   | `LoginInput` / `LoginSkinPhoneInput` → `LoginInput`(center) + `LoginPrimaryButton`                                                                                                                                                                                                                                                                                          |
| `account-deletion`（状态浮层）                    | 账号删除**状态展示**（发起流程在 Settings 的 `AccountDeletionSection`；登录页仅在存在删除回执时以**根层浮层气泡**展示 status，非主状态机 step；详见下方「注销状态浮层气泡」）                                        | `AccountDeletionStatusPanel`（**登录皮容器外**的根层浮层，非面板内）                                                                                                                                                                                                                                                                                                        |
| `browser-redirect`                                | 社交 / SSO 跳浏览器验证，等待回调                                                                                                                                                                                    | `LoginLoadingRing` + Desktop `LoginBackButton`（`cancel-browser`；Mobile 保留原取消入口）+ `LoginTitleBlock`                                                                                                                                                                                                                                                                      |
| `completed` / `error`                             | 登录成功 / 失败（含 browser 回调终态页）；`error` 步桌面另有面板下方 footer 的「跳过登录」**逃生入口**（登录服务不可用时仍能进未登录状态，与面板内入口同口径**过协议门**——2026-07-29 拍板；重试连接登录服务期间不禁用，只在切换到未登录状态的过程中禁用）                          | 成功无面板（进主界面）；error = `LoginBackButton`（仅桌面：普通登录网络错误取消当前等待，使用已取得的配置返回入口；配置尚未取得时显示「继续登录／跳过登录」的离线入口，不自动联网；添加账号则关闭流程）+ `LoginTitleBlock` + `LoginPrimaryButton`（重试）+ `LoginErrorText` + footer「跳过登录」按钮（桌面）；browser 回调页 `oauthResultPage`（系统浏览器独立 HTML，main 侧内联常量,色值与 `--login-callback-*` token 同源——renderer CSS var 不可达,改值需两处同步） |

**~~配置错误屏同样承载「跳过登录」逃生入口（移动端）~~〔已作废 2026-07-28：手机端整体剥离，配置错误屏无该入口〕**：`getMobileConfigIssues()` 命中（如 auth base URL 非法）时面板切到 config 提示态，该面板内仍渲染同一个 `LoginSkipLoginLink`（同槽 @(0,430)、同 handler、同 in-flight 门）——跳过登录不发任何网络请求，配置坏掉时恰恰最需要这个入口。

**协议门（consent gate）过门点与豁免（2026-07-29 更新）**：`identifier` 屏的协议同意行是一道**发起前拦截**——未勾选时点过门入口先弹服务条款 / 隐私协议弹窗，同意后续接原动作；同意即写入统计采集同意。

|                                | 入口                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **过门**（个人链路一律先同意） | 手机号提交、邮箱提交（含仅查方式的 discover）、`method-choice` 个人行发码、社交圆钮（Apple / Google / 未来微信）、**「跳过登录」**（面板内常驻入口 + 桌面 `error` 步 footer 逃生口）——2026-07-29 拍板 |
| **豁免**                       | 显式企业 SSO 入口（SSO 圆钮、组织标识提交、`method-choice` sso 行）                                                                                                                                   |

「跳过登录」过门的口径（2026-07-29 拍板，**推翻 07-27 的免门结论**）：不登录账号也是在使用 Cindy 客户端，因此与个人账号登录同口径——未勾选时先弹协议弹窗，同意后才进未登录状态，并写入统计采集同意（是否真的上报另由 main 侧闸决定：`analyticsSettingsService` 对本地会话一律 `!isLocalMode()` 不放行）。协议 UI（radio 四态、弹窗小按钮）与企业 SSO 豁免均不变。

> **实现约束（合规，勿改顺序）**：这条链路上「同意记录」必须落在 `auth:enter-local` **之后**，与其它过门点（放行时刻即落）不同。原因是 `acceptPrivacyConsent` 的 IPC handler 会同步广播 `allowed = isAnalyticsAllowed() && !isLocalMode()`——提前落同意时 `isLocalMode()` 尚为 false，广播出的 `allowed:true` 会让 renderer 的 TapDB 当场 `initSdk()` 并发出 `device_login`，等 `enter-local` 完成再广播 `allowed:false` 已经晚了，「未登录态不上报」在正式包上就被破了一个窗口。落码为 `requireConsent(action, { deferConsentPersist: true })` + `openLocalMode` 自己在会话切换后落同意；顺序由 `LoginPage.consent.test.tsx` 的 `invocationCallOrder` 断言锁住（面板内入口与 `error` 步逃生口、勾选与弹窗两条路径都覆盖）。
>
> 同一条合规约束还要求**切换窗口内不接任何新动作**：`auth:enter-local` 的 handler 要 await `waitForSessionInvalidation()` 与 `teardownAuthAccountBoundary()`，这段窗口里 `isLoading` 仍为 false、协议弹窗已关且 radio 已勾选，邮箱 / 社交等入口仍可点——它们走「放行即落同意」分支，会在 main 还没转成 local 时再次广播 `allowed:true`。收口点是 `requireConsent` 顶部的 `localModePendingRef` guard（豁免协议门的企业 SSO 入口与 `error` 步 `reset` 另行自挡，因为它们绕过 `requireConsent`）。用**行为层 guard 而不是给每个控件加 disabled**：窗口通常只有几十毫秒，全量 disabled 会换来一次可见闪变（规则 7：无视觉跳变），而行为 guard 已杜绝 persist 与派发。guard 读 ref 而非 state——点击可能落在 `setState` 与 re-render 之间，那时闭包里的 state 还是旧值。

**协议同意行整行热区（2026-07-29 拍板）**：命中区由 radio 的 24px 圈体扩到**整行 680×40**——点声明文字或行内空白都等于点 radio。例外两类：行内「服务条款」/「隐私协议」链接各自 `stopPropagation`（只开链接、不切勾选态），radio 自身也 `stopPropagation`（否则冒泡到行容器二次 toggle，净效果为点不动）。行容器不加 `role` / `tabIndex`：radio 仍是唯一无障碍交互点（`role="checkbox"` + `aria-labelledby` 指向声明文字），整行点击只是鼠标增强；整行 `select-none`，避免连点选中文字盖住勾选反馈。

**注销状态浮层气泡（figma 678:1075「注销状态」组件集，2026-07-26 定形）**：账号注销状态**不在登录面板内**，而是登录屏根容器的 absolute 浮层——历史实现曾把它放在登录皮容器（`LoginStage`）的文档流首子位置，被 `absolute; top:0` 的不透明登录面板 100% 覆盖（`pending` / `processing` / `completed` 三态全中，修复前证据见 `docs/design-previews/deletion-banner-repro/`）；**改回面板内即重现该缺陷，不得回退**。

- **层级与布局**:不占布局流、不推挤下方内容,**允许盖住立绘与字标**(设计意图,figma iPhone 帧即压立绘 91px);桌面 `z-30`(低于顶部拖拽条 `z-40`、协议弹窗 `z-50`),移动端靠渲染序位于登录组之后、协议弹窗之前。几何按设计单位 × 登录组同一缩放系数(见下「几何」),不随键盘位移。
- **显隐**：跟随面板入场——opacity 复用登录组同一入场动画值，入场完成前不可见且不可点击（桌面 `panelHidden` / 移动端 `handoffPhase === 'done'` 门控 `pointerEvents`），避免冷启动带注销回执时气泡先于登录 UI 出现在 splash 上。协议弹窗打开时，Android 需与登录组同步 `importantForAccessibility="no-hide-descendants"`（`accessibilityViewIsModal` 仅 iOS 生效，否则 TalkBack 可穿透读到状态文案并激活「我知道了」）。
- **几何(设计单位,与登录组同缩放)**:气泡的每一个几何值都是**设计画布单位**,渲染时乘以与登录组相同的缩放系数——不是物理 px。桌面画布 1819×2098 是 2x 稿,系数 = `PANEL_FIXED_SCALE`(0.5);移动端为各 stage 的 `surface.scale`(phone = 屏宽/750,pad 见 `resolveLoginSurface`)。**2026-07-26 修正**:初版把设计单位当物理 px 直接落码,气泡在屏幕上宽了整一倍(与面板 340 并列时达 670),已按下列换算纠正。
  - 桌面:宽 670、距窗口顶 72(顶对齐固定)→ 屏幕 **335 / 36 CSS px**,与登录面板 680×0.5=340 基本同宽(设计稿即 670 vs 680);水平窗口居中;窄窗时可视宽钳制 ≤ `100vw − 24`。
  - phone(stage 750):宽 670 @x=40 → 屏幕 `670 × 屏宽/750`(393pt 屏 ≈ 351pt,左右边距各 ≈21);top 取 safe-area 顶(设计 y=116 即状态栏下沿,间距 0)。
  - pad 横屏(stage 1180×820):宽 556 = `WORD_MARK` 框宽(figma 679:1201 x=607 w=556,与字标同宽)、x=607(中心 885 与登录组中心 884.8 同轴)、top 72(底边 163 距字标框顶 177 留 14);均 × `surface.scale`。
  - pad 竖屏(stage 744×1133):宽 504(字标框宽按可见图形等比反算 269.51 × 556/297.32)、水平居中于字标轴、top 72;均 × `surface.scale`。`left` 钳制在屏内。
  - 高度**由内容撑开**,禁止固定高。
- **视觉(同为设计单位)**:圆角 22、四边 padding 20、**不透明底**(浮层压立绘必须不透明,不靠阴影 / 模糊);描边保持 1 物理 px 细线(不随缩放,否则小系数下会消失);无图标、无阴影、无动效。标题与正文同为 20 / 行高 23 / Regular 400、全部居中(长文案居中换行),仅以颜色区分层级(标题 `--login-control-text` / 正文 `--login-secondary-text`);标题↔正文 5、正文↔「我知道了」22、**「我知道了」↔气泡底固定 20**(= 下 padding,文案拉长该距不变)。内部几何由组件子元素坐标反算自洽:figma 678:1074 标题 text @(20,20) h=23、正文 @(20,48) h=23,无钮变体总高 91 = 20+23+5+23+20。
- **「我知道了」**(仅 `completed` 态):下划线文字链(非按钮)。热区按端处理——桌面用上下各 11 设计单位 padding + 等量负 margin 抵消视觉(缩放后约 22 CSS px 高,鼠标指针足够);触摸端 hitSlop **按气泡内可用空间钳制**:上 = min(18, 正文↔链接间距×scale)、下 = min(18, 下 padding×scale)、左右 20 物理 pt——RN 的 hitSlop 不会越过父 View 边界,写大了是虚标。**不设未缩放的 44pt 绝对下限**:整个登录系统按 stage 缩放(320pt 窗口下登录主按钮本身仅 ≈34pt 高),孤立保 44 必须打破「正文↔链接 22 / 底距 20 恒定」的拍板视觉;热区随系统同步缩放、在边界内取最大。
- **颜色**：底 `--login-deletion-bubble-bg`（同登录面板 `#FDFDF8` / `#1F1F1F`）、描边 `--login-deletion-bubble-border`（墨水线 黑 8% / 白 10%），均为**固定亮 / 暗二值**——与 §16.2「`--login-*` 只分 light / dark、不随扩展主题」一致，**不得**改用 `var(--surface)` / `var(--chat-input-*)` 等会被扩展主题 override 的 alias（同 `--login-bg-base` 的改判先例）。移动端色板暂保留原值（#FFFFFF / #1F1F1E），随手机登录皮另行收拢。
- **状态与文案**：`pending`（预计删除日期 + 重新登录可取消）/ `processing`（等待期结束、正在删除）/ `completed`（已删除 + 「我知道了」）三态；`cancelled` 在轮询侧拦截、不渲染气泡（改为登录后的一次性「注销已取消」提示）。所有支持语言 × light / dark 全覆盖。

桌面登录恢复：准备态、错误态及离线入口的返回与「跳过登录」不因登录方式请求仍在等待而禁用；重试仍单次执行。凭证存储错误保留原有的检查与帮助流程，不绕过存储恢复限制。返回使旧请求失效，迟到结果不得覆盖新入口；「跳过登录」保留协议同意门与先切换本地会话、再保存同意的顺序。等待登录方式期间打开的跳过协议弹窗，在方式加载完成后仍可同意续接；登录完成、进入其他登录步骤或凭证存储故障仍取消续接。切换本地模式失败时保留可用表单，无表单的准备态进入可重试错误页，旧请求不得重新覆盖页面或解除新请求的等待。覆盖见 `LoginPage.initialization.test.tsx`、`LoginPage.consent.test.tsx`、`AuthContextInitializeCatch.test.tsx` 与 `authLoginBack.test.ts`。

### 16.5 深色模式与主题跟随

> 深色受 §10「Light / Dark 双模式交付门槛」约束，是**必须交付**的另一模式，非可选愿景。已落地：token dark 槽位、overlay token、深色资产切换及主题跟随均已实现；2026-10-27 起两模式色值取 CINDY 主界面墨水口径（§16.1）。机制如下。

**深色 = 主界面深色墨水口径**：面板取主界面深色卡片面，控件、描边与文字为白墨水，主按钮与社交圆钮反相白；几何 / 布局 / props / 状态机 / i18n **零改动**——只换色值。

**大部分组件纯 token 驱动**（由 §16.1 双态表的 dark 值驱动，组件不动）：`LoginPanel` / `LoginInput` / `LoginPrimaryButton`（底 / 边 / 字 + spinner）/ `LoginSocialButton`（随主按钮 token 自动反相白圆）/ `LoginBackButton` / `LoginTitleBlock` / `LoginTextLink` / `LoginMethodRow` / `LoginErrorText` / `LoginLoadingRing`。

**3 处非纯 token、需组件改动**：

1. **hover / pressed 叠层二态（2026-10-27 用户裁决，取代 2026-07-24 Figma「叠白变亮」口径与其状态矩阵）**：叠层一律走 `--login-overlay-*` light / dark 二态 token，挂在内容之下，不压文字与图标。
   - **墨水填充控件**（输入框、方式行、返回钮、协议弹窗「不同意」钮）：叠同色墨水加深一档——hover 叠黑 3% / 白 4%，与控件底合成约等于主界面「选中」档 8% / 10%；pressed 叠黑 5% / 白 7%，合成约等于「弱」档 10% / 13%。亮色变深、深色变亮，与主界面菜单 / 列表反馈同向。
   - **反相主按钮与第三方圆钮**（主按钮、「同意」钮、Google / WeChat / SSO 圆钮、回调页 CTA）：叠黑——亮色 hover 20% / pressed 40%（`#3C3F43` → 约 `#303236`，对齐主界面 `accent-hover` `#2E3237`），深色 hover 5% / pressed 10%（`#EEEEEE` → `#E2E2E2` / `#D6D6D6`）。
   - **Apple 圆钮**底色由 Apple 规范决定（亮黑 / 暗白），亮色黑圆叠黑没有反馈，故单独走 `--login-overlay-apple-*`：亮色叠白 8% / 14%，深色叠黑 5% / 10%。
   - **disabled**：主按钮禁用 = 墨水填充 + 占位档文字，描边透明、不叠层；原「深底叠白 70%」退役；`--login-disabled-button-overlay` 保留 ID 与透明默认值（治理合同 §4：旧 Token ID 不删除），组件不再消费。
   - **旧本地主题**：旧版「导出当前主题」会把当时所有 `login-*` 值写进本地副本，加载时优先于新默认值，升级后这些副本的登录页仍是旧样子（旧面板 / 画布 / 文字色与新色混在一起，禁用主按钮与可用态几乎相同）。`local-themes-normalize` 在**加载期**把「等于该主题模式历史默认值」的 `login-*` override 丢掉（对照表 `themes/loginLegacyDefaults.json`，取自冻结快照 `desktop-color-defaults.json` 自 2026-09-02 建档起的全部 git 历史，每个 token 出现过的旧值都在内，不逐代手补）。只比对本模式的槽位（深色主题里有意用的亮色历史值不丢），只处理确认是旧快照的主题（其中至少 10 个 `login-*` 值同时等于该模式的历史值；手写稀疏主题、或新建副本里零星几个被有意设成历史值的 override 保留），只改内存、不改写磁盘、幂等。建档之前的更早版本不在表内。
   - **回调页**（`oauthResultPage`，系统浏览器打开，拿不到 renderer token，用内联常量）：页面底、卡片、描边与 CTA 同上取值，CTA 叠层改挂 `background-image`，不压文字。
2. **`--login-bg-base` 前提变更**：画布底原为「跨主题恒定白 `#EDEDED`」，深色为 `#1F1F1E`（figma 532:585 帧实测）——即 `--login-*` 从「跨主题恒定」改为「随 light / dark 二态」（见 §16.2）。〔2026-10-01〕两态改为与 CINDY 皮肤页底同值 `#F2F2ED` / `#181818`，登录前后背景不再变色；仍为固定值，不随扩展主题。
3. **`LoginBrandStage` 资产按模式切**：深色画布用**登录专用**白字版字标 / slogan 资产（`assets/login/wordmark-dark*.png` / `slogan-dark*.png`，源自 figma 532:585 `CINDY_Standard_White` 与 SLOGAN `#FBFBFB`，已随暗色实现 PR 新增；**不是** §15.7 的新页横版 `cindy-logo-dark.png`——落位与尺寸不同）；立绘两模式同资产。

**disabled 态**：主按钮 disabled = 墨水填充（`--login-disabled-button-bg`，黑 5% / 白 6%）+ 占位档文字（`--login-disabled-button-text`，黑 32% / 白 30%），描边透明（`--login-control-border-disabled`）、不叠层；与可用态的反相实底拉开明显差距，一眼可辨不可点（2026-10-27 用户裁决；不沿用主界面 Button 的整体 60% 透明度，因为登录页首屏主按钮默认即为禁用态）。

**双模式门槛覆盖**：深色须覆盖亮色全部态——控件 default / hover(桌) / focus / filled / active / pressed / disabled / loading / error，全部 11 屏，桌面 Win / Mac + 手机 iOS / Android（phone / pad）。色值以 §16.1 为准（桌面取 CINDY 主界面墨水口径）。桌面组件的亮 / 深与 hover / pressed 用 `pnpm ui:check --page login-skin --case all --theme all` 截图核对（改动时加 `--compare` 出改前 / 改后）；它覆盖真实组件，不覆盖登录画布缩放与品牌层。

**主题跟随（产品逻辑）**：用户**首次**打开 Cindy → **亮色**登录界面（默认）；**第二次起** → 登录界面跟随用户上一次使用的 **light / dark 模式**（登录页只认 light / dark，不随具体扩展主题，见 §16.2）。这需要持久化「上次登录模式」+ 首次默认逻辑，超出纯 token 补范围，是一段状态逻辑。**已落地**：`apps/desktop/src/renderer/hooks/useTheme.ts` 持久化首启标记（`login.firstLaunchLightShown`），bootstrap 阶段由 `initLoginFirstLaunchLightGate` 对真首启整个登录前会话按亮色解析，登录页卸载时经 `endLoginFirstLaunchLightGate` 结束并恢复存储主题，不改用户的 theme 偏好。

**决策记录（2026-07-23 已定）**：(1) `--login-*`「跨主题恒定 → light / dark 二态」前提变更 + 新增 `--login-overlay-*` 二态 token——**已采纳**；(2) 深色落点 = **跟随编辑器 light / dark mode** + 上述主题跟随逻辑——**已采纳**；(3) 立绘 / 社交图标深色版——已核验（立绘两模式同资产，社交深色白圆 + 品牌色图标，见 §16.1）；本节原 ※推导值（splash 进度条 / 链接 hover / pressed）已经 Figma 组件库核验确认，§16.1 表已回填目标值。**（2026-07-24 增补）画布渐变定稿**：暗色帧红晕层（532:588/589）按 1:1 几何落地后，经实机走查拍板去除——两模式画布纯平（亮色撤渐变 = PR#104 拍板，两条决策相互独立、结论一致）；`--login-bg-gradient-*` token 保留 override 锚、值恒 `none`，红晕如需恢复须以该走查结论为基线重新与设计确认。**（2026-07-24 增补）组件库状态扩充**：hover 统一「叠白变亮」改判（本节 (1) 已按新口径改写，旧「白底钮 hover 叠黑 5%」作废）；新增协议勾选 radio 与服务条款弹窗小按钮目标规格（见 §16.3 尾注）；`SSO 登录_企业` / `back` Dark 三态、`white_button` loading 五态入库（逐态值见 §16.5 状态矩阵）。~~游客登录（跳过登录）样式为独立实现任务，不在本节展开~~〔**已回收（2026-07-27）**：该规格缺口已由本次改版关闭——入口定形为面板内「跳过登录」**文字按钮**（新组件类别，规格见 §16.3「登录文字按钮」；几何见 §16.2 表），游客圆钮方案与其图标资产一并退役〕。**（2026-07-24 增补·二）多语言长文本口径**：登录链路禁止以截断 / 省略号作为可见结果，文案侧按槽位长度预算约束（含 agent 翻译硬约束），说明类文本折行 ≤2 行 + 顶对齐 + 只向下伸展——规则全文见 §16.2「多语言长文本与翻译长度预算」。同日二次拍板：**副标题改判入说明类**（禁省略号、完整展示 ≤2 行，几何 540@70 对齐控件列，原 figma 单行 599@41 作废），双端已落码（桌面 `LoginTitleBlock` + 手机 `LOGIN_SUBTITLE`）。

**决策记录（2026-07-27 登录改版，拍板人 = 用户；依据 = figma 新稿 `705:915` / `705:799` / `700:783`）**：(1) **面板 440→500、登录组 560→620**，增的 60 全部给面板内新增的「跳过登录」槽（430..490），面板内其余元素坐标不动；圆钮行 480→540、协议行 582→642 随组顺移；error 槽回到 680×50 @380 与跳过槽首尾相接。(2) **游客圆钮退役 → 面板内「跳过登录」文字按钮**（新组件类别，见 §16.3），图标资产删除；圆钮行 `count` 动态。(3) **跳过登录 / 本地模式免协议门**（推翻 2026-07-24「个人登录一律先同意、含游客」），且不写统计同意；其它入口协议门不变（见 §16.4）。(4) **手机端新增跳过入口与无账号通路**（推翻 2026-07-24「手机 / pad 必须有账号、不加游客登录」）。(5) 移动端**键盘停靠锚改为 error 槽底**，键盘态允许遮挡跳过槽（见 §16.2）。(6) 手机短屏 / 长屏几何整档换新稿基准，短屏以下锚常量 `dh-640`→`dh-712`；**pad 竖屏为推导值（无 figma 源，用户接受推导，待设计回看）**。(7) **Splash 面板不跟随 500，保持 440**（拆出独立常量）。逐条落点见 §16.2 / §16.3 / §16.4 与 `design-decision-log.md`「2026-07-27」条。

> **⚠ 勘误（2026-07-28，拍板人 = 用户）：「跳过登录」仅桌面端落地，手机端整体剥离。**
> 上条 2026-07-27 决策记录的 (4)(5)(6) 与本节所有涉及**手机 / 移动 / 双端**的「跳过登录」
> 落地口径**一并作废**：手机端在 main 基线上从来没有游客 / 无账号功能，且 2026-07-24
> 产品拍板「手机 / pad 为远程连接客户端、必须有账号、不加游客登录」**仍然有效**（原判它被
> 07-27 推翻，经复核该推翻缺产品侧确认）。因此手机端本轮只保留**纯视觉改版**（品牌簇换新稿
> 基准 + 避脸方案），功能与几何回到 main 等价：**面板仍 440、登录组仍 560、圆钮行仍 480、
> 协议行仍 582、error 槽仍 680×60 @380、无「跳过登录」槽、键盘停靠锚仍是面板底、
> 无配置错误屏逃生入口、无 `LoginSkipLoginLink` 组件与 `skipLogin` 文案 key**。
> 本节表格里的 **500 / 620 / 540 / 642 / error 50 / 跳过槽 430..490 与命中区扩张 30**
> 均只对**桌面**成立；一切标注「移动 50」「双端」「手机端」的跳过登录口径读作**未落地**。
> **(6) 需拆开读**〔2026-07-29 二次修正〕：手机短屏 / 长屏的**品牌簇**（立绘 / SLOGAN / 字标）新稿基准与避脸落值**保留生效**；同条的**功能区落位**（`loginY` **622 / 827**）在 2026-07-28 曾随跳过登录剥离一并退回 main 原值（694 / 933），但那会与已换新稿的品牌簇拼出稿内不存在的 92 / 131.65 间距（实机可见空白），**2026-07-29 审图后恢复为新稿标注值**（方案 B，60 落到底部留白；详见上方 §16.2「面板 500→440 少掉的 60 去向」）。dh<1334 段**不采用**该条曾写过的 `dh-712`，而是「紧凑底距 18 + 钳到 622」（`dh-712` 会压盖窄屏字标，见 §16.2 对应条目）。**pad 竖屏推导值**（`loginY` 573.353 / `splashOffset` 206）仍然**作废**、保持 main 原值 621 / 158——pad 无 figma 新稿帧，其品牌簇也未换新稿基准，内部自洽，不受本次修正影响。
> 手机端保持无游客 / 无账号行为不变。详见
> [`design-decision-log.md`](./design-decision-log.md)「2026-07-28」条。

