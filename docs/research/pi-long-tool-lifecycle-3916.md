# Pi 长工具生命周期：#3916 受控取证

## 结论与范围

已在代码级复现并修复一条确定的退出通知缺陷：**Pi 已退出，但工具后代继承
stdout/stderr，Node 的 child `close` 一直等管道 EOF，导致 Cindy 没收到执行者退出通知。**
这不等于已经证明原用户的 Windows exe 打包故障就是此根因；原报告没有对应的
PID/退出码与最后 RPC 帧时间线。

本单只修本地 stdio transport。统一执行者丢失与终态接续归并行的 P0 修复；正文
事件/持久化归 #3696。未修改它们的 coordinator、重放或正文恢复逻辑。

## 版本与既有修复

- [原报告 #3916](https://github.com/makecindy/cindy/issues/3916)：客户端 0.1.72，
  提交时快照为 Windows、Pi、Grok 4.6。原作者称长 exe 打包几乎每次停在「已工作」，
  需要再发消息才接上；子进程是否仍跑未确认。讨论中的分析与 fico-hub 回复均要求受控取证。
- [0.1.72 发布](https://github.com/makecindy/cindy/releases/tag/v0.1.72)：2026-09-03，
  发布正文锚定 `2a039176935c71ee0e1a6377defccbea738b034b`；Pi pin 为 0.84.4。
- [#3761](https://github.com/makecindy/cindy/issues/3761) 是同类用户现象，但使用 Codex，
  不把其候选根因当作 Pi 根因。
- [#944](https://github.com/makecindy/cindy/pull/944) 已提供 Session 零事件 watchdog。
  当前代码仍有该保护；不能笼统声称长工具阶段所有保护都暂停。
- [#3742](https://github.com/makecindy/cindy/pull/3742) 增加 Pi 帧级诊断，已在 0.1.72
  发布清单中；它不是丢帧恢复。[#2574](https://github.com/makecindy/cindy/pull/2574)
  属 durable subagent，不证明主 Pi turn 已解决。
- 当前取证基线 `56c0e50028dcf0f5f83fb9a878e5cb32eee8806e` 与 0.1.72 的本地
  transport 都只用 child `error` / `close` 通知退出，没有 child `exit` 的兜底。
- 核对 [Pi 0.84.4 的 rpc-mode.ts](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/modes/rpc/rpc-mode.ts)：普通 prompt 在 preflight 成功时确认接受，
  不需要等长工具完成才返回。因此不能把 prompt 接受期限直接当成本单根因。

## 受控复现

`pi-long-tool-lifecycle.test.ts` 仅把 transport 的 executable 换成轻量 Node fixture；
使用生产 `PiAgent → PiRpcProcess → translator → AsyncQueue → Session`。
fixture 不调用模型、不运行真实打包，不读取个人凭证；生成物位于独立 `os.tmpdir()` 目录。

失败路径：fixture 确认 prompt、发 `agent_start` 和 `tool_execution_start`，随后
启动继承输出管道的轻量后代并 `exit(23)`。测试直接检查 Pi PID 已不存在、后代 PID 仍存活。

修复前，最初 4 个用例中 3 个对照通过，继承管道用例在 2 秒内始终没有 terminal error，
断言失败。修复后同一路径约 0.3 秒收到包含退出码 23 的 terminal error，Session 自动
关闭；后代仍存活，没有生成工具成功结果，也没有重新发送 prompt。

| 注入情形 | 当前生产链路的观察 | 本单处理 |
| --- | --- | --- |
| 正常工具静默 20 分钟（虚拟时钟），然后完成 | 保持 running；结果、正文、usage、done 到达且自动解锁 | 对照通过；不缩短工具期限 |
| Pi 已退出，后代仍持有管道 | 修复前没有退出终态；修复后明确失败且关闭旧 Session | 已修复 |
| 工具阶段 Pi 普通退出 | 既有 onClose 路径明确报错 | 既有保护通过 |
| 丢 `tool_execution_end`，其余终态到达 | Pi 最终回复仍可见、Session 解锁，但工具结果确实缺失 | 不编造结果、不重跑构建；尚未恢复丢失结果 |
| 丢 `message_end`，工具结果与 settled 到达 | 无正文/该条 usage，现有 `silentStop` 标记生效 | 交 #3696 / 既有续跑责任方，不在本单恢复 |
| 丢 `agent_settled` | 有正文但仍 running；45 分钟现有 watchdog 发明确超时 | 定界用例；本单未加终态轮询 |
| Pi 仍活着，RPC stdout EOF | 不是确认的进程退出；45 分钟现有 watchdog 兜底 | 定界用例；未实现即时 RPC 故障恢复 |
| 用户 Stop | cancelled done，只有一次 abort，没有新 prompt | 取消对照通过 |

另用 transport 单测覆盖退出后尾帧先到、关闭回调一次、关闭后的迟到帧被忽略，
以及 Stop/close 先于或后于 exit 两种竞态；已确认退出后不会再发送 SIGKILL。

## 修复契约

收到 child `exit` 后立即禁止继续写入，最多给输出尾帧 250ms 排空时间；正常 child
`close` 更早到达时沿用原路径。后代迟迟不关闭管道时，复用既有 `fireClose` 通知
上层并释放本端管道，显式 close 的等待也复用该通知。没有新增 supervisor 或共享接口。

250ms 只从**进程已退出**开始计算，不是正常工具、模型静默或整个 turn 的期限。
未添加自动续跑、原请求重放、进程树 kill 或独立 generation 状态机。

兼容：PiTransport 的字段和 `onClose(code, signal, reason)` 契约不变，P0 可独立、乱序
合入并复用；SSH transport 不经过本改动。手机/设备互联控制本地 Pi 时仍消费宿主原有
终态事件；无新增 IPC、wire 字段或 UI 入口，不涉及 relay 重连与多 peer 故障半径。

## 验证与限制

定向验证统一 `--maxWorkers=1 --minWorkers=1`，包括新增全链路 fixture、transport、
translator、两套 RPC client 与 Session watchdog 用例。ESLint 和 `git diff --check`
检查本单文件。最终这 6 个定向文件共 134 个用例通过；根级 `test:runner` 为 511 通过、
1 跳过。

`pnpm test:unit:related -- --workspace-concurrency=1` 第二轮完整通过：Desktop、
lizi-mcps、maker-core related 与 orca-workflow 的无模型单测均通过。定向行为测试保持
单 worker；根门禁的 Desktop 内部沿用仓库默认 8 worker，其余 workspace 串行。
首轮只在无本单改动的 `skillSlot.test.ts` 遇到一次临时软链接 ENOENT；该文件单独
单 worker 复查 27/27 通过，第二轮完整门禁也未再出现。未放宽断言或改插件基座，
该偶发失败的根因尚未确定。

额外 `tsc --noEmit` 发现 `maker.shutdown.test.ts:91` 的 `TS2322`：泛型 resolve 的
可选参数签名与 Promise resolver 不匹配。以 CompilerHost 从 Git HEAD 读取所有已改文件、
排除新增 fixture 后，原基线复现同一个错误；本单没有改该文件。包当前没有 `typecheck`
script，规定的 `run --if-present typecheck` 跳过，不把跳过称作类型检查通过。

缓存/模型指标：未修改 system 前缀、工具 schema、模型路由或 usage 计算。
正常 fixture 的 10 input / 3 output 在 done 中原样保留；热路径只增加一个 closed
布尔检查，无额外 IO/模型调用；新增 timer 每个退出进程最多一个，不进入 token 循环。
未运行真实模型缓存率或吞吐性能基准。

未覆盖：Windows 实机、真实 Pi 二进制 exe 打包、SSH、Renderer 重载/历史重开与 Light/Dark
目检。没有启动 dev、重启正式版、使用 Orca 编排或调用计费模型 API。

释放本端输出管道可能使继续输出的后代遇到 EPIPE；**通知 Pi 退出不等于证明构建后代已
安全停止或成功完成**。原用户根因的最小缺口仍是停住时 Pi/构建 PID 与退出码、最后
RPC 帧和 Session 终态的同轮时间线；本单不能据此宣称 #3916 整体已解决。

## PR 审查补充：关闭失败不能冒充退出

审查指出显式关闭期间 `kill()` 同步触发 `error` 会通过通用关闭通知提前完成 waiter。
受控测试确认：`error` 事件及抛异常两种路径原来都错误地 resolve；修复后保留资源登记，
继续 SIGTERM → SIGKILL，未收到退出证据则 reject，后续仍可重试并由真实 exit 收口。
通用通知中的 waiter 现在显式检查 exitInfo；终止中的 error 只记录错误，不伪造退出。
另覆盖退出发生在 3 秒升级或 8 秒确认期限前 1ms 的情况：排空期间不再发信号，也不误报超时。

另一条审查认为 exit-first/close-second 会立即 resolve 并丢失退出码。加强时序及
code/signal 断言后，在审查所指提交 d8bd012f1 上两种顺序均通过：Promise executor 中
`return` 只退出 executor，不会 resolve 外层 Promise；仍由 250ms 排空通知调用 finish。
因此保留现有排空行为，不将该报告称作已复现缺陷。新增断言持续保护真实退出信息。
