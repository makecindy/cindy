# 个人版迁移放行表

2026-11-12 起，随 M1 每个检查点更新（分支 `cindy/host-m1`，检查点标签 `m1-cp*`）。
个人版切到 Host 之前，「个人版应保留的能力」必须逐项有结论；本表记录每项的现状与证据。
开放迁移由交接任务决定，本表只提供依据。

状态口径：

- **已对齐**：Host 与桌面用同一份代码或等价逻辑，这条能力的写入、落盘、清理都已接上，有不带界面的自动验证；真实验证另列。只接了一部分时写「部分」，并列出没接的调用点。
- **部分**：只对齐了一部分，缺口写在同一行。
- **未做**：写明排在哪一步。
- **移出 M1**：写明移到哪个里程碑和原因。

拆分桌面模块与在 Host 上接用放在同一个检查点，不为「将来会用」先拆。

「自动验证」都是不带界面的测试；「真实验证」指真实账号、打包产物或带界面运行，M1 内均为「无」，
除非另行写明。

## 一、任务行为（a 类）

| # | 功能 | 生产方（桌面） | 状态与当前缺口 | 自动验证 | 真实验证 |
|---|---|---|---|---|---|
| 1 | 上下文窗口、输出上限、压缩阈值、核实窗口 | maker-host/index.ts、pi-host.ts 构造点 → `engineModelResolvers.ts` | 已对齐（m1-cp2a） | desktop `engineModelResolvers.test.ts`；Host `agent-graph.test.mjs` | 无 |
| 1b | 任务工作上下文预算 | `model-context-settings.ts` → `sessionContextBudgetCore.ts` | 已对齐（m1-cp2b） | Host `start-options.test.mjs` | 无 |
| 2 | 禁用的 Skill | `skillhub/activationPreferences.ts` | 已对齐（m1-cp3a） | Host `agent-graph.test.mjs` | 无 |
| 2b | 托管 Skill（内置与插件提供） | `maker-host/managed-skills.ts` → `managedSkillsCore.ts` | 部分（m1-cp6）：三个引擎都拿到 Host 插件运行时给的同一份清单，与桌面相同；Claude、Pi 直接加载，Codex 只在任务所在电脑提供托管 Skill 时用它停用本机副本。缺口：Codex 自己看到内置与插件 Skill 要靠 Skill 投影，等第 25 行。内置 Skill 只读桌面最后一次发布的快照，Host 不发布；没发布过的 profile 清单里没有内置 Skill，不报错。插件身份读取改用桌面的 `findGhostForInstanceId`（含账号可用性收紧，`cindy-brain/ghostAvailability.ts`）。随包插件在 Host 不标内置，见第五节。**迁移前必须完成**（Codex 部分） | Host `plugins/managed-skills.test.mjs`（正式插件运行时：发布后的内置 Skill、未发布为空、四类插件身份前后一致、账号不可用时剔除）、`agent/managed-skills.test.mjs`、`agent-graph.test.mjs`；桌面 `hostPluginIdentityParity.test.ts`（桌面生产函数与 Host 逐项相同，两种账号状态） | 无 |
| 3 | 插件花名册 | `mcp-integrations/ghost.ts` `getGhostRosterPrompt` | 已对齐（m1-cp3b，插件基座提交） | Host `agent-graph.test.mjs`；`plugins-installed.e2e.mjs` 花名册断言（该 e2e 未完整运行，见第五节） | 无 |
| 3b | 能力路由（Claude 常量、Codex 工厂） | `capability-routing.ts`、`codexCapabilityRouting.ts` | 已对齐（m1-cp3b） | desktop `codexCapabilityRouting.test.ts`；Host `agent-graph.test.mjs` | 无 |
| 3c | 引擎可用模型清单 | `catalog-to-descriptors.ts` `deriveAvailableModels` | 部分：刷新时机与桌面不同，见第二节 | Host `agent-graph.test.mjs`、`start-options.test.mjs` | 无 |
| 3d | 工作目录禁用的插件 | 桌面启动钩子第 ⑮ 步 | 已对齐，不含伙伴工具集（M3） | Host `start-options.test.mjs` | 无 |
| 4 | 自动复核、工具循环复核 | `auto-review-model-router.ts`、`oneShotCandidates.ts` | 未做（第 4 步，用户已选方案 A）。现状：Host 上 auto 任务里模型本会放行的操作改为人工确认，更安全但打断更多；工具循环只保留次数上限 | — | 无 |
| 5 | 视觉桥 | `vision-bridge/` | 未做（第 6 步） | — | 无 |
| 6 | 快速模式 | Host 原有 `session-settings.mjs` | 已对齐；Fast 轴与 Pi 价格档同步（m1-cp2b） | Host `start-options.test.mjs`（含恢复任务读到 priority） | 无 |
| 6b | Claude 按模型的思考档位 | `resolveModelEfforts` | 已对齐（m1-cp2a） | desktop `engineModelResolvers.test.ts` | 无 |
| 6c | 思考开关写通道 | `register.ts` `SET_THINKING_ENABLED` | 未做（第 10 步） | — | 无 |
| 6d | Pi 思考开关记忆 | `newMakerDefaultsCache.ts` | 部分：读取已接（m1-cp2b）；镜像由渲染层推送，客户端模式下推给窗口进程，Host 一直为空，要等 M2 的推送通道 | Host `start-options.test.mjs` | 无 |
| 7 | 回合改动记录 | `turn-change-set/store.ts` | Host 现有的两类回合已对齐（m1-cp5e，m1-cp5f 补测）：队列里的用户回合与直发回合。写入：引擎侧写前捕获（Claude、Pi）、派发时开记录定锚点（`beginTurnChangeSetAtDispatch`）、事件流记 Codex 原生改动（`noteTurnDiffEvent`，远程标记与桌面同一表达式）。落盘：done 与终止性错误时 `finalizeTurnChangeSet`，判定按 `sessionEventPreparation.ts` 手写（非共用代码），四种终态都有测试。清理：未派发、绑定实例关闭、同一任务换实例、删除任务。桌面另有这些发起回合的路径各自带着开记录与撤销的成对调用，Host 上都还没有：send_to_session（`register.ts:12348-12382`）、hook（`hook-control/session-runner.ts:1638`、1655、1675）、IM（`im/shared/turnRunner.ts:1948`、1961、1985）、定时任务（`scheduler-host/runner.ts:2278`、2334、2360，经 `createAutomationUserTurnGitBaselineHooks`）、goal-host（`controller.ts:2540`、2550、2591）、learn-host（`controller.ts:600`）、Orca 直发（`orcaInterAgentDispatcher.ts:878`、892，`beginDirectTurnChangeSet`）。哪条路径接到 Host，必须带上自己的这一对；查看与撤销的界面入口随 M2 | Host `input-queue.test.mjs`（锚点落盘、四种终态、先后顺序、未派发清理、实例关闭与替换）；`agent-graph.test.mjs`（引擎侧） | 无 |
| 7b | Git 保存点与文件回退 | `git-snapshot-host.ts` → `gitSnapshotHostCore.ts` | 部分（m1-cp5e）：保存点已接。派发前基线（队列钩子与直发钩子）、回合结束改后快照（`onTurnEnd`）、未派发撤回（`onTurnAbort`）、绑定实例关闭（`onSessionClosed`）、账号库就绪后的已删除任务引用对账，都与桌面同一份代码。未接：回退入口 `maker:rewind:preview`、`maker:rewind:commit` 随 M2 的界面通道一起接。标签：Host 上辅助模型调用未放开，标签一律用确定性兜底（如「改动 a.txt」）。停用裁决：`modelRouteGuardCore.ts` 已拆出、Host 未接（端口按「不可用」，失败时关闭），第 4 步必须连同等价的供应商视图一起接上；届时若决定不用，还原这次拆分 | Host `git-snapshot.test.mjs`（真实临时仓库）；`input-queue.test.mjs`（钩子顺序）；desktop `hostGitSnapshotChain.test.ts`（桌面建一轮、Host 接着建一轮：同一引用按序排列，尝试记录同一 owner 目录） | 无 |
| 8 | 工作树租约 | `worktree/runtimeLeases.ts` | 未做（第 7 步） | — | 无 |
| 9 | Codex 产品提示标记 | `maker-host/session-storage.ts` | 已对齐（m1-cp5a） | Host `agent-graph.test.mjs`；`codex-runtime.e2e.mjs` 数据库往返 | 无 |
| 10 | 读图钩子、电脑操作防护、Bash 并发闸门 | `claudeHooks` | 未做（第 6 步） | — | 无 |
| 11 | Codex 任务的记忆 | `apps/host/src/agent/memory.mjs:70` TODO | 未做（第 7 步）。m1-cp5c 起 Codex 的 `makerMemoryEnabled` 按用户设置读取，与桌面相同；第 7 步核实 Codex 经 MCP 桥实际拿到记忆工具 | — | 无 |
| 12 | 本机附件 | `normalizeAttachments.ts` | 部分：Codex 本机路径有自动证据；Claude、Pi 与输入框粘贴路径未验证（第 9 步） | `codex-runtime.e2e.mjs` | 无 |
| 13 | 用量与花费记录 | `maker-ipc/session*TurnUsage.ts` 与四个广播模块 | 未做（2e，M1 最后）。Host 期间不记录用量，事后补不回来，必须在迁移前完成 | — | 无 |
| 14 | 账号与供应商就绪、provider 冻结、model interface | 桌面启动钩子第 ③④⑤ 步 | 已对齐（m1-cp2b，就绪检查方式见第二节） | Host `start-options.test.mjs` | 无 |
| 15 | 订阅 Fast 策略、价格档 | 桌面启动钩子第 ⑥⑩ 步 | 已对齐（m1-cp2b） | Host `start-options.test.mjs` | 无 |
| 16 | 可选目录（账号过滤、订阅池投影） | `getDesktopSelectableCatalog` | 已对齐（m1-cp2c） | desktop `subscriptionPoolCatalog.test.ts`；Host `model-context.test.mjs` | 无 |
| 17 | 共享项目 Skill 链接 | 桌面启动钩子第 ⑬ 步与 `onBeforeStart` | 已对齐（m1-cp3b）；会写工作目录，见第三节 | Host `start-options.test.mjs` | 无 |
| 18 | /learn 捕获 | `learn-host/captureInvocation.ts` | 未做（授权路径，单独提交）。排在 3c 之后：捕获只认 Cindy 内置的 learn Skill，Host 从 m1-cp6 起能列出它（第 2b 行）；授权的消费方 `start_skill_learning` 在 `cindy_helper` 里，见第 22 行。**依赖第 25 行**：Host 列出的 learn Skill 是桌面最后一次发布的那份，迁移后不再更新；Codex 部分还依赖 Skill 投影协议 | — | 无 |
| 19 | 引擎专有项（Claude、Codex、Pi 各一组） | maker-host 构造点 | 未做（第 8 步） | — | 无 |
| 20 | 诊断：进程登记、cc-debug、出口路径事实 | maker-host 构造点 | 未做（第 7 步） | — | 无 |
| 21 | 启动时清掉从终端继承的 Anthropic 凭据与端点变量 | `main/index.ts` `stripSensitiveAnthropicEnv` | 已对齐（m1-cp5b）：`main.ts` 第一个导入执行同一步，保留导入用的 Claude 配置目录 | Host `boot-env.test.mjs` | 无 |
| 22 | Cindy 内置工具服务 | `mcp-integrations/mcp-providers.ts` `createLiziMcpProviders` | 未做，归属已定：M1 做 cindy_helper 里任务相关的一组、cindy_lsp、cindy_ssh（排在 M1 靠后，动手前先交分组清单）；M2 做设置类、cindy_scheduler、cindy_docs、inputHandoff；M3 做伙伴、Orca、IM 机器人、群聊记录、android、sessionImport、远程任务状态。Host 现在只有 browser、computer、cindy_memory 和插件网关。系统提示与桌面逐字相同、不裁剪，所以在对应工具补齐之前，Host 任务会被提示引导去用尚不存在的工具；**这一行必须在开放迁移前清零** | — | 无 |
| 23 | 引擎运行时配置（`runtimeConfig`） | `maker-host/runtime-configs.ts`；`pi-host.ts` `buildDesktopPiRuntimeConfig` → `runtimeConfigsCore.ts` | 已对齐（m1-cp5c）：产品系统提示、回答呈现提示、`behaviorFlags`、`taskShellEnv`、压缩阈值、换模型时的上下文评估、子代理模型、记忆设置（每次读取）、`userDataPath`、内置 ripgrep。Host 的 endpoint 仍是账号网关，见第 24 行；代输入的环境变量在 Host 上恒为空，见第二节 | desktop `hostRuntimeConfigParity.test.ts`：同一组输入分别走桌面装配与 Host 装配，逐字比较 systemPrompt、answerDeliveryPrompt，函数项按输入矩阵比较输出，允许不同的只有写死的 endpoint；Host `agent-graph.test.mjs`（含缺 ripgrep 时与桌面同样报错）；`codex-runtime.e2e.mjs` 断言真实 Codex 请求带产品提示 | 无 |
| 24 | Claude 与 Pi 的本机兼容代理 | `maker-host/anthropic-compat-proxy-host.ts`（`getClaudeEndpoint`） | 未做（M1，排在 3c、7b 之后；动手前先交依赖清单）。Host 的 Claude 与 Pi 直连账号网关，相当于桌面代理没起来时的退路；代理负责的按模型路由与字段适配（给非 Claude 模型去掉 Anthropic 专有字段）在 Host 上没有。要求：只监听本机回环、与桌面同一模块；接上后说明 `maker:session-background-activity` 一族与 `maker:claude-session-route:get` 两个通道的状态在 Host 上有了，记入 M2 可接清单；它写的路由登记是 Claude 用量记录的来源之一，与 2e 的分工写清 | — | 无 |
| 25 | 全局 Skill 投影、内置 Skill 发布、Codex 账号 CODEX_HOME 准备 | `authBoundaryQuarantine.ts` 的 owner 提交协议；`auth-adapters.ts:555-572`（`ensureSharedGlobalSkills`、`prepareBuiltInSkills`）、`:1373`（`prepareCodexGlobalSkillsLinks`）、`:2494`（`prepareCodexAccountHome`） | 未做（M1，紧挨第 11 步，与 Host 的 owner 提交一起；动手前先交切断清单）。Host 的 owner 提交不写投影边界状态；Host 里没有 `ensureSharedGlobalSkills`、`prepareCodexGlobalSkillsLinks` 的引用；Codex 独立账号直接用 `nativeSubscriptionAccount.configDir`，没有托管 Skill 投影与规则拷贝。Codex 上的内置与插件 Skill、home 级 Skill 链接都等这一行。内置 Skill 发布：Host 只读桌面最后一次发布的快照（m1-cp6），自己不调 `prepareBuiltInSkills`；迁移后桌面不再运行，内置 Skill 必然不再更新，因此这一行要让 Host 按同一 owner 提交协议发布内置 Skill。**迁移前必须完成** | — | 无 |

## 二、与桌面不同（已知差异）

| 项 | 桌面 | Host | 后果 |
|---|---|---|---|
| 启动前的就绪检查 | 等账号供应商发现屏障（`ensureCurrentAccountProviderReadiness`），等完再核对账号 | 等 Host 自己的 `listProviders`（把账号网关模型装进目录），等完再核对账号 | 等价；失败与换账号都用桌面的 `ACCOUNT_PROVIDER_NOT_READY` 拒绝 |
| 引擎模型清单刷新 | 9 处目录变更点即时刷新 | `listProviders` 应用模型之后、每次启动任务之前刷新 | 运行中的任务在其它目录变更后可能用旧清单，直到下一次启动 |
| 插件花名册在账号变更后 | 无此情形 | 返回空串 | 不会把上一个账号的插件写进新任务 |
| Fast 轴的初值 | bootstrap 时取任务行 | `prepareStartOptions` 取本次启动参数（来自任务行） | 效果相同 |
| 订阅 Fast 策略 | 总有 | Host 没有 Codex 运行时时不设置 | Host 正常都有 Codex，实际无差 |
| 自动复核（第 4 步之前） | 模型复核 | 退回人工确认 | 打断更多，不会更不安全 |
| Pi 思考开关记忆（M2 之前） | 读渲染层镜像 | 镜像为空 | 用模型默认值 |
| 用量记录（2e 之前） | 记录 | 不记录 | Host 期间的用量丢失；Host 侧 e2e 的「三张用量表行数」核对不适用 |
| 删除任务 | 界面删除把任务标为 `status='deleted'`（软删除），启动后的对账据此删掉它的保存点引用；桌面不在删除时立即删引用（`sessions.ts:689-693`，不可逆） | Host 的 `deleteSession`（`/api/sessions/delete`）调 `OwnerSessionStorage.delete` 物理删行；对账不认行缺失，保存点引用留在用户仓库 | 已定：随 M2 的删除通道改为与桌面相同的软删除与同一组清理；届时硬删除要么改成同一语义，要么只留给不面向用户的用途并写明调用方，并核实硬删除是否会让删除状态同步不到云端与其他设备。**迁移前必须完成** |
| 保存点标签的停用裁决 | 读桌面供应商服务（订阅池、`getDesktopSelectableBaseCatalog`、连接认领、Fast 投影） | Host 的 `publicViews` 用 `getActiveCatalog`、无订阅池与认领，两边视图不等价；Host 端口按「不可用」 | 标签走兜底，不发付费请求；`modelRouteGuardCore.ts` 已拆出、Host 未接，第 4 步连同等价视图接上，否则还原 |
| 代输入（sudo、ssh、git 密码提示） | 任务的 shell 带代输入的 askpass 环境变量，提示转给用户 | 同一个 `taskShellEnv`，但 Host 不启动 askpass，返回空 | 这些提示在 Host 任务里照命令行默认行为失败，不会转给用户；随代输入一起补 |
| 内置 ripgrep 的位置 | 打包版 `resources/tools/ripgrep`；开发时 `apps/ripgrep-bin/<平台>`（`pnpm install:ripgrep` 安装） | `hostRuntimeLayout().harnessRoot/ripgrep-bin/<平台>`：开发时就是同一个 `apps/ripgrep-bin/<平台>`；发布版是 `apps/host/scripts/build.mjs` 从 `apps/ripgrep-bin` 拷进 `resources/harnesses` 的同一个文件 | 同一个 rg 二进制；找不到时与桌面抛同一条错误（Pi 在构造时，Codex 在启动读 PATH 前缀时） |

## 三、Host 会写到 profile 之外的位置

这些是桌面已有的行为，对齐后改由 Host 进程执行。

| 写入 | 位置 | 何时 | 引入 |
|---|---|---|---|
| 共享项目 Skill 链接 | 任务工作目录（用户仓库） | 每次启动任务前两处 | m1-cp3b |
| 工作树租约 | 工作树运行时目录 | 任务运行期间 | 第 7 步（未做） |
| Git 保存点 | 用户仓库的 `refs/cindy/savepoints/<任务 id>` 及其对象，与桌面同名同位置 | 每个用户回合开始前与结束后 | m1-cp5e |
| 空文件夹初始化为 Git 仓库 | 任务工作目录（`git init`），仅在用户开了「自动初始化项目 Git」时 | 每个用户回合开始前 | m1-cp5e |
| Git 保存点对账删除 | 当前账号库里标记为已删除的任务在其仓库中的 `refs/cindy/savepoints/<任务 id>` | 账号库就绪后一次 | m1-cp5e |

## 四、移出 M1

| 项 | 移到 | 原因 |
|---|---|---|
| 供应商分组执行 | M3 | 任务会派到组内其它电脑执行，依赖 Device Link 的准入与转发（`docs/product-rules/provider-groups.md`） |
| 伙伴的会话环境（`resolveSessionEnvironment`）与伙伴工具集 | M3 | 伙伴任务在 M1 继续拒绝 |
| SkillHub 发现隔离（`scanLocalCustomizations`） | M2 | 只影响 Skill 列表界面，不影响任务运行 |
| Pi 包的安装与卸载 | M2 | 界面发起的写操作；运行只需读已安装的包 |
| 本地模式下运行任务 | M2 | 要先定本机登录或 API key 的认领方式与模型隔离规则 |
| 远程附件（OSS、点对点） | M3 | 手机远控的一部分 |

## 五、待办与未完整运行的验证

| 项 | 状态 |
|---|---|
| `apps/host/scripts/plugins-installed.e2e.mjs` | 未完整运行：缺 Playwright `chromium_headless_shell-1243`，`cdn.playwright.dev` 下载超时。自 Pi 桥修复起一直只跑到打开插件页面之前。网络恢复后安装并完整运行；在此之前引用它的验证都写「未完整运行」 |
| 桌面全量 vitest | 计划在 2e-2 后跑一次 |
| e2e 用量计数开关（只在测试里生效） | 第 9 步 |
| 通道清单重新生成（合并 main 后为 1466 个） | 在下一个确实需要的检查点提交，写明新增的 10 个通道及归类 |
| 带界面的验证 | 用户已允许（隔离沙箱、复用 host-usage）；2e 之前客户端模式只做导航与读取 |
| 基线失败：`apps/desktop/src/main/maker-ipc/__tests__/botLifecycleService.test.ts` 10 项 | 报 `SqliteError: no such table: mcp_app_view_states`（`deleteDeletedSessionViewStates`）。对照方法：把本分支改过的桌面源码换回合并的 main 版本（7eaf7788de）、删掉新增模块后单跑该文件，同样 10 项失败，判为 main 上原有问题。合并 main 后若自行恢复，删掉这一行 |
| 待定：随包插件在 Host 不标内置 | 桌面的 GhostManager 带 `isTrustedBundledId`（`resources/builtin-ghosts` 下 official、xd 两组种子的 id），根命名空间里的这些安装标 `builtin`；Host 的 `createHostGhostManager` 没有这个选项，任何安装都不标。后果：首方事实的内置官方分支在 Host 上不成立，随包插件按非内置判定（其 Skill 不标官方，依赖内置身份的首方特权被拒）。3c 之前就是这样；也因此 3c 的查找收紧在 Host 上实际只改变托管 Skill 清单。种子 id 从哪里来（Host 发布包不含 `builtin-ghosts`）需要方案，**迁移前必须有结论** |
| 待确认：gray-matter 在 Host 发布包里的形态 | 外置：`apps/host/scripts/build.mjs` 把所有第三方包设为外部依赖，按导入方位置解析后整包拷进发布目录的 `node_modules`（解析到仓库根 `node_modules/gray-matter`）。3c 之前已有 5 个导入方在 Host 的加载范围里（maker-core 的 customization-scanner、pinned-skill-invocation、memory/storage，桌面 skillhub/frontmatterValidation、cindy-brain/skillSlot），3c 没有新增依赖。证据用构建脚本原样截取的依赖插件对 `apps/host/src/main.ts` 跑 esbuild 得出（完整构建缺本机 Chromium） |
| 待查：客户端模式下的两个 GhostManager | 窗口进程与 Host 共用同一份 owner 目录，两边是否都会构造 GhostManager 并各自跑中断恢复（`recoverInterruptedMutationsSync`），有没有跨进程互斥。既有情况，不挡 3c |
| PR 正文须写：桌面提示前后哈希 | 重构前（7eaf7788de）与 m1-cp5c 之后，桌面三个引擎最终 systemPrompt / answerDeliveryPrompt 的 sha256 前 16 位相同：Claude `cb41d06b15ad7128` / `6084849accb05a45`，Codex 同 Claude（两份引擎补充提示目前为空），Pi `be3d281b8d83ea42` / `e6057c54763111fc`。结论：桌面提示前缀逐字节不变，缓存率不受影响 |
