# 个人版迁移放行表

2026-11-12 起，随 M1 每个检查点更新（分支 `cindy/host-m1`，检查点标签 `m1-cp*`）。
个人版切到 Host 之前，「个人版应保留的能力」必须逐项有结论；本表记录每项的现状与证据。
开放迁移由交接任务决定，本表只提供依据。

状态口径：

- **已对齐**：Host 与桌面用同一份代码或等价逻辑，这条能力的写入、落盘、清理都已接上，有不带界面的自动验证；真实验证另列。只接了一部分时写「部分」，并列出没接的调用点。
- **部分**：只对齐了一部分，缺口写在同一行。
- **未做**：写明排在哪一步。
- **移出 M1**：写明移到哪个里程碑和原因。

「自动验证」都是不带界面的测试；「真实验证」指真实账号、打包产物或带界面运行，M1 内均为「无」，
除非另行写明。

## 一、任务行为（a 类）

| # | 功能 | 生产方（桌面） | 状态与当前缺口 | 自动验证 | 真实验证 |
|---|---|---|---|---|---|
| 1 | 上下文窗口、输出上限、压缩阈值、核实窗口 | maker-host/index.ts、pi-host.ts 构造点 → `engineModelResolvers.ts` | 已对齐（m1-cp2a） | desktop `engineModelResolvers.test.ts`；Host `agent-graph.test.mjs` | 无 |
| 1b | 任务工作上下文预算 | `model-context-settings.ts` → `sessionContextBudgetCore.ts` | 已对齐（m1-cp2b） | Host `start-options.test.mjs` | 无 |
| 2 | 禁用的 Skill | `skillhub/activationPreferences.ts` | 已对齐（m1-cp3a） | Host `agent-graph.test.mjs` | 无 |
| 2b | 托管 Skill（内置与插件提供） | `maker-host/managed-skills.ts` | 未做（3c，插件基座） | — | 无 |
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
| 7 | 回合改动记录 | `turn-change-set/store.ts` | 部分（m1-cp5c 更正）：m1-cp5a 只接了引擎侧的写前捕获（Claude 与 Pi）。桌面在派发时开记录（`beginTurnChangeSetAtDispatch`）、从事件流记 Codex 的原生改动（`noteTurnDiffEvent`）、回合结束时落盘（`finalizeTurnChangeSet`）、未派发或关闭时清掉（`clearPendingTurnChangeSets`），Host 这四处都没接，捕获内容只留在内存里、不落盘。与 7b 同一批回合钩子一起补 | Host `agent-graph.test.mjs`（只覆盖引擎侧） | 无 |
| 7b | Git 保存点与文件回退 | `git-snapshot-host.ts` | 未做（下一步，切断清单已确认，第 3 处用方案 A）。回退入口 `maker:rewind:preview`、`maker:rewind:commit` 在 Host 上没有注册，随 M2 的界面通道一起接；这一步只接建保存点。保存点标签在桌面是一次辅助模型调用；Host 上先只接停用裁决，标签用确定性的兜底标签，等第 4 步把辅助模型装配做成可共用后再走真实调用 | — | 无 |
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
| 18 | /learn 捕获 | `learn-host/captureInvocation.ts` | 未做（授权路径，单独提交）。排在 3c 之后：捕获只认 Cindy 内置的 learn Skill，Host 要先有 2b 才能列出它；授权的消费方 `start_skill_learning` 在 `cindy_helper` 里，见第 22 行 | — | 无 |
| 19 | 引擎专有项（Claude、Codex、Pi 各一组） | maker-host 构造点 | 未做（第 8 步） | — | 无 |
| 20 | 诊断：进程登记、cc-debug、出口路径事实 | maker-host 构造点 | 未做（第 7 步） | — | 无 |
| 21 | 启动时清掉从终端继承的 Anthropic 凭据与端点变量 | `main/index.ts` `stripSensitiveAnthropicEnv` | 已对齐（m1-cp5b）：`main.ts` 第一个导入执行同一步，保留导入用的 Claude 配置目录 | Host `boot-env.test.mjs` | 无 |
| 22 | Cindy 内置工具服务 | `mcp-integrations/mcp-providers.ts` `createLiziMcpProviders` | 未做，归属已定：M1 做 cindy_helper 里任务相关的一组、cindy_lsp、cindy_ssh（排在 M1 靠后，动手前先交分组清单）；M2 做设置类、cindy_scheduler、cindy_docs、inputHandoff；M3 做伙伴、Orca、IM 机器人、群聊记录、android、sessionImport、远程任务状态。Host 现在只有 browser、computer、cindy_memory 和插件网关。系统提示与桌面逐字相同、不裁剪，所以在对应工具补齐之前，Host 任务会被提示引导去用尚不存在的工具；**这一行必须在开放迁移前清零** | — | 无 |
| 23 | 引擎运行时配置（`runtimeConfig`） | `maker-host/runtime-configs.ts`；`pi-host.ts` `buildDesktopPiRuntimeConfig` → `runtimeConfigsCore.ts` | 已对齐（m1-cp5c）：产品系统提示、回答呈现提示、`behaviorFlags`、`taskShellEnv`、压缩阈值、换模型时的上下文评估、子代理模型、记忆设置（每次读取）、`userDataPath`、内置 ripgrep。Host 的 endpoint 仍是账号网关，见第 24 行；代输入的环境变量在 Host 上恒为空，见第二节 | desktop `hostRuntimeConfigParity.test.ts`：同一组输入分别走桌面装配与 Host 装配，逐字比较 systemPrompt、answerDeliveryPrompt，函数项按输入矩阵比较输出，允许不同的只有写死的 endpoint；Host `agent-graph.test.mjs`（含缺 ripgrep 时与桌面同样报错）；`codex-runtime.e2e.mjs` 断言真实 Codex 请求带产品提示 | 无 |
| 24 | Claude 与 Pi 的本机兼容代理 | `maker-host/anthropic-compat-proxy-host.ts`（`getClaudeEndpoint`） | 未做（M1，排在 3c、7b 之后；动手前先交依赖清单）。Host 的 Claude 与 Pi 直连账号网关，相当于桌面代理没起来时的退路；代理负责的按模型路由与字段适配（给非 Claude 模型去掉 Anthropic 专有字段）在 Host 上没有。要求：只监听本机回环、与桌面同一模块；接上后说明 `maker:session-background-activity` 一族与 `maker:claude-session-route:get` 两个通道的状态在 Host 上有了，记入 M2 可接清单；它写的路由登记是 Claude 用量记录的来源之一，与 2e 的分工写清 | — | 无 |

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
| 代输入（sudo、ssh、git 密码提示） | 任务的 shell 带代输入的 askpass 环境变量，提示转给用户 | 同一个 `taskShellEnv`，但 Host 不启动 askpass，返回空 | 这些提示在 Host 任务里照命令行默认行为失败，不会转给用户；随代输入一起补 |
| 内置 ripgrep 的位置 | 打包版 `resources/tools/ripgrep`；开发时 `apps/ripgrep-bin/<平台>`（`pnpm install:ripgrep` 安装） | `hostRuntimeLayout().harnessRoot/ripgrep-bin/<平台>`：开发时就是同一个 `apps/ripgrep-bin/<平台>`；发布版是 `apps/host/scripts/build.mjs` 从 `apps/ripgrep-bin` 拷进 `resources/harnesses` 的同一个文件 | 同一个 rg 二进制；找不到时与桌面抛同一条错误（Pi 在构造时，Codex 在启动读 PATH 前缀时） |

## 三、Host 会写到 profile 之外的位置

这些是桌面已有的行为，对齐后改由 Host 进程执行。

| 写入 | 位置 | 何时 | 引入 |
|---|---|---|---|
| 共享项目 Skill 链接 | 任务工作目录（用户仓库） | 每次启动任务前两处 | m1-cp3b |
| 工作树租约 | 工作树运行时目录 | 任务运行期间 | 第 7 步（未做） |
| Git 保存点 | 用户仓库的 `refs/cindy/savepoints/<任务 id>` 及其对象，与桌面同名同位置 | 每个用户回合开始前 | 7b（未做） |
| 空文件夹初始化为 Git 仓库 | 任务工作目录（`git init`），仅在用户开了「自动初始化项目 Git」时 | 每个用户回合开始前 | 7b（未做） |

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
| PR 正文须写：桌面提示前后哈希 | 重构前（7eaf7788de）与 m1-cp5c 之后，桌面三个引擎最终 systemPrompt / answerDeliveryPrompt 的 sha256 前 16 位相同：Claude `cb41d06b15ad7128` / `6084849accb05a45`，Codex 同 Claude（两份引擎补充提示目前为空），Pi `be3d281b8d83ea42` / `e6057c54763111fc`。结论：桌面提示前缀逐字节不变，缓存率不受影响 |
