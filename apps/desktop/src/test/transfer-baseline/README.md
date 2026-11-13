# Device Link 传输量基准

一条命令跑完一段固定的远程会话，数出控制端套接字上每个阶段、每个通道、两个方向
实际传了多少字节：

```bash
pnpm transfer:baseline
# 只跑一种控制端 / 指定输出目录
TRANSFER_BASELINE_PROFILE=phone TRANSFER_BASELINE_OUT=/path/outside/repo pnpm transfer:baseline
# 逐项开关能力（见下文「能力开关」）
TRANSFER_BASELINE_EXTRA_CAPS_PHONE=<能力名> TRANSFER_BASELINE_DROP_TRANSFER=delta pnpm transfer:baseline
```

结果写到 `TRANSFER_BASELINE_OUT`（默认系统临时目录下的 `cindy-transfer-baseline/`）：
`transfer-baseline.json`（机器可读）和 `transfer-baseline.md`（汇总表 + 分通道明细）。
不要把输出目录指到仓库里。当前是场景版本 4（JSON 的 `scenario.version`）、报告格式版本 5
（`schemaVersion`，各版本加了哪些字段见 `report.ts` 开头）。

## 自检

分片完成前后的重复帧，字节数、帧数和重传次数都归到实际通道；重组中的重复计数随消息一起结算。
只验证这个计数口径（内存套接字，不跑完整会话）：
`pnpm --dir apps/desktop exec vitest run --config vitest.transfer-baseline.config.ts -t 'wire meter attributes'`。

每次运行都先写出结果，再检查各阶段确实量到了它名字所说的东西，有一项失败命令就失败：
每个阶段都有被控端发出的流量；展开工作组读到工作项详情；可见工具结果那一轮收到 6 个
`tool_result_full` 事件；展开后的刷新、列表重读、不跳过的预读（5 页）、展开运行中工作组都发生了。
完整运行两种控制端共 48 项，`TRANSFER_BASELINE_SCOPE=lists` 共 16 项；结果在 JSON 的
`selfChecks` 与 Markdown 开头。推送解不开时相关检查记为 `unknown`，不算失败（见「推送与列表增量补丁的压缩」）。

每个阶段的 `signature` 记录整页读次数 / 304 次数、详情读次数 / 304 次数、工作项补丁 / 历史通知
条数。四个有控制端在看的运行中轮次按「分步节奏」执行（见下），结果是确定的：同一提交的不同
运行之间每个阶段的 `signature` 应当一致，不一致说明这次运行走了另一条时序。

## 能力开关

不改代码就能给两种控制端追加或去掉声明的能力，用来在同一份代码上逐项量边际收益。基准不理解这些名字，只是透传：

| 变量 | 作用 |
| --- | --- |
| `TRANSFER_BASELINE_EXTRA_CAPS` / `TRANSFER_BASELINE_DROP_CAPS` | 追加 / 去掉 link-open 和 `device-link:subscribe` 里声明的能力 |
| `TRANSFER_BASELINE_EXTRA_HELLO_CAPS` / `TRANSFER_BASELINE_DROP_HELLO_CAPS` | 追加 / 去掉 hello 里的能力 |
| `TRANSFER_BASELINE_DROP_TRANSFER` | 去掉客户端逐请求加在 `transfer` 里的字段（例如列表请求的 `transfer.delta`）。在发出前改写，计量看到的是改写后的帧 |

- 都是逗号分隔；加 `_PHONE` / `_DESKTOP` 后缀只作用于一种控制端，两者同时生效。
- 去掉能力只覆盖 profile 自己声明的部分，客户端在 openLink 里自动追加的传输能力（`reliable-transport-v1` 等）不受影响。
- 逐请求字段只能去掉，不能追加：客户端不会解码的字段加上去会出错。
- JSON 的 `profiles.<id>.declared` 记录这次在线上实际声明的能力（hello、link-open、subscribe），`switches` 记录用了哪些开关。

`profiles.ts` 里两种控制端声明的能力列表抄自产品代码（文件与行号写在各字段旁边），不会自动跟着
产品变：产品给手机或电脑控制端新增声明的能力时，要同步改这里，否则基准量的是少声明了能力的
控制端。客户端在 openLink 里自动追加的传输能力不在此列，直接随产品代码生效。

线束级开关（不按控制端加后缀，默认都与生产一致，JSON 顶层 `harness` 记录取值）：

| 变量 | 作用 |
| --- | --- |
| `TRANSFER_BASELINE_PHONE_STOP_RETAIN=0` | 手机退后台时调不带参数的 `client.stop()`，不保留结果缓存。默认与生产相同，调 `client.stop({ retainResultCache: true })`；`stop()` 不认这个参数的客户端运行时忽略 |
| `TRANSFER_BASELINE_PMD_HOST=0` / `TRANSFER_BASELINE_PMD_CONTROLLER=0` | 被控端 / 控制端的 ws 客户端不提出 permessage-deflate（例如模拟不支持它的 iPhone socket）。不设时不传选项，与生产相同 |
| `TRANSFER_BASELINE_REALISTIC_ROWS=1` | 任务列表行换成「接近真实」的形状：`sessions` 表每一列都按行取不同值（固定种子），并带标签。默认行只填少数几列，各行大量相同，压缩比偏高 |

调试用：
- `TRANSFER_BASELINE_TRACE=live_turn,…`（或 `*`）：在 JSON 里保留这些阶段逐条消息的时间线；
- `TRANSFER_BASELINE_SCOPE=v1`：只跑到 v1 的四个阶段为止；`=lists` 只跑 v3 的列表阶段（两种规模）。

## 推送与列表增量补丁的压缩

产品代码导出推送字典（`PUSH_TRANSFER_DICTIONARIES`，或只有一个 `PUSH_TRANSFER_DICTIONARY_V1`）时，
以 `transfer.deflateBase64` 承载的压缩推送由计量器用同一份字典解开，计入解压后字节，并在通道行的
`deflatedMessages` 计数；解不开或代码里没有对应字典时记入 `decodedUnknownMessages`，不把压缩后的
大小当解压后字节。控制端是否声明压缩推送由产品客户端自己决定（两端注入的都是生产的 `desktopTransferCodec`），基准不另做开关。

列表增量回包的补丁以 `transfer.delta.gzipBase64` 压缩时同样解开：计入 `gzipMessages`，解压后字节按补丁原文计；
解不开的记入 `decodedUnknownMessages`（明细键 `delta:unknown`）。产品里没有这种回包时不受影响。

## 阶段

阶段名后的 v2 / v3 / v4 是该阶段加入的场景版本；新阶段只往后加。v4 把四个有控制端在看的运行中轮次改成
分步节奏（见下），其余已有阶段的口径不变。

| 阶段 | 内容 |
| --- | --- |
| `open_long_task` | 冷打开 10 轮长任务（每轮 5 个命令 + 1 个约 879 KiB 的结果，落库截到 8 KB） |
| `live_turn` | 任务页开着，被控端跑一轮：文本流 + 5 个工具 + 1 个 1.05 MiB 结果 |
| `reconnect` | 控制端断网，期间被控端跑完一轮短对话，恢复后补齐 |
| `sidebar_refresh` | 新起的控制端读任务列表，并预读 5 个任务的历史 |
| `live_turn_tool_results`（v2） | 一轮普通大小、不会被推迟的工具结果（Edit / Write / TodoWrite / 插件调用 / Agent / 失败命令，几十字节到 12 KB）。按生产形状带 `resolvedContent` |
| `expand_work_groups`（v2） | 展开一个已折叠的历史工作组，再收起；然后展开装着 1.05 MiB 结果的工作组 |
| `live_turn_with_expanded`（v2） | 上面那个已完成的工作组保持展开，被控端再跑一轮 |
| `foreground_list_unchanged` / `foreground_list_changed`（v3，手机） | 手机已经读过一次列表；退后台超过宽限期（`client.stop({ retainResultCache: true })`，与生产相同），回前台（`connectAllNow`），由恢复核心 reseed，再重读列表。后者在后台期间有 1 个任务写了一条消息。预读会跳过本进程已读过、版本没变的任务 |
| `reconcile_list_unchanged` / `reconcile_list_changed`（v3，电脑） | 电脑端定时对账（不带 `fresh`）。后者在两次对账之间有 1 个任务写了一条消息 |
| 以上四个加 `.rows200` 后缀（v3） | 同样的阶段换成 200 个任务的列表，与列表读取上限 200 相同 |

v3 的两种列表规模各用一个全新的被控端，和 v1/v2 用的那个被控端分开，所以两种规模之间只差任务行数。

v4 再加一个被控端，依次跑四个阶段。这个控制端先在首页读列表并预读，再打开长任务：

| 阶段 | 内容 |
| --- | --- |
| `reconnect_after_prefetch` | 断线重连，按真实 App 保留本进程的预读记录：没变的任务跳过 |
| `reconnect_after_prefetch_noskip` | 同样再来一次，但不跳过，量出这 5 页重读各多大（看 `session:<id>` 拆分） |
| `reconnect_after_long_turn` | 离线期间被控端跑完一整轮带普通大小工具结果的长轮次，然后重连补齐 |
| `live_turn_expanded_running` | 控制端展开运行中的工作组，然后被控端发出一条 1.05 MiB 的结果（生产形状，带 `resolvedContent`） |

**分步节奏**：`live_turn`、`live_turn_tool_results`、`live_turn_with_expanded`、`live_turn_expanded_running`
这四个有控制端在看的运行中轮次，每走一步（用户消息、思考、每个工具、回答）都等控制端的去抖读取跑完、链路静默后
再走下一步，读取与被控端落库之间没有竞争。

`connect`、`connect_cold`、`extra_open`、`v3_connect`、`v3_list_first`、`v3_tick_first`（含 `.rows200`）、
`v4_connect`、`v4_home`、`v4_open` 是准备阶段，单独列出。JSON 的 `channels[].breakdown` 拆开解压后字节：
- `event:<type>`：maker:event，含批内；
- `row:<role>`：`messages:created` 推送、`work-details` 结果里的消息；
- `body:sent` / `body:reused`：`messages:view` / `list` 结果里正文是整段发出还是复用；
- `session:<id>`：按目标任务拆开历史读取，同时带 `wireBytes`。

## 走了哪些真实代码

```
控制端 DeviceLinkClient ── ws ──▶ 自建中继 (packages/device-link-relay, 127.0.0.1) ── ws ──▶ 被控端 DeviceLinkClient
  ▲ 计量点：控制端 socket                                                                  │
  共享 HistoryViewController                                       dispatch.desktop（订阅、推送、批、投影、gzip）
  Mobile 恢复核心（重连）                                          ipcMain 捕获 → registerMessageIpc / registerSessionIpc
                                                                   真实迁移链建出的 SQLite
```

- 中继：完整初始化 + 加入流程拿到三台设备凭证，只监听回环地址，结束后删除临时目录。
  帧不带自建中继的设备签名（与官方中继线格式相同）。
- 被控端：`createInboundDispatch` 的 Desktop 装配、`desktopTransferCodec`、真实的
  `local-db:messages:view` / `work-details` / `view-intent` / `sessions:list` / `sessions:get`。
- 控制端：真实 `DeviceLinkClient`（可靠层、结果缓存、gzip、正文复用、标签目录），
  历史读取、去抖和工作项补丁走共享 `HistoryViewController`；手机重连走
  `rehydrateDeviceLinkPeer` + `PeerRecoveryScheduler`。

不是真实代码、需要知道的地方：

- 运行中一轮由脚本在主进程广播边界（`tapWindowBroadcast`）注入 `maker:event`，行通过真实
  `createMessage` 落库并发出 `local-db:messages:created`；Agent 运行时与事件准备链不跑。
- 几个小读请求（`maker:get-pending-interactions`、`maker:input:get-projection`、
  `maker:list-active`、`maker:goal:get-status`、项目别名、Desktop 侧栏的定时任务 / 伙伴列表）
  用空结果桩，报告里标 `stub`：请求条数和信封开销是真的，正文是空的。
- 控制端 App 外壳（界面、磁盘快照、目录 / 模型 / git 设置预取）不在内；各场景的请求顺序
  按 `scenarios.ts` 里标注的控制端代码脚本化。
- 心跳拉长到 1 小时，避免周期帧落进某个阶段；直连（WebRTC）与 Agent 网络路径不在内。

## 口径

- `wireBytes`：WebSocket 帧字节（帧头 + 载荷）。当前未协商 permessage-deflate（报告里
  `extensions: none`），载荷就是 JSON 文本帧。
- `decodedBytes`：可靠层重组、解开结果 gzip（含列表增量补丁）与推送压缩之后的逻辑消息字节，即接收端要解析和持有的量。
- `messages` / `frames`：逻辑消息 / WebSocket 帧条数。`tcpBytes` 是同一 socket 的 TCP
  字节，用来核对 `wireBytes`（只多出重连时的 HTTP 升级握手）。一旦协商了
  permessage-deflate，逐帧的 `wireBytes` 是压缩前的帧字节，阶段合计以 `tcpBytes` 为准。
- 两端的 `createWebSocket` 在 `hostHarness.ts` / `controllerHarness.ts` 里按生产选项（只带鉴权头）
  自建；要量不同的 socket 选项（例如启用压缩）时同时改这两处，中继侧用的是生产的 `startRelayServer`。
- 同一提交重复运行，数据通道字节一致，只有新写入行的随机 id 会让 gzip 结果差几个字节；
  累计 ACK 每个方向可能多或少一条，小阶段的合计因此会有几个百分点的波动。
  JSON 里的 `dataTotals` 不含 ACK 和中继控制帧，做比较或设上限时用它更稳。
