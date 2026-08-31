# PI harness 集成规则与上线清单

> 修改 `packages/maker-core/src/agents/pi/**`、`apps/desktop/src/main/maker-host/pi-host.ts`、
> `apps/desktop/src/main/mcp-integrations/piEnvironment.ts`,或任何 PI 会话行为、权限、
> 配置、system prompt 之前必读本文件。PI(github.com/earendil-works/pi)被定位为 Cindy
> 未来的基座 harness,集成原则与其余 harness 有别 —— 详见「设计原则」。

## 1. 架构总览

Cindy 以 `pi --mode rpc` spawn pi 二进制(JSONL/stdio),`translator.ts` 把 pi 事件映射进
统一 `AgentEvent`。关键装配点:

- **provider/model**:`index.ts writeModelsJson` 把 host 注入的模型清单挂在单一自建
  provider `cindy` 下,写进 `<agentHome>/models.json`。`baseUrl = runtimeConfig.endpoint`
  —— desktop 侧是本地 anthropic-compat proxy(loopback);proxy 未起时 fail-open 直连真上游
  (`anthropic-compat-proxy-host.ts`)。凭证走 `$CINDY_PI_API_KEY` env 插值,不落盘。
- **system prompt**:`--append-system-prompt` 追加 host 产品段 + 用户段,**保留 pi 默认
  prompt**(不用 `--system-prompt` 整体替换 —— 那会丢掉 pi 自己调好的工具用法/工程约定)。
- **权限执行**:pi 原生无工具审批(security.md 明确:非沙箱、不限制工具)。Cindy 用注入的
  `cindy-bridge.ts` 扩展在 pi 进程内 `pi.on('tool_call')` 拦截,经 `extension_ui_request`
  子协议冒泡到 `index.ts handleExtensionUiRequest`,映射成 `InteractionRequest` 交 Cindy
  审批 UI。档位写 `<agentHome>/runtime/perm-<sessionId>.json`,bridge 每次 tool_call 现读
  (热切换)。
- **Full access(`bypassPermissions`)契约(务必如实理解,勿夸大)**:该档下 Pi 的 `bash`
  **不是**受隔离的凭证安全边界。bridge 里的凭证路径/`/proc/*/environ` 文本硬拦只是
  **defense-in-depth**,可被变形绕过(`ps eww -p $PPID`、`find /proc -exec`、变量拼接 /
  base64 / heredoc、重定向/`tee`/`cp`/`mv`/`python` 写文件等)。因此在 Full access 下:
  - Pi 父进程环境里的代理 token / 网关 key / BYOM key / 外部 MCP header **可能被读取**;
  - `readOnlyRoots`(Extra Dirs)**可能被写入**——只读语义靠 auto-review 提示与文本拦截,
    非 OS 强制。
  真正的强隔离需要 OS 级手段(macOS `sandbox-exec`、Linux 只读 bind mount / seccomp),
  **本阶段未接入**。选择 Full access 即接受上述风险;需要硬边界时用 ask/auto 档,或等 OS
  沙箱落地。改动权限相关代码时不要再堆「看起来能拦」的正则并当成安全边界。
  与 Claude Code／Codex 一致，Pi 会话的 Full Access 也会让插件 `ghost_call` 的
  `attachments`／`dir`／`save_dir` 在 Host 侧免去额外过户确认；实现必须现读活跃 Session
  的稳定状态并同时匹配其 runtime instance identity；权限切换或关闭在途、远程／缺会话／
  实例不匹配／查询失败均 fail closed，且不得扩到 workspace、Setup、安装／更新、OAuth、
  Secret／凭证等其它授权面。instance 仅作为 opaque query 写入 Host 生成的 Pi MCP URL；桥接
  注册表不匹配时返回 401。旧 URL 缺 instance 时可兼容普通会话工具，但必须向工具隐藏
  instance，使 Full Access 自动交接保持 fail closed。
- **MCP 桥**:`piEnvironment.ts` 把 in-process MCP providers 暴露成 localhost streamable-HTTP，
  并把用户显式配置的外部 HTTP / Streamable HTTP MCP 作为 direct remote server 装入；旧式
  SSE transport 不在此链支持（但 Streamable HTTP 的 SSE response framing 受支持）。外部 URL
  要求 HTTPS，只有明确 loopback endpoint 可用 HTTP；认证 header
  真值仅经 Pi 父进程专用 env 传递，`CINDY_PI_MCP_BRIDGE` 只存 env 引用；这些 env 与描述符
  都会在 bash spawn 边界剥离。bridge 并行执行外部 server 启动探测，每个 server 的
  `initialize + tools/list` 总预算为 10s（低于 Pi RPC 30s ready 门槛）；探测完成后实际工具
  调用保留 600s 长预算。SSE response 按 event 增量消费，不等待 server 关闭持续流。Pi 模型侧
  始终只注册 `cindy_mcp_list_tools` 与 `cindy_mcp_call_tool` 两个稳定网关 schema；完整工具目录与
  input schema 留在 bridge 内部。先发现名称／描述，再按具体 server + tool 取单个 schema，
  未检查 schema 的调用在 bridge 内 fail closed，不会触达 MCP 或弹权限框。Host 审批、策略与变更捕获仍使用真实
  `mcp__<server>__<tool>` identity 和真实参数，不能退化成对网关包装器授权。Claude Code 与
  Codex 保持各自的直接 MCP 注册方式，不经过此 Pi 专属网关。配置新增、修改、禁用或删除对
  下一新建/重启会话生效；旧活动会话保留启动时 generation 快照至 close。
- **plan 模式**:挂 pi 自带 plan-mode 扩展,`/plan` toggle 驱动;Cindy 维护镜像态并在 resume
  时从 `get_entries` 校正。

## 2. 配置面:Cindy 显式设置 vs 放任 pi 默认

Cindy 显式设置:models.json、`settings.json` 的 `transport:sse` 与 `retry.maxRetries=6`
（`retry.provider.maxRetries` 保持 0）、`--append-system-prompt`、`--session-dir`、启动时 RPC
`set_auto_compaction{enabled:true}` / `set_thinking_level`。Pi 原生负责 threshold 与 overflow 压缩；
Cindy 消费 compaction 事件做 UI、usage、digest 投影，并只在本机原生自动压缩确定性失败后锁存
下一次发送前换窗。设置页的 Pi 百分比在每次启动或恢复 Pi 任务时冻结，并写入该任务 `settings.json` 的
`compaction.reserveTokens`（`window * (1 - pct/100)`）；切模只按这份快照重算，不回读最新全局值。
Claude Code 仍用独立百分比。env:`CINDY_PI_API_KEY`、
`CINDY_PI_SESSION_ID`、`PI_CODING_AGENT_DIR`、`CINDY_PI_PERMISSION_FILE`、`CINDY_PI_MCP_BRIDGE`、
外部 MCP 专用动态 env、`PI_OFFLINE=1`(关启动期联网)、`NO_PROXY` 兜底 loopback(防全局代理
打穿本地 proxy 与 MCP bridge)。

放任 pi 默认(未写 settings.json):`httpIdleTimeoutMs=300000`、`websocketConnectTimeoutMs`、
`compaction.keepRecentTokens`、`defaultProjectTrust`。Cindy 会在每次 startSession 覆写
`transport`、`retry.maxRetries=6`（provider 级保持 0）与 `compaction.reserveTokens`；
未配置 Pi 百分比时不写 `reserveTokens`，沿用 Pi 默认 16384。


## 3. 设计原则(Chris 2026-07-30 裁决)

- PI 是 Cindy 未来的基座 harness。
- **桥接/模型接入必须充分利用 pi 自身兼容层**(models.json 四种 api 形态 + per-model compat
  开关),**禁止「先转成 Claude 格式再转 pi 兼容」的双重转义**。BYOM 用户自定义/本地模型直接
  写 models.json 走 pi 原生 provider,不过 anthropic-compat 代理。

### 3.1 Pi 上游 GUI 非退化红线（Chris 2026-08-19 裁决）

Cindy 是 Pi 的上游 GUI，不是 Pi 的二次安全产品。Cindy 的 Pi 集成验收基线首先是：**不得让
同版本 Pi 原本能完成的事情，因为 Cindy 控制层新增的判断而失败、停用或无法由 Agent 恢复。**

1. **原生成功是成功真源**：`pi install/update/remove` 的退出结果是包 mutation 的成功真源。
   命令成功后，Cindy 的检查器、指纹器、快照器、兼容解析器或 UI 投影失败，不得把它改判成
   安装失败，不得回滚或自动停用。宿主自己的分析失败只能显示为 Cindy 诊断不可用。
2. **兼容检查永不阻断**：TUI API、RPC、静态语法、runtime range、未知资源及未来 Pi 格式的
   检查只用于详情提示。`partial`、`unsupported`、`unknown`、超时和解析异常都不能影响安装、
   更新、启用或运行；Pi 能加载就交给 Pi 加载，运行错误再按 Pi 原始错误呈现。
3. **显式操作零附加审批**：用户直接发送完整确定性的 Pi 包命令，或在设置页点击明确的
   安装／更新／启用／停用／移除，即完成对应授权，不得再弹宿主确认。Agent 自主发起的工具
   调用可以沿用通用工具批准，但批准后不得再加第二层包审批。
4. **宿主不确定时退回 Pi**：Cindy 无法识别 manifest、filter、symlink、构建产物、资源类型或
   新版包格式时，必须优先使用 Pi 原生包发现／加载路径；禁止因 Cindy 未覆盖全部情况而
   fail closed。Cindy 可以隔离自己的内部桥接文件，但不能据此隔离用户明确安装的 Pi 包。
5. **Agent 必须有恢复路径**：失败回执至少区分 Pi 原生命令失败与 Cindy 辅助分析失败；前者
   提供脱敏、可行动的错误类别，后者不得阻断。不得把原始可修复错误吞成只有“操作失败”的
   死路，也不得禁止 Agent 在用户授权后换 source/version、补构建或重试。
6. **对等测试是硬门**：包管理改动必须覆盖“Pi 原生命令成功 + Cindy 分析失败／超时／未知格式”
   仍安装并加载，以及失败后 Agent 可继续重试。任何以“安全增强”为理由接受 Cindy Pi 低于
   原生 Pi 能力的测试预期都应删除或改写。

允许保留的边界仅限 Cindy 自身运行所必需、且不改变 Pi 用户包结果的机械隔离（例如不把远端
会话指向控制端本地路径、保护 Cindy 内部凭证不被写入包目录）。这类边界也不能被描述成
Cindy 对 Pi 的产品安全升级，更不能拿来扩大阻断范围。

## 4. 维护不变量(改动时不得破坏)

1. **权限档从严到宽**:`capabilities.permissionModes` 必须 `[ask, auto, bypassPermissions]`
   顺序,`[0]` 是最严档 —— 无人值守链路(`hook-control/defaults.ts`)在「显式档不被支持」时
   回落 `[0]`,顺序错了会把更严选择静默放宽成完全访问。由 `pi-capabilities.test.ts` 守。
2. **凭证路径判定三处同步**:`shared/auto-review.ts CREDENTIAL_PATH_PATTERNS`、
   `cindy-bridge-source.ts touchesCredentialPath`、`auto-review-policy.ts` 只读分支全字段扫描
   必须同口径。bridge 自包含不能 import,改一处记得改三处。
3. **斜杠命令转义**:`escapeLeadingSlashCommand` 对 `/` 开头用户输入前置空格转字面(仅放行
   `/skill:`)—— pi RPC prompt 会执行扩展命令(`/plan` 被 plan-mode 吃掉且不留痕),不转义会让
   Cindy 状态镜像脱同步并暴露未来扩展命令攻击面。
4. **auto 档 dispatcher fail-closed**:分类抛错 / 无 resolver 一律不放行。
5. **成本计量**:models.json 的 cost 来自 host 模型目录(`ModelDescriptor.cost`),缺省按 0;
   派生链 `catalog-to-descriptors.ts` → `capabilities.availableModels` → `writeModelsJson`。
6. **权限弹窗正文**:`PermissionPrompt.formatToolInput` 必须 harness 无关(pi 小写工具名 +
   path/command 字段,CC 大写 + file_path),由 `formatToolInput.test.ts` 守。
7. **统一会话树真相**:Cindy `parentSessionId` 是外层独立会话分叉;Pi JSONL entry tree 是当前
   Pi 会话内分支。Pi 导航后必须通过 `session.treeRehydrate` 原子替换 SQLite 可见投影,旧行仅
   soft-hide;切换只改对话上下文,不得声称或尝试回滚工作区文件。
8. **项目资源显式装配**:root、只读 subagent 与离线 fork 启动 Pi 时都必须显式传
   `--no-approve`;没有 Cindy-managed 本机用户包根时同时传 `--no-extensions`。本机普通 runtime
   存在明确安装且未停用的用户包根时，为保留 Pi 原生 package discovery 可以只省略
   `--no-extensions`：包根只能来自 Main 生成的 runtime `settings.json`，`--no-approve` 仍是项目
   `.pi/extensions` / `.pi/settings.json` 的硬门，不得因此传 `--approve` 或读取项目设置。root
   仅用重复 `--extension` 回装 Cindy 自有 bridge/subagent 与 pinned plan-mode，并仅用重复
   `--skill` 装配 host 从 PR3 approval snapshot 判定 eligible
   的项目 skill 目录。eligible canonical 目录必须先完整物化到当前会话 `configHome` 的非自动
   扫描目录，再把隔离快照路径交给 Pi；不得把仍可变化的项目原路径直接放进 argv。复制期间
   任一越界 symlink、特殊文件或路径替换会使整组 skills fail closed。不得读取/复制项目
   `.pi/settings.json`，不得传 `--approve`，
   不得依赖 `PI_OFFLINE=1` 代替 packages/extensions 硬门。root 不传 `--no-skills`，以保留现有
   user/global skill 行为；项目 skill 的 `loaded` 只能由当前会话 `get_commands` 对隔离快照路径
   的 exact temporary/local provenance 证明。approval 真源缺失、异常、撤销、失效、路径消失
   或快照失败时，新会话
   一律不带项目 `--skill`，并在 per-session runtime manifest 记录诊断原因。
9. **Pi bash bounded timeout**:Cindy 覆盖的模型可调 `bash` 在 execute 入口强制默认
   `300s`、上限 `1800s`。缺省或非正数用默认;大于上限或非有限数字 fail-fast(参数错误,
   不是 `Command timed out`);合法秒数原样交给 Pi 原生执行器。不另起 timer / AbortController。
   覆盖范围是 Cindy 当前可达的模型 bash 路径(本地新进程、SSH 新进程、ask/auto/Full access)。
   Pi RPC `{type:'bash'}` 与 MCP 工具不在此契约内。tool schema / description 必须与上述语义一致。
10. **Pi 会话 spawn env 稳定性(轮 41,2026-08-12)**:同一 `sessionId` 的重建(断链重连 /
   恢复 / 重启挂回)spawn env 必须**逐字节稳定**(除显式换代)。远端 daemon 的
   `pi/ensure` 以 envHash 全量对比判定条件 restart——**任何 per-call 随机值
   (`randomBytes` / 时间戳 / 计数器)进入 spawn env 都会让 envHash 必变 → 重连即
   kill + 全新建,毁掉「断链保活 / 纯 attach」语义**。轮 41 实锤:pi session bridge
   token 曾每次 `randomBytes` 新生成,正常对话中 SSH 闪断一次就杀一次 pi。规则:
   新增 spawn env 键前先问「同 session 重建时这个值变不变?」——会变就必须确定性派生
   (如 `HMAC(进程级key, sessionId)`),或走非 env 通道(文件 / RPC 参数)。由
   `piEnvironment.test.ts` 的 token 稳定性断言守;`session-registry` 的 envHash
   机制测试只守「mismatch 会 restart」,守不住「env 不会自己 mismatch」。远端 Cindy-owned
   extension(`cindy-bridge` / `cindy-subagent`)源码字节必须进入 launch identity:
   `CINDY_PI_EXTENSION_BUNDLE_HASH` 只由源码确定,禁止随机数或时间戳;字节不变可 reattach,
   字节变化必须 restart。
11. **正式包后台脚本启动边界**:Desktop 正式包保持 `RunAsNode=false`,因此 Main 的
   `process.execPath` 是 Cindy 应用程序,**不是 Node 可执行文件**。Pi Subagent 的 durable
   runner 必须经 host 注入的 `spawnPiSubagentRunner` 交给 Desktop
   `utilityProcess.fork` 固定入口执行;扩展与 maker-core 不得再拼
   `ELECTRON_RUN_AS_NODE=1` 或把 `process.execPath` 写入子代理 env。开发版 / Vitest 里
   `process.execPath` 恰好可执行 JavaScript 不构成生产证据。打包契约测试必须同时断言
   `RunAsNode=false`、固定 utility-process 入口在 forge 清单中、Pi host 使用该入口，避免
   两份各自正确的测试再次掩盖跨模块矛盾。身份校验必须读未截断命令行（POSIX `ps -ww`
   / Linux `/proc/<pid>/cmdline`）；成功读到的命令行不含本 run 的 `runnerScript` 即
   视为 gone，只有读失败才 unverifiable。紧急停止和就绪超时都先对 runner pid 发 SIGTERM
   再 SIGKILL，禁止 `kill(-pid)` 把 utility-process 当成独立进程组。未确认退出不得写
   failed 终态（控制协议要带回 unconfirmed），否则 quit / 账号边界 sweep 会跳过仍可能活着的 runner。
   真正 spawn 前必须再读一次账号边界，并把在途 launch 纳入 teardown 收敛。Host 只用
   realpath 校验包含关系，传给 runner 的 argv 必须与 `config.runDir` 同一套原始绝对路径。
   dispose 未确认 runner 退出必须失败；Host 观察到的退出要能通过控制协议通知前台等待，不能只靠 status.json。
   Windows 上 SIGTERM 不得带 taskkill /F；前台若已读到终态必须先返回，不得被 Host 退出通知盖成失败。

## 5. 已交付(2026-07 里程碑)

- redacted thinking 不再显示为空卡片;PI 会话图标(π);Auto-review 核心 + pi adapter + auto 档;
  PI_OFFLINE / NO_PROXY;`--append-system-prompt`;斜杠转义 + 只读工具凭证收口;成本计量真值;
  权限档四语 i18n + 弹窗正文归一化 + 能力契约测试。
- 自动化安全网:maker-core PI 定向 + 端到端集成(真 pi 二进制 + 真 bridge + 假模型工具调用)
  覆盖安全命令静默执行 / 危险命令升级并 deny 拦截 / 区内写落盘 / 凭证读升级 / 普通读直通 /
  斜杠转义 / models.json 计费透传。
- PR4 项目资源桥:只装配 Cindy 明确批准的 `.pi/skills` 与 cwd→git root 范围内
  `.agents/skills`；真实 pinned Pi RPC 夹具覆盖未批准/显式 skills、重复名、并发隔离，以及
  项目声明 npm/git/local packages 与 extensions 时零 install/clone/第三方执行。

### SSH 远端能力(2026-08 里程碑,轮 39 补记)

- **形态**:SSH remote 已交付。远端 daemon 唯一形态是 `packages/maker-pi-manager/`
  (TS 单例 Node daemon,NDJSON RPC over unix socket,per-host 常驻);Python per-session
  daemon(`pi-daemon.py`)已完全退役并从仓库移除。新增 `PiTransport` 抽象(本地
  `createPiStdioTransport` / 远端 `createSshPiDaemonTransport` 双实现,PiRpcProcess
  感知不到差异)。
- **关键组件**:`maker-pi-manager`(protocol/codec/server/client/session-registry/bin)、
  `pi-manager-installer.ts`(probe/install/ensure/uninstall)、desktop 侧
  `pi-manager-client.ts` / `pi-remote-transport.ts` / `pi-host.ts` 装配。
- **凭证面**:网关 key/BYOM key 经 SSH 加密通道传远端,落 per-session env-file(0600);
  kill/空闲回收(30min)/daemon 重启(cleanupStaleState)三路径清理。Full Access 下
  bash 可读父进程 env 的已知风险(见上文 §3)同样适用于远端会话 —— 远端会话的
  ask/auto 档同样受限。BYOM key 落远端机器是设计语义(远端 pi 直连 BYOM endpoint),
  用户可见性由 i18n 文案覆盖。
- **受限能力(有意)**:远端会话不支持本地 fork(`forkSdkSession` 抛 remoteFork);
  `/review` 对 SSH 远端会话前置拦截(device-link 同款);无自动重连(用户手动 Retry,
  与 CC/Codex 对齐);版本差 + daemon 活着时 defer 并显示 UpgradeBanner, 用户确认
  后才 kill + 重装(daemon 已死则静默升级磁盘 bundle)。

## 6. 上线门禁

- [x] **平台分发**:pin 已升级到 Pi `v0.84.3`，darwin arm64/x64、linux arm64/x64、
      win32 arm64/x64 六份官方资产都进入 digest pin；下载器兼容 Unix `pi/` 嵌套包与
      Windows 根目录平铺 zip。当前 Mac 已完成六资产 SHA-256 下载验收；非本机 OS 的
      最终启动 smoke 仍由对应发布 runner 执行。2026-08 起 pi 与 cc/codex 一样只走
      CDN 运行时分发链(`agent-binaries` + splash prepare):CDN manifest 的可选 `pi`
      字段指向整包 tar.gz(归档根即完整目录分发,SHA256 为 tar.gz 的),启动时按
      manifest 版本下载到 `userData/pi/<version>/` 并清理更旧版本；prepare 会先对所有带
      `.verified` 的本地候选执行有界 `--version` 探针，真实 semver 不低于 manifest 时直接
      保留该安装（包括原地自更新后目录名仍旧的情况），不下载也不清理。只有 manifest
      版本更高，或探针没有得到可用候选时，才沿用原 CDN 安装流程。正式安装包不内置 Pi；
      manifest 缺字段或下载失败时**不阻塞启动**(splash 不进失败态),本次不注册 pi。
      **不变量(刻意如此,别当 bug 改掉)**:`pi-host.resolvePiBinaryPath` 只读
      `getReadyBinaryPath('pi')`——即本次启动 prepare 成功回填的路径,**不回落
      `getCachedBinaryStatus`**,因此不会复用上一次启动下载的旧版本。`prepare()` 先取
      CDN manifest、取不到就直接失败(不看本地存货),所以离线时 pi 本次不可用。这与
      Claude Code 一致(同样只读 `getReadyBinaryPath`),但与 **Codex 不同**——codex 读
      `getCachedBinaryStatus`,会接受早前已 `.verified` 的旧版本,离线仍可用。想让 pi
      也离线可用属于行为变更,需先确认再改,不要以"和 codex 对齐"为由顺手改回。
      发布入口**不在本仓**:
      二进制发布统一走 cindy 同级目录的独立工程 `cindy-binary-release`
      (`pnpm release:pi -- --region cn|global`,默认 canary 通道;配置与安全机制见
      该工程 README)。本仓只保留版本 pin 与暂存(`pnpm update:pi` / `install:pi`)。
- [x] **协议/模型兼容自动矩阵**:Anthropic Messages、OpenAI Responses、OpenAI Chat 三种
      Pi 原生 BYOM 映射均有契约测试；真实 Pi + fake gateway 覆盖 thinking/tool streaming、
      MCP bridge、redacted/usage 翻译，ChatGPT 订阅已做真实请求与 cacheRead 验收。发布账号的
      每个真实模型(chatgpt/、xai/、glm、deepseek、kimi…)仍建议在 release candidate 上
      anthropic-compat 下至少跑一轮**带工具调用**的回合,逐个确认 thinking 格式 / tool
      streaming / redacted thinking 正确；这是额度/账号发布 smoke，不再是功能缺口。
- [x] **compaction**:启动显式开启 Pi 原生 auto-compaction；threshold／overflow 压缩及续接由 Pi
      负责，Cindy 只投影事件并在本机确定性失败后换窗。手动 compact、boundary/usage 翻译、
      compaction digest 写入与缓存命中仍有测试。
- [x] **无人值守**:scheduler 对 `agentKind=pi` 使用 Pi 默认模型与
      `bypassPermissions` 的契约测试已补；Pi bridge 的 auto allow/deny 也用真二进制覆盖。
- [x] **resume 边界**:已用 Pi v0.82.1 真二进制创建 JSONL，再由 v0.83.0 恢复；
      invalid resume 在适配层先校验文件存在并遵守 CAS，precise rewind/fork 后 resume 有真二进制测试。
- [x] **prompt cache**:Pi 子进程默认注入 `PI_CACHE_RETENTION=long`；不支持的 provider
      忽略该选项。已用 ChatGPT 订阅实例确认 `cacheRead` 命中会端到端落库与展示。

## 7. 上线后路线图(已与 Chris 对齐)

项目 trust 的输入/输出契约见 [`pi-project-trust.md`](pi-project-trust.md)。PR4 已按该契约
收缩为 skills-only 显式装配；它不授权 `--approve`、trust.json、项目原始 settings 或用户
Pi home 复用。settings/packages/extensions 仍属于后续独立安全评审范围。

> 续做指南(每项怎么接着做 + file:line 锚点 + 坑)见 `docs/dev-rules/pi-remaining-work.md`。

- ✅ **HTML 导出**(已交付):`export_html` RPC 全链路仍在。会话头部 overflow 菜单入口暂隐
  (Pi 专属项先不进 `···`)。见 `Capabilities.sessionHtmlExport` /
  `Session.exportSessionHtml` / `MAKER_INVOKE.EXPORT_SESSION_HTML`。
- ✅ **手动压缩**(已交付):`compact` RPC 全链路仍在。头部 overflow 菜单入口暂隐;对话区
  context ring 仍可点按压缩。良性「nothing to compact / too small」→ `noop`(不报失败)。
  见 `Capabilities.manualCompact` / `Session.compactSession` / `MAKER_INVOKE.COMPACT_SESSION`。
  注:pi 斜杠转义后用户无法手输 `/compact`,context ring 是当前 Pi 会话手动压缩入口。
- ✅ **subagent 接 pi 轻量引擎**(已交付):Orca worker 可选 `pi` 引擎。核心链路(MCP
  schema / worker 创建服务 / 默认模型 claude-sonnet-4-6 / PiAgent 注册)本已按 AgentKind
  接通;本次补齐 UI(CreateWorkerPopover / composer「+」菜单协同项 / draft 映射)、两个
  main IPC coercion(WORKER_CREATE / SESSION_ENABLE_ORCA)、worker 展示(π 而非 Claude 脸)。
  注:pi 二进制缺失时 buildPiAgent 返回 null,pi 不进 agents map,建 pi worker 会抛错。
- ✅ **压缩即记忆**(已交付):新增 `digest` 记忆类型(与 curated 解耦)。pi `compaction_end`
  带 `result.summary` 时经 `deps.makerMemory.write` 写 digest —— 进 FTS 可 `memory_search`,
  但排除出 MEMORY.md / system prompt / LLM 的 memory_write 工具,**不污染 curated 记忆**。
  gate 同 CC(makerMemoryEnabled + manager),fire-and-forget。见 `memory/types.ts`
  (MEMORY_TYPES / CURATED_MEMORY_TYPES)、`memory/storage.ts rebuildIndex`、`pi/index.ts`
  writeCompactionDigest。
- ✅ **BYOM / 本地模型**(已交付):自定义/本地模型走 pi 原生 provider 块直连,不过 compat 代理。
  链路:CustomProviderDialog pi tab(+ api 选择器)→ custom-provider-store(pi runtime)→
  user-provider 派生 → pi-host `resolvePiNativeProviders` → PiAgent writeModelsJson 原生块 +
  provider 感知 setModel。真二进制测试证明直连原生端点、网关零请求。
- ✅ **统一会话树**(已交付):Cindy session fork 与 Pi append-only entry tree 的后端/
  对话框实现仍在。头部 overflow「任务分支」只在存在 Cindy 分叉家族时显示,不再单凭
  `agentKind=pi` 露出。支持原生分支切换、可选分支摘要、选中 user entry 回填原 prompt、
  SQLite 可见时间线原子重投影与上下文 usage 恢复;device-link / mobile transport
  contract 同步开放。切换不回滚工作区文件。
