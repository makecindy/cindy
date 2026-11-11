# 新增供应商型号误显示“尚未配置 CC”：重新修复技术方案

- 更新日期：2026-11-02；状态：已开始重新实现，修复与定向回归已完成首轮；相关门禁已通过，最终独立审查及验收尚待完成。
- 首轮方案核查基线：`5833d4ac744d1b110b9dd78d4f889c6bfef08df4`；2026-11-02 实施准备时 fetch 官方 main 并快进到 `e98940c6d8b815d7788a4bc19873cd5bd3671332`，以下复现绑定后者。
- 文档所在分支：`fix/provider-repair-restart-20261101`；worktree：`cindy-provider-repair-restart-20261101`。
- 该 worktree 此前从官方 main 新建；快进前只有未提交方案文档，文档内容已原样保留。当前实现范围见第 11 节。
- 本文整体替代上一版范围过大的重新修复方案；用户已要求按工作流和本文执行。先完成本地实现、检查与审查；外部交付按流程及授权推进，旧 PR 不自动关闭。

## 1. 目标与范围

用户要解决的是：**新增 DeepSeek 供应商的型号列表里，有接入依据、可以用于 Claude Code（CC）的补充型号，却显示“尚未配置 CC”。**

本次完成标准：按有效资料正确建立型号与引擎的归属，并使选择、保存、重新读取后的接口一致。保留原提示文字、布局和翻译，不新增“尚未确认”状态。

| 范围 | 处理方式 |
| --- | --- |
| 新增页补充候选的引擎归属 | 核心修复 |
| 在线发现与离线候选合并 | 同一归属问题，必须覆盖 |
| 勾选、保存、重读与运行时投影 | 必要配套，防止页面正确而保存结果错误 |
| 预设推荐、默认勾选、兼容开关 | 保持现有合同；归属不等于默认开启 |
| 编辑、刷新、导入入口 | 反查是否复用同一缺陷；存在才纳入同根因修复，未受影响需记录依据 |
| 提示文案、提示组件及语言文件 | 不改；正确归属后，原错误提示自然不再出现 |
| Codex 上游拒绝 `exec` | 独立根因，不在本次修复内 |
| 存量连接自动补齐或批量迁移 | 不做，不擅自增加引擎或改用户配置 |
| Server、桥接、系统提示词、权限、数据库 schema、原生依赖 | 不改；若复现证明必须涉及，先说明证据及范围变化 |

不能通过删除提示、隐藏型号、把所有型号塞进所有引擎或硬编码 DeepSeek 型号白名单完成此任务。

## 2. 根因及源码依据

### 2.1 已核实的静态链路

基线中的 [AddProviderWizard.tsx](../../apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx) 有三段相关逻辑：

1. 推荐型号来自预设的各引擎名单，直接建立 `agents`。
2. 补充候选调用 `providerModelsForRoute(baseUrl, protocol)`。除 Pi 的旧兜底外，它按连接地址和单一协议筛选离线表，没有在此处使用当前 Registry 的逐型号接口声明。
3. 在线合并对共享发现地址存在 `preservePresetOwnership` 分支，保留旧引擎名单，不为这些型号补入引擎归属。末尾提示只根据 `agents` 判断，并未发起真实 CC 调用。

[providerModelCatalog.ts](../../packages/model-providers/src/providerModelCatalog.ts) 的 `providerModelsForRoute` 实际比较离线条目的 `upstream` 和 `execution.pi.api`。例如离线记录是 Chat，而 CC 查询 Messages 地址/协议，就可能漏掉已有 CC 接口声明的型号。

[providerInterfaceRoutes.ts](../../packages/model-providers/src/providerInterfaceRoutes.ts) 已有 `availableModelInterfaces` 和运行时投影逻辑，会按 provider、精确 model ID、输入地址、接口绑定、退役和能力要求解析有效接口。新增页应复用这些能力，不能另造接口支持判定。

核查到本基线内置 Registry 为 V6，`updatedAt` 为 `2026-10-31T03:14:42.037Z`，含 DeepSeek 多种接口声明。这里描述的是仓内资料，不证明当前生产下发、实际账号权限或每种接口均真实可用。

### 2.2 大白话结论

系统有一份“这个型号能怎么接”的资料，但新增页补充型号时主要按旧表里的某一种接法找，没把这份有效资料用完整。因此漏掉 CC 归属，随后触发“尚未配置 CC”的提示。

问题发生在完成添加之前，不能归因于用户保存配置失败或未填写 Key。提示是归属错误的结果，修复重点是生成归属的数据链。

### 2.3 复现边界（2026-11-02 更新）

上述是静态缺口，不等于当前完整目录必现。真正运行测试后发现：`builtin.ts` 构建 `BUNDLED_CATALOG` 时还调用 `appendPiProviderPresets`，它会将同源离线型号补入各引擎，并投影当前接口。因此只看原始 `providers.json` 会漏掉加载阶段的补全，不能据此声称当前内置 CC 名单缺失。

当前完整内置预设对原型号 `deepseek-v4-flash-vision-exp` 的离线、在线两项控制测试均通过。缩减后的历史精简名单只在发现失败时重现 CC 成员丢失；相同精简名单的共享在线发现通过。另一个刻意构造的“各引擎推荐名单不同但共享 modelsUrl”输入能激活 `preservePresetOwnership`，在线发现后仍丢失 CC。后两项失败分别证明条件性缺口，不能写成当前生产目录必现或原截图已完整复现。

实际活动目录、用户原连接与原截图提示仍待核对；当前没有获取宿主实际接受的目录快照或发起真实账号请求。后续记录目录源/schema/revision、进入向导的实际 presets 以及精确型号，再决定是否仍需要修该路径。

## 3. 与 #8204 的关系

参考 [#8204](https://github.com/makecindy/cindy/pull/8204)，核查的 PR head 为 `19c8bfa3ea22f6d79d8a6427cea951e4397006bc`。

| 旧 PR 的部分 | 本次结论 |
| --- | --- |
| 向导取得当前 Registry，用有效接口资料建立补充型号归属 | 方向正确，作为参考 |
| 保存对应接口，保护显式专用路径及型号默认 | 必要配套，按新基线重新验证并最小实现 |
| V5 Pi 候选兼容 | 作为回归要求，不能因修 CC 删除旧版合法候选 |
| “接入资料待确认”及多语言提示改动 | 不纳入 |
| CI 翻译补齐与并发测试时序调整 | 不照搬；新基线确有失败时另查原因 |
| Codex `exec` 兼容补修 | 不纳入 |

旧 PR 正文记载 CC 真实回复 `DS_CC_OK`，属于历史证据，不是新 worktree 的验收结果。重做不否定旧 PR 的核心方向；不整包 cherry-pick、merge 或套用旧补丁，也不自动关闭旧 PR。

## 4. 实现方案

### 4.1 当前目录的读取

核对既有 `listProviderPresets` 只读通道：如果仍只返回 presets，在原响应中增加可选 `modelRegistry`，取自执行端当前接受的目录，而不是 Renderer 单独导入随包 Registry。

需要同步 main handler、preload 和 Renderer 类型；沿用原 channel 和权限，不新增 IPC。旧消费者忽略新字段；字段缺失时保持旧目录行为，不能把缺失解释为所有型号均不支持。

### 4.2 补充候选与归属

在 Desktop shared 层增加一个小型候选解析 helper，或复用新主干已有等价 helper。它只组合候选和已有接口解析器，不改变公共协议合同。

输入为预设、引擎、精确型号、当前 Registry、实际连接地址和发现来源路由；输出为有效候选及必要的接口引用/路由。

- 推荐名单维持原有推荐标记和勾选规则；补充候选仍默认未勾选。
- 从精确地址对应的离线资料和该产品当前有效接口收集候选；通过既有解析器核对可执行接口，不借其他产品、其他 host 或相似型号的声明。
- 有效的逐型号绑定及当前产品通用声明按既有解析器语义使用。未知型号不能仅因不在静态名单而被禁止动态发现。
- 当前 V6 明确的退役、空接口绑定、未知必需能力、冲突声明不能被随包资料“补活”。通用声明不能替代精确撤回。
- 没有 V6 声明的旧目录保留原合法直连发现及 Pi 混合 API 离线候选，不凭空推断跨协议支持。
- 自定义 host、显式 `requestPath` 不借官方接口改址；专用路径的已有合法发现保留其来源。

### 4.3 在线合并

离线补充与在线发现共用候选判定，分别测试共享列表、独立列表、主发现和附加发现。共享 `/models` 只证明列出了型号，不直接证明支持全部协议；有有效声明时也不能被“保留旧名单”分支永久挡住。

保留既有完整清单删除、失败回退、用户已勾选和过期请求丢弃语义。不要为本次归属修复重写发现状态机。

路由冲突必须分清来源：用户/导入显式配置不被覆盖；主发现已有命中不被后来的附加来源抢占；在线附加的明确专用路径可以替代同型号的离线占位；多个附加来源沿用既有顺序。

### 4.4 保存、重读与实际选路

选择后的 `agents` 决定对应 runtime 的型号成员；不能只改徽标。沿用 [presetConnectionRuntime.ts](../../apps/desktop/src/shared/presetConnectionRuntime.ts) 和 [user-provider.ts](../../packages/model-providers/src/user-provider.ts) 的配置投影。

- 自动接口继续引用当前默认，不把整份派生结果当用户 override 永久存下。
- 必须保留的非默认接口或独立发现路由使用已有字段，例如 `interfaceId`、`route`；不得引入第二套 schema。
- 型号仅有 Chat 接口、而引擎通过已有兼容链可执行时，不能只新增成员却丢掉 Chat 选择；也不能一律用连接级默认压过型号 preferred。
- 用户显式 API、接口、地址、专用路径和开关优先。保存前后经过 JSON 往返及正常存储读取，结果应一致。
- 引擎归属、默认开关、推荐引擎、账号权限是不同维度。本次不改变原生/兼容判定和默认开启规则。

## 5. 预计文件与边界

以下是入口清单，不是必须全部修改的文件列表；开工先在最新基线复核。

| 入口 | 预计用途 |
| --- | --- |
| `apps/desktop/src/renderer/components/settings/AddProviderWizard.tsx` | 候选、在线合并、保存 |
| `apps/desktop/src/shared/providerModelCandidates.ts`（若仍无等价实现） | 薄层组合逻辑 |
| `apps/desktop/src/main/maker-ipc/providerHandlers.ts` | 返回当前接受的 Registry |
| `apps/desktop/src/preload/preload.ts`、`apps/desktop/src/renderer/vite-env.d.ts` | 可选响应字段类型 |
| 已有向导、provider handler、存储测试 | 真实生产入口回归 |
| `packages/model-providers/src/providerInterfaceRoutes.ts` | 优先复用；仅发现独立缺陷时才改 |

反查 `ProviderConnectionDialog`、导入与刷新入口的候选来源，列出受影响/未受影响及依据。不能只搜索新 helper 的调用者就声称覆盖完整，也不因为入口名称相关就整体改造。

## 6. 验证与验收

| 场景 | 必须证明什么 |
| --- | --- |
| 原始 CC 误提示 | 同一补充型号有有效 CC 声明，新增列表归入 CC，原错误提示消失；文案原样保留 |
| 无网络/发现失败 | 有依据的离线补充仍可用；不把失败当无支持，不额外自动勾选 |
| 共享列表与动态新型号 | 有声明可加入相应引擎，不能跨协议全量复制；合法新型号仍可发现 |
| 退役、空绑定、能力缺失 | 不从旧离线资料恢复被明确排除的接口 |
| 自定义地址及专用路径 | 不套官方地址；显式路径及来源优先级不丢失 |
| Chat-only、双接口 preferred | 保存重读与运行时投影保持有效接口，连接默认不错误覆盖型号默认 |
| 默认变化及用户覆盖 | 未手选的跟随目录默认；显式接口、地址、开关保持用户选择 |
| V5 / 缺 Registry / Pi | 原合法候选和发现不退化 |
| 保存及正常存储读取 | 勾选结果进入正确 runtime，JSON 往返、重读及选择器一致 |
| 界面与真实 CC 请求 | 原添加步骤完成；选受影响精确型号，以 CC 收到真实回复；记录最终接口 |

优先扩展既有测试文件，用真实向导、保存回调、正常存储入口和 `buildUserProvider` 观察结果，不写源码文本匹配测试。先用最小输入得到修复前失败，再用同一判据验证修复后通过。没有独立风险的新排列不机械展开。

提交前执行根 `pnpm test:unit:related`，并为每个实际改动包执行 `pnpm --filter <包名> run --if-present typecheck`；新增 helper 若仅在 Desktop，不因此强行改公共包。若选择器按仓规退回全量，完整执行；不弱化门禁。

界面沿用现有主题与布局，仍检查 Light/Dark 下原场景；未实机验证的模式如实披露。真实账号请求沿用已授权的独立验收实例，不复制正式 profile。保存脱敏证据、代码 SHA 和包版本，不记录 Key。

Codex/Pi 做本次归属及保存不退化回归；不把修好三引擎所有真实推理、工具调用、图片能力作为本次交付条件。若 CC 真请求失败，先定位是否来自本次归属/保存；相关失败必须解决，独立故障另行明确报告，不能声称完整验收通过。

## 7. worktree 与实施顺序

1. 已在此前建立的重做 worktree 更新本文并添加最小复现测试，保留旧修复分支、旧 PR 和其他工作区的全部改动。
2. 已重新 fetch 官方 main 并完成只快进更新，完整 SHA 见文首；未搬旧 PR 补丁。后续若再次更新，仍先核对状态，不回退、不覆盖已有测试或文档。
3. 在最终实施基线重读实际源码、嵌套 AGENTS 和相关规则；确认 checkout 完整，按该 worktree 锁文件准备独立依赖，禁止复制/软链其他 worktree 的 node_modules。
4. 先复现 CC 归属错误；核对同根因入口；最小修复候选、发现和必要保存环节。
5. 跑上节检查，review 完整 diff，确认没有混入提示文案、Codex 工具适配或无关 CI 修复。
6. 后续若进入打包与 PR 交付，按用户授权和仓库流程执行。Draft PR 走个人 fork，commit 带 DCO；未经本轮授权不关闭旧 PR、不合并或直推 main。

## 8. 一次方案审查记录

- 审查日期：2026-11-02；方式：本会话自审，逐项对照固定基线源码与 #8204 实际 diff。不是独立 Agent 审查，也不是新实现的代码审查。
- 范围检查：已移除上一版提示改写、Codex `exec` 补修、工具往返必测和存量自动补齐目标。
- 根因检查：区分离线单协议筛选和在线保留归属两段，不把提示字符串或保存失败当根因；将静态事实与待复现结论分开。
- 数据安全检查：没有凭证、用户配置或迁移操作；新方案不扩大账号权限和引擎默认开关。
- 路由检查：明确自动默认不固化、显式接口/路径优先、Chat-only 保存、型号 preferred 与旧 Pi 候选的回归要求。
- 交付检查：旧 PR 的 CC 历史成功不算新代码通过；当前基线不称为最新主干；只有方案完成，产品修复尚未开始。
- 文档验证：`pnpm check:dev-docs` 10/10 通过；本文 17 个本地链接均存在；新增文档空白检查无错误。未运行业务单测、typecheck 或真实请求，因为本轮没有产品代码改动。
- 审查结论：方案可作为重新实施依据；尚待新基线最小复现、实现、测试和真实 CC 验收，不代表 #8204 或新代码已经通过合并审查。

## 9. 最小复现结果与审查意见落实

本节与第 8 节首轮方案自审分开；这是新主干上的测试结果，不是修复完成记录。

### 9.1 输入和结果

真实生产向导入口：既有 `addProviderWizardPresetEntry.test.tsx`，原型号 `deepseek-v4-flash-vision-exp`，真实 `AddProviderWizard` → 勾选 → 保存回调 → JSON 往返 → `buildUserProvider`。只有外部 IPC 用 fake host，Key 是固定虚拟字符串。

| 输入 | 结果 | 能证明什么 |
| --- | --- | --- |
| 当前完整 BUNDLED_CATALOG，发现失败 | 通过 | 当前完整内置预设已包含 CC，不能声称无条件必现 |
| 当前完整 BUNDLED_CATALOG，共享在线发现成功 | 通过 | 同上，并覆盖发现合并 |
| 历史精简名单，只保留 Flash/Pro，发现失败 | 预期正确行为断言失败 | 保存 CC 型号仅有 Flash/Pro，漏掉 Vision Exp，证明离线补充缺口 |
| 同一历史精简名单，共享在线发现成功 | 通过 | 共享地址本身不足以触发保留归属分支 |
| 构造精简名单：CC 仅 Flash，其他引擎 Flash/Pro，共享发现成功 | 预期正确行为断言失败 | 激活 splitDiscoveryUrls，保存 CC 只有 Flash，证明在线保留名单缺口 |

5 个选中用例，3 通过、2 失败，118 个无关用例未选；最终重跑该文件测试体 673ms，总时长 5.10s（含模块收集与 jsdom）。保留正确行为的失败断言作为后续修复判据，不改成“期待旧 bug”来让它通过。当前测试分支不是可提交的完成态。

最初尝试不缩减内置预设时，前置断言意外发现目标型号已存在；已纠正测试假设并保留完整预设作为控制。该次前置断言失败不计作产品 bug 的复现。

### 9.2 接口枚举的边界

复核 `availableModelInterfaces`：`agent` 用于 preferred 排序，不直接筛除其他引擎；空数组不携带原因，可能是缺 Registry、V5、地址不匹配、精确撤回、重复声明或未知必需能力。新增候选判定必须根据输入声明区分原因，并用最终投影验证执行选路；不能把 `choices.length > 0` 当全部成员判据，也不能把空结果统一旧表兜底或统一禁用。

此次沿用既有接口投影的未知能力、专用地址两项控制测试，均通过；这不表示上述所有空结果原因都已逐项测试。

### 9.3 默认变化控制

增强既有 `providerInterfaceRoutes.test.ts` 的默认变化用例：先分别 JSON 序列化一份自动配置和一份显式 Chat 接口配置；在同一 Registry 上改变型号 preferred 后，用同两份输入重新投影。自动从 Responses 跟随为 Messages，显式 Chat 保持不变；两份输入的 JSON 内容均未变。

该用例及上节两项控制合计 3/3 通过，85 个无关用例未选；测试体 54ms，总时长 857ms。证明当前运行时既有机制支持这项合同，尚未证明未来新增候选保存逻辑也会遵守；实现后仍须把向导产物接入同一默认切换验证。

### 9.4 其他检查

- Desktop `pnpm --filter desktop run --if-present typecheck`：最终通过。初次检查发现本轮测试夹具用了非合法 `ProviderErrorCode` 的旧字面量 `NETWORK`，已移除这个非必填字段并重跑通过；发现失败输入仍为 `ok: false`。
- `pnpm check:dev-docs`：10/10 通过；本地文档链接检查与 `git diff --check` 通过。
- 无生产源码改动；未提交、未推送。定向复现仍保留 2 条正确行为失败断言，不能据类型检查通过宣称修复完成。

### 9.5 最小复现轮次结束时的未完成项

以下记录保留该轮边界；后续真实实例缓存核对见第 10 节。

- 当时未读取实际宿主活动目录、未进行原截图的真实界面验收、未发送真实 CC 请求。
- 未修改候选或运行时生产实现，尚不能宣称修复完成。
- 未运行完整相关单测或跨平台实机；当前只有上述定向最小复现和控制。

## 10. 实例目录核对与真实缓存复放（2026-11-02）

### 10.1 实例与证据分开

本轮只读核对正式版、Dev、旧独立验收实例的数据目录与加载日志；没有启动/退出 App，没有刷新或改写实例缓存、账号设置、模型配置、数据库或凭证，没有发模型请求。

- 当前 Dev 的进程登记指向 `e98940c6d8b8` 开发包，使用独立 `CindyDev` profile；旧验收实例的 profile 为 `CindyAcceptance/provider-engine-membership`，数据仍在，当前未运行。
- 正式版、Dev、验收数据分别检查，未把后续修复包的验收成功当作原截图证据。无法仅凭现存截图把它唯一绑定到某个历史 PID；下表是实际保留的数据，不声称它们是截图当刻的内存 dump。
- 原问题消息时间为 2026-10-30 15:04（Asia/Shanghai）。Dev 当日 14:47:16 的日志记录成功加载 `https://model-access.cindy.com.cn/api/model-catalog/catalog`；当前 Dev 12:07:59 也记录成功加载相同远端目录。正式版与验收实例的日志也有远端目录加载记录。

| 实际保留来源 | Registry revision | DeepSeek 预设 |
| --- | --- | --- |
| 正式版 V6 LKG | `2026-10-27T15:16:20.193Z` | CC、Codex、Pi 都仅列 `deepseek-flash`、`deepseek-v4-pro` |
| 当前 Dev LKG | `2026-10-30T08:00:00.000Z` | 同上 |
| 旧独立验收实例 LKG | `2026-10-30T08:00:00.000Z` | 同上 |

三份 DeepSeek preset 内容完全相同。按 `JSON.stringify` 等价的 JSON 排序摘要（Python `json.dumps(sort_keys=True)` 默认空格格式）为 `e0359aa6c4565e6e70df35b74b178baa544b58ad11dcab91ef27ae65544a63f2`。

共同地址事实：CC 和 Pi 的 base URL 均为 `https://api.deepseek.com/anthropic`；Pi 明确为 `anthropic-messages`。Codex 是 `https://api.deepseek.com`、`openai-chat`。三者 modelsUrl 都是 `https://api.deepseek.com/models`。这与上一轮构造精简名单的 Pi Chat 根地址不同，因此上一轮输入不能直接代表真实实例。

当前 Dev/验收 LKG 的目录 payload SHA-256 记录在[脱敏公开夹具](../../apps/desktop/src/renderer/__tests__/fixtures/deepseek-retained-catalog.json)的 `source.catalogSha256`；封套 SHA-256 为 `7ae535d9074aee88de2344bb0fa6c2bd1013484fa4e32811a57bba6acaf62d4d`。夹具只保存公开 DeepSeek 预设、接口声明和相关公共型号资料，没有账号配置或凭证，且不复制其他产品整份目录。

### 10.2 生产加载链的复放

用该公开子集作为注入的远端响应，调用真实 `loadCatalogWithSource`，然后将结果交给真实 `AddProviderWizard`。测试没有访问外网或实例磁盘；providers 容器使用 bundled 的公开 builtin provider 满足解析要求，DeepSeek preset/接口声明来自真实保留快照。

观察结果：

1. 当前完整 `BUNDLED_CATALOG` 的 CC 名单原本已有 `deepseek-v4-flash-vision-exp`。
2. 远端加载成功后，`mergeWithBundled` 按同 ID 的远端 preset 为准，`backfillPresetMetadata` 只回填已有型号的资料等缺项，不合并全部型号成员。因此交给向导的 CC 名单仍只有 Flash/Pro。
3. Registry 是独立选择的整份快照；本次复放接受了比远端更新的 bundled Registry。这并不自动补全 preset 的成员。
4. 模拟在线发现全部失败时，离线候选只给 Vision Exp 建立 Codex 归属。真实 Pi 的 Anthropic 地址也没有补上该离线型号。
5. 向导行触发原 `settings.providers.models.capabilityNote`，源码对该 Codex-only 行的参数为 Claude Code；勾选、完成后，Codex 保存了 Vision Exp，CC/Pi 均未保存它。

测试：`addProviderWizardPresetEntry.test.tsx` 中 `reproduction: retained remote catalog loses Vision Exp CC membership after merging`。1 个选中用例在最后的正确行为断言失败：CC 中应有 Vision Exp，实际为 false；此前来源、目录名单、原提示出现、Codex 保存与 Pi 缺席的检查均通过。测试体 214ms，整次运行 4.98s；123 个无关用例未选。

### 10.3 可以确认与仍不能确认的结论

**可以确认：真实保留目录属于精简预设，具备已复现的触发条件；使用实际地址与名单经过生产加载链和向导自动化复放，可以重现原提示及 CC 保存缺项。**这解释了为什么完整 bundled 控制通过，实际实例仍可能出现问题。

不能确认：原截图当刻实际进入向导的内存对象、各引擎在线发现的返回值与顺序。保留日志没有提供该次发现的逐请求证据，因此不能断言当时发生了网络故障、401 或某一引擎单独失败。当前也没有把缓存当成进程内存读取结果。

修复仍按原范围进行：让新增页在精简预设下正确使用当前有效接口资料，并保留必要路由。不要为此直接将整个 bundled 型号表强行并回远端名单，也不改提示文案或追加存量迁移。

本轮仅新增公开夹具、扩展既有复现测试及更新本文；未修改生产实现。已执行上述定向复放和文档检查；没有重跑整包 typecheck 或真实 CC 推理，不沿用上一轮 typecheck 冒充本轮结果。原始缓存及日志只读，未写入仓库；无提交、推送或 PR 更新。

## 11. 重新实现记录（2026-11-02）

### 11.1 当前实现

- 既有 `listProviderPresets` 响应增加可选 `modelRegistry`，从执行端 `getModelCatalog()` 取得当前接受的快照；未新增 IPC channel、权限或跨端 wire。
- Desktop shared 新增 `providerModelCandidates.ts`，组合精确地址离线候选与既有 `availableModelInterfaces`。当前有效声明用已有接口引用表达；明确退役、空绑定、重复声明、未实现必需能力不能走离线回退。
- 新增向导的初始补充与在线发现共用该判定。推荐与勾选不改；共享列表必须有接入依据才能扩充归属。保留在线主/附加来源、用户导入路径及过期响应保护。
- 自动默认保存 `interfaceId: auto` 引用，不固化派生 API/URL；没有当前引擎默认的有效接口保存已有 profile 引用，确保 Chat-only 选择重读后仍可执行。显式 requestPath 仍保存发现来源。
- 提示 JSX、提示 i18n key/文案、远端合并规则、服务端与存量迁移均未改；未纳入 Codex `exec` 兼容补修。

### 11.2 同根因入口核对

| 入口 | 结论及依据 |
| --- | --- |
| AddProviderWizard 初始化与在线发现 | 唯一直接使用旧 `providerModelsForRoute` 补充与 `preservePresetOwnership` 分支的 UI；两处均已接统一 helper |
| ProviderConnectionDialog 新建/编辑/列模型 | 用户按单个 agent 操作；不调用旧补充 helper，也没有共享名单保留分支；已有表单保留 interfaceId/api/route，不扩大为自动跨引擎补齐 |
| 已有连接刷新（customProviders / providerHandlers） | 合并既有 runtime 的发现结果，使用 `mergeDiscoveredRuntimeModels`；不进入本次新增补充链，不后台新增 runtime |
| 导入 | `presetConnectionRuntime` 及既有检测草稿保持原合同；向导接收的显式用户字段在最终保存时继续优先 |
| 运行时 | 复用 `buildUserProvider` 与 `providerInterfaceModelRoute`，未修改公共投影实现 |

### 11.3 本轮验证记录

- 向导文件 124/124 通过，包含原真实目录复放、完整内置控制、历史精简/分裂发现输入及既有全部向导回归。
- 候选 helper 与 provider handler 首轮定向 256/256 通过。随后自审发现显式路径绕过未实现 profile capability 的问题，先增加最小失败用例，再收紧同一路径；最终结果以后续完整相关门禁为准，不把首轮结果套用到最终版本。
- 旧存储测试已有 `persists automatic and explicit interface choices without derived API snapshots`，通过真实 in-memory SQLite 创建、读取、更新验证两种引用保存；不重复新增同构存储测试，相关门禁继续覆盖它。
- 新候选 helper 的序列化及运行时回归覆盖 Chat-only pin、相同保存输入下的目录默认切换、显式接口保留、能力撤回、重复声明、自定义 host/path、合法动态发现和旧 Pi 混合候选。
- 单页 UI 增加 `wizard-deepseek-retained`：真实缓存中的精简预设 + 发现失败 + 当前 Registry；真实组件与主题，模拟 IPC 和保存。Light/Dark、zh-CN 共 2/2 通过，已目检 overview；未改布局、颜色、圆角、点击目标或文案。截图不算完整 App/真实账号验收。
- 根 `pnpm test:unit:related` 通过：Desktop 相关选择完成（321.3s），model-providers 相关选择完成（5.6s）。Desktop typecheck 通过；model-providers 没有 typecheck script，`--if-present` 正常跳过。测试规范、文档 10/10 与 diff 空白检查通过。
- 独立最终版本 Reviewer 尚待执行，未宣称最终 pass；准备保存本地提交，未推送、打包或发起真实账号请求。

### 11.4 工作流资料可用性

已读取本机 `pr-myself`、`git-workflow` 和共用审查协议。它们引用的 `cindy-development` 与 `cindy-git-workflow` 本机文件缺失，已检查现有个人 Skill 和 Cindy 托管目录，未找到。当前按仓库规则及用户已保存的 Cindy 约定推进本地实现与验证；未拿 Filo 命令、审批人或 snapshot 适配替代 Cindy。正式交付前需要补齐 Cindy 专用入口；不伪造缺失的交付回执。

## 12. 实施前规则入口

- [模型目录架构](../dev-rules/model-catalog-maintenance.md)、[接口核查](../dev-rules/provider-interface-audit.md)、[资料覆盖](../product-rules/model-metadata-precedence.md)。
- [配置与用户覆盖](../dev-rules/configuration-and-overrides.md)、[开发流程](../dev-rules/development-workflow.md)、[环境准备](../dev-rules/environment-setup.md)。
- [Desktop 模块规则](../../apps/desktop/AGENTS.md)、[Desktop 验证](../dev-rules/desktop-development.md)、[Electron 边界](../dev-rules/electron-security-and-process-boundaries.md)、[工程与测试规范](../dev-rules/engineering-conventions.md)。
- [视觉规范](../design-rules/DESIGN.md)、[凭证和本地数据](../dev-rules/credentials-and-local-storage.md)。
