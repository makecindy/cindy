# MCP Apps 本地协议验证记录

验证日期：2026-10-15（Asia/Shanghai，日期由系统时钟取得）。

结论：官方 SDK 申请表与独立 JSON-RPC 数据看板通过同一个生产 Host 接入，
无需按业务调整 Cindy。官方 `2026-01-26` 稳定协议及 Cindy 已声明能力的本地回归通过。
本记录是本仓的互操作与沙箱验证结果，不是上游颁发的兼容认证，也不代表实现全部可选能力。

## 环境与复跑

| 项目         | 实际环境                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| 系统         | Windows，PowerShell                                                                                                  |
| Node.js      | 22.22.2                                                                                                              |
| Electron     | 42.11.12                                                                                                             |
| MCP Apps SDK | `@modelcontextprotocol/ext-apps@1.7.5`                                                                               |
| MCP SDK      | `@modelcontextprotocol/sdk@1.29.0`                                                                                   |
| 协议基准     | [官方 2026-01-26 规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) |

从仓库根目录运行：

```powershell
pnpm.cmd --filter desktop test:mcp-apps:conformance
```

前序单测阶段结果为 12 个测试文件、158 项测试通过，退出码为 0。
前序两个真实 Electron 集成检查均以退出码 0 结束，分别输出
`MCP_APPS_SANDBOX_VERDICT=passed` 和 `MCP_APPS_RAW_SANDBOX_VERDICT=passed`。
`pnpm.cmd --filter desktop typecheck` 本轮通过。定向 ESLint 与当前 HEAD 基准逐项比对，
本轮代码和测试没有新增错误；`register.ts` 与 `makerSendTransaction.test.ts` 分别保留
13 项和 10 项既有错误。当前触及文件另有 coordinator 测试 3 项、Session 与视觉桥
测试各 1 项既有错误，与当前 HEAD 基准一致；没有新增错误，其余本轮文件为 0。
前序模拟/验证脚本的 ESLint 已通过。
前序自定义 MCP provider、Codex HTTP bridge 与 Pi 环境接入的 66 项回归通过；
前序作者侧修复重跑自定义 provider/registry、Codex 与 Pi 环境的 62 项回归通过。
已有卡片大小回归：完整卡片按 UTF-8 JSON 字节限制为 1 MiB，超大结果在写入前
变成标准有界错误；官方 View SDK 的实时/远程重开均能读取，模型仍收到原结果。
恰好达到上限、超出一字节、多字节文本、View-only metadata 和输入/结果合计均纳入验证。
前序新增 14 项回归：远程完整文档和事件数组使用 4 MiB 减 64 KiB 的 UTF-8 JSON
预算，覆盖多字节、引号/控制字符转义、真实 device-link invoke-result 分片编码、
超限 View 不占额度、消费后字节回收及另一控制端继续工作；普通 MCP 的 HTTP/SSE
补全、进行中的进度、订阅/退订、日志级别/通知、task 方法/状态通知和扩展请求均透传。
无上游能力时不虚报，撤权拦住迟到结果和新请求，取消只传给原请求、不重放。
普通工具调用另新增 9 项撤权竞态回归：在连接获取、工具执行、App 结果保存的等待期间，
分别切换账号、删除服务器和修改配置；等待后重新核验 owner/config，拒绝执行或向模型
返回迟到结果，已经执行的调用不重放。9 项均在修复前复现失败，修复后通过；
见 `serverProxy.test.ts`。该轮撤权修复重跑完整 MCP Apps 单测、Desktop 类型检查与
定向 ESLint，未重跑前序沙箱与真机验证。

前序 App 消息修复新增 23 项回归：所有文本块开头的斜线均转义，覆盖 Claude Code、
Pi 和 Codex 的 App 输入与来源说明，历史仍保留原文；读取任务、恢复队列、加载 metadata、
构建排队项及直发准备期间撤销卡片会阻止入队或派发，账号、清空与配置边界继续生效。
直发复用 Session 既有钩子，在 accepted 持久化前和异步准备后的最终 vendor 派发前核验；
保留主人授权意图，私有 guard 不进入队列持久快照、公开投影、历史或 provider options。
官方 App SDK 另验证发送准备期间撤销卡片、账号和服务器后没有派发。

前序另新增 26 项回归：排队后撤销卡片会阻止 drain 和排队插话；活 guard 留在 Main，
公开投影和 JSON/IPC 丢弃它。恢复快照时丢弃无活授权的 App 队列行（含旧版
来源标记），走正常 discard 结算并清理持久快照；不重造授权、不阻塞后续用户消息。
消息创建返回、历史回读和本机／同账号控制端广播均只下发公开标题与文本摘要，
完整参数、schema、structuredContent 和结果 metadata 仍留在 Main，只有授权后的
sandboxed App View 可读取；共享访客复用同一摘要白名单。回归见 `ipc.test.ts`、
`messagesWriteReadback.test.ts`、`agent-input-coordinator.test.ts` 与 `mcpApps.test.ts`。
Session 插话复用发送前的私有钩子，在异步准备后再核验；钩子不传给 provider，
钩子等待期间结束、替换或关闭的 turn 都不能接收迟到消息。
普通 MCP facade 继承下游实际 client capabilities，HTTP/SSE 的 roots、sampling、
form elicitation、roots 变更通知均到达原 harness；不同 facade 不串线，撤权后不向
上游返回迟到回调结果，无能力时不虚报。取消不重放，Main 对请求 ID 0 同样转发取消。
测试 peer 使用的 SDK 1.29 默认取消 handler 忽略数字 ID 0，因此该项直接检查 wire
通知；ID 1 同时检查实际 signal，不能把 wire 证据说成测试 peer 的 ID 0 handler 已取消。

该轮执行：

```powershell
pnpm.cmd --filter desktop exec vitest run src/main/mcp-apps/__tests__ src/main/maker-ipc/__tests__/makerSendTransaction.test.ts src/main/maker-ipc/__tests__/agent-input-coordinator.test.ts src/main/maker-ipc/__tests__/messageSourceNote.test.ts src/main/__tests__/mobileClientPromptNote.test.ts --maxWorkers=2 --reporter=dot
pnpm.cmd --filter @cindy/maker-core exec vitest run src/session.vision-bridge.test.ts src/session.origin.test.ts src/session-control.test.ts src/session-send-outcome.test.ts src/session.close.test.ts src/session.async-user-questions.test.ts --maxWorkers=2 --reporter=dot
pnpm.cmd --filter @cindy/maker-core build
```

结果：Desktop 16 个测试文件、925 项测试通过，退出码为 0；其中 MCP Apps 为 158 项，
`makerSendTransaction.test.ts` 为 172 项，来源说明和客户端说明分别为 12 项与 68 项。
coordinator 为 515 项。maker-core 的 6 个测试文件、200 项测试及无输出构建类型检查通过；
该包没有独立 typecheck script，build 实际执行 tsc --noEmit。
该轮未重跑前序 Electron 沙箱；真实模型账号、完整卡片双主题目检和 Mobile 真机仍未验证。

| 测试文件                      | 通过数量 | 主要覆盖                                                                                  |
| ----------------------------- | -------: | ----------------------------------------------------------------------------------------- |
| `interop.test.ts`             |       28 | 官方 App SDK、HTTP/SSE、上游 instructions、初始化失败回复、加载期间完成/撤销、模型 facade、App 消息撤权 |
| `conformance.test.ts`         |       18 | 独立 JSON-RPC App、编码/metadata 组合、分页、通知、取消、能力协商                         |
| `operations.test.ts`          |       11 | 任务与调用者绑定、输入校验、远程操作边界                                                  |
| `ipc.test.ts`                 |        9 | 卡片持久化、清空与账号竞态、删除后禁止重建、权限路由、公开错误                            |
| `protocol.test.ts`            |       22 | 标准 metadata、可见性、资源格式/大小、CSP 域声明与同源 base URI 默认值                    |
| `sandboxProtocol.test.ts`     |       10 | 不同 origin、账号隔离、权限拒绝、Renderer 生命周期回收、嵌套导航与 Escape                 |
| `remoteAuthorization.test.ts` |        5 | 真实 Session instance 路由、冻结装配名单、远程发现与执行授权                              |
| `connection.test.ts`          |        3 | 首次失败及断线后独立重连、关闭竞态、不重放已发送工具                                      |
| `openLifecycle.test.ts`       |        4 | 加载超时、打开前取消、晚到 View 回收、调用者与任务隔离                                    |
| `wireBudget.test.ts` | 7 | 完整文档/事件 UTF-8 JSON 大小、转义、device-link 编码、额度回收与控制端隔离 |
| `serverProxy.test.ts` | 25 | 普通 MCP 能力、补全/进度、订阅/日志、task/扩展；客户端能力及 roots/sampling/elicitation 回调、隔离/撤权/取消 |
| `messageSender.test.ts` | 19 | App 命令转义、来源与历史保留、发送/入队准备与入队后撤权、序列化丢授权与旧行拒绝 |
| `resultDelivery.test.ts` | 9 | 晚到结果/取消撤权、保存失败、延迟初始化、正常交付与其他卡片隔离 |

作者侧修复另经 Desktop 卡片可见性、MCP 目录与 SSH bridge、安全守卫定向测试验证；
Mobile 的卡片导航/HTML 注入与三个受影响消息展示测试共 39 项通过。共享 controller/
文档测试 13 项、device-link 超时与重试策略测试 31 项通过；Desktop、Mobile 与两个
共享包的类型检查、定向 ESLint、i18n 及设计台账检查通过。未用本地定向结果替代完整 CI。

前序跟进开始时旧 head `8cd728d` 的 [Linux unit tests (1/2)](https://github.com/makecindy/cindy/actions/runs/38636206425/job/116099904816) 失败：
`linuxInstallation.test.ts` 在 beforeAll 制作 `.deb` 夹具时，`ar rc … package.deb debian-binary data.tar.gz` 返回失败。
日志没有给出具体 stderr/退出原因，不能认定为瞬态；该安装器测试不在 PR 改动范围，
该轮未修改或跳过它。完整 CI 仍由新 head 正常触发并决定通过与否。

## 关闭握手补充验证（2026-10-15）

关闭控制器现在会等待其主动发送的 teardown 回执，收到 result/error 或达到发送后的
1 秒上限才通知 Host 释放 View。重复关闭共用同一等待，不把本地回执交给未发起该请求的
Host bridge；未主动通知时仍转发 Host 的标准 teardown 握手。

新增 4 项控制器回归，其中成功回执、错误回执和超时的 3 项在修复前复现提前关闭；
修复后控制器 14 项、共享文档 3 项、Desktop Host 协议与卡片 19 项、Mobile 卡片 3 项通过。
覆盖异步回执前不释放、错误回执完成、相同 ID 请求或无关响应不能完成清理、重复关闭、
从通知时刻计算的上限、晚到回执丢弃，以及关闭期间保留 Host 请求/响应路由。

head `298ad2a` 的 [Linux unit tests (2/2)](https://github.com/makecindy/cindy/actions/runs/38643078077/job/116123167873)
另有 3 项委派发送、1 项目标模式测试失败，原因均为源码片段的 Function 夹具没有注入
新增 Symbol，错误为 `MCP_APP_MESSAGE_GUARD is not defined`；本机均复现。
补入真实模块导出的 Symbol 后，`pluginTaskAuthorshipWiring.test.ts` 的 17 项与
`goal-host/__tests__/controller.test.ts` 的 228 项通过，原授权与目标模式断言保留。
本次定向测试合计 7 个文件、284 项通过，完整 CI 需在新 head 正常重跑后判定。

```powershell
pnpm.cmd --filter @cindy/maker-shared exec vitest run src/__tests__/mcpAppController.test.ts src/__tests__/mcpApps.test.ts --reporter=dot
pnpm.cmd --filter desktop exec vitest run src/main/mcp-apps/__tests__/conformance.test.ts src/renderer/components/chat/__tests__/McpAppCard.test.tsx --maxWorkers=2 --reporter=dot
pnpm.cmd --filter mobile exec vitest run src/__tests__/mcpAppCard.test.tsx --maxWorkers=2 --reporter=dot
pnpm.cmd --filter desktop exec vitest run src/main/maker-ipc/__tests__/pluginTaskAuthorshipWiring.test.ts src/main/goal-host/__tests__/controller.test.ts --maxWorkers=2 --reporter=dot
pnpm.cmd --filter @cindy/maker-shared run --if-present typecheck
pnpm.cmd --filter @cindy/maker-shared build
pnpm.cmd --filter desktop run --if-present typecheck
pnpm.cmd --filter mobile run --if-present typecheck
pnpm.cmd --filter @cindy/maker-shared exec eslint src/mcpAppController.ts src/__tests__/mcpAppController.test.ts
pnpm.cmd --filter desktop exec eslint src/main/maker-ipc/__tests__/pluginTaskAuthorshipWiring.test.ts src/main/goal-host/__tests__/controller.test.ts
```

maker-shared 没有独立 typecheck script，build 实际执行 `tsc --noEmit`，已通过；
Mobile 与 Desktop 类型检查均通过。
上述定向 ESLint 和文档合同检查（10 项）通过。
本次未重跑 Electron 沙箱，也未完成 macOS、Mobile 真机或完整卡片双主题目检。
当时 Mobile 原生卸载不能保留 WebView，属于尽力通知；未将单测结果当作原生异步清理完成的证据。
2026-10-16 的修复改为根级持有 WebView、原生 slot 内联承载，等待回执或 1 秒后再销毁，
实现与当前验收边界见 [MCP Apps 接入说明](mcp-apps.md)。原生实际运行仍须单独验收。

## 共享任务访客历史卡片补充验证（2026-10-15）

Desktop 和 Mobile 在挂载交互卡片前识别共享任务 peer，只展示名称、保存结果中的
text 块和主人专属操作说明。无结果时仍显示名称与说明；React / 原生 Text 将文字作为
正文显示，不执行其中的 HTML，不展示 View-only `_meta`、structuredContent 或嵌入资源。
Host 仍拒绝访客 MCP Apps 请求，房主本机和同账号远控仍使用原交互卡片。

- 定向回归 9 文件 / 136 项通过：Desktop 卡片、历史投影及 IPC 17 项；Mobile 卡片、
  历史投影、文字规范、五语 catalog 与来源文案 115 项；共享记录投影 4 项。覆盖访客
  零 Host 调用、无 iframe/WebView/重试按钮、保存文字与空结果、主人本机/远控打开和离屏回收。
- Desktop、Mobile typecheck 通过；maker-shared 无单独 typecheck，`build` 的
  `tsc --noEmit` 通过。i18n key、术语检查及文档合同 10 项通过。
- Desktop / 共享包改动文件 ESLint 除 `makerChatStore.ts` 外通过。该文件 3832、4159、
  11184 行的 3 项错误及 11182 行的 1 项警告，在原 head 与工作区逐项相同；均在本轮
  改动外。Mobile ESLint 未执行成功：包内没有 `eslint.config.*`，退出码 2，未添加临时配置
  或放宽规则。
- 两端新增说明已逐语核对简中、繁中、英、日、韩的含义及编码，未做母语者复核。
  测试覆盖 Light/Dark 状态分支，不计作真实 UI 目检；本轮未启动 Electron 沙箱或 Metro，
  未完成卡片双主题实机、macOS、Mobile 真机或真实双账号联调。

## 晚到工具结果撤权补充验证（2026-10-15）

结果保存失败时，Host 不再替换或投递晚到数据，而是释放同一账号、任务和卡片的全部 View，
并保留原错误。初始化输入和结果/取消通知发送前复用当前卡片校验；校验失败也回收 View。
持久化只允许新建待执行卡片，已删除行的结果/取消更新会明确失败，不重新创建卡片。

- 新增 Host 回归 9 项，其中 7 项在修复前复现越权投递或未回收；补充 IPC 回归 3 项，
  其中 2 项在修复前复现删除后重建。覆盖本机与远程 View、已初始化与等待初始化、
  保存失败及保存后撤权、完整结果和取消、正常交付一次、其他卡片不受影响及新卡片创建。
- MCP Apps、WebView 安全与 CSP 定向回归共 15 文件 / 258 项通过，退出码 0；
  Desktop typecheck、所改 Host/IPC 及测试 ESLint、文档合同 10 项均通过。测试使用
  内存依赖与现有 loopback fixture，没有读取用户数据库或连接生产服务。
- head `1053f64` 的 [client-ci](https://github.com/makecindy/cindy/actions/runs/38650071286)
  中 verify-checks、Desktop Git integration、Windows unit tests (1/2) 的根级 runner
  均因设计台账过期失败：上轮只读卡片新增的圆角未重新生成计数。本轮运行
  `pnpm.cmd design:inventory`，仅更新三个 surface 各增加 1 的圆角计数，人工区不变。
  `check:design-inventory` 与设计台账合同 52 项通过，未跳过或放宽门禁。

```powershell
pnpm.cmd --filter desktop exec vitest run src/main/mcp-apps/__tests__ src/main/__tests__/webview-security.test.ts src/main/security/__tests__/csp.test.ts --maxWorkers=2 --reporter=dot
pnpm.cmd --filter desktop run --if-present typecheck
pnpm.cmd --filter desktop exec eslint src/main/mcp-apps/host.ts src/main/mcp-apps/ipc.ts src/main/mcp-apps/__tests__/resultDelivery.test.ts src/main/mcp-apps/__tests__/ipc.test.ts
pnpm.cmd check:design-inventory
node --test scripts/__tests__/design-inventory.test.mjs
pnpm.cmd check:dev-docs
```

本轮未重跑真实 Electron 沙箱、Mobile 真机或 macOS；本地定向结果不替代新 head 的完整 CI。

## 两个独立 App

1. **申请表**：服务器使用官方 `registerAppTool`/`registerAppResource`，View 使用官方 App SDK。
   AI 预填后，用户修改并创建内存申请；更新模型上下文不启动模型轮次，明确发送消息才触发测试回调。
2. **数据看板**：View 只使用标准 JSON-RPC/postMessage；服务器使用普通 MCP SDK 低层 handler，
   不依赖 ext-apps 注册 helper。使用不同工具名和 `ui://` 资源，默认 blob HTML、list-level metadata，
   另测 text HTML、read-level metadata 与旧 `ui/resourceUri`。刷新、消息、上下文、模式和尺寸均走同一 Host。

两种服务器都提供随机 loopback Streamable HTTP 与 SSE，互操作测试覆盖两种传输；
真实 Electron 检查分别通过 Streamable HTTP 加载两种 App。
工具数据全在内存中，不连接 GM 生产接口、不创建真实申请、不发送消息给其他人。

## 协议覆盖与证据

卡片中的完整工具结果均指 1 MiB 序列化预算内的数据；超限只交付标准有界错误。

| 协议项               | 本次验证                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展与 MIME          | Client 声明 `io.modelcontextprotocol/ui`；读取 `text/html;profile=mcp-app`；两种服务器与传输均可发现 UI                                                                                                                    |
| 工具发现与可见性     | 支持 `_meta.ui.resourceUri` 和旧键；默认 model+app；模型看不到 App-only 工具，View 不能调用 model-only 工具；工具分页不会漏项                                                                                              |
| HTML 资源 | text/blob 两种编码；read/list metadata；拒绝错误 URI/MIME、非法 base64 和超过 4 MiB 的资源；远程完整文档按 UTF-8 JSON 计量，超限在保留 View 前拒绝 |
| 远程响应大小与背压 | 完整文档及 poll 事件数组最多 4 MiB 减 64 KiB，预留 invoke-result 封装；UTF-8、JSON 转义、数组括号/分隔符计入；已消费事件按相同字节回收，另一控制端继续工作；见 `wireBudget.test.ts` |
| 初始化、版本与 ping  | `ui/initialize` 协商 `2026-01-26`；未知请求版本返回实际支持版本；initialized 前不发输入/结果、拒绝工具调用；重复初始化切换文档代次、取消旧请求且不重放初始输入/结果；ping 正常                                                                                      |
| 模型 MCP 初始化 | HTTP/SSE 上游 `instructions` 和实际 capabilities 在标准 initialize 中保留；SDK 的 serverInfo 和版本协商保留；owner 变化时明确回复错误；见 `interop.test.ts` 与 `serverProxy.test.ts` |
| 模型 MCP 标准能力 | HTTP/SSE 补全、资源订阅/退订、日志级别/通知、task 方法/状态通知及扩展请求透传；任务式工具调用仍检查 model 可见性；取消不重放，迟到结果重新检查 owner/config；见 `serverProxy.test.ts` |
| 输入、结果与模型隔离 | initialized 后按输入、结果顺序交付；text/image/audio、嵌入文本/二进制资源、resource_link、structuredContent 与 `_meta` 完整保留给 View；模型 facade 去掉结果根 `_meta`；加载期间完成或取消仍正确交付                       |
| App 工具调用         | 只连接产生卡片的 server；按任务授权；拒绝授权时服务器不执行；保留工具 `isError` 与 View metadata；不重放写操作                                                                                                             |
| 资源与列表变更       | resources/read/list/templates、prompts/list；resources/list 游标可继续分页；tools/resources/prompts 的 list_changed 到达 App，刷新后工具定义更新                                                                           |
| 连接生命周期         | 超过 Host 额度的闲置 facade 不登记连接；首次请求（包括 initialize）登记，后续请求复用连接 ID，代理关闭后释放；回归见 `interop.test.ts`                                                                                     |
| 远程文档生命周期     | Renderer 重载、崩溃或销毁后，旧供片返回 404 并可重新挂载；同文档/子 frame 导航、其他 Renderer 与本地 Host 供片保留；回归见 `sandboxProtocol.test.ts`                                                                       |
| 消息与模型上下文     | `ui/message` 支持稳定单块与数组形状、text/resource_link；App 原生命令转为普通文字并保留来源和历史原文，入队及最终派发前核验卡片/View；上下文支持 text/structuredContent，后一次替换旧值；发送接受后仅消费本次快照，失败或主人原生命令保留，更新与发送重叠时不丢新值；单独更新不启动轮次；未声明模态明确失败 |
| 打开链接             | `ui/open-link` 转交查看端 controller；成功/失败均有 RPC 结果；拒绝 javascript 与含凭证的 URL；不让 App 自身导航离开资源                                                                                                    |
| 显示与尺寸           | inline/fullscreen 协商；App 限制仅 inline 时返回 inline；pip 请求返回实际支持模式；host-context-changed 同步模式；真实浏览器按 size-changed 改变 iframe 高度                                                               |
| 环境与主题           | locale、时区、容器尺寸、安全区域和工具信息可读；Host context 可增量更新；真实 Electron 内两种 App 的 Light/Dark 背景随 CSS variables 切换                                                                                  |
| sandbox 隔离         | 标准 sandbox-ready 与生产 proxy 供片；App 无 preload、require、process；不能读取不同 origin 的父文档；供片绑定当前账号                                                                                                     |
| CSP 域声明           | 真实浏览器中 connect/resource/frame/baseUri 声明域可用；未声明 fetch 和嵌套导航均被阻断，禁止域 HTTP 请求计数为 0                                                                                                          |
| 系统权限             | Host permissions 为空；真实 Permissions Policy 拒绝 camera、microphone、geolocation、clipboard-write；Electron request/check 两道守卫拒绝 App 及其外部后代 frame 的系统权限，真实 App 的通知权限请求返回 denied            |
| 取消与销毁           | `notifications/cancelled` 传到正在执行的 server 工具，且执行次数为 1；`ui/resource-teardown` 完成握手后释放；供片变为 404；清空、删 server 或账号切换后旧 View 不可用                                                      |
| 未支持能力           | 不声明 sampling、downloadFile；相应请求与未知方法返回 `-32601`；不声明的图像/音频消息或上下文明确拒绝，不静默丢内容                                                                                                        |

工具输入片段通知是可选项，当前发送零次 partial 通知并在初始化后发送完整 arguments。
工具结果的图像/音频块能完整到达 View，不代表 Host 支持图像/音频 `ui/message` 或模型上下文。
Desktop 声明 inline/fullscreen，Mobile 声明 inline；不声明 pip 或任何系统权限。

## 实测发现并修复的问题

生产导航守卫原先把 App 内声明过 `frameDomains` 的嵌套 iframe 也拦截了。
这会导致符合标准、使用外部嵌入内容的 App 无法加载该内容。

修复后沿真实 frame 的父链找到所属 App 资源，只按该资源重新校验的 `frameDomains`
授权后代 frame。App 自身和外层 sandbox 的导航限制保留；账号不匹配或供片撤销时没有授权。
真实 Electron 已确认声明域可加载、未声明域无网络请求；回归单测同时确认不同协议、
本地文件和其他 App 的供片地址仍受限。验证过程中主动访问禁止域产生的
`ERR_BLOCKED_BY_CSP` 是预期阻断证据，以最终退出码和 verdict 判断检查结果。

## 验证边界

这些结果说明：遵守上述稳定协议、使用 Cindy 已声明能力的不同 Apps 可以复用现有 Host 接入，
无需编写申请表或数据看板专用前端逻辑。它不保证未知的未来协议版本，或要求未声明可选能力的 App。
后续 SDK/协议升级需复跑同一套检查并补充新增能力覆盖。

真实浏览器检查加载生产 Host/controller/custom-scheme sandbox，但卡片存储、权限与消息使用测试回调。
尚未联调真实模型账号与完整 Cindy React 卡片，不等同于完整产品 UI 的 Light/Dark 实机目检。
大小检查只约束本版本的新卡片写入，不批量改写此前已经保存的历史记录。
上游 instructions 透传恢复模型既有的服务器说明，并在 facade 初始化时建立认证连接；
本地协议 fixture 验证字段与失败语义；修改边界的运行期测量见下节，
真实模型的缓存率、完整启动耗时、token 用量或调用决策准确率未测量。
Mobile 真机、真实 SSH 主机、真实 GM endpoint 仍待端到端验收。
本地模拟与自动验证不修改用户 MCP 设置，不连接生产业务接口。

## 外链授权有效期回归（2026-10-16）

Host 的 `authorize-link` 现在一次性认领待处理外链，把原 10 秒待授权计时替换为
30 秒结果等待，并返回 `validForMs`。Desktop Main 和 Mobile 共享控制器用单调时钟
把整个授权往返计入期限，在调用系统浏览器前拒绝过期回包。重复认领不延长期限，
结果丢失、撤权和 View 销毁按失败收尾；不重放浏览器动作，不重置 link 或 relay。

新增回归复现了旧代码在授权后原计时到期、过期授权回包仍打开浏览器的情况。
修复后 Desktop 4 文件 / 96 项、共享包 2 文件 / 61 项、Mobile 2 文件 / 26 项通过；
Desktop、Mobile 类型检查及 maker-shared 的 `tsc --noEmit` 通过，定向 ESLint 通过。
随后完整 MCP Apps 回归 19 文件 / 354 项通过，文档合同 10 项通过。
测试初始化夹具最初未完成握手，随后补齐；fake timer 清理顺序导致的 hook 超时也已修正，
未将这两类夹具错误作为产品问题或通过证据。

## 核心指标的运行期边界测量（2026-10-16）

影响评估：新增 MCP facade 可能影响稳定工具目录／instructions（缓存前缀输入）、
初始化与工具返回速度、发给模型的内容与额外轮次（用量），以及参数／结果／事件的准确性。
本 PR 未改 system 段、模型映射或 usage 计量；App 上下文只作为外部数据进入用户消息。

复跑命令：

```powershell
node apps/desktop/scripts/mcp-apps-sandbox.verify.mjs --metrics
node apps/desktop/scripts/mcp-apps-sandbox.verify.mjs --raw --remote --metrics
```

方法：真实隔离 Electron 加载生产 Host、facade、controller 与不同 App，
上游使用真实 loopback HTTP MCP server，下游使用 SDK InMemory transport，存储与消息发送
使用内存回调。每种 App 交替执行 30 次直接工具调用和 30 次 facade 调用，逐次比较结果
（只移除有意不交给模型的根 `_meta`），并比较工具目录与 instructions；App 编辑上下文后再比较。
没有真实模型请求、生产业务调用或用户数据库访问。

| 运行测量 | 官方 SDK 申请表 | 独立 raw 看板 |
| --- | ---: | ---: |
| facade 初始化 | 11.85 ms | 8.44 ms |
| 直接调用 mean / p95 | 12.99 / 16.40 ms | 13.63 / 17.72 ms |
| facade 调用 mean / p95 | 28.02 / 32.90 ms | 50.52 / 64.45 ms |
| 稳定工具目录 | 699 bytes，30 次及编辑后完全相同 | 310 bytes，30 次及编辑后完全相同 |
| 工具结果比较 | 30/30 相同（仅根 `_meta` 按边界剔除） | 30/30 相同（仅根 `_meta` 按边界剔除） |
| 直接／模型可见结果 | 225 / 127 bytes | 863 / 759 bytes |
| 最新 App 上下文 | 231 bytes，接受后消费一次 | 239 bytes，接受后消费一次 |
| 编辑上下文启动模型轮次 | 0 | 0 |
| 明确发送消息启动回调 | 0（此检查未点击发送） | 1 |

结论：修改边界未引入易变工具定义、未丢失模型可见结果，App 编辑不会启动多余轮次。
facade 比直接调用增加了约 15.03 / 36.89 ms 的本地平均耗时，包含调用前工具发现与校验；
raw 服务器使用三页目录，不能把这组本地测量外推为 SSH、真实网络或数据库性能。
两项完整沙箱检查均退出 0。真实供应商的 prompt cache 命中率、token 用量和模型决策准确率
仍未测量，输出对应值为 `null`；本记录只证明实际修改的 MCP／上下文边界，不宣称线上指标通过。

## 宿主页面运行环境（#8148）

所有 MCP App 页面均准备 SDK importmap 与表单前置代码，不解析 JavaScript 来判断是否需要 SDK。
保留作者映射、BOM/doctype、原 CSP 与双向旧端兼容；远程文档沿用可选 sdk.source 和既有 gzip 协商。
页面合格但附带 SDK 超预算时省略 SDK 并记录原因，页面仍可打开；依赖该 SDK 的 import 会失败。

验证入口为 `mcp-apps-sandbox.verify.mjs --host-sdk`（并跑 `--remote`、`--bom`）：
计算 import、外部模块与显式/隐式 document.write 均加载官方 SDK；页面 submit 先处理 click/Enter，
未处理的默认提交与直接 form.submit 不发请求、不跳转，卡片仍可用。前置代码仅增加 allow-forms，
form-action none 保留；没有 Swift/Kotlin 改动。预算和旧端回归并入现有 wireBudget、sandboxProtocol、
mcpApps 与 mcpAppNativeDocument 测试。手机 JS 单测不替代手机真机验收。
