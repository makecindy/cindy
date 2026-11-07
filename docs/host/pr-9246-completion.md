# PR #9246 本地完善与验收

2026-11-08：用户已授权将本地基础版修复推送到原 PR，并继续维护；不自动合并或批准。

当前可在本机试用基础文本任务；已验证新建、真实回复、刷新及 Host 重启后的同引擎续接，
尚未完成权限、停止、网络故障与三平台的整体验收。最新入口和实测记录见 [基础网页版](basic-web.md)。
已有回归测试证明的修复与仍未接通的功能分开记录；
暂只使用隔离目录验证，不将尚未统一的运行时用于正在使用的正式 profile。

## 已确认的产品边界

- 普通桌面启动保持原状；Host 按需开启，桌面只在显式选择时连接 Host。
- 2026-11-08 按实验功能继续维护；默认关闭、独立测试数据和正常桌面回归是交付边界，
  详见 [实验功能的发布边界](basic-web.md#实验功能的发布边界)。
- 浏览器通过本机回环地址或安全隧道连接，不直接开放公网或局域网监听。
- 2026-11-07 调整交付目标：基于现有 PR 先交付基础网页版，不要求完整还原桌面功能。
  第一版验收范围见 [基础网页版](basic-web.md)。未支持功能可以暂不提供入口或明确提示不可用，
  不能返回假成功，也不能把占位空数据描述成已读取用户的真实数据。
- 完整桌面后台（无窗口 Electron 辅助进程）不在本 PR 范围，作为后续单独工作。
- macOS、Windows、Linux 分别验收；浏览器支持不等于这些系统的执行端已通过实机验证。

## 当前已实现的修复（仍待整体验收）

- 浏览器通过一次性配对换取会话 cookie；主页不发授权 cookie，不嵌入 API token。
- 校验 Host/Origin；浏览器会话过期或撤销后关闭事件流；退出登录清理 cookie。
- 消息队列在异步准备前占用执行位置；准备失败保留输入；停止期间不发送迟到消息；删除任务停止并清理队列。
- 停止保留已流出的回复；abort 失败不把仍在运行的回合标为空闲；保存失败暂停队列，恢复时先补存，不重新发送已完成的模型回合。
- 错误消息接受消息表已有的 `error` 角色；消息写入按任务和 clientId 幂等。
- 自定义供应商读取独立的账号/供应商/引擎凭证，禁止回退到网关密钥。
- 模型目录缓存按账号、地址、凭证隔离，刷新失败不回退到另一账号的目录。
- 退出登录复用桌面的 saved-account tombstone 策略，保留其它账号。
- 桌面显式 Host 模式接收完整登录投影；权限卡与输入队列事件走对应频道。
- 任务删除和更新事件送往原有频道；刷新后的运行状态读取真实 Maker 实例，保留既有的版本化快照格式。
- 权限回答按任务定位；已回答请求移除 abort 监听，旧回合不能撤销后来同 ID 的问题。
- Node 与桌面共享项目别名、最近目录存储核心；插件快照使用同一身份检查 worker，通过不同进程适配器启动。
- Windows 使用对应的 `.exe` harness 名；profile 路径、启动脚本按平台解析。
- macOS/Windows 凭证适配使用私有 Electron safeStorage 辅助进程；Linux 保留 Secret Service。
- 凭证身份复用桌面的原子标记判定，兼容 Windows CRLF；加密失败不覆盖旧记录。
- 共享存储目录在最终 profile 覆盖后注入，避免隔离运行时捕获默认目录。
- 修复原 PR 中未接入新迁移配置的任务标签迁移测试。

## 无窗口辅助进程（已移出本 PR）

此前探索的无窗口 Electron 辅助进程（私有父子通道、preload 桥、窗口／托盘／菜单栏抑制）尚未接到 Host 启动流程，
扩大桌面改动面却不给基础网页版提供能力，已从本 PR 移除；自定义 MCP 存储的抽取同理。普通桌面启动路径保持原状。

## 完整版仍缺少的能力（不全部作为基础版前置条件）

1. 完整后台装配：当前 Node agent 装配仍缺桌面的代理、插件执行、MCP Apps、自动化与系统集成。
2. 网页 API：`apps/web/shim.js` 仍有占位响应；须接入真实后台，删除假成功路径。
3. 插件页面与媒体：浏览器须使用隔离页面传输及受控资源通道，不能把 Electron webview/协议当作普通网页资源。
4. 本地与隧道操作体验：文件选择、上传下载、剪贴板、权限引导与断线重连需要按执行电脑正确路由。
5. 完整生命周期：与桌面共用 profile 的单写者、凭证刷新及账号切换需统一，不能只锁 Host 与 Host。
6. 三平台实机验收；本轮可用环境没有 Windows 执行机。

基础版仍必须解决其范围内的可靠性问题；其它能力按实际支持范围明确排除。
同引擎 SDK 上下文恢复已完成本机验证；本轮补齐 `/chat` 的同一恢复路径。
跨引擎完整历史交接仍未验收，不作为基础版已完成能力。切换意图与桌面的
`createPendingAgentSwitchRegistry` 一样只在当前进程内保留，未发送前重启需重新选择；
不承诺持久化，也不为早期 PR 描述中的错误承诺新增持久状态。
权限模式与模型的修改现在先应用到运行中的任务再落库，运行时拒绝则返回失败；
工具调用回合内的多条助手消息按各自消息 ID 保存。不能仅凭 UI 能进入或测试中的模拟 Session 通过就关闭这些问题。

## 基础修复阶段的历史验证记录（2026-11-07）

- Host 回归：82 项通过（约 4.38 秒），覆盖 HTTP 配对、队列、凭证、运行时及真实快照子进程。
- 桌面 Host 连接、项目别名、最近目录：52 项通过。
- 共享 Host 通道 5 项、任务标签迁移 2 项通过。
- 文档／CI 汇总合同：37 项通过（约 2.45 秒）。新增 Host 状态已纳入成功、失败、取消、跳过的真实 shell 汇总测试。
- 桌面类型检查：提高 Node 堆上限后通过；初次默认上限检查因内存不足退出。
- 隔离目录真实启动：随机回环端口，公开健康检查不返回 profile 信息；授权后的运行状态接口返回版本化快照；SIGTERM 正常退出，endpoint 文件已清理。
- Node 插件快照 worker：真实子进程验证父目录身份不符时拒绝删除，匹配时完成删除。
- CI 已在本地增加 macOS／Windows／Linux 的 Host 回归矩阵，并计入 `verify`；没有推送或触发远端运行。
- macOS／Windows 凭证测试注入模拟 OS 进程，证明身份与传输合同；不等于这两个系统的真实钥匙串／DPAPI 验证。
- 未使用真实账号、未修改正在运行的 Cindy、未推送原 PR。

历史 `feature-parity.md` 的“已达成”是原分支的阶段记录，不能替代以上完整验收。

## 2026-11-08 评审收敛：账号、设置与客户端对称路径

本轮不变量：一个 Host 只执行已选账号的数据；设置成功应反映执行状态；同一引擎续接必须
恢复原生上下文；客户端收到的设置与账号状态不能被旧快照覆盖。

| 状态与入口 | 唯一负责方 | 本轮核对与修复 |
| --- | --- | --- |
| Host 启动，凭证与指定 owner 不同 | Host 初始化 | 在打开数据库前验证；失败释放租约，不构建 agent |
| 桌面显式 Host 模式的启动、刷新、登录事件及退出事件 | Host 负责持久认证，桌面只提交进程内 owner | 共用认证投影入口；退出 IPC 路由到 Host，不修改桌面自己的凭证 |
| 已有 Session 修改设置 | Session setter，随后数据库 | provider-only 修改也更新上游；不吞掉不支持的设置错误 |
| 队列及 `/chat` 冷启动 | 同一任务读取函数 | 同时恢复 SDK ID、权限、推理、Fast 和计划设置 |
| 本地设置写入、恢复默认及 SSE 更新 | Web shim 事件入口 | 同一处失效同步快照，避免旧布局覆盖新布局 |
| 未接线的 Device Link 原型 | 不提供此执行入口 | 删除闲置服务及仅测该原型的测试，避免无条件接受远端控制；正式桌面 Device Link 不变 |

验证为定向回归与 Host 套件，不等同于三平台实机或完整桌面功能验收。

### 本轮验证记录

- Host 全部 87 项通过（约 4.45 秒）；共享 Host 通道 6 项通过。
- 合入 main 后，21 个相关桌面测试文件共 581 项通过（整次命令约 20.87 秒）。
- 文档合同 10 项通过；测试规范检查通过，未提高违规基线。
- 已复现的 CI 代码失败来自未注入新宿主端口的旧夹具；补齐测试初始化，不改变生产权限判据。
- 旧 CI 的 Linux 分片 3 在 pnpm 安装期报 ENOENT，Windows 备份测试报 ENOSPC；等待新提交的干净 runner 复验。
- 本轮没有使用真实账号、运行收费模型、启动/重启正式 Cindy，也没有新增三平台实机验收结论。

测试价值：新增回归覆盖直接聊天的原生上下文、冷启动权限设置、本地写入后快照、
显式 Host 客户端 owner、账号不匹配时拒绝打开存储，以及运行期不支持设置的错误传播。
其余修改修复已有测试的依赖注入；保留原有账号撤销、隔离、模型目录和数据库行为断言。
桌面文件执行耗时如下（同一轮定向命令的逐文件结果，不含共享收集耗时）：

| 测试文件 | 用例数 | 执行耗时 |
| --- | ---: | ---: |
| `src/main/__tests__/invokeCaptureHealthOrdering.test.ts` | 3 | 2 ms |
| `src/main/__tests__/authCredentialStoreHealth.test.ts` | 10 | 4 ms |
| `src/main/__tests__/authRefreshBackoff.test.ts` | 20 | 9 ms |
| `src/main/__tests__/authPostCommitStartup.test.ts` | 6 | 146 ms |
| `src/main/__tests__/hostDelegation.test.ts` | 16 | 309 ms |
| `src/main/__tests__/authLoginFlowReset.contract.test.ts` | 34 | 13 ms |
| `src/main/__tests__/authColdStartRecovery.test.ts` | 27 | 59 ms |
| `src/main/mcp-apps/__tests__/protocol.test.ts` | 24 | 31 ms |
| `src/main/maker-host/__tests__/codexModelDiscovery.test.ts` | 34 | 6 ms |
| `src/main/__tests__/hostClientMode.test.ts` | 2 | 3 ms |
| `src/main/localDb/client/__tests__/DbClient.inproc.test.ts` | 1 | 6231 ms |
| `src/main/maker-host/__tests__/model-context-limit-store.test.ts` | 22 | 4763 ms |
| `src/main/cindy-brain/__tests__/skillSlot.test.ts` | 43 | 3214 ms |
| `src/main/maker-host/__tests__/piRosterAssembly.test.ts` | 3 | 328 ms |
| `src/main/maker-host/__tests__/codexAuthBindingClaim.test.ts` | 9 | 400 ms |
| `src/main/maker-host/__tests__/providerCatalogRealmReload.test.ts` | 31 | 1579 ms |
| `src/main/maker-host/__tests__/codexAuthIsolatedSandbox.test.ts` | 45 | 3330 ms |
| `src/main/maker-host/__tests__/modelContextSettings.sessionBudget.test.ts` | 21 | 28 ms |
| `src/main/maker-host/__tests__/codexAuthInvalidation.test.ts` | 72 | 2215 ms |
| `src/main/mcp-integrations/__tests__/piEnvironment.test.ts` | 28 | 178 ms |
| `src/main/localDb/ipc/__tests__/sessionsUpdate.test.ts` | 130 | 7824 ms |
