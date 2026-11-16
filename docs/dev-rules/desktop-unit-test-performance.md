# Desktop 单测性能基准

> **读取时机**：调整 Desktop Vitest worker、测试分池或根级单测资源配额前

## 可复现命令

`benchmark:desktop-workers` 复用 `test-workspaces.config.mjs` 中 Desktop unit tier 的
完整排除规则，不会混入 DB、migration、guard 或 `*.bench.ts`。

```bash
pnpm benchmark:desktop-workers -- --workers 1,2,4,8 --runs 1 --output <report.json>
```

报告包含机器信息、墙钟、文件数、测试数、文件耗时 P50/P95/P99 和最慢文件。调整 worker
或分池前后必须使用同一 checkout、同一机器和同一测试范围比较；单次数据需同时保留稳定性
结果，不得只挑最快的一次。

## 2026-11-14 CI 提速：8 分片、临时目录、类型检查独立与按耗时分片

基线来自当天 4 次成功的 PR client-ci（run 43549591409、43549471962、43547498115、43546722990）：
整轮墙钟 22–26 分钟，关键路径都是 Windows 单测分片（14.3–26.3 分钟）。同一时段 job 启动等待
不超过约 1.5 分钟；更长的等待都是重跑（attempt 2）从首次创建时刻起算，不是 runner 排队。

| 组成（Windows 每片） | 实测 | 说明 |
| --- | --- | --- |
| 准备 | 约 2.8 分钟 | checkout 31 秒；setup-node 73 秒，主要是恢复约 2.2 GB 的 pnpm store 缓存；install 43 秒 |
| Desktop unit | 814–1,077 秒 | 同一批文件在 Linux 分片为 473–583 秒，约 1.8 倍 |
| Mobile、maker-core 与其余包 | 3.5–4.5 分钟 | Mobile 87–131 秒 |

- 托管 Windows runner 的工作区在 `D:\a\<repo>\<repo>`，pnpm store 已默认放在同盘
  `D:\.pnpm-store`（pnpm 在项目盘根目录建 store），store 位置不是瓶颈。
- TEMP 默认是 `C:\Users\RUNNER~1\AppData\Local\Temp`。Desktop 有 700 多个测试文件创建临时目录，
  electron stub 的 userData 也建在 `os.tmpdir()` 下，所以分片 job 把 TEMP/TMP 指到工作区所在盘的
  `D:\cindy-tmp`。
  - 不能用 `RUNNER_TEMP`（`D:\a\_temp`）：回复附件测试把路径写进 Markdown 链接，`\_` 被当成转义，
    `taskImageDelivery.test.ts` 与 `chatServerReplyFiles.test.ts` 共 52 条用例报
    `ATTACHMENT_UNAVAILABLE`（试跑 run 43556031905；本机把 TEMP 放进 `_temp` 目录可原样复现）。
    临时目录的每一段都不要以 ASCII 标点开头。
  - 这些用例走的是生产 `prepareChatReplyFiles`：真实 Windows 路径含 `\_` 时同样找不到文件（已实测
    `\_`；CommonMark 对其余 ASCII 标点也按转义处理，如 `\.config`），是否需要在生产解析里保留
    原样另行判断。
- 2026-11-14 托管 Windows 镜像（windows-2025-vs2026 20261103）的 Defender 实时扫描为关闭
  （`RealTimeProtectionEnabled=False`），不需要额外排除目录。
- Windows unit 从 4 片改为 8 片。改片数会重排每片的文件组合，可能暴露文件之间的隐藏依赖：
  `ptyManager.test.ts` 的 `HostTerminalService` 用例曾以 POSIX `/tmp` 作为 cwd 并 `realpath`，在
  Windows 上解析为 `<盘符>:\tmp`，只在同片更早的测试碰巧建过该目录时才通过（8 片后第 3 片
  10 条 ENOENT），现改用 `os.tmpdir()` 的真实路径。并集仍是完整 unit tier，由 `Windows unit tests` 汇总阻断；
  `dev-docs-contract.test.mjs` 按矩阵长度校验 1..N 与 `XDT_UNIT_TEST_SHARD` 一致。
  公开仓标准 runner 不计费，但会占用组织的并发额度；调整片数后要确认没有出现排队。
- Desktop 分片设置 `XDT_VITEST_FILE_TIMINGS` 时，`src/test/vitest/fileTimingReporter.ts`
  写出每个文件的环境、准备、收集、setup 与测试耗时，作为 `desktop-file-timings-windows-shard-*`
  产物保留 14 天，供后续按耗时分片。未设置该变量时 Desktop 不覆盖 Vitest 默认 reporters；
  设置时显式补回 GitHub Actions 下默认追加的 `github-actions` reporter。

试跑结果（分支 workflow_dispatch，同一天，不含排队）：

| | Windows 最慢分片 | 各片范围 | 整轮墙钟 | 整轮最慢 job |
| --- | --- | --- | --- | --- |
| 基线（4 片，上述 4 次） | 22.7–26.3 分钟 | 14.3–26.3 分钟 | 22–26 分钟 | Windows 分片 |
| run 43557762427（8 片，全绿） | 14.1 分钟 | 8.8–14.1 分钟 | 18.2 分钟 | Linux 分片 18.1 分钟 |

- Windows 关键路径约降 40%；整轮只降到约 18 分钟，因为 Linux 4 片（11.9–18.1 分钟）和
  verify-checks（15.5 分钟）成为新的长板，要继续缩短需另行调整它们。
- run 43556031905 导出的逐文件耗时：Desktop 在 Windows 上 4,063 个文件合计约 13,770 秒 worker 时间，
  其中收集（导入模块）约 5,080 秒、执行测试约 4,240 秒；8 片之间 worker 时间差约 1.5 倍
  （不计有失败的一片，主要来自 runner 速度差，见下文）。最慢的 `BotGroupChatView.test.tsx` 约 187 秒、
  `CustomProviderDialogAccessibility.test.tsx` 约 158 秒，最慢 50 个文件占约 19%。

### 同日第二轮：Linux 8 片、类型检查独立、按耗时分片

- Linux unit 同样改为 8 片，并导出 `desktop-file-timings-linux-shard-*`。
- Desktop 与 Mobile 的 tsc 从 verify-checks 拆到并行的 `typecheck` job，由 `verify` 汇总阻断；
  `dev-docs-contract.test.mjs` 校验两项类型检查都在该 job，且 `verify` 依赖它。
- Desktop 的 `--shard` 由 `src/test/vitest/timingSequencer.ts` 按已提交的
  `src/test/vitest/fileTimings.json`（每个文件在 Windows 上的 worker 毫秒）切分：
  - 最长的文件优先放进当前最轻的片（`scripts/shared/duration-shards.mjs`），结果只取决于文件
    集合与耗时，不取决于输入顺序。每个分片 job 各自算出全部切分、只取自己那片，所以各片必须读
    同一份已提交的数据；`scripts/__tests__/duration-shards.test.mjs` 校验并集恰好覆盖每个文件一次、
    与输入顺序无关、按耗时而非文件数均衡。
  - 只改切分，片内顺序仍是 Vitest 默认（文件大的先跑）；不带 `--shard`（本地运行）时完全不变。
    试跑 run 43564629415 曾让片内按耗时从长到短启动：几个导入很重的文件在转换缓存还空时同时开跑，
    `usageBroadcasterCodexAccount.test.ts` 在用例里动态 import，超过 Linux 的 5 秒用例超时，所以撤掉。
  - 没有测量值的文件（新加的测试）按中位数计；数据文件读不到时，所有分片一起回退到 Vitest
    的哈希切分。数据过期只影响均衡，不影响覆盖，所以不需要每个 PR 更新。
  - 刷新：挑一到多次全绿的 client-ci run，执行
    `pnpm update:desktop-test-timings --run <run id>[,<run id>...]`（读取 Windows 分片产物）。
    大批增删测试或各片耗时明显不均时再刷新。
  - 其余 workspace 仍用 Vitest 默认的哈希切分，runner 对空分片补 `--passWithNoTests` 的判断不变。
  - 用真实 Desktop 配置在本机核对（4,378 个文件、8 片）：每个文件恰好分到一片，每片 546–548 个文件。
- **托管 Windows runner 之间的速度差是各片耗时差距的主因。** 每个文件固定的环境、准备与 setup
  开销本应各片相同，同一轮里却按片相差到约 1.9 倍（run 43564629415 的速度系数 0.68–1.25，
  run 43557762427 为 0.75–1.30）；Desktop 墙钟同样相差约 1.9 倍（314 秒对 589 秒）。所以：
  - 逐文件耗时混着所在 runner 的快慢。更新脚本先按每份报告的固定开销均值算出该 runner 的速度
    系数，除掉后再对多次 run 取平均，当前数据来自 run 43557762427 与 43564629415。
  - 扣除速度系数后，原哈希切分的内容不均约为最大值 / 平均值 1.07–1.11；按一轮数据切分、用另一轮
    数据评估为 1.03–1.05。按耗时切分只能拉平这部分，抽到慢 runner 的分片仍会慢，最慢一片主要由
    抽到哪档机器决定。
- 单个慢文件不再决定分片下限：最慢的文件约 120–190 秒 worker 时间，每片约 1,400–1,800 秒。
  逐个优化最慢的两个文件，摊到 8 片 × 4 worker 后每片只省几秒，本轮不做。收集（导入模块）
  阶段约占 37%，是后续更大的空间。

| 试跑（同一天，不含排队） | Windows 各片 | Linux 各片 | Typecheck | verify-checks | 整轮墙钟 |
| --- | --- | --- | --- | --- | --- |
| run 43557762427（Windows 8 片、Linux 4 片） | 8.8–14.1 分钟 | 11.9–18.1 分钟 | （在 verify-checks 内） | 15.5 分钟 | 18.2 分钟 |
| run 43564629415（两者 8 片、按耗时切分） | 8.8–15.2 分钟 | 7.0–11.5 分钟 | 6.3 分钟 | 5.9 分钟（失败） | 15 分钟 |

run 43564629415 的失败是两份 CI 结构合约漏同步新增的 `typecheck` job（已修），以及上文撤掉的片内排序
导致的一次 5 秒超时；同一 head 的最终验证以该 PR 自身的 client-ci 为准。

## 2026-10-16 CI 关键路径与分片调整

数据来自 main 上两次成功的 client-ci（run 38819825618、38805666371，当时为 2 个分片）：

| Job | 总耗时 | 主要组成 |
| --- | --- | --- |
| Windows 分片 1/2 | 34.1–34.2 分钟 | 准备约 3；runner 自测 3.1–3.2；Desktop unit 20.9（1,253 秒）；Mobile 2.5；其余包 3.4；伴侣 DB 回归 0.9 |
| Windows 分片 2/2 | 21.9–25.7 分钟 | Desktop unit 16.9（1,013 秒） |
| Linux 分片 | 13.8–23.9 分钟 | Desktop unit 547–890 秒 |
| verify-checks | 7.7–8.4 分钟 | Desktop typecheck 3.4–3.8 |

- 关键路径是 Windows 分片 1，比分片 2 多 8–12 分钟：约 4 分钟来自只在分片 1 执行的 runner 自测和
  DB 回归，其余来自 Vitest 按文件路径哈希均分（不看耗时）造成的 Desktop 不均衡。
- 每个分片里 runner 先独占跑 Desktop，再独占跑 Mobile，最后并发跑其余包；Desktop 在 4 vCPU 的
  `windows-latest` 上用 4 个 worker。
- 初始删除候选只有约 7 秒 worker time；独立审查随后恢复了必要契约（见下文），最终删除范围
  更小。清理的目标是维护成本，不能把 CI 提速归因于减少测试条数。

2026-10-16 调整：Windows 与 Linux unit 都从 2 个分片改为 4 个；Windows runner 自测和伴侣 DB 回归
移到独立并行 job `windows-runner-checks`，由原必需检查 `Windows unit tests` 一并阻断。本仓是公开仓，
标准 runner 不计费。按上表估算，Windows 每片约为准备 3 分钟 + Desktop 9–11 分钟 + Mobile 与其余包
2–3 分钟，整条 CI 约 17–20 分钟。

首次四分片实测：PR #6196、head `433248f7ff` 的 client-ci run `38856774589` 全部通过。
Windows 四片为 809／1,006／812／661 秒，关键路径 16 分 46 秒，较原 34.1–34.2 分钟减少约 51%；
Linux 四片为 783／539／691／718 秒；独立 Windows runner/DB job 387 秒。此轮先于审查恢复必要
契约与同步主干，最终合并版本的 CI 还须单独核验，不能用这次结果代替。

恢复必要契约并同步主干后的 head `49daa510b0`，client-ci run `38883713365` 也已全绿：
Windows 四片为 715／680／932／1,057 秒，关键路径 17 分 37 秒，较原基线减少约 48%；
Linux 四片为 754／535／693／699 秒，runner/DB 为 416 秒。后续卫生门与侧栏回归
补丁仍须由其自身 head 的完整 CI 核验。

head `1a7fe95729` 的 client-ci run `38901684967` 全部 13 个 job 通过：Windows
四片为 826／673／971／863 秒，关键路径 16 分 11 秒，较原基线减少约 53%；Linux
四片为 733／679／670／719 秒，runner/DB 为 355 秒。这是完整 CI 的实测样本，
不含排队，也不代表每轮固定收益；后续补丁仍须通过自身 head 的全部检查。

Vitest 每片切 `ceil(文件数 / 分片数)` 个文件，分片多于 2 个时，文件少的包末尾分片可能为空（6 个文件
分 4 片是 2、2、2、0）。runner 原来只在「文件数少于分片数」时补 `--passWithNoTests`，本机 4/4 分片因此
有 6 个包报 `NO_TESTS_REQUIRED`；现已按 Vitest 的切分方式判断空分片。Desktop 自 2026-11-14 起改为
按耗时切分（见上文），文件数远多于分片数，不会出现空片。

审查恢复到 92 个 Desktop guard 文件后，Windows CI 暴露了另一个启动边界：逐项传递
exclude 会超过 `vitest.cmd` 的 8,191 字符限制，Desktop 尚未收集测试便退出。runner 和
`benchmark:desktop-workers` 现共用 Windows 的直接 Node 启动器，保留完整参数和工具 PATH；
Linux 及 package script 的启动方式不变。回归测试通过真实 runner 传入超过 8,191 字符的
排除列表并执行已有小型测试，同时验证空格、中文、引号与 shell 特殊字符原样到达子进程。

同轮审查补齐了 workspace `process.cwd()` 源码路径、本地 timeout 包装和常量时长检测，
并修正 `afterEach` 不应追溯影响首例的假时钟判断。源码读取按各自绑定区分用途：
送入 Function／VM 执行的生产回调继续留在 unit；同一读取还用于源码文字断言时仍须分层，
无关的执行不能豁免它。device-link client 的四处 ≥100ms 等待改用假时钟，288 条原有
用例整份通过，约 17.2 秒；未通过新增基线或删除结果断言来放行。

最终复跑曾在 `directSessionSendGuard` 的全运行时 TypeScript Program 检查超过原有
15 秒限制。该 guard 现只装入 ES2022 标准库与显式 Session fixture，避免自动装入约
80 份无关 `@types` 和 DOM 声明；2,238 个运行时根文件、类型检查器和失败关闭行为
不变。同机 4 项测试从 7.14 秒降到 4.95 秒，原有超时未提高；别名与 continuation
方法正反例验证仍能区分 maker Session 与其它同名 send。最终 CI 另行复验。
后续 head `e4466fe2b6` 的 CI 再次在该 guard 用时 15.21 秒时触发原 15 秒限制；
现进一步使用 TypeScript 的 `ParseForTypeInfo` 模式，跳过无关的 JSDoc 注释 AST，
保留接收者类型信息。独立核实全部 2,238 个根文件、2,297 个 Program 文件及 6 个
有类型身份的发送位置完全一致，未改检查器、违规判定或超时。一次本机独立进程对照
为 6.93→6.10 秒；这只是解析成本对照，CI 并发下是否解决超时仍由新 head 验证。
head `968677d3b7` 的 CI 仍在 15.20 秒触发同一限制。该轮日志显示 Desktop 与
Mobile guard 的默认 worker 池重叠运行约 20 秒；独立单进程 profile 保留全部根文件、
真实 checker 与 6 个发送位置，总计 5.25 秒、RSS 约 1 GiB，主要成本为解析和绑定。
现在 Desktop guard 复用既有 `exclusive` 屏障并限制为 1 个 worker，避免跨 workspace
和 Desktop 文件间争用，所有必需 guard 与原 15 秒限制不变。真实 manifest→计划→
调度回归在旧配置下因重叠失败，新配置通过；没有据此声称 CPU 是唯一原因，最终
CI 仍须重新通过。

随后补齐 Promise 定时器的首参数时长、导入别名与遮蔽判定；基线逐文件、逐规则与
可信 Git 基准比较，拒绝同一提交手改抬高额度，缺失基准或格式错误均失败。真实临时 Git
仓库的 CLI 回归覆盖首次登记、收紧、手改抬高、删除与读取失败，4 项 scanner 自测
约 2.7 秒。侧栏清角标回归并入既有通知测试，通过真实生产 effects 与点击回调验证
打开、聚焦、重复点击及监听清理，23 项约 3.1 秒；生产行为与 375 文件基线均未改。
模块重载检测同样按 Vitest 绑定追踪解构、赋值与 namespace 别名，并检查 hook 及其
本地准备／清理函数；同名参数和非 Vitest 对象不会误判。既有账号用量初始化回归
改为带明确理由的单次直接重载，原 34 项通过（约 0.7 秒），不新增逐用例重载。
源码读取也按真实 fs 绑定跟踪别名、namespace、Promise API 和静态解构，保留本地
同名 wrapper 与执行源码的行为 harness，屏蔽局部遮蔽及 fixture 字符串中的伪代码。
取消 `scripts/` 的目录级豁免，只按完整路径登记 5 份已有跨文件契约并写明理由；
其模块重载与真实等待规则仍适用，新普通脚本测试读取应用源码会失败。扫描器自测
4 项约 2.4 秒，全仓 AST 扫描约 20 秒（比最初的文本扫描成本更高）。通过 `--update`
只删除 zero-wiring 内嵌 fixture 造成的 8 次误报，基线从 375 收紧为 374 个文件；本轮继续收紧掉已不再被误判为等待的 token-speed 条目，基线为 373 个文件。源码路径别名会沿本地 resolve／join 锚点传播，描述性变量名不能绕过普通 unit 的源码读取门；已有跨文件源码契约明确加入对应 guard allowlist。
计时器模式也沿真实 Vitest 绑定追踪属性、解构、namespace 和静态赋值别名，并在
实际调用或 hook 执行处生效；恢复真实时钟后，后续测试的长等待不会沿用假时钟豁免。
未调用的别名、局部同名对象及 fixture 字符串不改变模式，基线未放宽。
真实回调定时器也跟踪静态 `const` 别名与解构，并按函数被捕获时的时钟判定：提前
保存的原生函数不会因之后启用假时钟而豁免，假时钟下保存的函数也不会因恢复真实
时钟而误报。`node:timers` 的 named／namespace／default 绑定保留原生身份；
当前 Vitest 3.2.7 的真实函数身份验证与 scanner 正反例均通过，基线保持 373 个文件。
Promise timer 的本地 wrapper 也按导入绑定识别，并使用 Promise API 的首个时长参数；
named 与 namespace wrapper、短等待、常量内层等待和参数／fixture 遮蔽均有回归，
避免把包装后的真实等待漏出卫生门。对象方法（如 meter.pause(1_000)）不再仅凭方法名计入真实等待；只有直接函数调用或已解析的计时器包装才会进入门禁，避免把同步状态机接口误报为异步等待。
导入设置恢复真实组件挂载回归，验证首次自动扫描与重入时先显示缓存、再更新结果，
2 项单文件命令约 2.2 秒。slash 空结果、目录队列插入与语音输入保护并入既有 ChatInput
文件，经过真实编辑器／hook 验证键盘消费、目录 chip、语音全生命周期只读与顶层弹层
优先消费 Esc；同时保留录音中真实停止按钮可用，以及真实 ModelSelector 选完模型后
回到编辑器焦点的历史回归。整文件 12 项通过，完整命令 9.02 秒（执行 1.01 秒）。
该文件已有重型编辑器依赖，继续复用同一 harness，未新增重复环境或放宽超时。
市场更新／替换后保留并刷新原详情页的回归也并入现有 navigation harness，整文件
20 项通过（完整命令 6.12 秒）；只修改测试，清除详情或断开焦点／停止接线的内存
坏变体均准确失败。
文件正文引用恢复为真实 CodeMirror 表格源码选区→引用按钮→草稿的 1 项回归（3.72 秒）；
附件托盘恢复图片／文本点击与移除不冒泡的 3 项回归（2.04 秒）。模型加载错误提示、
子菜单 Portal、项目头拖动与付费模型计费页跳转都并入已有组件文件，完整文件分别
为 3／4／39／3 项，完整命令分别 4.00／4.60／5.79／5.93 秒；后两者收集初始化
占主导，没有新建环境、增加真实等待或修改产品代码。

### 2026-10-16 实验与落地

本机 Windows、32 CPU、Desktop 8 worker。隔离方式三组用同一分片（869 个文件）连续对照：

| 实验 | 结果 | 结论 |
| --- | --- | --- |
| 基线：forks + 逐文件隔离 | 108.3 秒，0 失败 | — |
| `--no-isolate` | 83.0 秒（−23%），150 个文件／1,283 条用例失败 | 不采用：测试之间互相污染状态。**不要在真实 checkout 里用 `--no-isolate` 跑 Desktop 单测**：这次实验中 git／HOME 的 mock 泄漏，某个 worktree 测试在真实仓库对 `apps/desktop` 执行了 checkout，把未提交改动全部还原，还生成了 `apps/desktop/unused-test-home/` |
| `--pool=vmForks` | 80.0 秒（−26%），41 个文件失败 | 不采用：要逐个修复 VM 上下文差异 |
| `codexProxyHost.test.ts`：逐用例 `vi.resetModules()` 改为生产 `disposeCodexProxy()` 加启动注入复位 | 105 秒 → 6.7 秒，285/285；3 个随机顺序全过 | 已落地。原版在随机种子 1 下就失败（logger mock 跨用例累计），一并修复 |
| `maker-core` 用 1／2／4 个 worker | 248／125／65 秒，全过 | 已落地：独占运行、用满 worker，排在 Mobile 之后 |
| 单测分片 checkout 不拉全部历史 | 静态确认单测不读仓库历史 | 已落地，CI 每片约省 0.5 分钟（待 CI 实测） |
| 声明 jsdom 但没用 DOM 的文件 | 仅约 20 个，约 10 秒 worker 时间 | 不单独处理，写进性能预算 |

每片的 worker 时间里，收集（导入模块）约 325–350 秒，执行测试 250–480 秒，环境初始化 105–127 秒，
准备约 46 秒；后三项主要来自逐文件隔离。整体切换隔离方式会破坏正确性，所以改为逐个修掉开销最大的
文件，并用 `pnpm check:test-hygiene` 阻止新增逐用例重置、真实等待和普通单测读源码文本（存量计数
只减不增，见 engineering-conventions.md §3.2「性能预算」）。修完 `codexProxyHost` 后，最慢的
单个文件从 138 秒降到约 32 秒，不再由一个文件决定分片下限。

优化后按 CI 方式（runner、4 分片、Windows tar、无 `XDT_*`）完整重跑：门禁、`test:runner`、guard、typecheck
全部通过；4 个分片只有 `taskWorkspace.test.ts` 1 条 symlink 能力失败。各片 `maker-core` 从 71／21／54／108 秒
降到 34／5／27／55 秒；含 `codexProxyHost` 的 Desktop 分片从 144 秒降到 117 秒。代码没动的 Desktop 分片同时
慢了约 20%，说明本机（同时运行其他重负载程序）整片墙钟有 ±20% 的波动，收益以上表的同机连续对照为准，
这是初始实现的本机对照；最终合并版本以 PR CI 的完整复跑为准。

后续候选（每项都要在同一 runner、同一分片配置下实测后才能声称收益）：

- 按历史耗时分配分片（自定义 Vitest sequencer），拉平哈希均分造成的不均衡。2026-11-14 已对
  Desktop 落地（见上文「同日第二轮」）。
- 把 Windows checkout 与临时目录放到 Dev Drive（ReFS），降低大量小文件 IO 的开销。2026-11-14
  先把 TEMP 移到工作区所在的 D 盘（见上文）；Dev Drive 是否另有收益仍需同 runner 对照。
  路径同样要避开以 ASCII 标点开头的目录段。
- 基线中逐用例重置最多的 `modelVisibilityPrefs.test.ts`（18 处）、
  `pi-package-store-security.test.ts`（余 `beforeEach` 1 处，其余 16 处是写明理由的重启边界；去掉它需要
  生产侧的 reset 接口）按 `codexProxyHost` 的方式改。`newMakerDraft.test.ts`
  （54 处）已于 2026-11-11 改完：模块只加载一次，每例和「app 重启」都用 `__reloadForTest()` 从
  localStorage 复位，双窗口用例用文件开始时加载一次的第二个模块实例；同机 106/106、29 秒 → 3.2 秒
  （测试体 27 秒 → 0.9 秒），7 种生产代码变异下新旧文件失败的用例完全相同。真实 I/O 重的
  `llamaCppService`、`proxy-auth`、`updateService` 评估是否迁到专用 tier。
- PR 阶段只跑受影响的 workspace、合并队列跑全量：需要先修改上面「PR 门禁完整覆盖」的规则，由维护者决定。

## 2026-10-15 测试审计结果

对 499 个候选文件逐一审计：

- 初始删除 81 个文件（488 条用例）；独立审查发现其中包含缺少等价覆盖的权限、竞态、远程路由
  和设计契约，已恢复 30 个完整文件，并从 `homeUsageDashboardSource.test.ts` 保留账号隔离的 3 条
  契约（含同步主干时保留的 `botChatSurface.test.ts`）。后续逐文件复核另保留分享脱敏的两条契约、
  侧栏折叠时通知订阅归属的一条契约。随后将 Mobile 混合文件逐项行为化、合并必要原生契约，
  最终相对当前 main 删除 50 个测试文件（包含已迁入其他文件的覆盖），
  不能沿用最初的「488 条无效用例」结论。
  `FileTreeView.horizontalScroll.test.tsx` 真实挂载组件并断言可见宽度，已恢复。
  IM 启动补全、空草稿水合与语音切换、预览误发送、远程扫描旧回包、图片标注误关闭、
  Orca 隐藏／可见时的通知生命周期、导入设置自动扫描与 slash 空结果键盘保护，
  改由真实生产入口或组件行为回归覆盖。
  原生源码检测包含 Swift、C/C++、Rust 等；必要的跨原生协议、权限与生命周期契约进入
  required guard，执行脚本和 JSON／二进制资源不作为源码字面量断言。
- 初始审计的 207 个 PARTIAL 文件（2,874 条用例，其中约 991 条是静态或重复接线候选）与续跑、设备链、
  账户切换、Pi、权限和竞速回归混在一起，只能在补上等价的生产入口测试后逐项替换，不能按字符串模式
  批量删除。后续识别 workspace cwd 后，逐项将这类混合文件改为真实回调、组件或脚本执行；
  跨原生／JS、权限、凭证与竞态契约合并进已有 guard，纯布局字面量和已有真实覆盖的重复项才删除。
- 最初迁移 27 个静态契约文件；审查恢复与扫描器补漏后，Desktop 和 Mobile 的跨文件安全、权限、
  主题或文案契约统一迁到各自 `guard` allowlist，由 CI 的 `pnpm test:guard` 执行。最终名单只在
  `scripts/test-workspaces.config.mjs` 维护，由 runner 从 unit 排除；
  不要在 `apps/desktop/vitest.config.ts` 的项目 exclude 里重复排除，否则 guard 层自己也收集不到这些
  文件（2026-10-16 发现 29 个 allowlist 文件实际只跑了 2 个，已修复）。
- 缺少 timing 的文件是 `src/main/cindy-brain/__tests__/pluginModelPrefsIpc.test.ts`。

本机（Windows、32 CPU）按当时的 Desktop unit tier 实跑：3,448 个文件／53,987 条测试，53,814 通过、
168 跳过，墙钟 414.5 秒。5 条失败都是当前账户无法创建目录 symlink 的 EPERM 能力探测路径
（`taskWorkspace.test.ts` 1 条、`pluginNamespaceMigration.manager.test.ts` 4 条），需要在支持 symlink 的
Windows CI 或 Developer Mode 下复验，不能 skip 或删除。本机未分片的结果不能直接和 CI 分片耗时比较。

## 2026-07-26 Windows 基线

环境：Windows x64、Node v24.15.0、32 available CPUs、63.8 GiB RAM。测试范围为
1,213 个文件、13,062 个测试。

| Workers | 结果 | 墙钟 | 相比上一档 | 相比 1 worker |
|---:|---|---:|---:|---:|
| 1 | 通过 | 710.6s | — | 1.00x |
| 2 | 通过 | 353.7s | -50.2% | 2.01x |
| 4 | 通过 | 183.5s | -48.1% | 3.87x |
| 8 | 通过 | 108.3s | -41.0% | 6.56x |

8-worker 复跑为 114.9s，说明该档在本机约为 108–115s。2-worker 首次运行曾在 116.7s
触发一次 `ERR_IPC_CHANNEL_CLOSED`，重跑 353.7s 通过；worker 数降低本身不能消除
Vitest/tinypool fork 通道的偶发退出问题。

随着 workers 增加，所有文件自身耗时之和从 247.0s（1 worker）升至 317.5s（8
workers），说明存在资源争用；但墙钟仍持续下降。综合速度、资源和实现复杂度，正式配置
采用单池最多 8 workers；低于 8 CPU 的主机按 `os.availableParallelism()` 自动下调。

## 长尾分布

8-worker 复跑中，最慢 200 个文件按路径聚合：

| 路径 | 文件数 | 文件耗时之和 |
|---|---:|---:|
| `src/main/git-review/**` | 10 | 180.7s |
| `src/main/__tests__/**` | 27 | 49.7s |
| `src/renderer/**` | 92 | 31.8s |
| `src/main/hook-control/**` | 1 | 11.9s |

最慢的单文件主要是创建真实 Git 仓库或子进程的测试：

| 文件 | 8-worker 文件耗时 |
|---|---:|
| `git-review/__tests__/stageOps.test.ts` | 42.1s |
| `git-review/__tests__/pushOps.test.ts` | 28.6s |
| `git-review/__tests__/branchReader.test.ts` | 23.8s |
| `main/__tests__/codexFileRewindExecutor.test.ts` | 23.4s |
| `git-review/__tests__/ipc.test.ts` | 22.0s |
| `git-review/__tests__/diffReader.test.ts` | 19.5s |

因此分池优先按“真实 Git／子进程长尾”和“其余测试”隔离，而不是只按 node/jsdom 环境
机械拆分。

## 多 worktree 资源协调

Desktop 测试按成本拆成默认层与显式层：

- `standard`：普通单测，以及一条代表性的真实 Git smoke；默认 `test:unit` 只运行这一层。
- `git-integration`：文件名为 `*.git-integration.test.ts` 的完整真实 Git 覆盖，由
  `pnpm test:git-integration` 显式运行。Vitest 内部不再获取跨 worktree 资源锁。

远端 `client-ci` 以独立并行 job 在每个 PR、`main` push 和手动触发时运行完整
`git-integration` 层；本地按改动风险选测，默认入口为 `test:unit:related`。

同一仓库的多个 worktree 默认独立执行测试，不共享单任务配额。需要主动排队时，在根级
测试命令后传 `--lock`；它只协调同样选择排队的本地重型 runner，不能限制其它入口。
锁按 Git common-dir 区分 clone，只监听 `127.0.0.1`，退出后自动释放，等待上限为
15 分钟；CI 与 guard 不参与。`--no-lock` 仍接受为兼容参数，两个选项不能同时使用。
单次运行的 worker 默认值与并发限制保持不变，可按本机预算选择定向 Vitest 参数。

测试分层仍需满足：

- 两个 project 的 include/exclude 必须互补；默认层以低成本 smoke 守住主链路，完整层保留
  index、patch、hook、ref、worktree 等组合语义。
- Vitest 3.2 的 inline project 不会自动继承根 CLI 的 `--exclude`；配置必须把这些排除项
  显式传入两个 project，确保 unit、DB、migration 等 tier 的测试边界保持不变。

真实 Git 测试的 fixture 还应优先复用 `src/test/vitest/testDirectoryTemplate.ts`：每个测试
文件初始化一次不可变基准仓库，再为每个用例复制独立目录。默认层不复制完整矩阵；完整层
不得为了提速把需要验证 Git index、patch、hook 或 ref 语义的集成覆盖全部 mock 掉。

2026-07-28 在 Windows 上测得旧 `resource-intensive` 范围为 22 files、219 passed /
3 skipped，墙钟 252.07s；其中 15 个真实 Git 文件的测试耗时合计占主要长尾。该数据是拆层
前基线，后续比较必须分别报告默认 smoke 与显式完整层，不能把两者相加后宣称默认层变快。

## 分池评估

分池把 21 个 Git／子进程长尾文件放入 `git-io`，其余文件放入 `standard`；两个池并发，
且完整覆盖仍为 1,213 个文件、13,062 个测试。

| 配置 | 结果 | 总墙钟 | 说明 |
|---|---|---:|---|
| 单池 8 forks | 通过 | 108.3–114.9s | PR3 单池基线 |
| 3 forks + 5 forks | 通过 | 126.9s | standard 池成为长板 |
| 2 forks + 6 forks | 通过 | 111.6s | 与单池持平 |
| 2 threads + 6 forks | 通过 | 114.8s | standard 使用 threads 无收益 |
| 2 threads + 7 forks | 通过 | 111.1s | git-io 成为长板 |
| 3 threads + 7 forks | 连续两次通过 | 102.2–103.0s | 最快分池候选 |

另一次 `2 forks + 7 forks` 中，standard 池在 100.6s 完成，但 git-io 池触发
`ERR_IPC_CHANNEL_CLOSED`，因此不作为有效性能样本。

最快分池候选的平均墙钟为 102.6s：

- 相比现有单池 4 workers 的 183.5s，减少 80.9s（44.1%）。
- 相比单池 8 workers 的平均 111.6s，减少 9.0s（8.1%）。
- 但 worker 上限会从 8 提高到两池合计 10，并引入分区维护和双执行器复杂度。

因此分池相对单池 8 workers 的额外 8.1% 收益不足以抵消资源与维护成本，正式配置不采用
分池，保留单池最多 8 workers。

## 2026-11-09 fork 首例 setup 超时复查

PR #9386 的 client-ci [run 42468165931](https://github.com/makecindy/cindy/actions/runs/42468165931)
在 attempts 1、2、3 均于 `fork.test.ts:172` 的首个 `beforeEach` 超过 10 秒；
失败用例均为 `disabled Cindy Make fork boundaries` 下的第一个 orchestration fork。
此前以 main 的失败状态推断基线故障不成立：main runs 42470248978、42467677622
的失败步骤是 `Install bundled ripgrep`，不是同一测试签名。

该 hook 把一次性的 `maker-orchestration/fork` 动态导入也计入首例准备时间。
本地临时计时显示首例 mkdtemp 约 0.37ms、首次导入约 634ms，100 例均通过；
CI 没有细分计时，不能据此宣称已证明其 10 秒全耗在导入，也不能宣称 main
已复现同一故障。处理是按测试生命周期把一次性加载移到 collection，放在 mock
状态初始化之后，保留每例目录隔离、100 个用例、全部断言和原有 hook timeout。
这不降低总加载成本，但避免把测试框架冷加载算作首个业务用例的 setup。
修改后单文件本地 100 例通过，墙钟 3.22s，测试体 252ms；搜索相关测试与 fork
一起运行 142 例通过（5.23s）。CI 是否恢复必须以新提交的检查为准。
