# Cindy 设计系统索引

> 本文件是 `docs/design-rules/` 全部设计文档的索引与版本台账（2026-07-24 起启用，此前为跳转 stub）。
> 设计类 `.md` 一律放本目录，并在下表登记；规范正文不要写进本文件。

## 文档索引

| 文档 | 内容 | 角色 |
|---|---|---|
| [`DESIGN.md`](./DESIGN.md) | 权威视觉规范全文：视觉语言（§1）、颜色（§2）、排版（§3）、组件（§4）、布局（§5）、交互约定与 Motion token（§14）、主题系统与 Token 参考（§10）、CINDY 皮肤族（§15）、登录链路（§16） | **权威正本**（原仓库根文件，根目录 `DESIGN.md` 保留为跳转入口） |
| [`design-governance.md`](./design-governance.md) | 设计系统治理合同：管道与记账（§1.1）、四种真相边界、Token 层级与现行 §10 三档的映射、兼容红线、工具单选、两级证据合同、PR 风险分类、治理接线纪律、待裁决登记、存量门禁处置表、实施路线图、已知边界（§13） | **治理正本**（管流程；视觉规则仍以 `DESIGN.md` 为准） |
| [`design-inventory.md`](./design-inventory.md) | Cindy Desktop 生产可达 UI 台账：GENERATED 机器事实（稳定 ID / 入口 / 组件 / 样式来源 / Token 与裸值统计）+ 人工迁移状态 | **台账正本**（schema 见 [`design-governance.md`](./design-governance.md) §2.1；生成 `pnpm design:inventory`，校验 `pnpm check:design-inventory`） |
| [Token README](../../packages/design-tokens/README.md) | 当前影子层边界、DS-8 / DS-10 生产接管、双端真实语义样本与平台覆盖唯一来源 | **Token 合同入口**（当前无生产消费者，不是另一份数值表） |
| [`figma-component-spec.md`](./figma-component-spec.md) | 登录链路 Figma 组件与色彩速查手册：全组件逐态参数、nodeId 溯源、wave1–wave6 读取记录 | 权威（登录域逐参数） |
| [`token-decision-table.md`](./token-decision-table.md) | 登录链路色值 / 尺寸 → token 决策记录（新增 / 复用 / 豁免的判定理由 + 各 wave 增补台账） | 决策记录（现行 token 清单与值以 `DESIGN.md §16.1` + `colors.ts` 为准） |
| [`design-decision-log.md`](./design-decision-log.md) | 全局设计决策史台账：被推翻的方案、勘误过程、backlog（已收录原 `DESIGN.md §13` G1–G4 归档与 §15 决策史全量） | 决策台账（只增不改；与 `DESIGN.md` 冲突时以 `DESIGN.md` 为准） |
| [`README.md`](./README.md) | 本目录使用规则 | 说明 |
| [`gamepad-silhouette-authoring.md`](./gamepad-silhouette-authoring.md) | 设置页手柄线稿交稿约定：画板网格、长弧画法、外壳/按键分家、热区与按下填充；附 Xbox Series 现稿 | 作者交稿约定 |
| [`xbox-series-gamepad.silhouette.svg`](./xbox-series-gamepad.silhouette.svg) | 设置页 Xbox Series 线稿现稿（与 `XboxGamepadLayout.tsx` 同坐标） | 样板图 |
| [`playstation-dualsense-gamepad.silhouette.svg`](./playstation-dualsense-gamepad.silhouette.svg) | 设置页 DualSense 线稿现稿（与 `PlayStationGamepadLayout.tsx` 同坐标） | 样板图 |
| [`gamepads/nintendo-switch-pro/`](./gamepads/nintendo-switch-pro/) | 设置页 Switch Pro 交稿包（SVG / PNG / 热区 / 键位表） | 交稿包 |
| [`gamepads/switch-joy-con/`](./gamepads/switch-joy-con/) | 设置页 Joy-Con 交稿包（SVG / PNG / 热区 / 键位表） | 交稿包 |
| [`gamepads/ultimate-c1/`](./gamepads/ultimate-c1/) | 设置页 Ultimate C1 / 通用手柄交稿包（SVG / PNG / 热区 / 键位表） | 交稿包 |

## 新贡献者从这里开始

1. 先读 [DESIGN.md](./DESIGN.md) 的适用视觉/组件规则，再读 [治理合同](./design-governance.md) §4 兼容、§6 证据、§7/8 风险与门禁；当前顺序及目标验收见 §12。
2. 在 [inventory](./design-inventory.md) 找实际入口、保护合同与人工下一动作；没认领的 owner 仍是 unassigned，按实际工作认领，不能把共享组件已被引用当成整页迁移完成。
3. 复用现有 [Button](../../apps/desktop/src/renderer/components/ui/button.tsx)、[Input / Textarea](../../apps/desktop/src/renderer/components/ui/input.tsx)；设置旧局部覆盖使用 [SettingsTextInput](../../apps/desktop/src/renderer/components/settings/SettingsTextInput.tsx)。FormField 与 Button loading API **尚未提供**，DS-6 随真实表单需求建立并补使用说明。
4. 需要改设计值时读 [Token README](../../packages/design-tokens/README.md)：当前影子层不被产品消费；双端语义样本与未来生成合同都在该处。Desktop / Mobile 分别在 DS-8 / DS-10 接管；新观感先查治理 §10 待决项，不因数值相同而删除局部主题覆盖。

以上仓内入口即可开始贡献；无需访问个人桌面记录。此阅读路径检查不代替 G2 的独立贡献者试用。

## 版本记录

- **2026-09-07（圆角改按可见层与登记分配）**：`DESIGN.md §5` 重写为两步判定树——Step 1 已登记形状（keycap / data mark）优先，Step 2 普通控件三档；判定对象从 DOM 标签改为「可见层」，§5 成为半径唯一权威（§§1/4/7/9 与组件条目只引用不另立）。新增 data mark 类目（0px 或 2px、按成员钉死），首批四个成员四角 2px：`usage-heatmap-day`、`usage-token-bar`、`workflow-status-cell`、`system-category-square`；07-28「status micro-cells（2px）」窄例外被后两个成员吸收——数值与组件不变，依据从「≤8px 非交互」改为图元角色，解除 non-interactive 限定、尺寸不再作归类边界。`every button` /「唯一豁免」等绝对化措辞改为「未命中 Step 1 的普通控件框」。命中尺寸采用 Equivalent 路径：用量历史同页补足产生相同单日筛选的合规日期选择控件；原定与密度恢复同 PR 交付的时序已被 #4064 先行恢复密度超越，控件单独交付，交付前密集目标为 §5 登记在案的过渡不合规。`REVIEW.md` 审查入口与 `design-governance.md §13` 同步；`UsageHeatmap` / `UsageTokenBars` 的生产差异登记为待迁移项。裁决全文与两处范围变更见 [`design-decision-log.md`](./design-decision-log.md)「09-07」条。**本条取代 08-29 条的「按钮一律胶囊／裸文字按钮唯一豁免」绝对化表述与 07-28 条的微格尺寸判据（三档数值本身不变）。**

- **2026-09-08（用量历史图表配色与交互登记，#4076）**：`DESIGN.md §2` 登记 Usage History 图表类别色（五个模型色相与热力图对进程蓝的引用）；§5 data mark 成员 `usage-heatmap-day` / `usage-token-bar` 之上登记悬停/焦点/选中有限放大、柱图选中淡化与热力格中性描边（Interaction constraints 内的组件交互登记）；§14.4 登记图表强调响应。移除草稿日期表单后的命中尺寸方案仍待裁决，见 `usage-history-charts.md`。

- **2026-09-07（设置分段选项与用量数据图形）**：`DESIGN.md §4` 补设置分段单选逐态与键盘合同，统一复用 `SettingsSegmentedControl`；§4/§5 明确用量热力方格、细柱与点击承载的 2px 数据图形例外，保留灰度色阶和日期筛选，避免普通按钮胶囊规则改变图表形状。

- **2026-09-07（DS-5 路线与双端设计合同）**：治理 §12 将未开始批次对齐为 DS-5—12（9=聊天、10=Mobile），以 G1—G4 分别验收；补 DS-4b / #4010 已合入及其局部兼容边界。Token README 登记当前数值权威、未来接管与两端真实消费样本；inventory 及生成器仅同步下一动作与静态说明，不改变迁移状态、发现能力或产品界面。此前日期记录中的旧编号保留为历史。

- **2026-09-06（DS-4 旧设置输入主题兼容收口）**：`SettingsTextInput` 复用标准 Input 并保留既有局部主题 alias；AgentResource / Collaboration 的四个数字框走同一封装。通用 Input 的 Tier-1 默认、错误态、焦点环及主题磁盘文件保持原合同。新增真实主题加载到组件消费的回归验证；DS-4 主线回填 #3920。

- **2026-09-04（DS-4 Button 与 Input 标准组件）**：`components/ui/button.tsx` / `input.tsx` 落地；§4 回写高度 / hover 换色 / pressed / 字号字重 / secondary 绑 Tier-1 / ivory 登记债（拍板人 = 用户/设计师，2026-09-03）。影子包新建 component 层。路线图 DS-3 已是 #3798；DS-4 号待本张合入后回填。 同日 self-review 收口三处：hover / pressed 改为从本变体 rest 底色朝前景 color-mix 派生（初版 alias 到 `--surface-hover` 在四个暗色主题里状态不可区分，违反 §10 双模式门槛；字面量 pressed 不跟主题），新增守卫 `themes/__tests__/buttonStateContrast.test.ts` 锁 11 主题每档 ΔRGB ≥ 8；按钮 hover / active 加 `enabled:` 前缀，修禁用态仍会 hover 换色的行为回归；§4 单行输入 focus 环还原为 `--focus-ring-soft`，spec 与实现的偏差改为登记进 [`design-governance.md`](./design-governance.md) §10 待裁决表，不擅自统一。

- **2026-09-02（Desktop 登录成功回调页 UX 覆盖）**：成功态移除返回 Cindy 按钮，改为 560×500 紧凑内容流卡片，底部显示本地化 3 秒倒计时并在结束时先移除文字再调用 `window.close()`；失败 / Warning 继续使用 680×680 卡片与返回操作。同步更新 `DESIGN.md §16`、`figma-component-spec.md §6`、`token-decision-table.md §4` 与客户端模板测试。

- **2026-09-02（DS-3 最小语义 Token 影子层）**：新建 `packages/design-tokens`（标准 DTCG JSON，reference → semantic 两层）。数据源为 DS-2b 冻结快照，零运行时接线；弃坑复查日期 2026-11-01。不改台账、不改产品代码。路线图 DS-2b 回填为 #3700。
- **2026-08-31（Switch / 通用手柄交稿包入仓）**：登记 `gamepads/nintendo-switch-pro/`、`gamepads/switch-joy-con/`、`gamepads/ultimate-c1/` 三组同事线稿，设置页 Nintendo 默认 Switch Pro、接上 Joy-Con 时换 Joy-Con 图，通用手柄用 Ultimate C1。零视觉规范改写。
- **2026-08-30（治理合同修订：管道/记账、已知边界、路线图勘误；同日按 review 收口）**：[`design-governance.md`](./design-governance.md) 新增 §1.1「管道与记账」（守卫红灯不是禁令——管道规则不许绕、记账值走「同 PR 更新快照/台账 + 设计师批」的合法路径改，消灭的是「没人决定过的变化」；**保护值例外**：CINDY 皮肤族 / U2 二级信息色 / `annotation-accent` 不适用通用路径，须按 `DESIGN.md` 各自的用户裁决或冻结条款；正式豁免登记是合法路径，只禁未经裁决为消红灯加豁免）与 §13「已知边界」（正则扫描边界——内联样式字面量会被 `hardcoded-color-audit` 发现、真正扫不到的是动态值与 canvas/xterm 自绘；复用道路唯一靠 review 不靠机器；**新代码默认走语义层**、保留 §3.3/§3.4 既有准入、仅存量渐进），两节自
  mivo-canvas-plugin 仓 4/7 张 PR 实战沉淀移植。勘误三处：§2 旧编号「PR-8」→「DS-8」；§12 依赖行 DS-6 前置由已关闭的圆角裁决改为「Permission 迁移余项」并补 DS-7 受 `radius` 覆盖裁决约束；§12 路线图回填 DS-1 = #3609（合入日期修正为 2026-08-30）。零视觉，非 DS 序号。
- **2026-08-30（生产 UI 台账）**：新建 [`design-inventory.md`](./design-inventory.md)，登记 Desktop 生产可达 surface（生成器 `pnpm design:inventory` / 校验 `pnpm check:design-inventory`）。首轮全部 `legacy`；Mobile 待 DS-9 增量。本条目仅登记台账与生成器；产品代码零改动。
- **2026-08-29（圆角三档写死）**：`DESIGN.md §5` Border Radius Scale 措辞加硬（拍板人 = 用户）：按钮一律胶囊（含权限允许/拒绝，删除「cannot wear the pill」主观逃生口）、8px 档判据改为「盒内非按钮」、4px 不入档（30 处生产存量登记为债、新代码禁止、机器拦截随设计系统棘轮 PR 落地）、「看起来小」不是改档理由、不加档。2px status micro-cells 窄豁免不变。**同轮补充裁决（随 #3619 review 落定）**：textarea 一律 8px（不设嵌套前提，§4/§7/§9 摘要句逐一对齐，§5 为唯一裁决源）；已登记的裸文字按钮（向导「← 上一步」、§16.3 登录文字按钮）是胶囊**唯一豁免**、不带圆角，新增用法须在组件条目登记——透明填充 / 仅描边控件不属豁免（fill 样式从不改变档位）。裁决全文与未决余项（允许/拒绝主次、双端几何）见 [`design-decision-log.md`](./design-decision-log.md)「08-29」两条。**［09-07 更新：圆角分配入口改为 §5 两步判定树（登记形状优先），「按钮一律胶囊／唯一豁免」绝对化措辞改为「未命中 Step 1 的普通控件框」，2px status micro-cells 例外改按 data mark 登记成员归类；三档数值不变，见 09-07 条。］**
- **2026-08-29（设计系统治理合同）**：新建 [`design-governance.md`](./design-governance.md)，启动设计系统治理（九张主线 PR 的第一张，纯文档）。定案：四种真相边界（规则 = `DESIGN.md`、数值现阶段 = `colors.ts` / 目标 = `packages/design-tokens` DTCG、台账 = 未来的 `design-inventory.md`、视觉 = 真实运行截图）；Token 工具单选 Terrazzo（锁 2.7.1，推迟到生成切换才安装）、不采用 Style Dictionary；可见 PR 两级证据合同（静态守卫测试 + 真实 Cindy Light/Dark 截图）；PR 三类风险不混张；旧 Token ID 不删不改名、用户主题不改写磁盘两条兼容红线；PermissionPrompt 圆角混用（8px×4 / 4px×4 / 12px×1，2026-08-29 实测，生成命令见 [`design-decision-log.md`](./design-decision-log.md)「08-29」条计数口径块）登记为待裁决项，裁决未关闭前相关文件不进迁移 diff。存量门禁与文档逐项登记处置去向（含 `DESIGN.md §10` Tier-1 表与 `§16.1` 表「生成切换后由机器摘要替代、此前维持人工维护」）。本条目仅登记治理文件；`DESIGN.md` 正文零改动。
- **2026-08-24（手柄线稿交稿）**：新增 [`gamepad-silhouette-authoring.md`](./gamepad-silhouette-authoring.md)，把设置页 Xbox 手柄图的画法收成同事交稿约定（同网格、长弧、键壳分家、热区与填充）。
- **2026-08-06（资源用量进程类别色）**：按用户对资源用量面板“icon 改为彩色”的走查要求，`DESIGN.md §2 / §10` 登记仅限 14px 进程类型 glyph 的六色 Light / Dark 调色板；颜色只编码任务 Agent、控制面服务、主进程、Renderer、GPU、Utility 类别，不表达健康或运行状态，行背景、文字、指标与操作继续保持中性。对应 token 加入外部主题导入保护，防类别色随导入主题漂移；该例外不得扩散到其它表格或进程 UI。
- **2026-08-03（排版立法：字重四档 + 桌面字号白名单，issue #1505 PR1）**：`DESIGN.md §3` 字重梯由「仅 400/500」修订为 400/500/600/700 四档（600 = 限量强调收编存量 72 处 semibold（生产代码口径）；700 仅限豁免域；800 及中间值全禁；与手机端 `fontWeight` token 对齐），§3 Principles / §7 Don'ts / §9 Iteration Guide 三处「never bold」表述同步改写；§3 新增四个小节——「字重阶梯」（含 CJK 伪粗体注记：中文层级不得依赖 600 vs 700）、「桌面 UI 字号白名单」（UI 段 {10–16} + 标题段 {18,20,24,28}，禁任意值 `text-[Npx]` 与小数；语义别名只收编 `xs/sm/base/lg`，源码侧禁止 `xl` 及以上，配置侧遗留项不在本轮删除范围；**四个权威来源的镜像关系已由 PR #1553 建立，另有 tailwind-merge 字号去重消费端单独校验**）、「排版豁免登记表」（登录品牌画布 / markdown `<strong>` / hljs 移植 / 外部页注入 / 手机 WebView 生成器 / 紧凑模式派生值）、「排版 non-goals」（line-height 混轨等本轮明确不治理）。走查数据、三项拍板与后续施工计划见 [`design-decision-log.md`](./design-decision-log.md)「2026-08-03」条与 issue #1505。
- **2026-07-29（修正：手机端功能区落位回新稿标注值）**：手机短屏 / 长屏的 `loginY` 由 main 原值 694 / 933 改回新稿标注值 **622 / 827**；短屏以下（dh<1334）改为 `min(622, max(0, dh-640))`——保留紧凑底距 18 再钳到短屏档落位（**不是**把锚常量改成 `dh-712`：那会让 dh∈[712,1222) 全段字标被面板压盖，review 实算 dh=1000 压 40 设计px）。起因：2026-07-28 剥离手机端跳过登录时把功能区落位一并退回 main，却保留了已换新稿的品牌簇，两半拼接使「字标底↔面板顶」间距变成 **92 / 131.65** 设计px（稿内为 20 / 25.65），实机肉眼可见一条空白。修正后间距回到稿值；面板 500→440 少掉的 60 落到底部留白（90 / 175，比稿内多 60）——审图拍板「方案 B」，未采纳「品牌簇整体下移 60」的方案 A。`DESIGN.md §16.2` 表与「60 去向」条目、§16 末尾勘误块 (6) 已就地更新；`loginSkinLayout.test.ts` 新增三条不变式：「间距上界不变式」（等于稿值，替代原先只判不重叠的下界）、「锚常量连续性不变式」（dh=1334 上下不跳变）、「间距不变式（短屏以下分支）」（dh∈[850,1334) 采样点面板顶不得压到字标底），防再次只改一半、也防窄屏压盖回归。pad 竖屏不受影响（无新稿帧、品牌簇未换基准，保持 621 / 158）。
- **2026-07-28**：`DESIGN.md §2` 语义色清单新增警告橙合法消费者「workflow agent 状态方块条的运行中格子」（8×8px 方块，后台任务面板详情 + workflow 聊天卡；done/failed/queued 各走自己的语义 token），并明确「不引入新 token 的消费者由 §2 清单登记即可、需要新 token 才必须先进 §10 豁免表」；`DESIGN.md §5` 新增小例外「status micro-cells（2px）」——≤8px 的非交互状态方块保留 2px 圆角（方块条格子与 SystemCard 分类方块），档位圆角在该尺寸会把方块变成圆点、丢掉大编队一眼总览的「方块条」读法，范围严格限定非交互 / ≤8px / 仅状态，按钮·标签·行·徽章·容器一律仍走三档。**［09-07 更新：本条的 §5 微格例外已并入 data mark 登记成员（`workflow-status-cell` / `system-category-square`），数值与组件不变，依据从「≤8px 非交互」改为图元角色；§2 警告橙消费者登记不受影响，见 09-07 条。］**
- **2026-07-28（勘误：手机端跳过登录剥离）**：手机端「跳过登录」与无账号通路整体从登录改版中剥离（2026-07-24「手机 / pad 必须有账号」拍板仍有效，07-27 的推翻缺产品侧确认）；手机端只保留纯视觉改版（品牌簇新稿基准 + 避脸），面板 / 组高 / 圆钮行 / 协议行 / error 槽 / 键盘停靠锚全部回到 main 等价值。`DESIGN.md §16` 末尾新增勘误块界定「哪些值只对桌面成立」，详情与依据归档至 [`design-decision-log.md`](./design-decision-log.md)「2026-07-28」条。
- **2026-07-27（登录改版：面板 500 + 跳过登录）**：`DESIGN.md §16` 几何表换新值（面板 440→500、登录组 560→620、圆钮行 y 480→540、协议行 y 582→642、error 槽回 680×50@380、新增「跳过登录」槽 680×60@430）+ 新增 §16.3「登录文字按钮」组件规格 + §16.4 协议门过门点与豁免表 + §16.2 移动端 stage 几何与键盘停靠锚；`figma-component-spec.md` 新增 §12（wave6 新稿 `700:783` / `705:799` / `705:915` 读取记录、跳过登录逐值规格、新旧稿差异、UNKNOWN 清单）；`token-decision-table.md` §3/§4 改值并登记跳过登录尺寸族（色源复用 `--login-secondary-text`，零新增颜色 token）；被推翻的两条 2026-07-24 产品拍板（游客过协议门 / 手机必须有账号）与 pad 竖屏推导值归档至 [`design-decision-log.md`](./design-decision-log.md)「2026-07-27」条。
- **2026-07-26**：`DESIGN.md §10` 新增「External Theme Import (VSCode / Obsidian)」小节——外部主题导入只映射从 7 个人工移植社区主题抽出的 91-token 模板、语义豁免族（`--login-*` / 危险红 / 警告橙 / 焦点蓝 / `--diff-*`）不参与导入、`-hsl` token 精确换算、新增 `--md-h1-fg`…`--md-h6-fg` / `--md-strong-fg`（默认 `inherit`，内置主题观感不变）、本地主题可选 `family` 字段。决策理由与取舍见 [`design-decision-log.md`](./design-decision-log.md) 2026-07-26 条。
- **2026-07-24（梳理批次 1）**：`DESIGN.md` 整体梳理第一批落地——去除 Ollama 官网叙事（标题改 `Cindy Design System`，§1/§4/§5/§8/§9 重写或删除官网内容）；focus ring 文档追平代码（`#3b82f6` → `#417CDD`）；§2/§9 二级三级文字与 chip 双 slot 表述按 `colors.ts` 修正；§10 移除写死 token 计数与过时豁免行；§12 结构化规格并入 §4（§12 编号留占位）；§13 G1–G4 归档至新建 [`design-decision-log.md`](./design-decision-log.md)；§14/§15/§16 若干失效指向修正。
- **2026-07-24**：目录整编（设计 md 统一归位 `docs/design-rules/`，本文件升级为索引）。同步 Figma 组件库更新：hover 统一「叠白变亮」口径（旧「白底钮 hover 叠黑」作废）、新增协议勾选 `radiobutton` 四态与双色模式小按钮四母版、`SSO 登录_企业` / `back` 扩 Dark 三态、`white_button` 增 loading 五态（`figma-component-spec §11`、`DESIGN.md §16.5`）。`figma-component-spec.md` / `token-decision-table.md` 自迁移前仓库最后版本恢复并更新至 wave5。
- **2026-07-23**：`DESIGN.md` 新增 §16 登录链路（登录全链路设计规范、`--login-*` 双态 token 表、深色模式落地机制）。
