# 插件平台能力的客户端性能自查

2026-11-12，PR #9825。隔离性能基准以 `2c0e66c8acb95d73f7a4818f5d9a0c94bf6e84f0` 为基线，
当前代码已预合 `209212431e`；下文不把旧基准当作预合后的整客户端实测。
receipt 同步段去重已撤回，存储、终端、亲选目录与流式分片恢复每次校验重新读取；
不增加 AsyncResource、async hook 或 ALS。下文 renderer A/B 保留旧基线数据并明确标注。
本轮性能修正之后补齐了已保存 PAT／网络凭证引用；手机端建立引用和 Node Host
生产 scheduler/ssh/docs 装配不在交付范围内，未装配服务调用返回 `UNSUPPORTED_CAPABILITY`。
预合 `209212431e` 后，Node Host 复用上游已装配的 browser/computer provider 对象接入插件入口；
只把引用加入同一 provider 数组并使目录投影失效，不新增平台工厂、扫描或启动进程。
下文启动与 renderer 数字仍为注明基线的历史样本，未重测此次上游平台装配。
下表区分未使用时的路径、使用后的预算与尚未具备的能力，不把代码路径证据当作完整客户端实测。
显式调用 `host_services` 属于能力发现的消费者：它会按需生成全部服务的工具元数据，
包括尚未声明的组，供作者判断可用性；这不是普通调用热路径，也不会执行浏览器或电脑操作。

| 热点 | 未使用时的开销 | 使用后的上限 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| Desktop 启动与服务登记 | 登记只保存 provider 引用；不构建 MCP runtime、不探测 enablement、不关闭异步 runtime。普通终端输出不进入新增 ring。 | 首次查询才生成目录；目录在 provider 更换时失效。 | `hostServiceCatalog.test.ts` 的 `does not construct or probe unused providers and caches metadata until replacement`；`ptyManager.test.ts` 的 `does not retain or measure UI output when no managed reader was requested`。 | 已修复两处未使用路径回退。存在静态模块求值和少量对象分配，未测完整 Desktop 冷启动时间。 |
| Node Host 启动 | provider 工厂未被目录登记调用；装配后的新增活跃资源为 0，无 PTY 启动。 | 实际调用才生成 MCP server；终端按需 spawn。 | 隔离生产装配 0.78 ms；`resourcesBefore/After/AfterClose` 均 `[]`，见原始 JSON；`HostTerminalService` 构造函数仅建立 manager / sink / map。 | 无新增定时器、连接或子进程的代码路径与隔离资源证据；不代表完整 Host 启动耗时。 |
| Node browser / computer 插件入口 | 复用上游为 Agent 创建的 provider，仅登记对象引用。未声明组的调用在第一个 `await` 和运行时工厂之前同步拒绝，不进行 provider 查找、enablement 探测、审批或确认；没有调用时不进入 gateway。 | 仅允许已声明且获批准的插件调用；沿用客户端、电脑开关、输入协调器与调用身份门禁。原生 worker 由上游 `beforeCall` 懒建，停用沿用原清理路径；不新建平台实现或资源预算。 | `apps/host/src/main.ts:655–665`；`hostServiceCatalog.ts:21–26`；`hostToolSlot.ts:47–58`；`hostToolCaller.ts:122–129`。`hostToolSlot.test.ts` 的 `rejects undeclared %s before constructing its runtime` 覆盖 browser/computer/docs，断言拒绝且工厂、审批、确认与执行均为 0；Node `tools.test.mjs` 的共享 provider 与 lazy worker 回归。 | 未声明时没有新增 provider 热路径工作；启动仍有两个引用登记与 dirty 标记，不宣称绝对零分配。平台工厂原由上游 Agent 装配，不在插件入口重复运行；完整启动/CPU 未重测。 |
| 每次 `host.call` | 没有调用时不执行 gateway；未声明的新服务组在工厂之前拒绝，未批准调用不创建输出目录。 | provider 查找是内存数组查找；computer runtime 按插件与安装 revision 缓存。批准事实每次校验实时读盘，不做同步段或跨调用缓存。 | `hostToolSlot.test.ts` 的 `rejects undeclared %s before constructing its runtime`、`creates a private output directory only for an approved Desktop service execution`；下文 50 次调用基准。 | 已移除新增的提前 `mkdirSync`。保留重复读取开销，沿用公共授权链，不增加去重机制。 |
| 已保存凭证复用 | 普通密钥仍只有原先一次读取；同步比较非密钥标记后直接沿原路径，不调用引用解析器。管理器按需构造，没有新定时器、订阅或后台同步。 | 使用引用时只按精确实例键复核来源／目标，直接读取现有 vault；不缓存批准、不在网络或流续读中枚举已装插件。只有用户打开或刷新凭证选择目录时枚举可选来源。 | `networkSlot.test.ts` 的 `rejects a marker without an approved reference and does no reference lookup for an ordinary key`；`ghostSavedCredentials.test.ts` 的 `stores only a reference, resolves the original value freshly, and stops on source removal` 同时断言注入与守卫未新增目录扫描。 | 未使用路径有同步短路的测试证据；未新增 renderer 结构或常驻资源。上述 renderer A/B 数字早于本次文案增量，不能当作当前提交的体积实测。 |
| 文件监听 | `GhostFsSlot` 仅建立空 map；没有 `watch` 请求不订阅 watcher。 | 每插件最多 32 个 watcher、每 watcher 256 条事件；同一目录 / 调用复用；插件显式批量拉取，无新增逐事件 renderer IPC 或轮询。 | `fsSlot.ts:505,529`；`fsSlot.test.ts` 的 `workdir:监听通过游标续读，拒绝他插件，交卷立即释放宿主 watcher`、`workdir:监听缓冲缺口明确要求重读，且取消建订阅不会留下 watcher`。 | 有数量、缓冲与生命周期上限。复用现有 watcher-host 原生批事件通道。 |
| 大目录列举 | 无请求时不枚举目录。 | 列举回复最多 2000 条；共享 core 在 `readdir` 完成后检查，超限返回 `DIRECTORY_TOO_LARGE`。 | `fsSlot.ts:543`，`packages/file-browser-core/src/scanner.ts:308`。该 `listDir` 在基线已存在，文件浏览界面也使用。 | **未分页**；完整枚举的时间 / 临时内存不受 2000 限制。本 PR 保留主干行为，不新增分页语义。 |
| 大文件读写 | 无请求时无文件 IO。 | 单次读写最多 16 MiB。授权目录读内部按 1 MiB 分块，再合成完整回复；写为有上限的单次原子写。handoff / media 存储读取按 64 KiB。 | `fsSlot.ts:550–560`、`shared/ghost.ts` 的 `GHOST_FS_READ_MAX_BYTES / GHOST_FS_WRITE_MAX_BYTES`；`storageProviders.ts:65`。 | 文件 IO 分块不等于插件 API 支持流式读写；完整回复仍可能占用 16 MiB 加编码开销，已明确记为边界。 |
| 终端与后台作业 | UI PTY 保持原 push 路径，不计算输出字节、不生成续读 ring；插件停用不创建未用过的终端服务。 | exact owner 最多 10 个启动中 / 运行中 / 停止中作业；第 11 个拒绝。运行输出 256 KiB / 256 段，终态 16 KiB，单次续读 64 KiB；最近 100 条终态按结束顺序回收；停用释放。 | `ptyManager.test.ts` 的配额、终态 101、Unicode ring、待启动取消与空闲清理用例；`lizi_xdtHelperMcpServer.test.ts` 的 `returns the stable managed-job limit and capacity through the shared terminal tool`。 | 无后台输出推送给插件；只有显式续读，无定时器。配额不影响 UI PTY 或未使用此新服务的主干 Agent 终端。 |
| HTTP stream / WebSocket | 构造只有空 map / set；没有连接不建计时器或 socket。 | 每插件最多 4 条连接；每连接 1 MiB / 256 事件 ring；读批最多 128 KiB、等待最多 20 秒且最多 4 个等待者；闲置 5 分钟关闭。WS 每消息 64 KiB、握手 30 秒、禁压缩；发送在 `bufferedAmount > 1 MiB` 时拒绝，最坏再容纳一个 64 KiB 消息。 | `networkConnections.ts:6–8,41,68–71,149,200–216`；`networkSlot.test.ts` 的 `bounds stream history, reports a cursor gap, and expires abandoned connections`。 | 发送有背压拒绝；接收采用有界丢旧 ring，**不向传输层暂停读取**，缺口用 `resetRequired` 告知，不能当作无损流。 |
| 共享存储 | Desktop 首次 `storage` 调用才构建服务；Node 装配只建 provider 引用及 map，不读业务数据、不建订阅。 | provider 由 map 定位，普通读写不扫描全插件。`targets` 才显式列举。分享每来源同时 1 次；文件最多 64 MiB，确认前后各验摘要；写入复用原 handoff 配额。 | `storageService.ts:47–108`，`storageProviders.ts`；`storageService.test.ts` 的同来源单飞、撤权、替换与不确定回执用例。 | 没有新增定期扫描或另一份持久数据。完整快照和再次复核各占有界内存，64 MiB 不是流式分享。 |
| 服务登记与停用 | 没有活跃 computer runtime 时不构建花名册批准 map；空目录不启动插件。 | computer 连接按安装拥有；停用、崩溃、更新与账号变化关闭。已查询的目录仅保留元数据至 provider 更换，不保留原生连接。 | `ghostLocalizationRefresh.test.ts` 的 `skips computer approval reconciliation when no plugin has a live computer runtime`；`hostToolSlot.test.ts` 的 stop / crash / update 表驱动用例。 | 已修复空闲对账开销；没有新注册中心、后台扫描或消费者轮询。 |
| 常驻开销 | 新增的 confirm-dismissed 监听仅在有待决确认时建立；未声明 OAuth 的详情组件同步返回，不执行 controls 的 effect / IPC。 | 确认结束后释放监听；network 每活跃连接 1 个闲置 timer，显式长读有短 timer；全部关闭后释放。 | `GhostInstallConsentHost.test.tsx` 的撤回用例同时断言首次订阅为 0、待决为 1、结束退订为 1；`GhostAccountReuseSection.tsx:11–14`；隔离资源结果。 | 无新增空闲轮询、watcher 或后台进程。完整客户端 CPU / RSS 未实测；下文隔离样本不支持“整客户端零回退”的结论。 |
| Device Link / 多客户端 | 没有新跨设备定时调用；`packages/device-link` 与协议包相对本 PR 基线无 diff。 | 沿用每帧 2 MiB、InvokeScheduler 每设备常规并发 12 / 后台 4、交互额外 2、等待队列 128。新 Node 确认复用已协商 SSE，心跳沿用既有 15 秒，不另开流。确认发送积压超过 1 MiB 或 `write=false` 且未排空时拒绝，不排队。 | `device-link-protocol/src/protocol.ts:26`、`device-link/src/invokeScheduler.ts:12–24`；Node `host-tools.test.mjs` 的 negotiated event-stream 回归。 | 并发上限不是每秒限流；本 PR 不增加自主请求频率。慢端确认按无法送达取消，迟到肯定回答不能启动作业；原任务事件 writer 的积压行为是基线已有，未修改。 |
| renderer bundle | 账号复用界面仍在 `GhostPluginPage` 懒加载 chunk，不进初始静态依赖闭包。 | 同依赖、同配置生产构建比较全部 JS 与初始闭包的 raw / gzip。 | 见下文 A/B 数字与构建脚本。 | 体积确有小幅增长；不以构建时间推断运行性能。 |

Node 私有桥最多保留 8 个待决请求。`fetch` 的传输兜底为宿主已有媒体上限 300 秒加
原 60 秒桥预算，共 360 秒；实际网络超时仍由原 `networkSlot` 按请求模式裁决，
不会把普通请求的超时扩大到 360 秒。其它网络操作仍为 60 秒。等待中的网络请求与
宿主工具调用一样计入 Worker 活跃工作；成功或失败后才恢复空闲回收。
回归为 `nodeHostServicesClient.test.ts` 的 90 秒媒体回执与 360 秒兜底，
以及 `nodeRuntimeBroker.test.ts` 的并发 network 成功/失败后回收矩阵，均用假时钟。

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
| `terminal_list` | 29 | 9.74 ms | 19.48 ms | 5.58 ms |
| `host_services` | 27 | 11.56 ms | 24.26 ms | 6.52 ms |
| `storage_request providers` | 28 | 7.16 ms | 16.43 ms | 3.78 ms |
| `storage_request call` | 34 | 8.39 ms | 14.71 ms | 3.87 ms |

这是在 `2c0e66c8ac` 上重放并撤回四处去重后的工作区结果，**不是延迟门禁**：测量期间
有其它类型检查并行，耗时受机器调度影响。数量在 50 次样本中一致。公共授权层与本线均
保留每次重新读取，不计划再加同步段去重或 mtime 缓存。

隔离装配耗时 0.78 ms；装配前后及 close 后 `process.getActiveResourcesInfo()` 均为空。
2 秒空闲控制样本 CPU 20.38 ms / 1.02% 单核，装配后 23.66 ms / 1.18%；heap 增量分别
34,480 / 21,256 字节，RSS 分别下降约 66.98 / 1.69 MiB。这种短样本受 GC / 模块初始化
与并行任务影响，不能用来判断 CPU 差值是否为功能回退，更不能外推完整 Electron 的 CPU / RSS。

## renderer 生产构建对照（旧基线记录）

以下对照基线为 `fa54e46fab46ce535d1a9f526291202c00e55e3f`，不是当前 `2c0e66c8ac`。
尚未重跑新基线的 renderer 构建，不将这些数字描述为当前 head 的体积结论。

[脚本](plugin-platform-services-renderer.mjs)从仓库根运行，使用真实 `vite.renderer.config.ts`，
相同依赖、相同构建配置。基线通过 `git show` 源码覆盖载入，新增模块若意外被基线载入即失败；
不是用当前源码冒充基线。不切工作区，不生成被 Git 跟踪的构建产物。
初始大小为 entry 和全部静态 imports 的闭包，不包括动态懒加载 chunk。

```sh
NODE_OPTIONS=--max-old-space-size=12288 node docs/performance/plugin-platform-services-renderer.mjs
```

后续基线变化时可将新基线 SHA 作为脚本第一个参数，保留相同依赖和统计口径。

最终数字包含 `9fc4e3fb06` 的 UI 生命周期修正，见[原始 JSON](plugin-platform-services-renderer.json)。
构建启动记录的 parent 为 `08c3af0977`，当时工作区中的两个 UI 源 / 测试文件随后原样提交为
`9fc4e3fb06`；`git diff 08c3af0977..9fc4e3fb06 --name-only` 可核实只有这两个文件。

| 范围 | 基线 raw | 修正后 raw | raw 增量 | 基线 gzip | 修正后 gzip | gzip 增量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 初始静态闭包 | 1,244,797 | 1,249,472 | +4,675 B | 378,269 | 379,660 | +1,391 B（0.37%） |
| 全部 JS（265 chunks） | 30,143,971 | 30,200,033 | +56,062 B | 8,823,192 | 8,839,118 | +15,926 B（0.18%） |
| 插件详情懒加载 chunk | 273,693 | 276,557 | +2,864 B | 72,198 | 72,969 | +771 B |

基线 / 修正后的构建耗时分别 100.2 / 294.4 秒，有并行类型检查；这是构建墙钟，不用于
判断客户端运行或冷启动快慢。前一轮低负载样本的源码体积结论一致，构建墙钟为 17.5 / 22.9 秒。

## 验证与剩余边界

新基线恢复逐次读取后：六个 Desktop 文件共 432 项；首次因回调夹具缺少重放后的依赖，
出现 24 项失败。补齐依赖后，失败集所在 `hostToolSlot.test.ts` 的 54 / 54 通过，其余五文件
378 项已通过。MCP dispatcher / provider 两文件 66 / 66 通过。后续门禁结果另随提交记录更新。
新增短路与确认生命周期三文件 16 / 16；Node Host 的 tools、server、plugins、input-queue
四文件 82 / 82。Desktop / Host 类型检查、i18n 与术语检查、文档 11 / 11 及 Skill 105 检查通过。
本地其余 CI 对应检查已跑：test-hygiene、settings-search、design-colors/inventory、endpoints、
brand、Desktop/Mobile/maker-core guards、Device Link 编译及互通 10 / 10、迁移、scheduler guard
和 Mobile scope 均通过。Mobile typecheck 在本机有既有的 7 处 Agent-Net `timer.unref` TS2339，
相关源文件相对基线无 diff。runner 自测为 732 通过、2 跳过、1 失败：
`whoami attributes a shared personal shell to its business checkout` 的 fixture 使用固定 app 路径，
原 `scripts/desktop-whoami.mjs:194` 仅识别工作树的 node_modules/electron，返回空列表。
生产脚本及测试与 `2c0e66c8ac`、核对时的 `origin/main` 均相同；该项只在 macOS 运行，
CI verify-checks 使用 Ubuntu。未修改这些基线问题，也未将本地门禁描述为全绿。
以下是此前基线的验证记录，不代表已在新基线全部重跑：

- Desktop 七个服务测试文件：307 / 307，5.31 秒；包含文件、网络、存储、PTY、gateway、catalog、花名册路由。
- 流式分片去重用例已随实现撤回；原网络撤权与缓冲行为用例保留。
- MCP dispatcher：58 / 58，1.17 秒；含结构化配额错误。
- Renderer 确认生命周期：6 / 6；回归复现阶段单独运行 3.22 秒，修正后在并行检查下 8.36 秒。
- Node Host `host-tools.test.mjs` + `plugins.test.mjs`：12 / 12；最终回归 15.84 秒，使用真实 Worker / PTY 的已有用例。
- SSE 背压修正：`host-tools.test.mjs` + `server.test.mjs` 26 / 26，5.04 秒。
- Host 与 Desktop 最终类型检查均通过。未运行全量测试。
- `check:dev-docs` 11 / 11；`check:test-hygiene` 通过；范围与 whitespace 检查通过。
- 纯生命周期修正没有布局 / 样式 / 文案改动；未重新进行 Light / Dark 实机目检，不把逻辑单测当作截图验收。

新增 Node `host_prompt` SSE writer 的背压回归已复现旧代码错误：慢端积压后仍接受迟到的肯定
回答，进入了测试 terminal.start。修正只让此 writer 在发送缓冲超过 1 MiB，或 `write=false`
且缓冲未排空时返回 false；沿用原确认桥的“无法送达”取消，不排队、不重试、不关闭其它
控制端。原任务事件 writer 的同类问题是主干已有，未修改。

后续 PR 风险段须保留：receipt 每次实时读取及其开销、主干完整枚举超大目录的行为、
16 MiB 的完整文件回复、网络接收丢旧语义、托管作业预算及错误结果，并明确区分 DSH 三个
数值与 Cindy 额外的 100 条上限。PAT / 手机引用、Node Host 缺失的生产服务、完整安装产物链、
真实第三方 OAuth 和跨平台原生输入的未验证项仍沿用既有 PR 风险，不在此次性能修正中扩范围。
