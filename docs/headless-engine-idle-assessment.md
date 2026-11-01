# Headless 执行引擎空闲回收评估

2026-11-01；基于第一阶段提交 82b075ec41。状态：已按用户选择接入 Desktop 的原生插件禁用策略，并在本地接入 5 分钟空闲调度；未在线部署。下文按阶段保留，最新结论见末节。

## 已确认的生命周期

- `packages/maker-core/src/agents/codex/app-server/host.ts` 明确规定：app-server 懒启动，但启动后随 CodexAgent 存活；关闭单个 session 只 unsubscribe thread，不按 session 数量销毁共享进程。
- `apps/cindy-terminal/src/tasks/host.ts` 的 start 路径为本机任务创建 Agent 和 Maker；因此不能把通用 CodexHost 的“共享”直接解释成 terminal 全部任务都共享一个进程。
- terminal 的 closeTaskRuntime 会关闭 session、shutdown Maker、释放工具/知识/能力并移除 live 项。它比关闭一个 Codex thread 更接近完整释放路径。
- 这条关闭路径也会结算 pending interaction、关闭输入协调器并清理自动继续状态，不能直接用定时器无条件调用。
- `Session.closeIfIdle()` 已有同步检查与关闭预约，保护 send reservation、未结算 turn 和宿主操作；它是竞态处理的可复用基础，但不等于完整的产品层空闲判定。
- `remote-agent/src/host/runHost.ts` 已有独立的 idleMinutes 回收：检查反向请求、运行调用、rewind、启动状态和 Agent activity。需要复用其语义，避免叠加两个相互冲突的超时。

## 推荐的第二阶段最小范围

先针对 terminal 自己拥有的、已结束一轮且可从持久记录恢复的本地 Codex 任务做回收原型。暂不修改共享 maker-core 的默认常驻策略，不将 Pi、Claude、供应商分享和 SSH 执行节点一并套用。

“进程没有 CPU 活动”或“控制端断开”都不是回收条件。进入倒计时前至少排除：

1. 活跃 turn、工具调用、启动/关闭过程、send 预约和在途 RPC。
2. 等待授权、用户输入、计划确认或代输入；不能把等待人当成可丢弃状态。
3. 排队输入、goal/定时任务自动继续、用量恢复、重试或后台子任务。
4. 尚未完成的持久化、回退、压缩、模型切换和变更快照。
5. 仍借用同一个引擎实例的其它执行者。

在现有任务锁内再次检查，预约关闭后释放 runtime。新消息与回收并发时必须只有一个获胜者；新消息不能丢失或重复执行。恢复使用原 task / vendor thread 身份及原工作目录，不创建新的用户任务，不重放已经执行过的工具。

首版原型可用 5 分钟作为待验证实验值，不将其直接写为产品默认或新增用户开关。需要先测量重新启动延迟、复用效果和恢复正确性，再确定阈值。

## 验证与收益口径

- 使用假的引擎生命周期和虚拟时间，覆盖空闲回收、忙态/等待态不回收、发送竞争、失败关闭与恢复；通过真实宿主入口验证。
- Linux 隔离实例覆盖真实子进程：完成一轮后保留持久记录、回收引擎，再发送消息；确认 thread 和工作目录连续、无重复执行。
- 对比回收前后整个进程树 PSS、CPU、子进程数量以及首次恢复延迟，包含代理、工具和数据库连接，不能只看单个 Codex PID 消失。
- 一阶段观测的 Codex 约 224 MiB 只是一个进程快照，不是保证能节省的固定值；全部业务模块仍在，回收引擎也不意味着约 500 MiB 的主服务一起消失。

故障范围：仅 terminal 所有的单个本地任务 runtime；不主动重连共享 device-link，不改手机协议，不关闭其它任务。SSH 路径暂不进入该原型；控制端继续使用现有任务操作，冷启动延迟必须对各控制端一致。

## 冷恢复前置验证（2026-11-01）

已通过真实 TerminalTaskHost、SQLite 与 Session 的定向测试：授权等待时 `closeIfIdle()` 返回 false；授权完成后可关闭 session 并通过宿主完整关闭入口释放 runtime；下一条消息重新启动时仍使用原 task id、Codex thread id 和工作目录。两条输入对应两次发送，没有在此路径重复发送旧输入。

测试价值与边界：

- 生产入口：`maker:send`、`maker:resolve-interaction`、`maker:close-session`、`terminal:tasks:wait`，配合公开的 `Session.closeIfIdle()`。
- 规则依据：本评估的等待态保护与原线程冷恢复要求；这是实现前的契约验证，不是已修复生产 bug 的证明。
- 现有覆盖缺口：已有 Worker 关闭测试使用 Claude，未覆盖普通 Codex 任务从授权等待到冷恢复的完整路径。
- 最小输入：一个本地 Codex 任务先请求授权，完成后关闭，再发送第二条消息。
- tier：集成性质，复用现有 `src/tasks/host.test.ts` 的真实数据库 fixture；vendor transport 为 synthetic，未调用真实推理。
- Windows 初次运行因路径分隔符断言失败，改为 `path.resolve` 比较同一目录，不修改生产路径处理。

验证命令（在 `apps/cindy-terminal`）：

```text
node ../../node_modules/vitest/vitest.mjs run src/tasks/host.test.ts -t 'preserves a Codex thread across idle close|keeps a silent task occupied' --maxWorkers=1 --fileParallelism=false --reporter=dot
```

结果：4 passed、120 skipped；总耗时 53.15 秒，其中模块收集 44.78 秒、测试执行 7.96 秒。三个既有静默任务用例覆盖继续、停止和重试耗尽的占用状态；它们不构成新增回收协调器对自动继续保护的验证。该现有大文件包含集成 fixture，不宣称满足 5 秒 unit 预算，也未增加 timeout。`pnpm --filter cindy-terminal run typecheck` 和 `git diff --check` 通过。

## 队列、自动继续与竞争边界验证

在原测试内新增两个不同的状态断言，未复制新 fixture：

1. Codex 已完成本轮后，用生产队列客户端放入一条被编辑锁暂停的消息。此时 `isTurnRunning` 为 false，但 `notificationHasActiveWork` 为 true，队列投影仍包含该消息且没有发给引擎。移除该条消息并解锁后才进行冷关闭测试。这证明仅用 turn 状态作为回收条件会漏掉待发送工作；不代表自动回收已保护队列。
2. 三个既有静默任务用例，在继续／停止／重试耗尽前调用 `closeIfIdle()`，均返回 false，native teardown 次数为零，原来的继续结果断言仍通过。这补上了真实 TerminalTaskHost 下自动继续等待与关闭接口的交互覆盖；该组既有 fixture 使用 Claude，不扩大为 Codex 全部恢复路径已验证的结论。

规则依据仍为等待态保护；最小输入分别为“空闲引擎 + 一条暂停队列消息”和“silentStop + 待结算逻辑轮”。新增断言沿用现有集成文件，未增加真实等待或 timeout。最新定向结果为 4 passed、120 skipped，48.78 秒（收集 40.61 秒、测试 7.69 秒）。

另外复用 maker-core 现有测试，而非再写一套底层竞争用例：

```text
# 在 packages/maker-core
node ../../node_modules/vitest/vitest.mjs run src/maker.test.ts src/session.close.test.ts -t 'closeIfIdle|keeps the executor available|host-initiated RPC' --maxWorkers=1 --fileParallelism=false --reporter=dot
```

结果为 5 passed、176 skipped，1.28 秒。覆盖发送先取得预约时拒绝关闭、关闭先预约时拒绝迟到发送、显式关闭身份、静默继续和在途宿主 RPC。**关闭先获胜时，Session 会拒绝发送而不是自动冷恢复**；因此还必须验证宿主锁与发送入口对该竞争的处理，不能直接把这五项通过当作自动回收可上线的证据。

协调器接入要求由上述结果收窄为：在与发送相同的 route lock 内完成队列恢复与检查、持久化状态检查、Session 关闭预约和完整 teardown；关闭期间的其它 `ensureLive` 调用也必须等待同一关闭完成边界，不能取得尚未退出的旧 runtime。队列检查需包含 recovery 项和暂停项，不能只复用 `isTurnRunning`。不直接拿 `maker:close-session` 当定时回收入口，它带有取消恢复和清理输入的用户关闭语义。

尚未验证：真实 Codex 子进程退出、Linux 进程树内存收益、宿主层回收与发送竞争、回收失败，以及自动回收对队列和自动继续的完整保护。当前没有新增计时器或修改在线 VPS。

## 宿主单次回收原型

`TerminalTaskHost.reclaimIdleCodexTask(id)` 是宿主内部入口，不新增 IPC、CLI 参数或持久配置，也没有默认定时器。它用于接下来的隔离实验：

- 只接受有历史发送时间和持久线程 id 的普通本地 Codex 任务；排除远程执行、供应商组、非普通来源、Orca、Review、父子任务、插件、共享任务及具有 Goal 记录的任务。
- 运行中或 route lock 已占用时直接返回 false，不排在等待授权的发送后面。取得同一任务锁后，恢复队列、排空历史写入并检查当前宿主状态。
- 暂停、排队输入（含 recovery）、用量恢复、交互、后台任务、待切换、持久化故障和宿主关闭都会阻止回收；最后用 `Session.closeIfIdle()` 同步预约关闭。
- 从关闭预约到完整 teardown 期间，`ensureLive` 等待同一个 Promise；使用已有的 rehydrate 输入保留机制，避免把回收当成用户取消任务。
- 关闭错误向调用者返回，不报告回收成功；保留持久线程身份，由后续正常启动路径重试恢复。

定向测试改为调用该真实入口。用可控 Promise 暂停 native teardown，在此期间并发调用发送和上下文查询，验证仅创建一个替代 runtime、继续原线程、原输入不重放。模拟 transport 不支持上下文查询，因此断言恢复后的正常 capability 错误，而不是旧 runtime 的 closing 错误。随后注入一次退出未确认错误，验证回收失败且下条消息仍可在原线程完成。

首轮实验暴露两处实现／测试问题并已修正：等待授权时不能排队取得任务锁；普通任务在 SQLite 中的 source 默认为 `desktop`，不能把所有非空 source 一律排除。测试的关闭 gate 使用 finally 释放，没有增加超时预算。

最终验证：host.test.ts 定向选择 `preserves a Codex thread across idle close|keeps a silent task occupied|shares live tasks, approvals and cold channel startup`，5 passed、119 skipped，58.29 秒（收集 47.79 秒、执行 10.07 秒）；`pnpm --filter cindy-terminal run typecheck` 与 `git diff --check` 通过。fixture 使用真实宿主、Session 与 SQLite，native transport 仍为替身。当前未运行整个 host.test.ts 或全仓测试；上述耗时不是单独新用例耗时。

故障半径仍是单个本地任务 runtime：不重连 device-link，不修改协议，也不释放其它任务。本轮不涉及在线 VPS。尚需 Linux 隔离环境的真实子进程退出、整个进程树 PSS/CPU 与冷恢复延迟测量，再决定定时策略；内部原型通过不等于自动回收已启用。

## Linux 真实引擎实验：线程恢复通过，完整进程释放未通过

环境：本地 WSL Ubuntu-26.04、官方 Node v22.22.0、真实 codex-cli 0.159.2。Codex 官方 linux-x64 包 SHA256 为 `9e2d29a713b94478b240dec2f10e11324cd05fad76dc43e7c639bdf8a1337a6b`，与仓库 pins 一致。使用临时 profile、明显无效的测试 Key 和 loopback Responses 服务，不使用真实账号或付费推理。模型接口是本地 fixture，但 Codex 本身仍会创建 Git 网络 helper，不能称整个实验完全离线。

新增验证并入现有 `src/models/runtime.integration.test.ts`，沿用显式 native integration tier。两条路径分别调用内部回收入口和既有 `maker:close-session`，其余 fixture 相同。每条路径执行两次输入，真实 CLI 的第二次请求含第一次历史；持久 thread id 和工作目录不变，HTTP 请求数恰好为 2。

采样跟踪 Vitest worker 及其全部后代，以 PID + 启动时间继续追踪被 reparent 的旧子进程，避免把它们从统计里丢掉。每次采样保存 PSS、状态、CPU ticks；退出后另取真实 1 秒窗口。该真实等待属于原生性能观测，不能用 fake timer 替代。测试 finally 仅清理本测试观察到且启动时间仍匹配的残留进程，产品退出断言在清理前执行。

| 路径 / 轮次 | 回收前 PSS | 1 秒后 PSS | 差值 | 关闭耗时 | 恢复至模拟回复 | 1 秒后旧子进程 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 回收，较早严格采样 | 1299.8 MiB | 1140.0 MiB | 159.8 MiB | 41.4 ms | 921.6 ms | 4 |
| 回收，同批对照 | 1306.2 MiB | 1127.4 MiB | 178.8 MiB | 40.1 ms | 904.8 ms | 0 |
| 原有显式关闭，同批对照 | 1308.4 MiB | 1148.3 MiB | 160.0 MiB | 35.5 ms | 965.9 ms | 4 |

以上包含测试框架约 1.1 GiB 的占用，**不是正式后台的绝对内存基线**；恢复时间使用本地固定回复，不包含真实模型的网络和推理延迟。初轮仅沿当前父子关系采样得到约 178 MiB 差值，随后发现该算法会漏掉 reparent 进程，不用初轮结果证明完整释放。

CPU：Linux `CLK_TCK=100`，约 1.03 秒窗口内持续存活进程的 ticks，三轮回收前分别为 5/5/6，之后为 4/3/4。这个指标包含采样开销，且不包含窗口内已退出进程的完整 CPU 消耗，**不能证明稳定 CPU 降幅**。原始数据见 `headless-engine-idle-results.json`，顺序对应上表。

发现：Codex 主进程退出后，其 `git` / `git-remote-http` 后代会被 reparent，采样中仍处于 S（睡眠）状态而非僵尸，还可继续创建后代。它们有时自行完成，但不是在关闭返回时可靠消失。既有显式关闭同样复现，因此不是新协调器独有的回归。`stdioTransport.ts` 的退出确认针对直接子进程，现有行为不足以证明 helper 树已释放。

最终同批验证：**1 passed、1 failed、15 skipped**；失败为显式关闭 1 秒后仍有 4 个旧后代。总耗时 43.52 秒（收集 32.27 秒、执行 10.69 秒）；较早严格回收用例也曾因同类残留失败。保留严格断言，不用放宽超时、忽略 reparent 或测试清理后的状态制造通过。`pnpm --filter cindy-terminal run typecheck` 和 `git diff --check` 通过，不把它们作为原生测试通过的替代。

复现（在 Linux 实验副本的 `apps/cindy-terminal`）：

```sh
CINDY_CODEX_TEST_BINARY=/absolute/codex-package/bin/codex \
CINDY_IDLE_REPORT=/absolute/evidence/idle-comparison \
/absolute/node-v22.22.0/bin/node ../../node_modules/vitest/vitest.mjs run \
src/models/runtime.integration.test.ts -t 'reclaims a real idle Codex' \
--maxWorkers=1 --fileParallelism=false --reporter=dot
```

下一步应先解决 headless 引擎自身 helper 的退出归属与确认，再重复此实验；不要先开启定时回收，否则可能反复创建未结束的 helper。不要直接把所有用户后台进程一并杀掉，也不要改变共享 CodexAgent 的默认常驻策略。本轮未修改在线 VPS，未启用定时回收，未宣称完整 CI 通过。

## 用户选定的修复：对齐 Desktop 原生插件策略

进一步采样确认：残留 Git 在私有 `CODEX_HOME/.tmp/plugins-clone-*` 中执行 `fetch`、`remote-https` 和 `index-pack`，属于原生插件下载。诊断只输出测试目录内的相对路径和有限 Git 动作，不记录完整命令、URL 或凭证。

Desktop 的 CodexAgent 已设置 `disableCodexPluginRuntime: true`，terminal 尚未接入。先在 Linux 隔离副本验证这一候选，再由用户明确选择“采用 Desktop 策略，停用 Codex 自带插件”，随后应用到正式工作区的 `apps/cindy-terminal/src/models/runtime.ts`：本地任务和模型发现使用同一策略；远程 transport 继续由原生适配器管理，未改远程配置。

该改动禁用 **Codex 原生** `plugins` / `remote_plugin`；不是通用进程树清理器，不新增进程扫描／终止代码。Cindy `.cindy`、宿主 MCP 桥接代码与 Skill 装配代码未改动。没有证明任意用户工具树都能被完整回收，因此不得把本次修复宣传为通用子进程回收完成。

同一真实 Codex 0.159.2、Node 22.22.0、loopback 模型 fixture 下，两条 native integration 路径 **2 passed、15 skipped**，41.80 秒（收集 30.37 秒、执行 10.91 秒）。两条路径的回收前、恢复后采样均只有测试宿主与 Codex，无 Git 下载进程；关闭后剩余旧后代均为 0，持久线程及工作目录相同，每例模型请求恰好 2 次。原始数据：`headless-engine-idle-policy-results.json`。

| 路径 | 测试进程树 PSS 下降 | 关闭耗时 | 恢复至模拟回复 |
| --- | ---: | ---: | ---: |
| 单次空闲回收 | 157.1 MiB | 42.7 ms | 1028.3 ms |
| 显式关闭 | 159.9 MiB | 35.5 ms | 961.7 ms |

仍包含 Vitest 开销，仍不含真实模型推理延迟，不由短窗口推算稳定 CPU 降幅。底层既有“动态配置准备失败时仍保留禁用策略”的回归单测 1 passed、1040 skipped，3.20 秒；未修改 maker-core 的共享默认行为。最终 `pnpm --filter cindy-terminal run typecheck` 和 `git diff --check` 通过。保留前一节的失败证据以说明修复依据。

下一步可基于这个已选择的能力范围设计并验证空闲定时策略；单次回收验证不代表定时器、并发多任务或真实账号推理已验收。在线 VPS 未修改。

## 本地接入 5 分钟空闲调度

普通本地 Codex 的产品轮次结束后启动一次 5 分钟计时；已有历史的冷启动也安排计时。新发送取消旧计时，下一轮结束后重新计时。仅定时触发机会检查，实际关闭仍经过前述 route lock、输入队列、授权、恢复状态与 Session 关闭预约检查。正在运行、暂停或存在排队输入时不关闭；条件仍允许计时但本次不能关闭时，5 分钟后再检查。关闭失败只记录不含用户内容的警告，不自动循环重试。宿主退出时取消计时并等待已经开始的回收完成。

不新增配置项，不更改 Desktop 或共享 CodexAgent 的回收默认值。远程引擎、伙伴、Orca、Review、插件所有任务、共享与 Goal 等生命周期继续排除在回收范围外。故障半径保持为单个本地引擎：不重连 device-link、不清除用户历史、不影响其它引擎；下次发送复用持久线程。

Windows 定向回归 6 passed、119 skipped，62.23 秒（收集 47.12 秒、执行 14.67 秒）；覆盖旧计时失效、队列保留、忙时再检查、原线程恢复、关闭期间发送、授权等待、silent-stop 与 channel 冷启动。定时器用虚拟时间验证，保留真实日期，避免测试将真实文件锁的租期快进而不推进其心跳。测试使用真实宿主与 SQLite、替代 native transport，不等同于真实模型推理。`pnpm --filter cindy-terminal run typecheck` 与 `git diff --check` 通过。

同步本轮宿主与测试到 WSL Ubuntu 26.04 后，定时策略测试加两条真实 Codex 关闭／恢复测试共 3 passed、139 skipped，56.56 秒（收集 44.11 秒、执行 11.42 秒）。Codex 0.159.2 与 Node 22.22.0，模型仍为 loopback fixture；真实引擎用单次回收入口，未真实等待 5 分钟。两条真实关闭路径旧后代均归零、同线程恢复、各 2 次模型请求；恢复至模拟回复分别为 916.3 / 909.4 ms。

在线 VPS 未修改，未验证真实账号推理或完整 CI。此前 PSS 数据仅证明本次进程树回收的内存收益，不证明稳定 CPU 降幅。
