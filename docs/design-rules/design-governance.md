# Cindy UI 设计系统治理合同

> 状态：治理正本（2026-08-29 起生效）
> 角色：本文件规定设计系统的**治理流程**——真相源边界、兼容红线、证据要求、PR 风险分类与
> 存量门禁处置。**视觉规则本身**（颜色、排版、组件、交互）一律以
> [`DESIGN.md`](./DESIGN.md) 为准；两者冲突时，视觉判断以 `DESIGN.md` 为准，流程判断以本文为准。
> 方法论先例：同套治理已在 `xindong/mivo-canvas-plugin` 仓完整试点并被 review 流程接受
> （治理合同 #191、单一台账 #233/#237、Token 单一权威 #332/#341、最小试点 #343）。

## 1. 目的与范围

Cindy 的新界面大量由非设计师贡献。本合同要达成的状态：

- 精确设计数值只维护一份真相，其余消费点由机器生成或直接引用；
- 旧主题与用户自定义主题永不因治理工作损坏；
- 非设计师使用标准组件即可产出基本合理的界面；新增裸颜色、任意字号等退化被机器发现；
- 整体视觉风格调整主要通过语义 Token、少量 Primitive 和核心 Pattern 完成。

范围：Desktop 与 Mobile 的 UI 视觉基础层（颜色、排版、间距、圆角、组件样式）。产品信息
架构与交互流程的设计不在本合同范围内。

### 1.1 管道与记账（守卫红灯的正确读法）

本合同的全部规则分两类，性质不同、改法不同：

| | 是什么 | 能不能改 |
| --- | --- | --- |
| **管道**（永久规则） | 值只有一个出处；旧 Token ID 不删不改名；用户主题不改写磁盘；颜色走语义 token 不许硬编码；迁移台账只有一份（见 §2.1；`token-decision-table.md`、`design-decision-log.md` 等职责不同的台账不在此列） | **不许绕过**——它与长相无关，改版后依然成立 |
| **记账**（当前拍板值） | 具体色号、圆角三档的当前成员、非保护区观感 | **随时能改**——走下面的合法改值路径 |

**记账值不等于无主值**。DESIGN.md 为部分值登记了比「设计师批准」更严的裁决门槛，
这些**保护值**不适用上表的通用改值路径，按各自条款执行：

- CINDY 皮肤族（`DESIGN.md §15`）：值经用户 2026-07-18 终签，**实现期零裁量**——
  仓内以主题文件、`cindyDecisionData.ts` 与冻结测试为权威编码，改值须回到用户裁决；
- U2 二级信息色（`DESIGN.md §15.5`）：明示「never darken unilaterally」，改值须
  **新的用户裁决**（2026-08 亮色调整即循此路径），冻结测试 `cindyThemes.test.ts` 组⑦
  会在缺裁决时拦下基线变更；
- `annotation-accent`（`DESIGN.md §15.4`）：图片标注烧录墨色，exempt, do not change
  ——与烧进位图的笔迹恒一致，改它就是改已发布图片的外观合同。

**守卫红灯不是禁令，是提醒走合法路径**：改数值真相源 → 同一 PR 更新对应守卫快照 /
台账 / 文档 → 按 §6 交证据 → 设计师批准（保护值另按上文门槛）。这是必要步骤，不是
绕守卫。唯一禁止的事：为了让红灯变绿而**未经裁决**加豁免、绕加载路径、在别处重声明
——那是砸管道，不是改设计。真实例外（资产固有色、平台语义色等，`DESIGN.md §10`
Process gates 要求）仍走 §11 登记的 `hardcoded-color-exemptions.json` 豁免表，附
理由与 owner 登记——经裁决登记的正式例外是合法路径，与为消红灯私自加条目是两回事。
系统对「混乱」的全部定义：消灭**没人决定过的变化**；一切拍板过的值都可以再拍板。

## 2. 四种真相与职责边界

| 真相 | 载体 | 负责 | 不负责 |
| --- | --- | --- | --- |
| 规则真相 | [`DESIGN.md`](./DESIGN.md) | 设计原则、MUST/SHOULD/NEVER、组件使用时机、豁免登记 | 不再人工维护精确数值总表（见 §11 处置表对 `DESIGN.md §10 Tier-1` 表与 `§16.1` 表的过渡安排） |
| 数值真相 | Desktop 已接管族：`packages/design-tokens/src/{reference,semantic,component,themes}` DTCG；`desktop-bindings.json` 登记输出与保留边界。Mobile 未接管族、运行期计算和用户主题仍沿原权威 | Terrazzo 2.7.1 生成颜色/内置覆盖、通用排版/间距/圆角/尺寸/动效、shared 默认字号与背板、DESIGN 精确摘要 | 不决定新观感、不改变用户配置或 Mobile 方案 |
| 台账真相 | `docs/design-rules/design-inventory.md`（DS-2a 已建立，schema 见 §2.1；Mobile 入口已由 DS-7 纳入） | 生产可达 UI 范围、每个 surface 的迁移状态与保护标签 | 不保存截图与历史日志（证据外置，见 §6） |
| 视觉真相 | 真实运行的 Desktop / Mobile 截图 | 视觉验收的唯一依据 | SSR / 静态渲染样张（含 UI 设计哨兵产物）不得充当 |

在 `packages/design-tokens` 建立并完成生产生成切换（路线图 DS-8）**之前**，`colors.ts`
仍是 Desktop **颜色**数值权威——这与 `DESIGN.md §10`「`colors.ts` itself is the only
authoritative inventory」的现行表述一致（该句本身也限定在颜色 Token 登记范围内），本合同
不提前改变它；Desktop 非颜色数值的现行来源见上表。已合并的 DS-8 已建立 DTCG→Terrazzo→Desktop 生产链；fixture 仅作独立预期。实际范围、保留项与验证状态见 Token README 和唯一主计划。接管按族登记：DS-8 交付 Desktop 的颜色与非颜色生成消费链，Mobile 独立阶段再接管；未切换族继续沿用原权威，不可提前宣称已统一。完整转换与双端样本合同见 [Token README](../../packages/design-tokens/README.md)。

### 2.1 台账 schema（现行生成与人工维护合同）

- 单一文件 `docs/design-rules/design-inventory.md`，不建立第二份迁移台账；
- 机器事实与人工决策物理分开：

```text
<!-- BEGIN GENERATED: surface-facts -->
脚本生成：稳定 surface ID、平台、生产入口、可达组件、样式来源、Token/裸值统计
<!-- END GENERATED: surface-facts -->

人工维护：按 surface ID 记录 owner、迁移状态（legacy / pilot / migrated）、
protected 标签、目标道路、下一动作
```

- 生成器只允许重写 GENERATED 区块，不得覆盖人工状态；连续两次生成结果必须字节一致；
- `protected` 是与迁移阶段**正交**的独立标签（一个 surface 可以同时 `legacy + protected`，
  也可以 `migrated + protected`），表示其视觉或交互合同被有意保护——例如 `DESIGN.md §10`
  的语义豁免色族、`§15` CINDY 皮肤族、外部主题导入保护 Token；
- 后台或宿主入口只登记用户可见出口（通知、系统卡片、菜单、错误反馈），不展开无视觉
  意义的业务逻辑；不可达残留、开发工具与测试样张不进入必做迁移清单。

## 3. Token 层级

### 3.1 目标层级（DTCG）

`packages/design-tokens`（DS-8 已接 Desktop 构建期生成，产品运行时不依赖此包；Mobile 尚未接管）采用标准 DTCG JSON，三层：

```text
reference   原始值：色阶、字号、字重、间距、圆角、动效时长
semantic    用途角色：text.primary、surface.elevated、status.danger …
component   组件值：button.*、input.* —— 只随消费组件建立，不预先铺设
```

语义层描述**角色**而不是色相或当前样式。依赖方向单向：`component → semantic → reference`，
组件层不得反向成为基础 Token 的来源，机器守卫检查该方向。

生产接管时改为 **DTCG → 同一生成流程 → 各端消费子集**；冻结 fixture 仅作独立回归预期，不能继续反向生成生产真相。Mobile 静态平台覆盖拟落 `src/platforms/mobile/`，单向引用共享用途角色，与共享源一起生成；不再在 Mobile 手写同义值。目标目录和角色尚未建立，具体来源与运行期例外见 [Token README](../../packages/design-tokens/README.md)。

### 3.2 与现行体系的映射

`DESIGN.md §10` 现行的三档（Tier-1 semantic slots / Tier-2 aliases / Tier-3 singletons）
与目标层级的对应关系：

| 现行（§10） | 目标（DTCG） | 说明 |
| --- | --- | --- |
| Tier-1 semantic slots | `semantic` | 名称与用途延续，不改名 |
| Tier-2 component aliases | `component` | 保持历史组件名，消费方无感 |
| Tier-3 singletons（语义豁免色等） | `semantic` 中的 protected 角色或保留原位 | 逐项裁决，默认不动 |
| （无对应） | `reference` | 新建的原始色阶/尺寸层，仅供 semantic 引用 |

### 3.3 直接依赖 reference 的准入

Primitive 与 Pattern 默认只绑定 semantic 角色。只有品牌表达、兼容合同或台账中登记为
`protected` 的 surface 才允许直接依赖 reference 值，且必须在台账说明理由。

### 3.4 运行时派生值不迁

运行时经色彩计算得到的值（如对比度自适应、alpha 叠加的运行期结果）留在代码中，
台账登记其存在与负责人即可，不强行塞进 DTCG。

## 4. 兼容红线

1. **旧 Token ID 不删除、不改名。** 旧 ID 已进入用户本地主题文件，是长期兼容契约；
2. **用户主题只允许加载期内存兼容**（`local-themes-normalize` 一类），不自动改写磁盘文件；
   任何兼容转换必须幂等（重复执行结果相同）；
3. 生成物正式接管任何消费点之前，必须保留与切换前的逐值对比；任一不一致即不得切换；
4. Mobile 侧任何会改变原生 runtime fingerprint 的方案必须另立高风险 PR 并按
   `docs/dev-rules/mobile-development.md` 冷更边界获得明确批准；
5. `DESIGN.md §10` 外部主题导入的豁免族与保护 Token 机制不受治理工作影响。

## 5. 工具决定（单选，一次定案）

| 工具 | 决定 | 理由 |
| --- | --- | --- |
| Terrazzo（锁 2.7.1） | **采用**，DS-8 已锁定 CLI/parser 同一版本作为构建依赖 | 没有真实消费者不引工具；校验与生成必须共用同一 DTCG 解析器 |
| Style Dictionary | **不采用** | 与 Terrazzo 并存即两个 DTCG 解析器，会制造最难发现的双份真相 |
| Storybook | **不建** | 未来若引入，必须复用同一份真实 scenario 数据，不得另造假组件样例 |
| Impeccable 等通用 UI audit | 仅人工触发 | 不进 CI、不自动改码、不得用通用规则推翻 Cindy 已确认的 Inter 与 pill-first 裁决 |

在 Terrazzo 安装之前，Token 源保持标准 DTCG JSON；结构、alias 方向与 Light/Dark 完整性
用自写守卫测试保证。全仓任何时点最多存在一个 Token 工具依赖。若 Terrazzo 停止维护，
源文件保持标准 DTCG，只替换 `packages/design-tokens` 内的薄封装。

## 6. 证据合同

### Level 1：静态守卫测试（每张可见 PR 必须）

- 从生产源码/样式解析出规则台账，锁 Token 表达式、Light/Dark 双模式覆盖与关键对比度；
- 声明「零视觉变化」的 PR：迁移前后 computed 值逐值一致，或场景截图逐像素一致。

### Level 2：真实 Cindy 截图（每张可见 PR 必须，按受影响平台采集）

- Desktop 改动：真实 Desktop 构建运行采集 Light/Dark 各一份（可复用
  `scripts/desktop-dev-runner.mjs` 与 `scripts/cdp-eval.mjs` 基础）；使用独立临时
  `userData`，不触真实数据库、凭证与外部网络；
- Mobile 改动：真实 Mobile 构建采集 Light/Dark 各一份，复用 `apps/mobile/scripts/
  visual-baseline-check.mjs` 与 `apps/mobile/e2e/maestro/`（§11 已登记的现行 baseline
  工具，不建第二套）；
- 同时改动 Desktop 与 Mobile 的 PR：两个平台的 Light/Dark 均需采集，不得只交一侧；
- 提交只覆盖未受影响平台的截图（如 Mobile-only 改动附 Desktop 截图）不算满足本条；
- 记录 commit SHA、平台、主题、日期；
- **栅格证据（截图 / 录屏）一律走 PR 附件或 artifact，不入仓**（2026-09-05 收口，起因见下）。
  `docs/design-evidence/YYYY-MM-DD/` 只放**纯文本索引**：commit SHA、平台、主题、日期、
  逐格实测值（computed style 取到的色号即可复核）、有意差异清单、缺口登记、以及指向 PR
  评论的链接。台账与文档同样只保存稳定链接与最近结论；
  - **为什么改**：本条原文给了「入仓 `docs/design-evidence/` 或 PR artifact」两个选项，
    DS-4（#3920）是第一张真正跑证据流程的 PR，选了入仓那条，实测代价 = 12 张 PNG / 944KB
    永久进 Git 历史。栅格证据的效用是**一次性的**（供设计师 review 时看一眼），而 Git 历史
    是永久的、每次 clone 都要下；按当时编号，后续 DS-5 / DS-6 / DS-9 三张同为「有意可见」，照此累积
    将达数 MB 量级。真正需要长期留存的是**数值与结论**，它们是文本、放 `design-evidence`
    的 README 与 `design-decision-log.md` 里即可；
  - **既有入仓证据不追溯删除**（Git 历史重写代价大于收益）；本条只约束新增。DS-4（#3920）
    的 12 张 PNG 在本条落地前已随合并进入 `main` 历史，本 PR 只把它们从 tip 移除、不重写
    历史——`docs/design-previews/**/evidence/` 下另有 19 张同类历史资产，同样按「不追溯」
    处理；要不要连带收口是独立议题；
  - 图片放 PR 时的操作说明：GitHub 的图片附件上传端点依赖网页会话，`gh` CLI 与 REST API
    都传不了图（GraphQL 亦无公开 mutation），需由人在 PR 评论框里拖拽上传。Agent 应把图
    落到工作区（gitignore 覆盖的临时目录）并在报告里给出路径，由人完成上传；上传后若图片
    出现在 PR 内某条评论里，把**该评论的链接**回写进 `design-evidence` 的文本索引，
    即成为稳定入口（issue comment URL 长期有效，附件 URL 随 CDN 变动）；
- 本合同与 `DESIGN.md §10` 双模式交付门槛的关系：实现双模式是硬性要求；实机目检按该门槛
  执行 best-effort 并如实申报，不得把「复用了 themed 样式」上报为「双模式已验证」。

### 批准边界

有意视觉变化必须由设计师批准；AI 不得用自己产出的截图自我批准；视觉基线不得自动 accept。

## 7. PR 风险分类与回退

每张设计系统 PR 属于且只属于以下一类，不同类不得混在同一张：

| 类别 | 定义 | 验收特征 |
| --- | --- | --- |
| 零视觉基建 | 文档、台账、测试、影子 Token 包、生成器 | 产品界面逐像素不变 |
| 有意可见变化 | 标准组件落地、Pattern 迁移中的有意调整 | 附两级证据 + 设计师批准 |
| CI 门禁调整 | 新增/升级检查、required 名单变动 | 先报告后阻断 + 管理员人工审核（§8） |

每张 PR 必须写明独立回退方式；任一阶段结束时仓库必须不劣于开始状态。影子 Token 包
在约定复查期内没有真实消费者时应删除，不长期并存（DS-3 弃坑复查日期 **2026-11-01**，
详见 `packages/design-tokens/README.md`）。已登记缺口不得描述为已完成能力；
缺口未修复前，对应验收矩阵格不得记为通过。

## 8. 治理接线纪律

任何设计检查接入或调整 CI required 名单：

1. 必须经管理员人工审核后合入，AI 与自动化不得自批（与仓库 workflow 审慎规则一致）；
2. 必须同 PR 附带「检查名称 ↔ required 名单 ↔ 脚本入口」三方一致性测试，防止名称漂移
   （机制已在 mivo-canvas-plugin 仓 `design-governance-wiring.test.mjs` 验证）；
3. 没有标准替代道路时不上阻断级门禁——先报告模式运行并用历史 PR 回放验证误报率，
   再升级阻断；门禁错误信息必须包含文件、行号与推荐改法。

### DS-7 首批接线（2026-09-10，已合并 #4215）

复用 `client-ci` 的 `verify-checks → verify`，增量运行 `pnpm check:design-colors` 与
`pnpm check:design-inventory`。`hardcoded-color-audit.test.mjs` 验证脚本入口、真实 CLI
失败及两个汇总的 success/failure/cancelled/skipped 行为。实时 required 另作带时间的只读
核对，不能由单测替代；DCO 是外部 App，不制造本地同名 workflow。

DS-7 已合并 [#4215](https://github.com/makecindy/cindy/pull/4215)，最终 head `cdaef3f80f3d8466d1bbd3338c615b6f55dff4c8`，合并提交 `4f03ea9a7b5f6425e517acd91071df6d397c6079`。历史回放与复现命令见 [DS-7 证据](../design-evidence/2026-09-10/ds7-guards.md)。旧 JSON 绑定当时脚本 hash，最终脚本有 3/4 变化，不能当作最终版本重跑通过证明；合并后 20 张阻断预期复核均相符，#3920/#4076/#4164 报告计数变化。原证据不覆盖；本次 DS-8 的颜色检查使用实际 base→worktree，不变更来源识别或豁免。

| 规则 | 候选方式 | 维护与升级边界 |
| --- | --- | --- |
| Desktop renderer 消费者新增 HEX 字面颜色、样式语境中的 RGB/HSL/OKLCH 等字面颜色函数与字面 fallback | block；准确新增行、列、原因、建议；已验证范围见证据 | 语义角色入口为 `themes/colors.ts`；不能机械替换为随意 Token。数值颜色函数要求位于样式属性、CSS 声明/函数或任意值语境——普通文案字符串里的颜色函数文本不算设计变化。不清洗已有存量 |
| 颜色来源、测试 fixture、已正式批准的具体角色/值 | allowed，输出仍保留 | 来源由现有冻结测试保护；消费者只读窄 `matches`，旧 glob 记录不再整文件放行；窄规则可经 `object` 绑定获批对象路径（如 `VARIANT_MAP.info`、`MASCOT_PREVIEW_CONFIGS.cindy`），同文件其它对象/变体复用批准色即违规；原批准值/上下文和新违规均有反例 |
| Mobile 及非上述生产消费者、素材/文档中的字面颜色 | report（是否违规仍需判断） | Mobile 既有 designTokenDiscipline / typographyTokenDiscipline 继续阻断；新增 diff 规则不冒充覆盖所有平台 |
| 已注册可见层圆角、命中层/指示层、未知几何与任意间距 | report | 识别范围与未知分类分开；keycap 4px、已登记图元 2px，不能从 button 标签推出 pill；未决命中方案不自动批准 |
| 广泛表单采用、焦点/secret/保存行为 | 采用建议 report，现有 DS-6 行为测试保留 | G2 独立试用未完成；不以类名检查取代行为测试，不将全部确认改 CTA |
| Desktop/Mobile 入口台账新鲜度 | block | 入口发现不等于迁移；人工 owner/pilot/legacy/下一动作不由生成器重写 |

异常/错误引用或无法读取源文件退出 2，不能当无命中；`--report` 只把真实违规的退出 1
变成报告成功，操作错误仍失败。未提交候选用 `--worktree --base-ref <实际基线>`，默认
commit 模式不覆盖未提交内容。正式 CI 比较事件 base 与当前候选 merge/head，所有引用
经环境变量和参数数组传递。

2026-09-10 手机端协作约定：同事正在重构，DS-7入口发现不冻结布局或组件；DS-10与未成熟规则等重构方案明确后一起评估。新增/改名路由同步台账，不能把旧组件结构当永久规范。

回退本批新增颜色检查时，可把该 CI 步骤切到 `pnpm report:design-colors` 或撤回新增
接线；保留现有主题、排版、Mobile、单测、类型、Windows 与 verify 汇总。台账发现和
有效回归样本可保留。任何新颜色例外须带正式依据、具体角色/值、owner、复查日期，
不能因旧文件出现过就获准；规则扩大仍走报告→反例→回放→管理员审核。DS-10 接收
未知几何、动态通道/拼接、自绘内容、跨端报告和表单采用：kirozeng 协调、执行者维护，
2026-09-17 复查待决事项；未成熟不转阻断。合并前须有管理员实际批准，本地自测不代替它。

## 9. 计数纪律

文档中出现的任何统计数字（Token 数、主题数、违规数）都是**当日快照**，必须标注统计
日期与可重复执行的生成命令，不作为长期人工维护数据。示例：

```bash
# registerColor 总数（2026-08-29 快照：506）
git grep -c "registerColor(" -- apps/desktop/src/renderer/themes/colors.ts | awk -F: '{s+=$NF} END {print s}'
# 内置主题数（2026-08-29 快照：11）
ls apps/desktop/src/renderer/themes/builtin/*.ts | wc -l
```

这与 `DESIGN.md §10` 的既有立场一致（counts drift constantly，`colors.ts` 为唯一权威清单）。

## 10. 待裁决登记

事实采样：**2026-09-07，main `36638ff33ca8b28e259b247a47054a696d6c4ee4`**，仅源码核对，未做双端 Light/Dark 实机对照。下表的建议是工程建议，**不是设计批准**。设计决定人均为用户/设计师；DS-5 执行者 Codex 负责此次核对，相应后续批次的工程执行者开工认领准备与实施责任，不杜撰长期 owner。公开双端消费/来源只维护在 [Token README](../../packages/design-tokens/README.md)；本节集中记录选择及后果，不另抄数值表。

### 已裁决：实施状态另记

| 事项 | 正式依据 / 结果 | 实施状态与下一动作 |
| --- | --- | --- |
| Permission 按钮 / 非按钮圆角 | 2026-08-29 用户裁决，#3619 回写：按钮胶囊，textarea 与盒内非按钮 8px；见 `DESIGN.md §5` 与 [decision-log](./design-decision-log.md) 对应日期；不决定外层卡片几何 | **已批准，DS-9 本地实现；用户视觉验收通过（09-11）**：[PermissionPrompt](../../apps/desktop/src/renderer/components/new-chat/PermissionPrompt.tsx) 本地候选已接标准 Button 的胶囊框；键帽 4px 保持；桌面三项已按 09-11 正式决定关闭。Mobile Permission 按钮已 pill；外层卡片差异见下表 |
| 快捷键键帽外框 | 2026-09-06 用户裁决 [#4001](https://github.com/makecindy/cindy/pull/4001)：所有可见快捷键外框（含承载快捷键的交互按钮）4px；边框/填充/内边距/颜色按所在表面 | 已回写 `DESIGN.md §5` / decision-log；Desktop Permission 本样本键帽已 4px，不重开该决定，不把键帽按普通按钮胶囊改掉 |
| DS-4 基础控件 | `DESIGN.md §4` 与 decision-log 2026-09-04：按钮/输入尺寸、按钮字号字重、hover/pressed、通用 secondary Tier-1、ivory 暂留 | DS-4 已落地；DS-4b 设置封装恢复局部覆盖。ivory 的长期用途已由下列 DS-6 裁决明确；完整表单/证据与第二消费者在 DS-6 |

**DS-6 已批准、验收另记（2026-09-08）**：D1 soft/50% 输入焦点环，亮暗/错误/旧主题可辨识是验收前提；不通过须提供实际对照再讨论该项。D2 elevated 默认＋用途明确的 ivory，保留局部覆盖。D3 普通确认保留反相中性主按钮、轮廓次/第三按钮、主→第三→取消排列、默认 Cancel / 显式主按钮 / typed 输入优先分支及 default/destructive；仅指定两处删除入口 opt-in，授权不迁。D4 原必填/格式规则转字段错误并定位首错，服务失败保留 Toast。D5 仅实际保存禁止重复提交及 Cancel/Esc/遮罩关闭，成功关闭/失败恢复，不锁独立测试连接/获取模型，不改业务语义。实现与实际证据见 [DS-6 索引](../design-evidence/2026-09-08/ds6-forms.md)，未验证不记通过。

**DS-9 Desktop Permission 已裁决（2026-09-11）**：真实组件对照后用户选择允许一次突出、保持中性、沿用当前密度；适用边界见 DESIGN §4「Desktop chat and operation authorization」及 decision-log 同日条目。下表 Permission 行保留来源比较：Desktop 已关闭，Mobile 保持后续待决。工程实现、用户最终视觉验收分别登记。

### 待决与已关闭范围

| 问题 / 行为依据（Permission 含决定前对照） | 候选与推荐依据（是否已批准见该行结论） | 影响、未决定时的保持方式 / 最晚阻塞 |
| --- | --- | --- |
| **用户 `colors.radius` 效果**：[theme-service.ts](../../apps/desktop/src/renderer/themes/theme-service.ts):11 优先主题显式值；[Tailwind](../../apps/desktop/tailwind.config.ts):85—87 用 `--radius` 派生 rounded-lg/md/sm；实际 computed 可偏离默认档 | A：保留用户覆盖，并区分默认基线与合法自定义；B：以后让标准控件固定几何，仅在明确兼容方案与用户裁决下讨论。**建议 A**，保留现有用户能力。B 不能通过删字段/白名单绕过旧主题红线，当前未授权 | 自定义圆角主题。pending 保留字段与实际效果；DS-7 棘轮不能把合法覆盖报违规，可按类名与默认主题建基线；DS-8 必须等值保留，不能保留就先关闭该部分决定，不得先切换 |
| **跨 surface 旧 alias**：DS-4b 仅设置输入；`msg-user-text/msg-assistant-text` 默认同指 `text-primary` 仍允许独立用户覆盖，设置同理。来源：`colors.ts`、theme-service 与 Token README 真实消费者 | A：以语义源供默认值，保留旧局部 ID 及覆盖优先级；B：强制局部跟随全局会改旧用户主题效果，不能在现兼容合同下执行。**建议 A**，按族核对，不能靠默认同值猜意图 | 设置、消息、确认/授权及其它主题用户。pending 原 ID、作用域、加载幂等和磁盘不变；DS-6/8/9 分别在相关消费者切换前核对，历史“49 文件”不当实时清单 |
| **Permission 允许/拒绝主次（Desktop 已裁决，Mobile 后续）**：[PermissionPrompt](../../apps/desktop/src/renderer/components/new-chat/PermissionPrompt.tsx):209/241 为拒绝/整任务允许轮廓，:267 允许一次实底，CINDY 内置覆盖为反相中性；Mobile [InteractionPanel](../../apps/mobile/src/session/InteractionPanel.tsx):635—672 拒绝/始终允许 secondary、允许一次 primary（cta） | A：保留允许一次为视觉主动作、其它次级；B：降低允许强调或突出拒绝以增强审慎感。先比较真实普通请求、长规则与主题；Desktop 无高风险字段，不虚造样本；不以 Desktop 默认白底推断所有主题。选项仅指视觉，不改含义/顺序/默认/审批生命周期 | 所有授权用户，两端与主题。pending 原样保留；**Desktop 已按上述 09-11 决定关闭；Mobile 后续单独裁决**，责任为用户/设计师决定，DS-9 执行者准备/落实 |
| **Permission 危险样式**：09-11 main 的 Desktop PendingPermission 无风险等级字段，PermissionPrompt 没有危险视觉 variant；autoReviewUnavailable 仅表示审查不可用；Mobile [interactionModel](../../apps/mobile/src/session/interactionModel.ts):64—82 判高风险，[InteractionPanel](../../apps/mobile/src/session/InteractionPanel.tsx):611—620 高风险允许要二次点击且不提供始终允许；风险提示为中性色，无 destructive 红 | A：保留中性风险信息与已有确认行为；B：危险授权加清晰的危险色/层级，普通授权保持中性。建议比较风险提示的辨识度再决定 B 的范围，不能因普通 ConfirmDialog 已有 destructive 就认为授权已裁决 | 高风险授权及信息色；pending 保留现有行为与配色，尤其不移除 Mobile 二次点击、不恢复高风险始终允许。**Desktop 已按上述 09-11 决定关闭；Mobile 后续单独裁决**；若要求权限业务变化则退出设计迁移范围另议 |
| **Permission 外层与布局（Desktop 已裁决，Mobile 后续）**：Desktop 原基线外卡 12px、按钮 8px；DS-9 本地候选保持外卡与密度、按钮已接标准胶囊；Mobile InteractionPanel:1769 `radius.container` 卡片、pill 按钮/minHeight 44，另由 [interactionTouchLayout](../../apps/mobile/src/session/interactionTouchLayout.ts):35—58 按屏宽与动作数计算触控布局 | A：共享层级与角色，保留原生触控/窄屏自适应；B：使卡片密度/排列更接近 Desktop，仍保留必要触控区。**建议 A**，避免以像素统一损害触控；已定胶囊与键帽不重投票 | Desktop/Mobile 窄屏、长内容、键盘用户。pending 保留几何，**Desktop 已按上述 09-11 决定关闭；Mobile 后续单独裁决**；按钮已批准的结果随 DS-9 实施 |
| **Mobile 用途差异**：两条真实链与来源见 Token README；输入/正文排版不同，`radius.micro/control` 不等于 Desktop 档位；M 行内代码有意无底色（[MessageRenderer](../../apps/mobile/src/session/MessageRenderer.tsx):7964—7974），输入 focus 字段只作 caret，触控和光学 padding 留平台适配 | A：共享用途与唯一数值上游，保留平台覆盖和已有原生差异；B：另设计更接近 Desktop 的可见效果。**建议 A**，先保证真实消费者等值，B 须真实双端对照并明确独立风险 | iOS/Android 可读性、输入与触控。pending 保留当前平台值/行为；Mobile 后续独立阶段可按 A 的等值合同接管，新增外观在实施前须裁决，不能混进零视觉 PR |

**Permission 三项（主次、危险样式、外层与布局）的 Desktop 决定未关闭前，Desktop Permission 相关文件不得进入迁移 diff；前置批次是 DS-9。Mobile 对应决定留待独立阶段，不阻塞 Desktop。** 2026-09-11 用户明确本期只收尾桌面端，DS-9 包含聊天与桌面授权，DS-10 做保护、维护与最终验收。已批准但未实现的圆角不等于三项已关闭；待决只约束对应改动。正式决定须写适用范围、决定人、依据与实施阶段，回写 `DESIGN.md` 并追加 `design-decision-log.md`，不修改历史记录来伪造批准。

DS-4/4b 尚有公开附件交接与完整设置页/部分状态证据缺口，DS-6 补齐并更新既有证据索引；已合入不能自动消除未验收项。影子层复查日仍为 **2026-11-01**，DS-8 负责结束影子阶段，到期按 §7 的真实消费者与维护情况处置，不为赶日期跳过兼容。

## 11. 存量门禁与文档处置表

以下资产**保持现状运行**，本合同只登记其在治理体系中的定位与未来去向；任何实际改动
由对应的后续 PR 单独完成。

| 资产 | 现定位 | 去向 |
| --- | --- | --- |
| `scripts/hardcoded-color-audit.mjs` + `scripts/hardcoded-color-exemptions.json` | 新增行颜色审计、共享 matcher 与窄例外 | DS-7 已合入报告/精确位置/候选扫描，范围与回退见 §8；DS-10 按证据扩大成熟范围，不另造平行系统 |
| `scripts/check-pr-design-basis.mjs` | UI PR 设计依据校验 | DS-7 / DS-10 按成熟范围复用；UI 路径定义抽成唯一来源供其共读，证据锚点校验若确有需要在其上扩展；现有字段检查不代表视觉质量审核 |
| `scripts/brand-terminology-guard.mjs` | 品牌术语门禁 | 保持现状，不受本计划影响 |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板（UI 变化 + 设计规范引用字段） | DS-7 / DS-10 若需证据锚点检查，随对应门禁同步模板，不单为记账另拆 PR |
| `apps/mobile/scripts/visual-baseline-check.mjs` + `apps/mobile/e2e/maestro/` | Mobile 视觉基线与流程 | Mobile 后续独立接管时复用并扩展；不建第二套 baseline 工具 |
| `docs/design-rules/token-decision-table.md` | 登录改版 token 决策记录（其自身已声明非现行清单） | 维持决策档案定位，非数值真相 |
| `docs/design-rules/design-decision-log.md` | 全局设计决策史台账 | 维持只增不改；治理裁决（含 §10 待裁决项）关闭后在此归档 |
| `DESIGN.md §10` Tier-1 slot 表 | DS-8 GENERATED 精确值摘要（用途与规则人工维护） | DS-8 同一 Terrazzo 流程生成，不再人工编辑表中数值 |
| `DESIGN.md §16.1` 登录 token 表 | 登录域现行 token 清单（人工维护） | 同上 |
| UI 设计哨兵（插件仓） | SSR 抽取式扫描工具 | 仅用于发现组件、统计硬编码、定位代码与观察迁移进度；其样张不得充当视觉证据（§2 视觉真相行） |

## 12. 公开实施路线与目标验收

本节是开源贡献者可读的路线摘要与实际 PR 链接入口；逐 surface 的事实、owner、迁移状态与下一动作只维护在 [inventory](./design-inventory.md)。项目完整施工安排与过程记录由项目负责人持续维护，不作为贡献者必读依赖；仓内须足以定位规则、当前能力、未决项及下一批工作。不要在本节复制个人施工日志，也不另建逐 surface 台账。

**编号就是执行顺序**：已合入 DS-1—8 保留；本期余下两批，DS-9 为桌面聊天、跨入口与授权呈现，DS-10 为桌面保护、维护与最终验收。每批默认一张 PR。Mobile 延至独立阶段，暂不编号，已有兼容保护和检查保留。Permission 桌面三项仅阻塞对应文件；所有门禁升级继续受 §8 管理员审核约束。

### 系列命名规则

- **PR / commit 标题**：`<type>(design-system): DS-<序号> <中文短描述>`；type 按实际风险选择，**不写总数**。
- **分支名**：`ds/<序号>-<英文短语>`。
- **PR 正文第一行**：`设计系统改造系列 DS-<n>，路线图见 docs/design-rules/design-governance.md §12`。
- 合入后回填实际链接；工程合入、视觉验收、独立贡献者试用分别记录，不互相代替。
- 按风险类别、批准前置、独立发布/回退或实际不可清楚验证的边界拆 PR；无固定行数上限。文档、使用说明、证据与台账通常随相关实现交付，不预拆成独立 PR；需要拆分时先调整尚未执行的顺序并说明真实原因，历史编号保留。

| # | 内容 / 可交付结果 | 风险类别 | PR / 状态 |
| --- | --- | --- | --- |
| DS-1 | 建立治理合同与存量门禁处置表 | 零视觉（纯文档） | [#3609](https://github.com/makecindy/cindy/pull/3609)，2026-08-30 合入 |
| DS-2a | 生产 UI 台账 | 零视觉 | [#3648](https://github.com/makecindy/cindy/pull/3648)，2026-08-31 合入 |
| DS-2b | 主题兼容冻结守卫 | CI 门禁 | [#3700](https://github.com/makecindy/cindy/pull/3700)，2026-09-02 合入 |
| DS-3 | 最小语义 Token 影子层 | 零视觉 | [#3798](https://github.com/makecindy/cindy/pull/3798)，2026-09-03 合入 |
| DS-4 | Button 与 Input 标准组件（既有 `components/ui/`） | 有意可见 | [#3920](https://github.com/makecindy/cindy/pull/3920)，2026-09-04 合入；完整表单 / 公开附件缺口由 DS-6 补齐 |
| DS-4b | 设置输入旧主题局部覆盖兼容收口 | 零视觉兼容修复 | [#4010](https://github.com/makecindy/cindy/pull/4010)，2026-09-06 合入；只覆盖设置封装，未完成全仓 alias 收口 |
| DS-5 | 对齐执行路线、数值权威、双端语义与待决合同；仅文档及必要台账静态说明 | 零视觉 | [#4022](https://github.com/makecindy/cindy/pull/4022)，2026-09-07 已合入 |
| DS-6 | 完整设置表单、第二消费者与普通确认复用；按真实需求补 FormField / loading，附使用说明、真实状态证据与独立贡献者首轮试用 | 有意可见 | [#4135](https://github.com/makecindy/cindy/pull/4135) 已合入（head `62472f559c` / merge `6559d2610a`）；已实现 FormField / loading、两个消费者和指定普通确认；用户测试版手动审核通过。工程验证、G2 与公开附件分别见[证据索引](../design-evidence/2026-09-08/ds6-forms.md)，不把 PR 交付等同目标全部验收 |
| DS-7 | 复用守卫，成熟写法先报告/反例/历史回放后阻断；增量发现 Mobile 入口；未成熟范围继续报告 | CI 门禁 | 已合并 [#4215](https://github.com/makecindy/cindy/pull/4215)：成熟颜色增量接 verify，Mobile 入口纳入同一台账；[历史证据](../design-evidence/2026-09-10/ds7-guards.md) 的版本边界见 §8。DS-7 当次双审豁免不延续至后续批次 |
| DS-8 | Desktop 颜色、排版、间距、圆角/尺寸与动效的 DTCG → 生成 → 生产链；旧主题兼容，结束影子阶段 | 零视觉接管 | 已合并 [#4268](https://github.com/makecindy/cindy/pull/4268)，merge `2e74488d21`；人工及平台证据缺口继续登记 |
| DS-9 | 统一桌面聊天、代码与附件；核跨入口继承；按正式决定整理桌面授权呈现 | 有意可见 | [#4300](https://github.com/makecindy/cindy/pull/4300) 草稿已提交，待 CI/合并；实现、自查与用户视觉验收通过（09-11）；视觉基线 `f8aaae334f`，提交前同步主干至 `f9ce362377`，保留 #4283 伙伴设置与 Cindy Make 完成卡；[实现与验收记录](../design-evidence/2026-09-11/ds9-desktop-core.md) |
| DS-10 | 扩大成熟范围检查、维护交接，完成 Desktop G1—G4 验收 | CI 门禁 | 待 DS-9；遵循 §8，复用已有守卫；最终验收不额外拆批 |
| Mobile 后续（未编号） | 接同一数值源，保留平台适配；独立裁决授权呈现，验证 iOS/Android | 按实际变化分类 | 新重构方案就绪后另行启动；沿用 fingerprint 冷更规则与既有兼容检查 |

### 完成条件：分别验收 G1—G4

不以 PR 数、Token 数、迁移百分比或固定张数合完判断成功。DS-10 内先对 Desktop 在既有证据索引与本节记录以下结果；Mobile 同样目标在独立阶段验收；验收和回填本身不预造另一张 PR，发现真实修复再按其风险安排。

| 目标 | 必须拿出的结果 | 当前结论 |
| --- | --- | --- |
| G1：整体改风格更集中 | 可撤销演练从共享源调整颜色、排版、间距、圆角/尺寸与动效代表项，本期作用于真实桌面设置、聊天与高频入口；Mobile 后续另验；记录仍需逐页补丁处，每项静态值只有一个可编辑上游；显式主题覆盖保留 | DS-8 已生产接管；待 DS-9 / DS-10 桌面最终演练 |
| G2：非设计师可以独立做对 | 未参与改造的贡献者仅凭仓内文档和组件完成真实小界面，记录额外指导、手写样式、遗漏状态，修复后复试；Agent 自测不代替独立试用 | DS-6 首轮，最终复试，待验收 |
| G3：新贡献不会持续退化 | 有标准替代道路的范围能准确报违规文件、行号与改法；合法写法、键帽例外、用户主题不误报；历史回放与管理员审核后分段阻断 | DS-7 首批、DS-10 扩大，待验收 |
| G4：兼容与平台成立 | 保留旧主题文件、ID 与实际消费效果；Desktop 两模式实现并验证旧主题；Mobile 后续接同一语义源并保留平台差异；代表页面有真实运行证据，未验证项明示 | DS-4b 已补局部兼容；DS-6 / DS-8 / DS-9 继续验证，整体待验收 |

最终遗留范围须有负责人、保留理由与复查日期；高频界面持续依赖逐页补丁、旧主题失效、无人接管的例外会阻止相关目标通过。G1—G4 分别填通过/未通过/待验证，经设计负责人验收、维护者接手后再归档施工内容，长期合同继续有效。

## 13. 已知边界（如实登记，不夸大机器能力）

以下是本治理体系**做不到**的事。登记它们的目的：不得把「机器没拦」当作「合规」的证据。

1. **词法扫描的边界**——共享 matcher 在新增行上下文中识别 HEX 与完整字面颜色函数，
   纯语义包装/PR编号/注释排除，嵌套字面 fallback 仍检查。默认阻断仅限 §8 列出的
   Desktop renderer 消费者后缀；`.svg`、assets/vendor、Mobile 和其它路径仅报告。
   它不是 JS/CSS AST 或运行期求值器：命名色、拼接/转义字符串、部分数值通道、动态
   样式、自绘 canvas/xterm、复杂模板嵌套、间接调用和裸数字几何仍须 review。普通
   `color(surface)` 与空函数文档不是颜色；未知写法不能据“未命中”判合规。
   `--worktree` 扫 staged/unstaged/指定源码目录内 untracked，commit 模式仅扫明确 refs。
2. **「复用道路唯一」是纪律不是机器闸**——防止出现第二套 Button / Toast / 菜单动作模型，
   靠 review 裁决，机器只能发现雷同、不能自动判定谁该让位；
3. **语义分层是渐进的**——存量代码混引语义层与原始值是登记在案的现状；**新代码默认走
   语义层**（§1.1 管道规则 + `DESIGN.md §10` 均禁止新代码硬编码颜色、引入裸设计值），
   品牌表达、兼容合同或台账登记为 `protected` 的 surface 仍可按 §3.3 直接依赖
   reference（走 token、非硬编码，且须在台账说明理由）、运行时派生值按 §3.4 留在
   代码中不强迁——这两条是合同本身开的准入，不是「新代码优先语义层」的例外漏洞；
   存量随各表面迁移顺带收敛，不专门开重构 PR。
4. **圆角分类审查边界：** 自动审查应先识别 §5 已登记成员及其具体可见层，再检查对应约束。未决分类、缺少证据与明确违反登记值须分开报告。**不得仅凭 DOM 标签、可访问名称或局部样式类推导 pill，也不得用建议改形状代替缺失的分类裁决。** 未登记的新例外仍须裁决；已登记的待迁移差异按对应台账处理，不重复制造相反的「修复」要求。评论应指出登记项、作用层及违反的条款，严重级别按现行审查规则判断。

DS-7 的运行期报告只自动认领带显式 `data-usage-mark` 的用量图层、其 target/indicator
身份与有可见框的 `<kbd>`；其它普通框、状态格或仅声称是键帽的按钮先报 unknown。
分类器的完整登记值正反例不表示生产识别已覆盖这些成员；缺证据与待决命中不能当通过。
