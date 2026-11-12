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
| 4 | 自动复核、工具循环复核 | `auto-review-model-router.ts` → `autoReviewModelRouterCore.ts`；`oneShotCandidates.ts` → `oneShotCandidatesCore.ts`；`auxiliary-model-settings-store.ts`、`resolveAuxiliaryModelChain.ts` → 各自的 core | 已对齐（m1-cp11a 拆分，m1-cp11b 接上；方案 A：审核方定，用户未反对）：Host 用桌面同一条复核模型链：先是专用候选（网关 `cindy/auto-review`、ChatGPT 复核、luna），之后是用户自定义的辅助模型链；工具循环复核走同一条辅助模型链。Claude 拿两个复核，Codex、Pi 拿自动复核，Maker 拿工具循环复核，键名与桌面相同。授权上下文用桌面同一个解析器，Auto 分类器失败的降级协调器已接。复核模型全部不可用时结果是询问；工具循环复核不可用时照桌面放行疑似循环、保留次数上限。与桌面的差别见第二节 | Host `auto-review.test.mjs`（接线；本机模拟网关上复核成功、自定义链兜底；5xx、key 被拒、连接失败、无 key 无订阅、答复没有裁决、裁决不在取值内、自定义链也失败、超时，一律询问；未设授权上下文不复核；工具循环停下与不可用时继续；分类器降级只切 Auto 的 Claude 任务）、`input-queue.test.mjs`（授权上下文）、`model-access.test.mjs`（网关端点读取与 Host 同步一致）；desktop `hostAutoReviewParity.test.ts`（同一模拟网关上两边的请求序列与结果相同，桌面接线照抄 index.ts，有源码形状断言）、`hostAuxiliaryModelChainParity.test.ts`、`hostReviewContextParity.test.ts`；`codex-runtime.e2e.mjs`（Codex 档位的复核经回环代理、带令牌） | 无 |
| 5 | 视觉桥 | `vision-bridge/`：`vision-bridge-settings-store.ts` → `visionBridgeSettingsStoreCore.ts`；`vision-bridge.ts` → `visionBridgeCore.ts`；`pi-vision-bridge-env.ts` → `piVisionBridgeEnvCore.ts`；接线照 `maker-host/index.ts` | 已对齐（m1-cp15a 拆分，m1-cp15b 接上，`apps/host/src/agent/vision-bridge.ts`）：Host 读 profile 里同一个 `vision-bridge-settings.json`，不写也不删（读不懂时由进程级默认保留，见第二节）；Maker 拿钩子（层 B）、Pi 拿环境（层 C），端口与桌面相同：活动目录、任务的供应商、自定义供应商 key、账号网关 key 与端点、Host 出站 fetch；网关 key 读取函数和 controller 是进程级的（回环代理的层 A 与 Pi 环境读 controller），运行时关闭时读取函数不再返回 key、controller 清掉（更新的运行时已设自己的除外），Maker 关闭之后执行；提示事件照桌面 `broadcastVisionBridgeEvent` 的去重与文案，经事件中枢发出，客户端映射到 `MAKER_PUSH.EVENT`，不落库。视觉描述请求是付费请求，2e 之前不记录（见第 13 行）。`tool-result-image-descriptor.ts`：桌面只 import 未调用（m1-cp15b 再核对一次仍是这样），Host 不接，桌面开始调用时再接 | desktop `hostVisionBridgeParity.test.ts`（同一张图、同一组本机模拟视觉后端：请求序列与描述相同，主后端不可用时改走的备用后端相同、提示相同；Pi 环境相同；设置文件当前格式、读不懂、不存在三种两边读法相同，Host 那份逐字节不变；换 owner 后读不到上一个 owner 的网关 key 和 controller；提示与桌面源码逐行相同）；Host `agent/vision-bridge.test.mjs`（Maker 与 Pi 拿到同一个桥，controller 在图建成后设置、关闭时清掉，收尾在 Maker 关闭之后） | 无 |
| 6 | 快速模式 | Host 原有 `session-settings.mjs` | 已对齐；Fast 轴与 Pi 价格档同步（m1-cp2b） | Host `start-options.test.mjs`（含恢复任务读到 priority） | 无 |
| 6b | Claude 按模型的思考档位 | `resolveModelEfforts` | 已对齐（m1-cp2a） | desktop `engineModelResolvers.test.ts` | 无 |
| 6c | 思考开关写通道 | `register.ts` `SET_THINKING_ENABLED` | 未做（第 10 步） | — | 无 |
| 6d | Pi 思考开关记忆 | `newMakerDefaultsCache.ts` | 部分：读取已接（m1-cp2b）；镜像由渲染层推送，客户端模式下推给窗口进程，Host 一直为空，要等 M2 的推送通道 | Host `start-options.test.mjs` | 无 |
| 7 | 回合改动记录 | `turn-change-set/store.ts` | Host 现有的两类回合已对齐（m1-cp5e，m1-cp5f 补测）：队列里的用户回合与直发回合。写入：引擎侧写前捕获（Claude、Pi）、派发时开记录定锚点（`beginTurnChangeSetAtDispatch`）、事件流记 Codex 原生改动（`noteTurnDiffEvent`，远程标记与桌面同一表达式）。落盘：done 与终止性错误时 `finalizeTurnChangeSet`，判定按 `sessionEventPreparation.ts` 手写（非共用代码），四种终态都有测试。清理：未派发、绑定实例关闭、同一任务换实例、删除任务。桌面另有这些发起回合的路径各自带着开记录与撤销的成对调用，Host 上都还没有：send_to_session（`register.ts:12348-12382`）、hook（`hook-control/session-runner.ts:1638`、1655、1675）、IM（`im/shared/turnRunner.ts:1948`、1961、1985）、定时任务（`scheduler-host/runner.ts:2278`、2334、2360，经 `createAutomationUserTurnGitBaselineHooks`）、goal-host（`controller.ts:2540`、2550、2591）、learn-host（`controller.ts:600`）、Orca 直发（`orcaInterAgentDispatcher.ts:878`、892，`beginDirectTurnChangeSet`）。哪条路径接到 Host，必须带上自己的这一对；查看与撤销的界面入口随 M2 | Host `input-queue.test.mjs`（锚点落盘、四种终态、先后顺序、未派发清理、实例关闭与替换）；`agent-graph.test.mjs`（引擎侧） | 无 |
| 7b | Git 保存点与文件回退 | `git-snapshot-host.ts` → `gitSnapshotHostCore.ts` | 部分（m1-cp5e）：保存点已接。派发前基线（队列钩子与直发钩子）、回合结束改后快照（`onTurnEnd`）、未派发撤回（`onTurnAbort`）、绑定实例关闭（`onSessionClosed`）、账号库就绪后的已删除任务引用对账，都与桌面同一份代码。未接：回退入口 `maker:rewind:preview`、`maker:rewind:commit` 随 M2 的界面通道一起接。标签：桌面用引擎自己的一次性调用（`maker.oneShot`）起标签，派发前经路由守卫做停用裁决，守卫读桌面供应商服务的视图。Host 没有等价的视图，标签一律用确定性兜底（如「改动 a.txt」），不发付费请求；路由守卫端口按「不可用」。等价的供应商视图随 M2 的模型通道做，届时再拆路由守卫并接真实调用（m1-cp12 已把之前的拆分还原，`model-route-guard-live.ts` 与 main 相同） | Host `git-snapshot.test.mjs`（真实临时仓库）；`input-queue.test.mjs`（钩子顺序）；desktop `hostGitSnapshotChain.test.ts`（桌面建一轮、Host 接着建一轮：同一引用按序排列，尝试记录同一 owner 目录） | 无 |
| 8 | 工作树租约 | `worktree/runtimeLeases.ts` | 未做（第 7 步） | — | 无 |
| 9 | Codex 产品提示标记 | `maker-host/session-storage.ts` | 已对齐（m1-cp5a） | Host `agent-graph.test.mjs`；`codex-runtime.e2e.mjs` 数据库往返 | 无 |
| 10 | 读图钩子、电脑操作防护、Bash 并发闸门 | `claudeHooks`（`maker-host/index.ts`） | 已对齐（m1-cp15b）：Host 的 ClaudeCodeAgent 用同一组共用模块拼出同样的 claudeHooks；并发闸门每个运行时一个（桌面每个 Maker 一个），上限每次准入现读代理资源设置；电脑操作防护按本 owner 的 computer 插件开关给理由 | Host `agent/claude-hooks.test.mjs`（事件表与桌面拼法相同；读图钩子放过非图片；上限为 1 时第二个 Bash 排队、第一个结束后放行；键鼠模拟被拒，开、关两种理由；与 `index.ts` 逐行相同的源码形状断言） | 无 |
| 11 | Codex 任务的记忆 | `apps/host/src/agent/memory.mjs:70` TODO | 未做（第 7 步）。m1-cp5c 起 Codex 的 `makerMemoryEnabled` 按用户设置读取，与桌面相同；第 7 步核实 Codex 经 MCP 桥实际拿到记忆工具 | — | 无 |
| 12 | 本机附件 | `normalizeAttachments.ts` | 部分：Codex 本机路径有自动证据；Claude、Pi 与输入框粘贴路径未验证（第 9 步） | `codex-runtime.e2e.mjs` | 无 |
| 13 | 用量与花费记录 | `maker-ipc/session*TurnUsage.ts` 与四个广播模块 | 未做（2e，M1 最后）。Host 期间不记录用量，事后补不回来，必须在迁移前完成。2e 的边界还包括：复核调用的用量（第二节）；视觉桥的视觉描述请求（第 5 行）；Codex 作废后“需要恢复”的账号接口确认（桌面 `verifyRecoveryWithAccountRpc`，由用量读取发起），2e 完成时对照测试补上这一步 | — | 无 |
| 14 | 账号与供应商就绪、provider 冻结、model interface | 桌面启动钩子第 ③④⑤ 步 | 已对齐（m1-cp2b，就绪检查方式见第二节） | Host `start-options.test.mjs` | 无 |
| 15 | 订阅 Fast 策略、价格档 | 桌面启动钩子第 ⑥⑩ 步 | 已对齐（m1-cp2b） | Host `start-options.test.mjs` | 无 |
| 16 | 可选目录（账号过滤、订阅池投影） | `getDesktopSelectableCatalog` | 已对齐（m1-cp2c） | desktop `subscriptionPoolCatalog.test.ts`；Host `model-context.test.mjs` | 无 |
| 17 | 共享项目 Skill 链接 | 桌面启动钩子第 ⑬ 步与 `onBeforeStart` | 已对齐（m1-cp3b）；会写工作目录，见第三节 | Host `start-options.test.mjs` | 无 |
| 18 | /learn 捕获 | `learn-host/captureInvocation.ts`；`maker-ipc/register.ts` 的 `captureCindyLearnInvocation` | 部分（m1-cp10）：捕获已接；/learn 在 Host 上仍不可用，依赖第 22 行与第 27 行。Host 的回合执行本来就走共用的 `createMakerSendTransaction`，补上同一个 `createCindyLearnInvocationCapture`，依赖逐项照桌面（内置 Skill 读桌面最后一次发布的快照、Cindy 的 Skill 启用设置、机器人会话检查、按引擎列 Skill）。实测：Claude（`/cindy:learn`、`/learn`）与 Pi（`/skill:learn`、`/cindy:learn`）能捕获，引擎钉住已发布的内置 learn 文件，这条用户消息记下同一份快照；Codex 要等 Skill 投影（第 25 行）才列得出内置 learn，在那之前不捕获。快照只由 Host 自己写，客户端塞进输入的同名字段既进不了消息记录，也改变不了钉住的文件。消费方 `start_skill_learning`（cindy_helper，第 22 行）与 Learn 宿主（第 27 行）都还没有，所以 /learn 只是钉住了正确的文件，实际跑不起来。依赖第 25 行：迁移后内置 learn 不再更新。**迁移前必须完成** | Host `agent/learn-capture.test.mjs`（真实发布与 Host 引擎列 Skill；各引擎、各否定条件；列出的 Skill 路径全部在夹具目录内）、`agent/learn-send.test.mjs`（经输入队列与共用事务：钉住的文件与消息记录；伪造字段两层断言）；桌面 `learn-host/__tests__/hostLearnCaptureParity.test.ts`（桌面与 Host 的依赖在同一 profile 上逐场景给出同一份快照，列 Skill 的参数也相同） | 无 |
| 19 | 引擎专有项（Claude、Codex、Pi 各一组） | maker-host 构造点 | 未做（第 8 步） | — | 无 |
| 20 | 诊断：进程登记、cc-debug、出口路径事实 | maker-host 构造点 | 未做（第 7 步） | — | 无 |
| 21 | 启动时清掉从终端继承的 Anthropic 凭据与端点变量 | `main/index.ts` `stripSensitiveAnthropicEnv` | 已对齐（m1-cp5b）：`main.ts` 第一个导入执行同一步，保留导入用的 Claude 配置目录 | Host `boot-env.test.mjs` | 无 |
| 22 | Cindy 内置工具服务 | `mcp-integrations/mcp-providers.ts` `createLiziMcpProviders` | 未做，归属已定：M1 做 cindy_helper 里任务相关的一组、cindy_lsp、cindy_ssh（排在 M1 靠后，动手前先交分组清单）；M2 做设置类、cindy_scheduler、cindy_docs、inputHandoff；M3 做伙伴、Orca、IM 机器人、群聊记录、android、sessionImport、远程任务状态。Host 现在只有 browser、computer、cindy_memory 和插件网关。系统提示与桌面逐字相同、不裁剪，所以在对应工具补齐之前，Host 任务会被提示引导去用尚不存在的工具；**这一行必须在开放迁移前清零** | — | 无 |
| 23 | 引擎运行时配置（`runtimeConfig`） | `maker-host/runtime-configs.ts`；`pi-host.ts` `buildDesktopPiRuntimeConfig` → `runtimeConfigsCore.ts` | 已对齐（m1-cp5c）：产品系统提示、回答呈现提示、`behaviorFlags`、`taskShellEnv`、压缩阈值、换模型时的上下文评估、子代理模型、记忆设置（每次读取）、`userDataPath`、内置 ripgrep。Host 的 endpoint 仍是账号网关，见第 24 行；代输入的环境变量在 Host 上恒为空，见第二节 | desktop `hostRuntimeConfigParity.test.ts`：同一组输入分别走桌面装配与 Host 装配，逐字比较 systemPrompt、answerDeliveryPrompt，函数项按输入矩阵比较输出，允许不同的只有写死的 endpoint；Host `agent-graph.test.mjs`（含缺 ripgrep 时与桌面同样报错）；`codex-runtime.e2e.mjs` 断言真实 Codex 请求带产品提示 | 无 |
| 24 | Claude 与 Pi 的本机兼容代理与订阅桥 | `maker-host/anthropic-compat-proxy-host.ts` → `anthropicCompatProxyHostCore.ts`（`getClaudeEndpoint`）；`anthropic-responses-bridge-host.ts` → `anthropicResponsesBridgeHostCore.ts`；`pi-subscription-websocket.ts` → `piSubscriptionWebSocketCore.ts` | 已对齐（24a 代理，24b 订阅桥）。Host 的 Claude 与 Pi 经同一模块的回环代理（只监听 127.0.0.1），按模型路由、字段适配与恢复规则与桌面相同；自定义供应商由直连改为经代理；Pi 登记会话 token；任务的供应商与思考档位登记与桌面相同。24b：ChatGPT 与 SuperGrok 订阅（Claude 走 HTTP，Pi 走 HTTP 与 WebSocket）经与桌面同一份订阅桥，凭据来自 profile 自己的登录：ChatGPT 读 profile 的 codex-home 与独立账号目录，SuperGrok 读 Host 的 grok 登录；桥的凭据缓存在 Codex 登录、登出、作废时清空，与桌面相同；上游判定 ChatGPT 登录被撤销时按第 26 行作废，独立账号经账号服务作废，SuperGrok 经 grok 恢复流程。Codex 子代理读 OAuth 改为经同一个桥（桌面 `readSubagentOAuth`）。Claude 认证与桌面适配器逐个分支相同，订阅账号按桌面 `subscriptionAccountState`（SuperGrok 读自己的登录，独立 Claude 账号报已停用）。订阅桥属于 Codex 运行时，没有 Codex 运行时时见第二节。`maker:session-background-activity` 一族与 `maker:claude-session-route:get` 的状态已在 Host 上具备，见第六节。与 2e 的分工：代理按桌面的时机写路由登记、挂子代理用量与余量观察器；读登记写用量表、注入余量 listener 归 2e | Host `agent/claude-proxy-runtime.test.mjs`（入站门、占位常量、订阅交给桥、无 Codex 运行时时拒绝、关闭清理、字段剥离、分类器失败）、`agent/native-auth.test.mjs`、`agent/agent-graph.test.mjs`、`scripts/claude-proxy.e2e.mjs`（真实 Claude Code：网关、自定义供应商、ChatGPT 订阅经桥到本机模拟的 ChatGPT 后端并带 profile 的登录、上游撤销后作废且下一次请求不再外发）；桌面 `hostClaudeAuthAdapterParity.test.ts`（桌面与 Host 的 Claude 适配器在 来源 × 凭据模式 × 模型 × 登录事实 的 4096 格里状态与环境变量都相同，唯一差别是占位常量对运行时密钥）、`anthropicCompatProxyStartup.test.ts`、`anthropicCompatProxyInboundPort.test.ts`、`hostRuntimeConfigParity.test.ts`（例外清单为空）；包 `server-inbound-admission.test.ts` | 无 |
| 25 | 全局 Skill 投影、内置 Skill 发布、Codex 账号 CODEX_HOME 准备 | `authBoundaryQuarantine.ts` 的 owner 提交协议；`auth-adapters.ts:555-572`（`ensureSharedGlobalSkills`、`prepareBuiltInSkills`）、`:1373`（`prepareCodexGlobalSkillsLinks`）、`:2494`（`prepareCodexAccountHome`） | 未做（M1，紧挨第 11 步，与 Host 的 owner 提交一起；动手前先交切断清单）。Host 的 owner 提交不写投影边界状态；Host 里没有 `ensureSharedGlobalSkills`、`prepareCodexGlobalSkillsLinks` 的引用；Codex 独立账号直接用 `nativeSubscriptionAccount.configDir`，没有托管 Skill 投影与规则拷贝。Codex 上的内置与插件 Skill、home 级 Skill 链接都等这一行。内置 Skill 发布：Host 只读桌面最后一次发布的快照（m1-cp6），自己不调 `prepareBuiltInSkills`；迁移后桌面不再运行，内置 Skill 必然不再更新，因此这一行要让 Host 按同一 owner 提交协议发布内置 Skill。**迁移前必须完成** | — | 无 |
| 26 | Codex 原生登录被服务端作废 | `auth-adapters.ts` `DesktopCodexAuthAdapter.invalidate`（实例隔离分支）与 `maker-host/index.ts` 的 `setOnLogoutSuccess`、`setOnInvalidatedBroadcast` | 已对齐（24b；登录、登出收口 m1-cp9），迁移来的共享登录也已对齐（m1-cp13；用户 2026-11-13 决定，原话「和桌面完全一样」）：安装版 Host 像已打包桌面一样与系统 Codex 登录对账，链接、认领、作废后在系统重新登录时自动恢复（`codex-system-login.ts`）；与桌面的差别见第二节。原为既有缺口，24b 补上：之前 Host 的 Codex 适配器没有 `invalidate`，服务端判定登录失效后不落标记、不清凭证。安装版 Host 读系统 `~/.codex/auth.json` 并把 profile 的 codex-home/auth.json 链接过去（与已打包桌面相同），源码运行不读系统登录；标记按检测到的凭据范围写，共享系统登录时记恢复 owner；迁移来的 profile 里 codex-home/auth.json 若是指向系统登录的链接，Host 平常经这个链接读写系统那份登录（订阅桥刷新令牌、Codex 自己刷新都是），与桌面相同，作废只删 profile 里的链接，外面那份文件不变。能指明被拒凭证的失效：凭证代次与当前 auth.json 一致才按被拒的那份记标记；文件换了（inode 不同）或登录进行中不动；同一文件就地改写时记不带指纹的标记、压住当前这份（m1-cp15a 起，与桌面相同；代次用桌面同一个解析函数读）。顺序与桌面相同，标记 → 解除授权 → 删 auth.json → 退役本机 Codex 进程与代理注入 → 删模型缓存 → 通知界面并让 Pi 的 MCP 桥失效。子进程没说明是哪一份凭证的失效（maker-core 目前都报这一种）：与桌面相同，凭证原样保留，写抑制标记，登录进行中或显式断开后不动；为此账号登录服务加了只读的 `isCodexAccountLoginActive`（共用模块，桌面不调用）。两种都与桌面同一份标记位置与格式，写不进时同桌面改写撤销标记兜底；m1-cp15b 按桌面 invalidate 的分支对应表补齐五处：只有独立账号的 providerId 不作废（网关、自定义供应商的任务报失效时照样作废原生登录）；去掉 Host 独有、无调用方的被拒令牌入参；收口中途 owner 变了就在桌面同样的位置停下；codex-home 本身是或链接到 `~/.codex` 时不删 auth.json；收口结束时重读标记，仍是这次的原因和范围才播报。m1-cp16 按桌面显式登出的分支对应表对齐 Host 的原生登出：取消进行中的登录，写桌面同一个持久断开标记（写不进就登出失败），保留 auth.json（共享登录的链接留在原地，对账由标记停住），退役本机进程，删模型缓存，结束前再写一次标记，最后撤销授权；每一步之前查 owner，第二次登出并入第一次，登出期间开始的登录等它结束，登出期间完成的登录不绑定。Host 不再经账号服务的 `logoutCodexAccount`，不再写账号服务自己的 `disconnected` 文件（原生连接只有登录成功后才读它，那时已被删除）。随后与桌面相同：profile 里的 auth.json 已经不在时，迟到的失效照样重新记作废并播报，登录占着这段空窗时不动；凭据范围读不出时用标记记下的上一次范围（桌面重启后同样从标记恢复）；作废时登录正在进行、两次写盘都失败、日志先后三处不改，见第二节；读登录态时与桌面一样报出作废原因，直到重新登录。登录成功、登出、作废三处收口逐步对应桌面 `setOnLoginSuccess`、`setOnLogoutSuccess`、`setOnInvalidatedBroadcast`（m1-cp9 补上登录与登出：退役所有持本机登录的 Codex 进程、清代理注入、发路由变化、让 Pi 的 MCP 桥失效） | desktop `hostCodexSystemLoginParity.test.ts`（每个场景两边各建一份、各用一个假 HOME：8 种继承登录的作废与系统重新登录组合、全新 profile 链接认领、无系统登录、硬链接换符号链接、Cindy 里登录的保留、账号不同的旧版显式归属、同账号本地文件重链、显式断开、登录进行中与登录中途开始、owner 中途变更、同进程与重启、getAuthEnv 三种模式、启动时单次对账、恢复只给原 owner、遗留硬链接的作废、共享登录就地改写后的作废、两种 relink 失败；比较登录态、链接形态、绑定与标记，假系统登录的字节、inode、修改时间不变）；Host `agent/codex-system-login.test.mjs`（三种运行方式的系统登录路径）、`agent/codex-invalidation.test.mjs`；桌面 `hostCodexInvalidationParity.test.ts`（代次与当前文件不一致的三种情形两边结果相同；双向：两种失效下 Host 作废后桌面读到的与桌面自己作废后相同；桌面作废并重新登录后 Host 先读到作废原因、再读到已登录；HOME 为空目录且跑完仍为空）；Host `agent/codex-auth-boundary.test.mjs`（三处收口逐步对照桌面；登出与并行的登录、收口中途改写标记的作废）；m1-cp16 登出的对照（cp13 的“显式断开”一例改跑 Host 自己的登出；先作废再登出、保留 auth.json 删模型缓存、作废收口中登出两边都不播报、登出后在 Cindy 里重新登录，Host 经自己的账号服务和假的 Codex CLI 登录；auth.json 已不在时的迟到失效）；m1-cp15b 五处补齐的对照（`hostCodexInvalidationParity.test.ts`：网关、自定义供应商、独立账号三种 providerId，收口中途换 owner，收口中途被登录取代不播报；`hostCodexSystemLoginParity.test.ts`：codex-home 链接到假系统 `~/.codex` 时系统文件字节、inode、修改时间不变；Host `codex-invalidation.test.mjs`：入参与 maker-core 上下文一致、没有系统登录路径时同样不删 `~/.codex/auth.json`、标记被改写成别的原因或范围时不播报）、`codex-invalidation.test.mjs` 的链接用例（指向 profile 外的硬链接、符号链接，两种作废，外面的文件内容、inode、修改时间不变） | 无 |
| 27 | Learn 宿主 | `learn-host/`（`controller.ts`、`staging.ts`、`apply.ts`、`runStore.ts` 等，约 4200 行） | 未做，归属待定：到第 22 行交 cindy_helper 分组清单时与 `start_skill_learning` 一起定，届时说明哪些部分依赖 Electron 或窗口、apply 与 Skill 投影（第 25 行）的先后、它写到 profile 之外的位置。**迁移前必须有结论** | — | 无 |

### 第 26 行：Codex 原生登录的对齐记录与索引

三张分支对应表（每个分支：桌面做什么、Host 做什么、哪条测试覆盖）：

- `docs/host/codex-system-login-branch-map.md`：与系统 Codex 登录对账（链接、认领、恢复 owner、读登录态、spawn 环境）；
- `docs/host/codex-invalidation-branch-map.md`：服务端作废（入口、未归属分支、归属分支、收口、播报）；
- `docs/host/codex-logout-branch-map.md`：显式登出。

各检查点对齐的内容：

| 检查点 | 内容 |
|---|---|
| 24b | Host 的 Codex 适配器接上服务端作废：实例隔离分支和未归属分支，同一份标记位置与格式；标记写不进时写撤销兜底；收口顺序与桌面相同 |
| m1-cp9 | 登录、登出、作废三处收口钩子（退役本机 Codex 进程、清代理注入、发路由、让 Pi 的 MCP 桥失效） |
| m1-cp13 | 安装版 Host 与系统 Codex 登录对账：链接、认领、恢复只给原 owner、按检测到的凭据范围记标记；三种运行方式的系统登录路径 |
| m1-cp14 | 引擎上报、共享系统登录、没有凭据代次时记 unknown 范围；订阅桥读令牌前和登录之后的对账；“需要恢复”标注的实际效果 |
| m1-cp15a | 凭据代次与当前文件不一致：换 inode 或登录进行中不动，就地改写时不带指纹压住当前文件；代次用桌面同一个解析函数 |
| m1-cp15b | 只跳过独立账号的 providerId；去掉无调用方的被拒令牌入参；收口中途换 owner 就停下；codex-home 本身是或链接到 `~/.codex` 时不删 auth.json；收口结束时仍是这次的原因和范围才播报 |
| m1-cp16 | 显式登出照桌面：持久断开标记、保留 auth.json、删模型缓存、最后撤销授权、与登录和作废并行时以登出为准；auth.json 已不在时迟到的失效照样重新记作废；凭据范围读不出时用标记里记下的范围 |

剩下的差异（都在第二节，不改代码）：
- 差4：作废时原生登录正在进行；
- 差8：标记和撤销兜底都写不进时的具体后果；
- 差9：日志先后。

挂到后面的事项：
- 显式登出时的订阅池，随 M2 的供应商视图；
- 作废后“需要恢复”的账号接口确认（`verifyRecoveryWithAccountRpc`），随 2e（第 13 行）。

## 二、与桌面不同（已知差异）

| 项 | 桌面 | Host | 后果 |
|---|---|---|---|
| 启动前的就绪检查 | 等账号供应商发现屏障（`ensureCurrentAccountProviderReadiness`），等完再核对账号 | 等 Host 自己的 `listProviders`（把账号网关模型装进目录），等完再核对账号 | 等价；失败与换账号都用桌面的 `ACCOUNT_PROVIDER_NOT_READY` 拒绝 |
| 引擎模型清单刷新 | 9 处目录变更点即时刷新 | `listProviders` 应用模型之后、每次启动任务之前刷新 | 运行中的任务在其它目录变更后可能用旧清单，直到下一次启动 |
| 插件花名册在账号变更后 | 无此情形 | 返回空串 | 不会把上一个账号的插件写进新任务 |
| Fast 轴的初值 | bootstrap 时取任务行 | `prepareStartOptions` 取本次启动参数（来自任务行） | 效果相同 |
| 订阅 Fast 策略 | 总有 | Host 没有 Codex 运行时时不设置 | Host 正常都有 Codex，实际无差 |
| 没有 Codex 运行时时的订阅路线 | 总有订阅桥 | 订阅桥由 Codex 运行时建立；找不到 codex 可执行文件时，Claude 与 Pi 的 ChatGPT、SuperGrok 路线在本地明确拒绝（403 `subscription_route_unavailable`），不落到网关 | Host 正常都有 Codex，实际无差 |
| Claude 认证在系统加密不可用时 | 返回 `no_encryption`（safeStorage） | 不做这一步：Host 的凭据在它自己的凭据库里 | 无对应情形 |
| 自动复核与工具循环复核 | 同一条复核模型链 | 同一条链，三处不同：1. Host 没有本机模型运行时（Ollama），这类候选失败后跳过；2. 旧版工具模型档位链（`getUtilityModelChainProfiles`）两条复核路径都读不到，Host 的端口直接报错并写明原因；辅助模型链的其他用户接到 Host 时，要换成真实实现；3. 自定义供应商 key 从 Host 凭据库读（与 Pi 鉴权同一实现），不含桌面安装型 BYOK 供应商的凭据 | 1、3 只在用户把这类模型放进自定义链时出现：该候选不可用，落到下一个，全部不可用就询问 |
| 辅助模型设置文件 | 读 owner 目录的 `auxiliary-model-settings.json`；遇到旧格式会迁移、写回并写迁移标记；读不懂的文件删除 | 同一份代码读同一个文件，Host 不写也不删：两个旧命名空间判定恒为 false，旧格式只在内存里用迁移后的结果，不读未分 owner 的旧 voice 文件；读不懂的文件保留，同样按自动链处理 | 客户端模式下窗口进程与 Host 共用 owner 目录，窗口进程是这个文件唯一的写入方，避免跨进程先读后删、删掉用户刚存的设置。窗口进程重置设置的瞬间，Host 可能读到半截迁移标记，把旧 voice 文件里用户以前选过的链用一次，下次读取恢复；不会落到网关 |
| 读不懂的用户设置文件 | 经 `createOverrideSettingsFile` 读的设置文件读不懂（解析失败、超过大小上限）时删掉，按默认值继续；有 13 个 store 自己设了保留 | Host 启动时（紧接 `boot-env.ts` 的 `boot-settings.ts`）设一个进程级默认：凡是没自己设这一项的 store，读不懂时一律保留文件、按默认值读、拒绝普通写入（重置仍可删），根不是对象的文件也算读不懂；store 自己设的值优先。桌面从不设，行为不变（m1-cp15a） | 原则：Host 和窗口进程共用目录期间，Host 不删任何它读不懂的用户设置文件。Host 闭包里经它读的设置有 23 个，原先会删的 10 个（停用模型与供应商、子代理模型、Git 安全、记忆、代理资源、浏览器后端、本地 Codex 供应商展示、静默加密重试、应用会话、辅助模型）和视觉桥设置（m1-cp15b）都按这个默认处理。代价：这类文件坏掉时，Host 上对它的写入会报错，直到修好或重置。不经这个函数的两处：`device-link-settings.json` 也读同一个默认（m1-cp15b）：保留时按默认值（全部关闭）读，写入被拒；它没有“重置”入口，恢复办法是修好或删掉这个文件，或者由桌面（不设默认，读到坏文件照旧删除）处理；不保留的话删掉会清空撤销过的控制端名单，用户以后重新打开远程控制时等于重新放行。Codex 作废标记坏了就删，是认证状态，与桌面相同，不改 |
| 自动复核的授权上下文 | 插件委托任务按其登记的范围复核 | 同一个解析器；插件委托在 Host 上还没有投递，正在运行的输入一旦标成插件委托（包括客户端自选的 client id），就失败时关闭，复核变成询问 | 插件委托的授权上下文随 M2 或 M3 的投递一起接 |
| Auto 分类器失败的降级 | 代理观察到分类器失败后，由协调器把该任务的复核切到 Cindy（register.ts） | 同一个协调器（m1-cp11b） | 无差。未实测：原生分类器只在 Claude 订阅登录（oauth-bearer）的任务里出现，真实触发需要真实订阅登录；接线由 `auto-review.test.mjs` 覆盖 |
| 安装型 BYOK 供应商的凭据 | `readCustomProviderKey` 先读安装型 BYOK 供应商的凭据，再读自定义供应商 key | Host 的 `providerConfig.readKey` 只读自定义供应商 key，不含安装型 BYOK 凭据 | 用这类供应商跑任务时 Host 缺 key；辅助模型链里放了这类模型时，该候选不可用（落到下一个，全部不可用就询问）。**迁移前必须对齐**；随等价的供应商视图一起放在 M2 的模型通道 |
| 复核调用的用量（2e 之前） | 记录 | 不记录 | Host 上复核调用的用量在 2e 之前不记录；2e 的边界表要把它算进去 |
| 订阅余量（2e 之前） | 代理读订阅余量响应头，交给注入的 listener 落库并广播 | 观察器照挂，不设 listener | 不记录订阅余量；2e 接上 |
| 回环代理的入站凭据 | 代理现有的会话与受邀者检查 | 在同样的检查之外，Host 的回环代理要求入站凭据：Pi 会话 token、当前网关 key，或运行时发给自家 Claude Code 的密钥（每个运行时随机 32 字节，只在内存，经环境变量交给 CLI，owner 变更时更换）；其余一律 401，公开的占位常量不算凭据 | 多一道入站门。受邀者路由令牌也是合法入站凭据，Host 现在不接远程任务所以没放行；**M3 接远程任务时要加进放行名单**，否则受邀者请求会被挡掉。m1-cp9 起这三类放行保持不变：经 `ANTHROPIC_CUSTOM_HEADERS` 只认密钥的收紧，已验证主请求与子代理请求带头，分类器与 count_tokens 两类未能触发；第 4 步（m1-cp12）结论：这两类请求只在 Claude 订阅登录的任务里出现，验证需要真实的订阅登录（假登录在 macOS 上可能读写系统钥匙串），M1 内不做，保持三类放行 |
| Codex 回环代理的入站凭据 | 代理现有的路由与受邀者守门 | 在同样的检查之外，Host 的 Codex 回环代理（主代理、各模式的控制面代理、自定义上下文与受邀者代理）要求入站凭据：本运行时发给自家 Codex 进程的令牌（每个运行时随机 32 字节，只在内存，经环境变量交给 Codex，启动参数里只有变量名，常量时间比较，转发前删掉，上游看不到）；其余一律 403，不回 401（Codex 把 401 当登录过期，会去刷新并作废登录）。任务自己的工具命令能读到这个变量；令牌只在本运行时的回环代理上有效，运行时关闭即失效 | 多一道入站门。受邀者任务的 Codex 也由 Host 本机拉起、同样带令牌，**M3 接远程任务时核对** |
| 与系统 Codex 登录对账 | 已打包桌面（正式版与个人版，个人版是打包后安装的版本）读 `~/.codex/auth.json`；未打包桌面只认 Release profile 的登录，或用它的只读快照 | 安装版 Host 读 `~/.codex/auth.json`，与已打包桌面同一条路；源码运行（开发、测试、沙箱）一律不对账，识别不了按源码运行；测试只能用 `CINDY_HOST_TEST_SYSTEM_CODEX_AUTH` 给一个隔离 HOME 里的绝对路径，安装版忽略它 | 对应桌面“开发版不碰系统登录”；host-usage 沙箱里迁移带来的那条链接保持原样，不用它跑这部分 |
| 作废后“需要恢复”的收口 | 用量读取里的账号接口调用成功后清除（`verifyRecoveryWithAccountRpc`） | Host 在 2e 之前没有这次调用，标注一直保留；在 Cindy 里重新登录也不清除（桌面登录后同样保留，由随后的账号接口调用清除；m1-cp14 这里写成“保留到显式登录”是错的，m1-cp15a 更正）。实际效果：用户在系统里重新登录之后，这份登录在 Host 上可用（读登录态为已登录、OAuth；任务启动拿到环境；订阅桥读到新令牌），只是带“需要恢复”的标注；maker-core 与 Host 都不因这个标注拦截任务 | 只是标注；2e 接上用量读取时一起接，见第 13 行（`codex-system-login.test.mjs`） |
| 认领绑定之后的收口 | 重置 openai 模型自动刷新冷却、补拉 Codex 模型、让 Pi 环境失效（`setOnOAuthBindingClaimed`） | 只让 Pi 的 MCP 桥失效 | Host 没有前两套机制 |
| 标记写不进时的进程内兜底 | 进程内继续抑制（`memoryOnlyInvalidatedSystemCredential`），直到重启 | Host 每次读标记，不留进程内状态；标记写不进时走已有的撤销授权兜底 | 与桌面重启之后相同 |
| 作废时没有被拒凭据的指纹、凭据为共享系统登录 | 没有凭据代次，或文件已就地改写：引擎上报（带上下文）时记 unknown 范围；订阅桥上报（不带上下文）时按检测到的范围 | 相同（m1-cp14 起没有代次的情形，m1-cp15a 起就地改写的情形；之前用当前文件的指纹记 system-shared） | 无差（`hostCodexSystemLoginParity.test.ts` 两种上报、共享登录就地改写） |
| 作废时凭据代次与当前文件不一致 | 文件身份（dev、inode）变了：外部原子替换，不动；登录取消窗口开着：登录还在收尾，不动；同一文件就地改写或文件没有身份：不带指纹的标记压住当前这份，照常收口 | 相同（m1-cp15a 起；之前一律当旧代不动）。Host 的“登录取消窗口”是原生连接的登录进行中（账号服务 `isCodexAccountLoginActive`，读不出来按进行中）：从登录开始到账号服务提交新凭据；桌面的窗口从开始登录一直开到绑定、清标记之后。Host 登录在暂存目录里完成、rename 提交，新凭据总是新 inode，两边窗口长短的差别只影响就地改写 | 无差（`hostCodexInvalidationParity.test.ts` 三种情形：就地改写、换 inode、登录进行中就地改写）。生产上引擎目前只报未归属的失效、订阅桥不带代次，这条路径暂时只有测试走到 |
| 标记与撤销兜底都写不进时的具体后果 | 进程内压住，直到重启 | Host 不留进程内状态，结果与桌面重启之后相同：未归属的失效保留 auth.json，Host 下一次起 Codex 仍会用被服务端拒绝的凭据，会反复失败；共享系统登录的作废删掉链接之后，下一次对账可能把被拒的系统文件链回来 | 只在两次磁盘写都失败时出现（作废分支表差8，不改代码） |
| 作废时原生登录正在进行 | 归属作废先取消进行中的登录并等它结束，再收口：登录被取消，界面显示作废 | 不取消登录：登录照常提交新凭据，读登录态为已登录、带“需要恢复”标注（作废分支表差4，选乙） | 只在被拒的仍是当前文件、用户正好在登录时出现；Host 的结果对用户无害 |
| 显式登出时的订阅池 | 登出时把 openai 订阅池标成已断开，并中止池内正在进行的登录（`subscription-accounts/runtime.ts` 的 `disconnectSubscriptionPool`） | Host 不做这一步：这段逻辑在带 Electron 的订阅池运行时里，Host 只有底层读写的 `store.ts`，不在 Host 里另写一份 | 客户端模式下窗口进程读到的 openai 订阅池在 Host 登出后仍是“已连接”。随 M2 的供应商视图一起做（审核方决定，m1-cp16） |
| 客户端模式下两个进程同时对账 | 单进程 | 窗口进程本地读 Codex 登录态时（用量、供应商服务、Pi 鉴权）也会对账，与 Host 指向同一个 codex-home/auth.json。relink 是同一目标的原子 rename，两边最终形态一致；一边作废（删链接、写标记）时另一边同时重新链接，另一边内存里没有抑制，可能把链接建回来，但两边读登录态都按标记报作废 | 留给 M4 与交接任务一起处理 |
| 代理的进程内登记在 owner 变更时 | 路由登记随 app 生命周期常驻 | 代理运行时关闭时，按它服务过的任务 id 清掉路由登记与后台活动；Pi 会话 token 用同一撤销函数 | Host 比桌面严：Host 跨 owner 长期运行，M2 还会把读路由登记的通道开出去 |
| Pi 思考开关记忆（M2 之前） | 读渲染层镜像 | 镜像为空 | 用模型默认值 |
| 用量记录（2e 之前） | 记录 | 不记录 | Host 期间的用量丢失；Host 侧 e2e 的「三张用量表行数」核对不适用 |
| 删除任务 | 界面删除把任务标为 `status='deleted'`（软删除），启动后的对账据此删掉它的保存点引用；桌面不在删除时立即删引用（`sessions.ts:689-693`，不可逆） | Host 的 `deleteSession`（`/api/sessions/delete`）调 `OwnerSessionStorage.delete` 物理删行；对账不认行缺失，保存点引用留在用户仓库 | 已定：随 M2 的删除通道改为与桌面相同的软删除与同一组清理；届时硬删除要么改成同一语义，要么只留给不面向用户的用途并写明调用方，并核实硬删除是否会让删除状态同步不到云端与其他设备。**迁移前必须完成** |
| 保存点标签的停用裁决 | 读桌面供应商服务（订阅池、`getDesktopSelectableBaseCatalog`、连接认领、Fast 投影） | Host 的 `publicViews` 用 `getActiveCatalog`、无订阅池与认领，两边视图不等价；Host 端口按「不可用」 | 标签走兜底，不发付费请求。等价的供应商视图随 M2 的模型通道做，届时再拆路由守卫、接真实调用；m1-cp12 已还原之前的拆分。安装型 BYOK 供应商的凭据挂在同一个 M2 事项下 |
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
| Claude 托管 Skill 暂存目录 | 系统临时目录下的 `cindy-claude-skills-*`（maker-core `managed-skill-plugins.ts`）：每个插件一个目录，含 `plugin.json` 和指向批准来源的链接，不复制 Skill 内容 | 每次启动 Claude 任务且托管 Skill 清单非空时建；该次查询中止或启动失败时删除 | m1-cp6 |
| 系统 Codex 登录（经链接） | 迁移来的 profile 里 codex-home/auth.json 若是指向 `~/.codex/auth.json` 的链接：订阅桥刷新令牌时原地写回（`anthropicResponsesBridgeHostCore.ts`），Host 拉起的 Codex 自己刷新时也写；作废只删 profile 里的链接，不改外面那份 | 令牌快过期时 | 24b |

### Host 会读到的 profile 之外的位置

同样是桌面已有的行为。

| 读取 | 位置 | 何时 | 引入 |
|---|---|---|---|
| 官方 Codex Browser 插件的描述 | 系统 `~/.codex/config.toml` 的 `[plugins]`（共用启动配置里的 `prepareCodexBrowserCompanion`）；只读 config，不碰凭证 | 每次准备本机 Codex 进程的启动参数时 | M1 之前（Host 接入共用 Codex 启动配置时，m1-cp0 已有） |
| 系统 Codex 登录（经链接） | 同上，迁移来的 profile 里经链接读系统那份登录 | 每次读 Codex 登录态与派发请求时 | 24b |
| 系统 Codex 登录（对账） | `~/.codex/auth.json`：stat、读取账号，建指向它的符号链接；只在安装版 Host | 启动时、读登录态、取启动环境、订阅桥取令牌、在 Cindy 里登录后 | m1-cp13 |
| Claude Code 的配置与 Skill | `CLAUDE_CONFIG_DIR`，没设时 `~/.claude`（Claude 任务用 CLI 默认配置目录；/learn 捕获列 Skill 时也读这里） | 启动 Claude 任务、列 Skill 时 | m1-cp10 起用于 /learn 捕获 |

### Host 在 profile 内与窗口进程共用的文件

客户端模式下窗口进程与 Host 共用同一个 owner 目录。下表列出两边都会读、需要说明 Host 是否写入的文件。

| 文件 | Host 是否写 | 原因 | 引入 |
|---|---|---|---|
| owner 目录的 `auxiliary-model-settings.json`、`auxiliary-model-settings-migration.json` | 不写、不删 | 见第二节「辅助模型设置文件」 | m1-cp11b |

## 四、移出 M1

| 项 | 移到 | 原因 |
|---|---|---|
| 供应商分组执行 | M3 | 任务会派到组内其它电脑执行，依赖 Device Link 的准入与转发（`docs/product-rules/provider-groups.md`） |
| 伙伴的会话环境（`resolveSessionEnvironment`）与伙伴工具集 | M3 | 伙伴任务在 M1 继续拒绝 |
| SkillHub 发现隔离（`scanLocalCustomizations`） | M2 | 只影响 Skill 列表界面，不影响任务运行 |
| Pi 包的安装与卸载 | M2 | 界面发起的写操作；运行只需读已安装的包 |
| 本地模式下运行任务 | M2 | 要先定本机登录或 API key 的认领方式与模型隔离规则 |
| 远程附件（OSS、点对点） | M3 | 手机远控的一部分 |
| 桌面的 Claude 与 Codex 回环代理启用入站凭据检查 | M1 发布后单独一个改动 | 用户 2026-11-13 决定；M1 期间桌面行为不变。Claude 代理按三类放行，不要求只认密钥 |

## 五、待办与未完整运行的验证

| 项 | 状态 |
|---|---|
| `apps/host/scripts/plugins-installed.e2e.mjs` | 未完整运行：缺 Playwright `chromium_headless_shell-1243`，`cdn.playwright.dev` 下载超时。自 Pi 桥修复起一直只跑到打开插件页面之前。网络恢复后安装并完整运行；在此之前引用它的验证都写「未完整运行」 |
| 桌面全量 vitest | 计划在 2e-2 后跑一次 |
| e2e 用量计数开关（只在测试里生效） | 第 9 步 |
| 通道清单重新生成（合并 main 后为 1466 个） | 在下一个确实需要的检查点提交，写明新增的 10 个通道及归类 |
| 带界面的验证 | 用户已允许（隔离沙箱、复用 host-usage）；2e 之前客户端模式只做导航与读取 |
| 测试纪律：会碰到 Codex 登录的运行 | host-usage 沙箱的 codex-home/auth.json 链着本机真实的 Codex 登录，Host 在那里走到 Codex、订阅桥或作废逻辑就可能经链接改写它。凡是会让这些跑起来的运行，一律用 HOME 隔离、假登录的 profile；host-usage 只做不触发这些路径的只读检查，拿不准就不用 |
| 测试纪律：用发布构建跑 Host | 发布构建（带发布清单）会被认成安装版，与运行它的系统用户的 `~/.codex/auth.json` 对账、链接（与打包后的桌面在沙箱 profile 里的行为相同；m1-cp13 之前 Host 不读系统登录）。凡是用发布构建跑 Host 的测试（验证安装包、M4 的联合验收等），HOME 必须隔离 |
| 移交交接任务：发布构建与系统 Codex 登录 | 上一行的情况由审核方在 M1 发布时通知交接任务 |
| 基线抖动：`packages/anthropic-compat-proxy/src/server-websocket.test.ts`“forwards the upgrade handshake, strips /v1, and pipes buffered bytes both ways” | m1-cp15a 门禁里失败一次（断言 SERVER_HEAD 时缓冲为空，5ms），该包自 m1-cp14 起没有改动；单文件重跑 5 次全过、整包重跑 578/578。以后门禁里它再失败，先单文件重跑，过了按基线记 |
| 负载下超时：`apps/desktop/src/main/maker-host/__tests__/authAdaptersImportPurity.test.ts` | main 上已有的测试，自带 20 秒超时。m1-cp6 把 cindy-brain、maker-host、plugin-market 三个目录一起跑时超时，单独跑 6 秒通过。不归本分支 |
| 基线失败：`apps/desktop/src/main/maker-ipc/__tests__/botLifecycleService.test.ts` 10 项 | 报 `SqliteError: no such table: mcp_app_view_states`（`deleteDeletedSessionViewStates`）。对照方法：把本分支改过的桌面源码换回合并的 main 版本（7eaf7788de）、删掉新增模块后单跑该文件，同样 10 项失败，判为 main 上原有问题。合并 main 后若自行恢复，删掉这一行 |
| 待定：随包插件在 Host 不标内置 | 桌面的 GhostManager 带 `isTrustedBundledId`（`resources/builtin-ghosts` 下 official、xd 两组种子的 id），根命名空间里的这些安装标 `builtin`；Host 的 `createHostGhostManager` 没有这个选项，任何安装都不标。后果：首方事实的内置官方分支在 Host 上不成立，随包插件按非内置判定（其 Skill 不标官方，依赖内置身份的首方特权被拒）。3c 之前就是这样；也因此 3c 的查找收紧在 Host 上实际只改变托管 Skill 清单。种子 id 从哪里来（Host 发布包不含 `builtin-ghosts`）需要方案，**迁移前必须有结论** |
| 待确认：gray-matter 在 Host 发布包里的形态 | 外置：`apps/host/scripts/build.mjs` 把所有第三方包设为外部依赖，按导入方位置解析后整包拷进发布目录的 `node_modules`（解析到仓库根 `node_modules/gray-matter`）。3c 之前已有 5 个导入方在 Host 的加载范围里（maker-core 的 customization-scanner、pinned-skill-invocation、memory/storage，桌面 skillhub/frontmatterValidation、cindy-brain/skillSlot），3c 没有新增依赖。证据用构建脚本原样截取的依赖插件对 `apps/host/src/main.ts` 跑 esbuild 得出（完整构建缺本机 Chromium） |
| 待查：客户端模式下的两个 GhostManager | 窗口进程与 Host 共用同一份 owner 目录，两边是否都会构造 GhostManager 并各自跑中断恢复（`recoverInterruptedMutationsSync`），有没有跨进程互斥。既有情况，不挡 3c |
| PR 正文须写：桌面提示前后哈希 | 重构前（7eaf7788de）与 m1-cp5c 之后，桌面三个引擎最终 systemPrompt / answerDeliveryPrompt 的 sha256 前 16 位相同：Claude `cb41d06b15ad7128` / `6084849accb05a45`，Codex 同 Claude（两份引擎补充提示目前为空），Pi `be3d281b8d83ea42` / `e6057c54763111fc`。结论：桌面提示前缀逐字节不变，缓存率不受影响 |

## 六、M2 可接（状态已在 Host 上具备，只差通道）

| 通道 | 状态来源 | 具备于 |
|---|---|---|
| `maker:session-background-activity`、`maker:session-background-activity:list`、推送 `maker:session-background-activity-changed` | `claude-session-background-activity.ts`，由回环代理的请求与响应观察写入，任务关闭时清 | 24a |
| `maker:claude-session-route:get`、推送 `maker:claude-session-route-changed` | `claude-session-route-registry.ts`，由回环代理的路由决策写入 | 24a |
