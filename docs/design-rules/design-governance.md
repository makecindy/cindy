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

## 2. 四种真相与职责边界

| 真相 | 载体 | 负责 | 不负责 |
| --- | --- | --- | --- |
| 规则真相 | [`DESIGN.md`](./DESIGN.md) | 设计原则、MUST/SHOULD/NEVER、组件使用时机、豁免登记 | 不再人工维护精确数值总表（见 §11 处置表对 `DESIGN.md §10 Tier-1` 表与 `§16.1` 表的过渡安排） |
| 数值真相 | 现阶段：Desktop 颜色 → `apps/desktop/src/renderer/themes/colors.ts`；Desktop 非颜色（字号/行高/动效时长与曲线等）现行仍分散在 `apps/desktop/src/renderer/styles/globals.css`（`--text-*`、`--motion-*`）与 `apps/desktop/tailwind.config.ts`（`fontSize`/`borderRadius` 映射），尚未收拢；Mobile 颜色与非颜色数值统一在 `apps/mobile/src/theme/tokens.ts`。目标阶段：全部收拢进 `packages/design-tokens` 标准 DTCG JSON（见 §3） | 每个 Token 的唯一取值 | 不承载运行时派生值（见 §3.4） |
| 台账真相 | `docs/design-rules/design-inventory.md`（由后续 inventory PR 建立，schema 见 §2.1） | 生产可达 UI 范围、每个 surface 的迁移状态与保护标签 | 不保存截图与历史日志（证据外置，见 §6） |
| 视觉真相 | 真实运行的 Desktop / Mobile 截图 | 视觉验收的唯一依据 | SSR / 静态渲染样张（含 UI 设计哨兵产物）不得充当 |

在 `packages/design-tokens` 建立并完成生产生成切换（路线图 PR-8）**之前**，`colors.ts`
仍是 Desktop **颜色**数值权威——这与 `DESIGN.md §10`「`colors.ts` itself is the only
authoritative inventory」的现行表述一致（该句本身也限定在颜色 Token 登记范围内），本合同
不提前改变它；Desktop 非颜色数值的现行来源见上表。

### 2.1 台账 schema（约束未来的 inventory PR）

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

`packages/design-tokens`（由后续 Token PR 建立）采用标准 DTCG JSON，三层：

```text
reference   原始值：色阶、字号、字重、间距、圆角、动效时长
semantic    用途角色：text.primary、surface.elevated、status.danger …
component   组件值：button.*、input.* —— 只随消费组件建立，不预先铺设
```

语义层描述**角色**而不是色相或当前样式。依赖方向单向：`component → semantic → reference`，
组件层不得反向成为基础 Token 的来源，机器守卫检查该方向。

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
| Terrazzo（锁 2.7.1） | **采用**，但推迟到生产生成切换 PR 才安装 | 没有真实消费者不引工具；校验与生成必须共用同一 DTCG 解析器 |
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
- 记录 commit SHA、平台、主题、日期；材料外置到 `docs/design-evidence/YYYY-MM-DD/` 或 PR
  artifact，台账与文档只保存稳定链接与最近结论；
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
在约定复查期内没有真实消费者时应删除，不长期并存。已登记缺口不得描述为已完成能力；
缺口未修复前，对应验收矩阵格不得记为通过。

## 8. 治理接线纪律

任何设计检查接入或调整 CI required 名单：

1. 必须经管理员人工审核后合入，AI 与自动化不得自批（与仓库 workflow 审慎规则一致）；
2. 必须同 PR 附带「检查名称 ↔ required 名单 ↔ 脚本入口」三方一致性测试，防止名称漂移
   （机制已在 mivo-canvas-plugin 仓 `design-governance-wiring.test.mjs` 验证）；
3. 没有标准替代道路时不上阻断级门禁——先报告模式运行并用历史 PR 回放验证误报率，
   再升级阻断；门禁错误信息必须包含文件、行号与推荐改法。

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

| 事项 | 现状 | 裁决人 | 规则 |
| --- | --- | --- | --- |
| PermissionPrompt 圆角 | **已关闭（2026-08-29 裁决，#3619 回写）**：三档不变、按钮一律胶囊（唯一豁免 = 已登记的裸文字按钮）、8px = textarea 一律 8px + 盒内非按钮、4px 不入档（含裸 `rounded` / `rounded-sm` 等价写法，**前提 = 主题未覆盖 `colors.radius`**；存量为债、新代码禁止）、「看起来小」不是改档理由。`DESIGN.md §5` 已加硬，全文归档于 [`design-decision-log.md`](./design-decision-log.md)「08-29」条 | 设计师 | 已按 `DESIGN.md §13` 机制回写并归档（与回写同一 PR 生效） |
| `radius` 主题覆盖 | 待裁决（随 DS-7 棘轮设计一并关）：本地主题 JSON 可覆盖 `colors.radius`（`resolveThemeValue` 优先 `theme.colors[id]`），届时 `rounded-sm`/`rounded-md` 的 computed 值整体平移、不再等于 4px/6px。是否冻结 `radius` 为不可覆盖不变量（涉及 `local-themes-normalize` 白名单 + 既有本地主题兼容红线）；裁决前 DS-7 按类名建基线、以默认主题 computed 值为准 | 设计师 | 未关闭前 DS-7 棘轮不得把覆盖了 `radius` 的本地主题报为违规；结论回写 `DESIGN.md` §5 与 decision-log |
| Permission 迁移余项 | 待裁决：允许/拒绝按钮的视觉主次、危险授权样式、Desktop 与 Mobile 权限弹窗几何是否一致 | 设计师 | 余项未关闭前，Permission 相关文件不得进入任何迁移 PR 的 diff（DS-6 前置）；结论同样回写 `DESIGN.md` 并归档 |

## 11. 存量门禁与文档处置表

以下资产**保持现状运行**，本合同只登记其在治理体系中的定位与未来去向；任何实际改动
由对应的后续 PR 单独完成。

| 资产 | 现定位 | 去向 |
| --- | --- | --- |
| `scripts/hardcoded-color-audit.mjs` + `scripts/hardcoded-color-exemptions.json` | 现行硬编码颜色门禁与豁免 | 棘轮 PR 在其上扩展（新增裸圆角/间距检查、豁免补 owner/理由/复查日期）；不另造平行系统 |
| `scripts/check-pr-design-basis.mjs` | UI PR 设计依据校验 | UI 路径定义未来抽成唯一来源供其共读；可见 PR 的证据锚点校验在其上扩展 |
| `scripts/brand-terminology-guard.mjs` | 品牌术语门禁 | 保持现状，不受本计划影响 |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板（UI 变化 + 设计规范引用字段） | 证据合同生效后由单独 PR 增补证据锚点要求 |
| `apps/mobile/scripts/visual-baseline-check.mjs` + `apps/mobile/e2e/maestro/` | Mobile 视觉基线与流程 | Mobile 扩展 PR 复用并扩展；不建第二套 baseline 工具 |
| `docs/design-rules/token-decision-table.md` | 登录改版 token 决策记录（其自身已声明非现行清单） | 维持决策档案定位，非数值真相 |
| `docs/design-rules/design-decision-log.md` | 全局设计决策史台账 | 维持只增不改；治理裁决（含 §10 待裁决项）关闭后在此归档 |
| `DESIGN.md §10` Tier-1 slot 表 | 现行 Tier-1 registry（人工维护） | 生产生成切换后由 `packages/design-tokens` 生成的机器摘要替代；此前维持人工维护现状 |
| `DESIGN.md §16.1` 登录 token 表 | 登录域现行 token 清单（人工维护） | 同上 |
| UI 设计哨兵（插件仓） | SSR 抽取式扫描工具 | 仅用于发现组件、统计硬编码、定位代码与观察迁移进度；其样张不得充当视觉证据（§2 视觉真相行） |

## 12. 实施路线图（施工期条目，完成后归档）

十张主线 PR（DS-2 的台账与阻断守卫风险类别不同，按 §7 拆为 2a/2b）；拆分依据是 §7 的
风险类别。依赖：1 → 2a → 2b → 3 → 4 → 5/6（可并行）→ 7 → 8 → 9；DS-6 另需 §10 圆角裁决
关闭；DS-2b、DS-7 升阻断均需 §8 管理员审核。

### 系列命名规则

- **PR / commit 标题**：`<type>(design-system): DS-<序号> <中文短描述>`——scope 固定
  `design-system` 以便检索全系列；`type` 按各张实际性质选取（见下表）；序号对应本表，
  **不写总数**（拆分时用 `DS-5a` / `DS-5b` 子号，总数会变）；
- **分支名**：`ds/<序号>-<英文短语>`，如 `ds/1-governance-contract`；
- **PR 正文第一行**固定为：`设计系统改造系列 DS-<n>，路线图见
  docs/design-rules/design-governance.md §12`；
- 本表的「PR」列是系列进度的唯一台账，每张合入后回填实际 PR 号。

| # | 标题 | 风险类别 | PR |
| --- | --- | --- | --- |
| DS-1 | `docs(design-system): DS-1 建立治理合同与存量门禁处置表`（本张） | 零视觉（纯文档） | — |
| DS-2a | `test(design-system): DS-2a 生产 UI 台账` | 零视觉 | — |
| DS-2b | `ci(design-system): DS-2b 主题兼容冻结守卫`（新增阻断需 §8 管理员审核） | CI 门禁 | — |
| DS-3 | `feat(design-system): DS-3 最小语义 Token 影子层` | 零视觉 | — |
| DS-4 | `feat(design-system): DS-4 Button 与 Input 标准组件`（落入既有 `components/ui/`） | 有意可见 | — |
| DS-5 | `refactor(design-system): DS-5 AI 对话区 Pattern 迁移`（Tool Call / Reasoning / Message / Attachment） | 有意可见 | — |
| DS-6 | `refactor(design-system): DS-6 Permission Pattern 迁移`（裁决关闭后） | 有意可见 | — |
| DS-7 | `ci(design-system): DS-7 新增裸设计值棘轮` | CI 门禁 | — |
| DS-8 | `refactor(design-system): DS-8 Terrazzo 生产生成切换` | 零视觉（大型基建） | — |
| DS-9 | `feat(design-system): DS-9 Mobile 扩展` | 有意可见 | — |

本节随施工推进更新完成状态；十张全部合入后，本节归档进
[`design-decision-log.md`](./design-decision-log.md)，本文其余章节转入长期生效。
