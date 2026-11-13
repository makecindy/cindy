# 插件平台能力的客户端性能自查

2026-11-12，PR #9825，基线 `209212431e552c2667dae662a0b96a205e86a66a`。
范围为授权文件与监听、终端与作业、服务目录、存储提供者、生命周期及 Node Host 接线。
第 23 项网络扩展与第 25 项凭证委派移至后续 PR，不属于下表或本 PR 的性能结论。
receipt 每次校验重新读取；不增加 AsyncResource、async hook、ALS 或跨调用缓存。
代码路径证据与隔离样本不等于整客户端冷启动、CPU 或 RSS 实测。
`host_services` 是显式消费者，按需生成服务工具元数据，不能将该查询计入未使用路径。

| 热点 | 未使用时的开销 | 使用后的上限 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| 逻辑页首次启动 | 没有状态变更就不运行回调。新增资源释放同步排除 `starting/running`，不创建资源。 | 仅沿既有退出态释放文件、终端与电脑资源；没有新定时器。 | `hostToolSlot.test.ts` 的 Desktop/Host × stop/crash/update 矩阵，从真实 `GhostRuntime` 启动前已有连接开始。 | 常驻 Node 资源跨逻辑页启动保持，停止/崩溃/更新仍释放；原模型与任务调用失效路径不变。 |
| Desktop 启动与服务登记 | 登记只保存 provider 引用；不构建 MCP runtime、不探测 enablement、不关闭异步 runtime。普通终端输出不进入新增 ring。 | 首次查询才生成目录；目录在 provider 更换时失效。 | `hostServiceCatalog.test.ts` 的 `does not construct or probe unused providers and caches metadata until replacement`；`ptyManager.test.ts` 的 `does not retain or measure UI output when no managed reader was requested`。 | 已修复两处未使用路径回退。存在静态模块求值和少量对象分配，未测完整 Desktop 冷启动时间。 |
| Node Host 启动 | provider 工厂未被目录登记调用；装配后的新增活跃资源为 0，无 PTY 启动。 | 实际调用才生成 MCP server；终端按需 spawn。 | 隔离生产装配 5.28 ms；`resourcesBefore/After/AfterClose` 均 `[]`，见原始 JSON；`HostTerminalService` 构造函数仅建立 manager / sink / map。 | 无新增定时器、连接或子进程的代码路径与隔离资源证据；不代表完整 Host 启动耗时。 |
| Node browser / computer 插件入口 | 复用上游为 Agent 创建的 provider，仅登记对象引用。未声明组在第一个 await 和工厂之前同步拒绝；没有调用时不进入 gateway。 | browser 沿用原后端与门禁；Node 插件 computer 在 runtime、确认和驱动之前明确不支持，能力发现同样标记不可用。Agent provider 与 Desktop 路径不变。 | `hostToolSlot.test.ts` 的未声明拒绝、Desktop 快照保留/stop/crash/update；Node `host-tools.test.mjs` 的 `Node plugins cannot create computer snapshots or execute, while Desktop plugins retain the provider`，断言两次拒绝且 runtime/确认/执行均为0，同时 Agent/Desktop 可执行。 | Node 不保留不可用的插件 computer runtime，不新增跨进程授权证明、缓存或 timer；平台工厂仍只由上游装配。完整启动/CPU 未重测。 |
| 每次 `host.call` | 没有调用时不执行 gateway；未声明的新服务组在工厂之前拒绝，未批准调用不创建输出目录。 | provider 查找是内存数组查找；computer runtime 按插件与安装 revision 缓存。批准事实每次校验实时读盘，不做同步段或跨调用缓存。 | `hostToolSlot.test.ts` 的 `rejects undeclared %s before constructing its runtime`、`creates a private output directory only for an approved Desktop service execution`；下文 50 次调用基准。 | 已移除新增的提前 `mkdirSync`。保留重复读取开销，沿用公共授权链，不增加去重机制。 |
| 文件监听 | `GhostFsSlot` 仅建立空 map；没有 `watch` 请求不订阅 watcher。 | 每插件最多 32 个 watcher、每 watcher 256 条事件；同一目录 / 调用复用；插件显式批量拉取，无新增逐事件 renderer IPC 或轮询。 | `fsSlot.ts:505,529`；`fsSlot.test.ts` 的 `workdir:监听通过游标续读，拒绝他插件，交卷立即释放宿主 watcher`、`workdir:监听缓冲缺口明确要求重读，且取消建订阅不会留下 watcher`。 | 有数量、缓冲与生命周期上限。复用现有 watcher-host 原生批事件通道。 |
| 大目录列举 | 无请求时不枚举目录。 | 列举回复最多 2000 条；共享 core 在 `readdir` 完成后检查，超限返回 `DIRECTORY_TOO_LARGE`。 | `fsSlot.ts:543`，`packages/file-browser-core/src/scanner.ts:308`。该 `listDir` 在基线已存在，文件浏览界面也使用。 | **未分页**；完整枚举的时间 / 临时内存不受 2000 限制。本 PR 保留主干行为，不新增分页语义。 |
| 大文件读写 | 无请求时无文件 IO。 | 单次读写最多 16 MiB。授权目录读内部按 1 MiB 分块，再合成完整回复；写为有上限的单次原子写。handoff / media 存储读取按 64 KiB。 | `fsSlot.ts:550–560`、`shared/ghost.ts` 的 `GHOST_FS_READ_MAX_BYTES / GHOST_FS_WRITE_MAX_BYTES`；`storageProviders.ts:65`。 | 文件 IO 分块不等于插件 API 支持流式读写；完整回复仍可能占用 16 MiB 加编码开销，已明确记为边界。 |
| 终端与后台作业 | UI PTY 保持原 push 路径，不计算输出字节、不生成续读 ring；插件停用不创建未用过的终端服务。 | exact owner 最多 10 个启动中 / 运行中 / 停止中作业；第 11 个拒绝。运行输出 256 KiB / 256 段，终态 16 KiB，单次续读 64 KiB；最近 100 条终态按结束顺序回收；停用释放。 | `ptyManager.test.ts` 的配额、终态 101、Unicode ring、待启动取消与空闲清理用例；`lizi_xdtHelperMcpServer.test.ts` 的 `returns the stable managed-job limit and capacity through the shared terminal tool`。 | 无后台输出推送给插件；只有显式续读，无定时器。配额不影响 UI PTY 或未使用此新服务的主干 Agent 终端。 |
| 共享存储 | Desktop 首次 `storage` 调用才构建服务；Node 装配只建 provider 引用及 map，不读业务数据、不建订阅。 | provider 由 map 定位，普通读写不扫描全插件。`targets` 才显式列举。分享每来源同时 1 次；文件最多 64 MiB，确认前后各验摘要；写入复用原 handoff 配额。 | `storageService.ts:47–108`，`storageProviders.ts`；`storageService.test.ts` 的同来源单飞、撤权、替换与不确定回执用例。 | 没有新增定期扫描或另一份持久数据。完整快照和再次复核各占有界内存，64 MiB 不是流式分享。 |
| 服务登记与停用 | 没有活跃 computer runtime 时不构建花名册批准 map；空目录不启动插件。 | computer 连接按安装拥有；停用、崩溃、更新与账号变化关闭。已查询的目录仅保留元数据至 provider 更换，不保留原生连接。 | `ghostLocalizationRefresh.test.ts` 的 `skips computer approval reconciliation when no plugin has a live computer runtime`；`hostToolSlot.test.ts` 的 stop / crash / update 表驱动用例。 | 已修复空闲对账开销；没有新注册中心、后台扫描或消费者轮询。 |
| 常驻开销 | confirm-dismissed 只在待决确认存在时订阅；浏览器断线观察也只在各类待决确认存在时订阅，Desktop 不订阅。未请求文件监听或作业时不启动相应资源，不订阅 Session。 | 浏览器复用已有请求 AbortController 和连接状态，断线同时取消当前/排队确认，答复结束或卸载后退订。首个任务托管作业给现有作用域增加1个真实 Session 关闭订阅，后续作业复用；关闭、替换或释放时沿原 destroyed 链终止 PTY。 | `GhostInstallConsentHost.test.tsx` 的 browser operation/permission 断线、迟到肯定回答、重连新请求及空闲/Desktop 零观察回归；`ptyManager.test.ts` 的 active/closed 与退订；Host `plugins.test.mjs` 的真实 Session.close 与真实子进程退出。 | 无新请求表、自主轮询、timer 或第二状态源；整客户端 CPU / RSS 未实测。 |
| Device Link / 多客户端 | 没有新跨设备定时调用；`packages/device-link` 与协议包相对本 PR 基线无 diff。 | 沿用每帧 2 MiB、InvokeScheduler 每设备常规并发 12 / 后台 4、交互额外 2、等待队列 128。新 Node 确认复用已协商 SSE，心跳沿用既有 15 秒，不另开流。确认发送积压超过 1 MiB 或 `write=false` 且未排空时拒绝，不排队。 | `device-link-protocol/src/protocol.ts:26`、`device-link/src/invokeScheduler.ts:12–24`；Node `host-tools.test.mjs` 的 negotiated event-stream 回归。 | 并发上限不是每秒限流；本 PR 不增加自主请求频率。慢端确认按无法送达取消，迟到肯定回答不能启动作业；原任务事件 writer 的积压行为是基线已有，未修改。 |
| renderer bundle | 沿用已有权限确认与详情页；账号复用组件已移至后续 PR。 | 未新增 renderer 入口、独立后台订阅或全局轮询；确认撤回订阅仅在待决时存在。 | 相对基线的 renderer diff 为权限文案、文件删除确认与确认生命周期；先前包含账号复用的 A/B 构建已随网络 PR 移走。 | 拆分后生产 bundle 体积增量未实测，不引用拆分前数字。 |

## 已修复的回退

下列修正已随本 PR 推送，新增的生产入口回归与原有点名测试通过。

- `bb9a9150bd`：普通 UI PTY 的输出不再进入新增的字节统计 / ring。
- `1f7838ca8b`：停用未用过终端服务的插件，不创建服务和账号监听。
- `58132f604a`：托管作业有并发、输出和终态条目预算；启动占位在文件 IO 前同步完成。
- `3ce52d61de`：未查询目录时，不在 provider 登记中构造 MCP runtime。
- `c06c49f374`：没有 computer runtime 时，不构建批准投影。
- `5673a6b94a`：未声明服务组在运行时工厂之前拒绝；目录准备移到批准后的异步执行阶段。
- `9fc4e3fb06`：无待决确认时不增加 confirm-dismissed 订阅。
- `88a710b480`：新增 SSE 确认 writer 在发送积压或背压未排空时按无法送达拒绝。

以上短 SHA 是首次验证时的本地检查点标识，重放后以对应测试和当前代码为准。
原四个同步段去重检查点已撤回。停用、换 owner、换安装、目录 inode 变化和确认后的迟到结果
继续由每次重新读取的检查拒绝。

## 托管作业预算的来源与结果

DSH 只读参考为 `packages/jobs/jobs-local/src/index.ts`：34 行并发 `10`，37 行运行输出
`256 * 1024`，40 行终态输出 `16 * 1024`。DSH 不提供终态条目数量 / TTL 默认值；其
`remove()` 与 owner / service teardown 分别在 342、640–679 行删除记录。

Cindy 额外增加 **每 owner 最近 100 条终态记录**：第 101 条进入终态后按结束顺序回收最早的，
不影响仍在运行的作业，不加计时器。历史输出的 UTF-8 载荷合计最多 1,638,400 字节
（约 1.56 MiB），不包含 JS 对象、字符串表示、PTY 原生缓冲或最多 10 个活跃作业的输出。
因此这不是进程 RSS 的 1.6 MB 承诺。

`terminal_start` 在满额时返回 `isError:true` 和
`{ok:false,errorCode:'TERMINAL_JOB_LIMIT',data:{current:10,limit:10,hint:...}}`。
不排队、不抢占或杀掉已有作业；停止请求仍占名额，收到退出事实后才释放。
该服务在本 PR 基线和核对时的 `origin/main` 均不存在，主干 Agent 终端不使用它；UI PTY
直接使用原 `PtyManager.create`，没有 opt-in `retainOutput`。

## 真实 receipt IO 的隔离基准

[基准脚本](plugin-platform-services-runtime.mjs)在 `apps/host` 下运行：

```sh
node --expose-gc --import tsx --import ./src/loaders/register-raw.mjs ../../docs/performance/plugin-platform-services-runtime.mjs
```

Node 22.22.3 / macOS；每条路径预热 5 次、计数 50 次，读取临时目录下 497 字节的有效 receipt。
实际调用生产 Node Host gateway、helper 和授权链；数据库端口为内存 fake，receipt IO 为真实
`GhostInstallReceiptStore.read()`。不含 `GhostManager` 的目录分类和投影，不含实际作业启动。
各次读取都检查实际文件字节，不加 mtime 或跨调用缓存。原始数字见
[JSON](plugin-platform-services-runtime.json)。

| 调用 | receipt 次数 / 调用 | p50 | p95 | 平均 receipt IO / 调用 |
| --- | ---: | ---: | ---: | ---: |
| `terminal_list` | 29 | 5.48 ms | 10.70 ms | 2.71 ms |
| `host_services` | 27 | 5.04 ms | 9.94 ms | 2.71 ms |
| `storage_request providers` | 28 | 5.25 ms | 9.63 ms | 2.62 ms |
| `storage_request call` | 34 | 5.61 ms | 11.67 ms | 3.01 ms |

这是在 `209212431e` 上拆分网络与凭证后的工作区结果，**不是延迟门禁**：测量期间
有其它类型检查并行，耗时受机器调度影响。数量在 50 次样本中一致。公共授权层与本线均
保留每次重新读取，不计划再加同步段去重或 mtime 缓存。

隔离装配耗时 5.28 ms；装配前后及 close 后 `process.getActiveResourcesInfo()` 均为空。
2 秒空闲控制样本 CPU 17.18 ms / 0.86% 单核，装配后 48.21 ms / 2.41%；heap 增量分别
34,520 / 21,256 字节，RSS 分别下降约 64.44 / 170.77 MiB。这种短样本受 GC / 模块初始化
与并行任务影响，不能用来判断 CPU 差值是否为功能回退，更不能外推完整 Electron 的 CPU / RSS。

## 拆分验证与边界

拆分后真实 Node Worker / PTY / 文件与副本交接通过 `apps/host/src/plugins.test.mjs` 的 7 项回归，
单文件 4.55 秒。该用例不再启动 HTTP / WebSocket 服务，不依赖新增凭证管理器。
保留 Desktop / Node 的 starting、stop、crash、update 生命周期矩阵，插件侧边栏浏览器仍明确拒绝，
专用浏览器、我的浏览器、Agent 与 UI 的既有路径不变。

Node Host 已装配 history、任务控制、terminal、files、storage、discovery，复用上游 browser/computer
provider；实际原生操作仍须通过客户端、开关、输入协调器与身份门禁。scheduler、ssh、docs
未装配时返回 `UNSUPPORTED_CAPABILITY`，不另建平台实现。

风险保留：receipt 实时读取的开销、超大目录完整枚举、16 MiB 完整文件回复、64 MiB 完整分享快照、
托管作业预算、原任务事件 writer 的既有背压行为。完整安装产物链与跨平台原生输入未验证。
未实测整客户端冷启动、CPU / RSS 或拆分后的 renderer bundle；不能据此声称零回退。
