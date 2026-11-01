# Headless Linux 第一阶段验证报告

2026-11-01；基线 `85002b04fc`；分支 `perf/headless-runtime-stage1`。

## 结论与范围

已拆分 CLI／后台／TUI 的加载边界，减少前台内存及 CLI 启动 CPU，修复真实 PTY 无信号断开后的残留和清理时的 EIO。全部业务模块保留；后台常驻内存尚无稳定改善证据，不宣称 daemon 已完成轻量化。

在线 VPS 未修改、未重启、未部署。测试在本机 WSL Ubuntu 26.04 使用新建未登录 profile，没有复制真实账号配置、访问用户工作目录或发起收费推理。

## 实现

- 保留 cli.js 和命令参数；按命令加载 service、TUI、browser，doctor 的浏览器检查也延迟加载。
- ESM 分块与入口同目录，保持资源路径；清理旧生成分块，避免陈旧产物进入包。
- terminalText 提取为纯文本模块，原 UI 导出兼容，CLI 不再通过该函数加载 Ink。
- TUI 处理 stdin end/close、SIGHUP、SIGTERM、EIO/EPIPE，卸载界面、关闭客户端并撤销监听器；等待 Ink 最后一帧的异步错误完成。其他错误仍暴露。
- 未调用后台停止接口；未改模型、权限、协议、数据库迁移、账号区域或引擎回收策略。

## 最终资源对照

相同独立包依赖、官方 Node 22.22.0、构建版本、Global 区域及新 profile。基线包只换回原始单文件 CLI，worker 与资源不变；从独立 profile cwd 启动。

| 指标 | 基线 | 优化版 |
| --- | ---: | ---: |
| TUI PSS | 482.4 MiB | 108.6 MiB |
| --version 峰值 RSS 中位数 | 508.9 MiB | 112.4 MiB |
| --version CPU 秒中位数 | 3.609 | 0.483 |
| --version 墙钟秒中位数 | 3.037 | 0.326 |
| --help 峰值 RSS 中位数 | 508.0 MiB | 111.0 MiB |
| --help CPU 秒中位数 | 3.607 | 0.469 |
| 后台 PSS 采样范围 | 501.5–544.6 MiB | 542.0–542.3 MiB |
| 后台单核 CPU，10 秒窗口 | 0–5.40% | 0–0.30% |

TUI 减少约 373.9 MiB（77.5%）；CLI 查询峰值内存减少约 78%，启动 CPU 时间减少约 87%。CLI 每条命令重复三次，CPU 是用户态与内核态之和。RSS 与 PSS 不混用。两版 TUI 的 10 秒 CPU 窗口均为 0%，不宣称空闲 CPU 改善。

后台包含启动和垃圾回收波动：基线后段约 502.5 MiB，优化版约 542.3 MiB，反而更高；不能据此证明后台内存下降，也不把短窗口 CPU 差值解释为稳定节省比例。测量不包含登录、活跃 Agent、浏览器或并发业务。早期源码目录的 83% TUI 降幅不作为最终指标。

原始数据：`headless-runtime-results.json`；工具：`apps/cindy-terminal/scripts/measure-headless.py`。

## 真实断线回归

无信号关闭 PTY：基线 5 秒仍存活，需测试器回收；最终包 exit 0，无残留。普通挂断以 SIGHUP 退出；SIGTERM 和 Ctrl-Q 清理后 exit 0。后台始终存活。stdin end/close 和 EIO 单测均先红后绿；最终包无未处理的 EIO，不把信号退出称为 exit 0。

## 验证账本

- typecheck、完整构建、help/version、diff 检查通过；构建有既有 image-resizer direct-eval 警告。
- check-entry-loading.mjs 通过：CLI 静态闭包无 service/React/Ink/TUI，后台无 React/Ink/TUI。
- input、authentication、lifecycle、service-manager、maintenance、shell 六文件 56 项通过，Vitest 9.40 秒。lifecycle 直接通过 Node 运行 Vitest 单独验证：3 项通过，Vitest 3.01 秒、墙钟 3.82 秒，满足 5 秒预算；经 pnpm 启动的早期记录为 5.66 秒。
- 生产 package-runtime 打包及自带原生依赖/help/version smoke 通过；最终独立包从非安装目录启动服务、查询状态并完成 PTY 验证，分块、数据库和 worker 路径可用。
- Linux 宿主/远控集成测试优化前后均为 33 通过、3 失败、1 Windows 专用跳过。未修改源码基线实际复现相同失败：task tags 与 locked vault 两例显式 5000ms 超时；通知文本预期 Finished，实际 Finished private path。未放宽断言、超时或脱敏行为。
- 集成通过项包含真实私有传输、事件、连接恢复、文件服务、数据库重启、附件、加密配置交接、工作目录及客户端释放。
- Windows 同组 33/37 通过，另有三个路径相关失败，不作为 Linux 成功证据。
- check:test-hygiene 失败于五个未修改的 Desktop 基线计数：agent-input-coordinator、orcaWorkerCreationService、deviceProvidersCache、useFeishuBot、WebMicAudioEngine.keepAliveIdle。未修改门禁基线放行；没有声称整仓 CI 全绿。

未执行真实账号的 Desktop/Mobile 端到端操作或模型推理，不能据此声称所有业务组合均已验证。

## 环境和复现

Ubuntu 自带 Node 22.22.1 未编译 TypeScript 支持，原始 TS migration 报 ERR_NO_TYPESCRIPT；正式测量使用打包固定的官方 Node 22.22.0。官方 linux-x64 tar.gz SHA256：`c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744`。向量扩展从本地文件补齐并核对 LFS 哈希；没有修改 native 源码或迁移。引擎及 Electron 下载有网络失败，本次未使用这些引擎推理。

```sh
APP_VERSION=0.1.115 pnpm --filter cindy-terminal build
node apps/cindy-terminal/scripts/check-entry-loading.mjs
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/resources.json
CINDY_MEASURE_NODE=/absolute/runtime/node python3 apps/cindy-terminal/scripts/measure-headless.py /absolute/app/dist/cli.js /absolute/cli.json --cli-only
```

--lifecycle-only 仅检查断线。诊断/profile 在临时目录，工具只回收自己创建的进程；报告记录失败，不用脚本返回码替代逐项结果检查。

中国大陆版通过 CINDY_AUTH_REGION=cn 构建，build-info 已核对为 cn，启动和全部生命周期 smoke 通过，后台保持存活；正式资源对照为 Global 未登录环境。任何在线替换均不属于本轮交付。

大陆版交付包 SHA256：`7a29142fde65f26d867e6cbc47f7686534d8437e52179403f1924f0cc974486e`。包为本次本地验证构建，不等同于上游正式发行版或已通过完整 CI 的版本。

## 后续迁移门禁复核（2026-11-01）

替代草稿 PR #8342 已包含入口优化和 Codex 空闲回收。对主干 `96cc30181e` 的只读 `git merge-tree` 预演报告 364 处冲突；没有在当前 worktree 发起合并，也没有修改原工作区的未完成合并。GitHub 标记 CONFLICTING；当前仅 DCO 检查成功，不能将没有运行的 client-ci 视为通过。

Desktop 全量类型检查确认仍有共享提取后的接口缺失与宿主适配错误。本次先修复六处诊断：两个共享翻译接口按实际调用收窄为只接受 key，Desktop 适配器保持默认语言；通知宿主导入共享 payload 类型；调度接口按实际调用收窄 provider / Fast 输入，并允许 worktree 释放返回结果（调用方只等待完成，不消费结果）。没有删除断言、添加类型强转或改变工作区回收行为。

最终定向回归：generatedImageDelivery、runnerShared、runnerSessionClose 三文件 36 项通过（30.55 秒，收集 24.26 秒、执行 5.25 秒）。没有新增测试，沿用真实图片交付入口和调度生命周期覆盖。完整 Desktop 类型检查与主干合并仍是未完成门禁；本轮不部署在线 VPS。

最终 app-runtime 和 cindy-terminal 类型检查通过；Desktop 按项目 12 GB 堆预算执行完整检查后仍有 270 条其它诊断，本次涉及的六处诊断已消除。文档检查 10 项通过，diff 检查通过。Desktop 增量缓存仅写入本机临时目录，不进入仓库。

后续整合应按行为迁移，而非给旧类型补空字段：优先核对 maker-ipc 的宿主回调与任务生命周期，其次供应商组／分享的 Fast 策略、插件模拟安装证据与迁移、伙伴云端能力应用与到达提示。冲突中的 Desktop 转发文件需与对应共享包一起检查，不能只保留转发语句而丢掉主干新增实现。各模块继续遵循专项权限、插件兼容和协议规则，未完成前维持草稿。

### 初始化时序与测试隔离修复（2026-11-01）

修复 Desktop 在 inputCoordinator 初始化前装配队列服务时的提前读取：三个共享工厂在调用时读取宿主依赖，Desktop 使用 getter 注入。自动恢复生命周期移入 providerGroupService 所在作用域；补齐运行时设置宿主的 getSessionProvider，并允许数据库 agent kind 的既有 null 返回值。没有改变队列授权、持久化格式或传输协议。

sessionControlService.test.ts 的新增 unit 回归通过真实三个工厂复现初始化前的 ReferenceError，再验证初始化后的队列读取与控制入口；旧实现先失败，修复后全文件 23 项通过（单独运行墙钟 4.13 秒）。既有用例只使用已初始化依赖，未覆盖该启动时序。Terminal 真实宿主队列、协作、共享和账号限额恢复定向集成 4 passed、121 skipped，55.37 秒。

deviceProvidersCache、useFeishuBot、WebMicAudioEngine.keepAliveIdle 保留既有行为断言，改用生产缓存驱逐／解绑／音频模块释放入口隔离用例，不再逐例 resetModules。麦克风竞态用例完成断言后显式停止录音。三文件单独运行墙钟分别为 3.49、4.47、2.47 秒；与 sessionControlService 合跑 90 项通过（Vitest 6.49 秒）。这些测试只调整夹具，不新增产品清理 API。

app-runtime 与 cindy-terminal 类型检查通过。Desktop 完整复查仍有 259 条诊断（此前 270），本批涉及的测试与共享队列模块无诊断；并非全量通过。test-hygiene --update 仍在可信基线比较阶段拒绝五项既有上调，未执行收紧，基线未修改；其中三个 resetModules 源码问题已修复，两处源码读取测试仍待迁移。主干冲突、完整 CI 与余下类型错误仍未解决，不修改在线 VPS。

### 队列测试迁回生产入口（2026-11-01）

agent-input-coordinator.test.ts 的远程入队与插话测试曾从 register.ts 截取已迁走的实现；主人编辑测试还误截取相邻清理代码。现改为注册共享 makerInputSubmission 处理器、调用 sessionControlCoordinator，并将现有编辑来源与授权判定原样提取为 createQueuedEditProvenance，由 Desktop 和测试共用。主人编辑刷新正文授权、共享访客保留原授权、账号与输入代次检查均保留；不改 wire、持久化或插件批准机制。入队夹具现在经过真实参数验证，并使用真实附件生命周期组件。

保留原有三组 unit 断言，15 passed、582 skipped，最终定向运行 11.71 秒（收集 11.02 秒、执行 227ms）；未新增测试文件。该存量巨型文件包含 597 项测试和大量运行时依赖，冷收集已超过 5 秒预算，本轮不增加逐例加载或真实等待。完整文件复查 583 passed、14 failed，29.18 秒；此前 576 passed、21 failed，消除 7 项失效源码夹具造成的失败。余下失败涉及插话失败后的活跃状态、调度人工恢复、拒绝 compact 后的恢复与伙伴原话转发，不能宣称队列整体通过。

共享 app-runtime、cindy-terminal 类型检查通过；Desktop 完整检查仍为 259 条诊断，本次夹具和 makerInputSubmission 无新增诊断。门禁原始 scanRepository 复查先前五个文件，仅 orcaWorkerCreationService.test.ts 仍有 sourceReads=1，其余不再命中。正式门禁仍受当前分支的既有基线上调阻挡，尚未收紧基线。继续处理 Orca 生产授权入口和共享运行时的行为迁移；PR 仍为草稿。

### 调度恢复与已核实原话迁移（2026-11-01）

从主干迁回共享协调器的调度失败继续资格：仅已持久化且未成功撤回的调度失败设置 errorCanContinue，停止／清错重置资格，不保存或重放已结束的调度 prompt。投影字段为可选，旧宿主缺失时客户端按不可继续处理；Desktop/Mobile 已有消费者。插话被 vendor 拒绝后若产品仍有活跃后台工作，不再合成 done 或错误地启动下一轮。

迁回 verifiedOwnerRequestText 及审核历史恢复中的原话读取：只接受已有 host-owned 回执中的 true 标记、来源任务和消息标识及非空原话；未核实回执、插件与共享访客历史不会因此成为主人授权。队列发送、插话和持久化历史使用同一解析器；不修改系统提示词。发送端伙伴身份裁决与 IM 主人输入读取尚待迁移，不能声称原话链路已完整接通。

既有 agent-input-coordinator 全文件 597 项通过（修复前 14 失败）；与 autoReviewUserIntent、forwardedRequest、数据库 autoReviewProjection 合跑 693 passed、3 failed，31.32 秒。三项失败均在 forwardedRequest 的发送端：尚未接入 ownerVerified 参数及 ownerChannelInputEvidence，未放宽断言。Terminal 真实宿主定向集成 4 passed、121 skipped，54.41 秒。没有新增测试或改动既有测试断言。

app-runtime、cindy-terminal 类型检查通过。maker-shared 没有 typecheck script，因此额外执行其 build（tsc --noEmit）：发现存量 findLastIndex 与 ES2022 lib 不兼容，改为等价倒序查找后通过；五组空列表、无撤销、仅撤销及多次撤销输入与原行为一致。该改动不提高运行时语言版本要求。主干冲突、完整 CI、正式 test-hygiene 与发送端身份迁移仍未完成，在线 VPS 不变。

最终 Desktop 全量检查为 241 条诊断（本批之前 259），共享恢复与原话解析代码无新增诊断；队列测试中仍有原有重复 statDirectory 夹具字段的诊断，发送端缺失接口也仍报告类型错误。未将这些错误隐藏或标为通过。文档检查 10 项通过，diff 检查通过。

### 伙伴身份与发送端原话证据（2026-11-01）

共享 taskActionHost 补回当前分支伙伴自主范围合同，区分 owner、entrusted 和 autonomous，并隔离独立工具调用的授权上下文。采用主干 `7eb991b79c^` 对应行为；后续主干已调整伙伴策略，合并时必须同步迁移规则、实现与测试，不能只选一侧代码。Desktop 与 Terminal 均接入工作台真实任务归属查询，Terminal 随伙伴服务解绑一并清理查询回调。

发送端仅为本轮宿主核实的伙伴主人请求写入 ownerVerified，不继承旧回执标记。IM 原话从同一任务、同一 clientId、未撤回的用户消息读取；普通任务保留原有正文。远程发送复用本机相同捕获入口，账号切换仍中止交付。不新增数据库角色或 migration。

沿用既有生产入口测试：taskActionAuthorization、botWorkbenchAccess、forwardedRequest 三文件 145 项通过（9.40 秒）；原发送端失败已消除。companion-core、app-runtime、cindy-terminal 类型检查通过。Desktop 完整类型检查仍有 232 条诊断（本批之前 241），本批授权及原话捕获模块无诊断。

Terminal 宿主五项定向集成因 Windows libuv `src/win/fs-event.c:72` 原生断言崩溃，继发 ERR_IPC_CHANNEL_CLOSED；启用 Chokidar polling 和缩小至四项分别重试仍复现，未获得有效通过结果。未修改产品监听行为、放宽测试或将该组计为成功。此项、其它 Desktop 类型错误、Orca 测试门禁及主干冲突仍待解决，PR 保持草稿，在线 VPS 未修改。

### Windows 临时目录别名复验（2026-11-01）

上述 libuv 崩溃与本机 TEMP 的 Windows 8.3 路径别名有关：普通 realpath 保留短用户名，realpathSync.native 返回长用户名。仅将测试进程 TEMP/TMP 指向同一物理目录的长路径，同组 5 项宿主集成通过（50.42 秒）。测试夹具现统一先用 realpathSync.native 解析临时目录，再创建隔离子目录；未修改产品 watcher 或断言。

恢复默认 TEMP/TMP 后，同组 5 passed、120 skipped（53.83 秒，收集 39.82 秒、执行 13.60 秒），Terminal 类型检查通过。沿用真实宿主与 SQLite 的既有集成用例，没有新增用例、模块重载或真实等待；该存量宿主文件的收集成本仍超过单测预算。本项只验证测试环境恢复，不代表产品已全面支持 Windows 短路径监听，也不代表完整宿主回归或 CI 已通过。

完整宿主文件复查为 116 passed、9 failed（251.76 秒，收集 41.27 秒、执行 210.09 秒），没有原生监听崩溃。失败分别为恢复归档任务仍返回 archived、五处宿主路径比较差异、跨电脑切换 5000ms 超时、脚本用例清理 ENOTEMPTY，以及项目自动化按斜杠形式重复登记同一目录。需分别确认产品回归与断言语义，不将这些失败归为已解决。原始 test-hygiene 扫描与 origin/main 基线比较，仅 Orca worker creation 测试的 sourceReads=1 超标；未修改基线。

### 宿主路径语义与计划授权复核（2026-11-01）

归档恢复的 CAS 要求提交读取到的目录身份，夹具改为传入创建接口返回的 workingDir；原实现不改。工作目录断言按宿主文件系统语义使用 path.normalize／realpath，不改远程协议格式或整段输出。Git 基线夹具用隔离目录中的空配置文件替代 Git for Windows 无法读取的 Node os.devNull。

两项产品修复：项目自动化启动扫描以已登记 schedule 的目录写法为先，同一 Windows 路径的大小写或斜杠变体不再被 session 覆盖，避免重启新增另一个 hash 记录；不迁移或删除已有数据。插件 Worker 的计划授权读取器对 realpath 结果与持久目录使用相同宿主路径规范化，避免正反斜杠导致误拒绝；仍复核插件归属、计划路由、账号代次及最终数据库快照，不改批准状态、凭证、安装布局或 wire。

原有 7 项失败回归现全部通过（79.86 秒，收集 39.54 秒、执行 39.90 秒），包含真实 SQLite、Git、插件安装与撤权、工作树回收和调度重启；未新增用例或放宽超时。项目自动化 13 项通过（3.90 秒）、插件授权 78 项通过（3.54 秒），app-runtime 与 Terminal 类型检查通过。脚本 capability 用例单独重跑通过，但全文件曾出现的清理竞态仍未证实解决。跨电脑切换用例单独重跑仍 5000ms 超时，并在影子目录清理报 EPERM；重复 p 层是既有固定祖先目录布局，不是递归复制。完整宿主文件尚未在本批修复后重跑，不能据此宣称 125 项全绿。Desktop 232 条诊断、主干冲突、Orca 测试门禁与完整 CI 仍待处理，在线 VPS 未修改。
