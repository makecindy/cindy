# Desktop 开发、启动与验证

## 排队消息展示

Desktop 与 Mobile 都把待发消息作为消息流气泡展示，气泡下方的「排队中」菜单提供插话、编辑、上移、下移与取消发送。输入框不再承载独立队列列表。已在提问卡展示的异步回答不产生待发气泡或菜单，判据与手机共用 `isAnsweredAsyncQuestionClientId`；后台投递照常。

Desktop 在工作过程分组后追加待发项（`pendingQueueItems.ts`），避免待发输入提前截断当前助手轮次。待发项与正式回流使用相同的 `msg-clientId` key，已回流的历史优先，防止队列快照迟到造成双显。`PendingQueueBubble` 复用 `UserMessage`，操作可用性使用 `maker-shared/queue` 的共享判据。编辑锁由任务页持有，不随气泡虚拟化卸载而释放；队列通知放在消息流 footer。

定向界面验证：`pnpm ui:check --page pending-queue --theme all`。真实派发仍由现有输入协调器负责。

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

只为检查界面改动（样式、布局、文案、深浅色、多语言）时不必启动 Desktop，先用下文
「单页 UI 快速验证」；需要真实 IPC、登录、数据库或跨设备行为时再按本节启动。
需要完整主界面但不想登录或碰真实数据时，加 `--mock` 用免登录的模拟数据启动，见
[UI 模拟数据](ui-mock-data.md)。

Agent 启动 Desktop 只使用仓库根的安全包装命令，并显式选择目标区域。restart
命令默认使用固定的 `dev` 命名隔离沙箱（等价于自动附加 `--isolated=dev`），
不再默认共享 Cindy 账号登录态与业务数据。OpenAI 模型登录态是刻意保留的例外：
普通 Dev 可只读复用同区域 Release／本机 Codex 已有登录态，能够调用模型，但不能在
Dev 内发起 OpenAI 登录或断开共享登录态。同 owner 的 Release 授权通常优先；若其 access
token 已过期，且本机 Codex 有同账号／workspace、有效期明确且尚未过期的授权，则改用
本机授权，避免旧 Release 快照挡住已恢复的登录。有效期未知或账号无法确认时保持原优先级；
与 Release 共用 userData 的 Dev 不自动切换来源。实现与回归见
`maker-host/codex-shared-auth.ts`、`codexAuthIsolatedSandbox.test.ts`。
Claude Code 的配置目录同样不隔离：Dev 与正式版
一样使用 CLI 默认的 `~/.claude`（不设 `CLAUDE_CONFIG_DIR`），所以直接沿用本机 Claude Code
的订阅登录；在 Dev 里「使用 Claude Code 登录」等同于在终端运行 `claude auth login`，「断开」
只撤销本实例的使用许可。代价是多个 Dev 实例与安装版在同机共用 `~/.claude` 下的 Claude 转录
（按 sdk session id 区分；同机导入分享包时同 id 转录会复用同一份）。旧版 Dev 隔离在
`<userData>/claude-home` 的转录与文件检查点，会在启动时后台一次性补拷到默认目录（只补缺、
不覆盖、不删旧目录；拉起 Claude CLI 前最多等一次 15s）；补拷完成后，旧 checkout 再写进旧目录的
转录不会再补拷：

```bash
pnpm restart:desktop:remote --region=global
pnpm restart:desktop:remote --region=cn
```

默认 `dev` 沙箱与 checkout 路径无关：无论从主仓还是哪个 worktree 启动，
Global 都落在同一个 dev 沙箱，CN 也落在同一个 CN dev 沙箱；登录态与 dev 数据持续保留。
需要按 worktree 拆分数据时才显式传 `--isolated=@worktree`，它会按 checkout 目录名派生
稳定沙箱名（去掉前导 `cindy-`，再加路径短哈希）。

只有用户明确说「共享登录 / 不要重新登录 / 用现有数据」时才加 `--shared`；用户明确
「不要关当前实例」时才加 `--preserve-running`。不要把「用户没提模式」理解成共享。
需要复用旧的共享正式 profile 时，命令是：

```bash
pnpm restart:desktop:remote -- --shared
```

启动命令结束时必须出现一行 `DESKTOP_DEV_VERDICT=ready` 才算成功；看到
`DESKTOP_DEV_VERDICT=failed` 或根本没有 verdict 行，不得声称开发版已起来。
失败时把 `code` / `message` 交给用户。若有 `next=` 且用户没有点名必须共享，
可以执行那条 next 命令重试。不要给启动命令接会吞退出码的管道。

Agent 没有 TTY 时，dev 会在新开的 Terminal（macOS）／cmd（Windows）窗口里运行。macOS 上
该窗口的输出同时写入当前 checkout 的 `apps/desktop/logs/dev-terminal.log`（每次启动覆盖，
只保留前 8MB，足够覆盖启动过程；之后的运行日志看按天轮转的 `main-*.log`），窗口关掉后仍可查；启动失败时命令会直接打印日志末尾，verdict 带 `log=` 指向该文件。
排查启动失败先读这份日志，不要靠反复重启猜原因。

Forge 开发进程默认使用 8 GiB 的 Node 堆上限，为主进程／Worker 的 watch 图和 Renderer
冷启动转换留出空间；已复现过 6 GiB 上限在完整冷启动时触发 `JavaScript heap out of memory`
并以 `134` 退出。显式设置的 `NODE_OPTIONS` 堆上限仍优先，入口见
`scripts/shared/desktop-dev-node-options.mjs`。restart 的就绪等待包含完整冷构建与窗口／登录态／
数据库初始化，默认等待 180 秒，避免在构建刚完成时误报超时。

停止旧实例后的 macOS Terminal 标签页清理，只访问已经运行的 Terminal，并按旧实例的精确
TTY 匹配标签页；Terminal 未运行时直接跳过，不能因清理 iTerm 等终端的 TTY 而将它启动。
实现与回归见 `scripts/restart-desktop-remote.mjs` 和 `scripts/__tests__/restart-desktop-remote.test.mjs`。

Desktop 连接的是你自己的 Cindy 云端账号（remote）。这与登录页中免 Cindy 账号的
「跳过登录」（应用内显示为「未登录」，无需账号即可使用本机 agent；代码内部标识仍为
`local` mode）不是同一个概念。Agent 不得自行改用
`pnpm dev:desktop` 或 `pnpm dev:desktop:remote` 绕过包装脚本。

启动包装会先停止**当前 checkout** 已有的 Desktop dev 进程；其他 worktree／命名沙箱的
实例不受影响。必须尊重宿主提供的并行或保活工作流。脚本只在宿主是**当前 checkout**
的 desktop dev 时拒绝重启（杀掉宿主会连这次启动一起收掉）。宿主是正式版或另一个
worktree 时可以起隔离沙箱；从另一个 checkout 的 desktop dev 里起共享实例仍会拒绝，
避免两份进程抢同一份正式 profile。若因当前 checkout 宿主拒绝、或目标 userData 被其他
checkout 占用而中止，不要换命令绕过，应把 verdict 交给用户。

## 可选启动参数

只调试本机设备互联服务、仍使用真实账号登录时，保持 `restart:desktop:remote`，
仅在本次启动环境按账号区域设置 `XDT_DEVICE_LINK_CN_LOCAL_URL=http://127.0.0.1:<端口>`
和／或 `XDT_DEVICE_LINK_GLOBAL_LOCAL_URL=http://127.0.0.1:<另一个端口>`。
此覆盖只供未打包的开发版使用，只接受带显式端口、无凭据/路径的 IPv4/IPv6 回环地址，
仅作用于对应区域的当前会话及按区域读取的设备互联端点。旧 `XDT_DEVICE_LINK_LOCAL_URL`
只作为 CN 的兼容别名，不能把 Global Access Token 发往 CN 服务。正式版忽略这些覆盖；认证、SSO 双区发现、
模型与其他服务仍按原清单和账号区域运行。跨电脑可使用经明确授权的临时回环隧道。
不要为只替换设备互联服务而启动完整 `local` 模式：它会把两个账号区域固定到同一套
本机服务，不能承载真实双区企业 SSO。

两个 restart 命令都支持下列参数。不加任何模式旗标时默认走固定的 `--isolated=dev`
命名沙箱；要回到旧的共库行为必须显式加 `--shared`。这些参数只对 dev 生效，不影响
用户机器上的正式版。

- `--region=cn|global`（默认 `global`）：切换构建身份与仓内端点清单；中国大陆版
  必须显式传 `--region=cn`，读取 `config/endpoint.json`。
  remote 开发启动忽略环境里的 `XDT_ENDPOINT_MANIFEST_FILE`，始终按所选区域重设
  端点文件，避免继承宿主的其它区域或自定义服务器。`--endpoints-cdn` 仍走所选区域的
  线上 CDN；本地服务调试（local）仍保留本地端点文件配置。
- `--shared`：显式选择共享 userData（旧默认行为）：dev 与正式版共用当前区域的正式
  profile，数据库、登录态、会话完全共享。仅当用户明确要求「共享登录 / 复用现有数据」
  时使用；禁止与 `--isolated` 或环境里的 `XDT_ISOLATED=1` 组合。
- `--isolated` / `--isolated=<名字>` / `--isolated=@worktree`：使用独立 userData 沙箱，数据库、Cindy 账号登录态、会话、定时
  任务与设备身份都与正式版彻底隔离（首次需重新登录 Cindy 账号）；OpenAI 模型登录态按
  上述只读例外复用，Claude Code 按上述约定使用默认 `~/.claude`。命名沙箱每个名字一条独立沙箱，
  名字限 `A-Za-z0-9_-`、≤32 字符。`@worktree` 是保留名，按当前 checkout 目录派生沙箱名。
  用户说「独立数据库／隔离数据／沙箱启动／不要动正式版
  数据」时用；Agent 把「启动开发版」也落在这条路径。**未合入主干的 migration 必须在 `--isolated` 沙箱里跑，不得连共享 userData**
  （见 [`database-and-migrations.md`](database-and-migrations.md)）。沙箱（及任何 dev
  userData 覆写）内不触发首登旧数据迁移（mToc）：不探测老目录、不弹确认窗、不把正式
  数据复制进沙箱。**`--isolated` 不得落在任一正式 profile 上**：显式 `XDT_USER_DATA_DIR`
  若指向 CN / Global / Dev 任一正式目录（不限当前构建区域），启动器与主进程都 fail closed。isolated 会换独立 deviceId，
  正式目录里的 refresh token 属于正式版设备，叠在一起必然 `DEVICE_MISMATCH`，再删盘会
  把正式版踢下线（2026-08-16）。
- `--mock`：免登录的 UI 模拟数据。未指定沙箱时使用独立的 `--isolated=ui-mock`，首次启动直接
  进入「未登录」模式并写入两端共用的模拟任务；不能与 `--shared`、`--preserve-running` 组合。
  细节见 [UI 模拟数据](ui-mock-data.md)。
- `--passive`：定时任务被动模式，本实例不自动触发 schedule。多开导致定时任务重复、
  需要让位给 primary 时用。它可以和 `--isolated` 组合（隔离沙箱只看 UI、不跑定时任务
  是合法的）。**共库只读契约不是这个旗标本身**，而是解析后的正式 profile + passive
  才落地。共享正式 profile 的 passive 实例对
  userData 布局保持只读：不执行 owner-namespace 迁移（claim 推迟到下次独占启动），
  legacy 数据导入（`hasLegacyOwnerNamespaceClaim` 门控的 secret／IM／brain 搬账）
  一并等待。非 passive 实例执行该迁移前也会先查 `.dev-instances` 实例注册表
  （dev 与 packaged 实例都登记——dev 与正式版共库双开受支持），发现其它存活实例
  共享同一 userData 时同样推迟——搬家式迁移必须独占 userData 才能执行，否则会打断
  还在运行的旧版本实例（2026-07-23 slack-hook.json／网关凭证被搬走事故）。
  **auth 凭证同属这条契约**：passive 共享实例不得**删除、作废或消费**整机共享的 auth
  持久状态——磁盘 refresh token、服务端 device token（调登出会连坐作废 primary 的
  那份）、relogin marker（一次性，被消费掉 primary 就再也看不到）、canary flag、账号
  删除 receipt。它的「退出登录」只清本进程内存态（`authManager.ts` 的
  `isPassiveSharedUserDataInstance`）。代价是同机两个实例的登录态可能不一致，这是有意
  的：passive 无权代表整机登出（2026-07-27 事故：MIGRATE_FAILED 的 passive 实例在
  fatal 界面点「返回登录」，删掉整机 refresh token，primary 在 19／46 分钟后的续期周期
  被强制重登）。
  约束的是破坏性动作，**不是写入本身**：passive 照常排续期 timer，轮换后正常写回新的
  refresh token——那写入的是有效凭证，primary 侧由 replacement-retry 消化。反过来让
  passive 停止续期，会使它的 access token 过期后再无替换途径（primary 的续期只更新磁盘
  token，不更新 passive 进程的内存态，而直接走 `apiFetch` 的路径没有 401 refresh/retry）。
- `--preserve-running`：启动编排，不是运行期模式。默认 restart 本来就不会关正式版和
  其它 worktree，只替换**当前 checkout** 的旧 dev；本旗标连这份旧 dev 也保留，再并排
  开一个共库预览，并强制 `--passive`。启动前必须由 `.dev-instances` 存活记录证明已运行
  实例与目标区域一致，旧记录没有 region 或跨区域都会 fail closed。仅供能证明实例归属的
  上层编排，或用户明确「不要关当前实例／不要重新登录」时用。仅支持 remote。禁止与
  `--isolated` 或环境里的 `XDT_ISOLATED=1` 组合。共享实例若只发现没有 realm 的旧版裸
  refresh token，也不得猜区域迁移或轮换，保持本进程登出，交给同区域独占实例完成凭证迁移。

已手动设 `XDT_USER_DATA_DIR` 时尊重用户值，不覆盖，也不探测或迁移正式区域目录。
唯一例外：`--isolated` / `XDT_ISOLATED=1` 把该目录指到正式 profile 时直接拒绝启动。

正式版目录保持历史兼容：CN → `Cindy`，Global → `CindyGlobal`，不在启动时改名或搬迁用户数据。
`--shared` dev 使用当前区域对应的正式 profile；`--isolated` 沙箱再按相同区域映射派生目录。
**dev writer 不得把正式 profile 升到当前 checkout 比安装版更新的 schema**：有 pending
migration 就拒绝启动，改用 `--isolated=<名字>`。`--preserve-running` / 共库 passive 仍只读。
跨区域共享、登录态迁移或旧版本回滚应使用显式隔离目录，避免不同构建误用同一 profile。

### 并行多开 dev

restart 的 kill 作用域是**当前 checkout（worktree）**：只停自己这份 checkout 的 dev
进程，其他 worktree／命名沙箱的实例一律保留（2026-07-30 约束：并行沙箱不得被另一个
checkout 的启动器顶掉）。因此并行多开的标准姿势是：**每个 worktree 显式传
`--isolated=@worktree` 或 `--isolated=<名字>`**，各自使用独立沙箱；默认 `dev`
沙箱跨 worktree 共用，适合单人常规开发但不能并行多开同一份 userData。

配套护栏与工具：

- **userData 冲突门**：目标 userData（按 `--isolated` 名字推导）已被其他 checkout 的
  dev 实例占用时，restart 会在杀任何进程之前中止并列出占用进程——不代杀、不共库。
  verdict 为 `USERDATA_IN_USE` 并给出 `next=… --isolated=@worktree`：执行它即可改用本
  worktree 自己的沙箱并行启动（首次需登录）；或由用户自己停掉那个实例后重试。
- **嵌套的托管 worktree 不算本 checkout**：`.cindy-worktrees/<name>` 位于主 checkout
  目录内，进程归属按命中的最深 worktree 判定。从主 checkout restart 不会停掉托管 worktree
  的实例，冲突门也会把它们当作其他 checkout。检测靠 helper 进程命令行上的
  `--user-data-dir`，对方实例刚启动还没起 helper 时可能漏检，属尽力而为。
- **借用的 Node 不算归属**：判断归属前先去掉命令行开头的 Node 运行时与包管理器入口
  （node / pnpm / npm / corepack）。另一份 checkout 借用本 checkout 自带的 node 启动 dev
  时，本 checkout 的 restart 不会把它当成自己的实例杀掉；Electron、electron-forge 等指向
  checkout 自身依赖的路径仍是归属依据。
- **CDP 端口**：dev 的 remote-debugging-port 固定 9222，只有先起的实例能绑上。后起
  实例需要 CDP 调试面时，用 `XDT_CDP_PORT=<端口>` 覆写（仅数字生效，dev-only）。
- **模拟 Rosetta 转译**：在 Apple 芯片上检查「Intel 包换装提示」和启动日志的 `[arch]`
  行时，加 `XDT_SIMULATE_ARM64_TRANSLATION=1`；只在源码运行时生效，安装包只认 Electron
  的 `app.runningUnderARM64Translation`。
- 同一 checkout 内仍是单实例语义：restart 会替换本 checkout 上一个实例（不论沙箱
  名字），一个 worktree 同时只跑一份 dev。
- 共享 userData 的并行（`--preserve-running` 被动预览）语义不变：不停任何实例、强制
  passive、禁止与 `--isolated` 组合，仅供能证明实例归属的上层编排使用。

Agent 自身仍只走 restart 命令，不直接调 human-only 的 `dev:desktop*`。共享同一 userData
多开时，非 primary 实例用 `--passive` 让出定时任务调度（见上）。

### 开发深链与系统关联

未打包的 Desktop（`app.isPackaged === false`）不注册 `cindy://` 或历史
`xdt-maker://` 的 OS 默认处理程序，也不改写 Windows 协议显示名。这与区域、
`--isolated`、`--shared`、`--passive` 以及 `process.defaultApp` 是否存在无关。
隔离 userData 不能隔离系统 URL 关联；临时 checkout 退出或删除后，系统关联仍会保留。

macOS 的 `setAsDefaultProtocolClient` 不保存 `path` / `args`（这两个参数仅适用于
Windows）。把默认处理程序设为 stock `Electron.app` 后，冷启动它没有项目入口，可能
只显示 Electron 欢迎页。Windows 虽能保存入口命令，也不能让临时 checkout 接管正式链接。
不在退出时调用 `removeAsDefaultProtocolClient` 来“恢复”：该 API 只移除当前默认处理程序，
不承诺还原之前的应用，异常退出也不会执行清理。参见
[Electron 协议注册 API](https://www.electronjs.org/docs/latest/api/app#appsetasdefaultprotocolclientprotocol-path-args)。

开发验证分两层：

- URL / argv 解析、登录前 pending 和导航分发继续使用既有入口；本次只跳过 OS 注册，
  `open-url`、`second-instance` 和冷启动 argv 接收不变。用现有深链定向测试验证这些行为。
- 浏览器点击、冷启动和运行中唤起须用 packaged macOS / Windows 验证。运行 dev 时直接
  点击系统链接仍交给原有安装版，不能把它当作当前 checkout 的验收。

已被旧开发版覆盖关联时，先正常关闭那份旧 dev。保存正式版中的工作后，从安装位置
（macOS 通常为 `/Applications/Cindy.app`，按实际区域/版本选择）正常退出并重新启动
对应的打包版，再重试链接；打包版启动会重新注册其协议。仅切换到已经运行的窗口不会
重新执行注册。Windows 若仍未恢复，在系统“默认应用”中检查这两个协议的目标应用。
不要批量注销所有 Electron 应用、删除用户 profile 或重置整个 LaunchServices 数据库。

实现与回归见 [deepLink.ts](../../apps/desktop/src/main/deepLink.ts) 和
[deepLink.test.ts](../../apps/desktop/src/main/__tests__/deepLink.test.ts)。该修复防止新的
开发实例覆盖关联，不会扫描或自动修复旧 checkout 留下的系统记录。

### 使用统计（TapDB）在 dev 下不上报

dev 构建**默认不初始化 TapDB**，与用户是否同意《隐私政策》、统计开关是否打开无关。闸在
main 侧 `analytics-settings-store.ts` 的 `isReportingBuild()`（`app.isPackaged !== true`
默认关），renderer 只消费 `allowed` 这个结论。

原因：TapDB Web SDK 的设备身份（`device_id`）写在 renderer 的 localStorage 里，而
localStorage 按 **origin + userData 目录** 分家——dev 的 renderer 从
`http://localhost:<vite 端口>` 加载（并行多开时端口自增），`--isolated[=<名字>]` 与
`XDT_USER_DATA_DIR` 每条沙箱又各有一份。于是一个开发者一天能凭空造出几十台「新增设备」，
把线上新增设备／转化率／次日留存全部带偏（2026-07-26 复盘：某地区单人一天 78 台设备、
新增账号 1、次日留存 2.6%）。dev 与 release 目前共用同一个 TapDB appId，只能在闸上区分。

要验证上报链路本身时，手动设 `XDT_TAPDB_DEV=1` 放行（严格等于 `1`，其它值一律视为关）。
**这会把 dev 数据打进线上 app，用完即撤，不要写进任何脚本或 `.env`。**

## 何时需要重启

- 修改 main、preload、MCP、原生依赖或 package 运行时代码后需要重启。
- 只修改 renderer 时优先使用现有实例的热更新，不重复重启。
- 不确定运行实例来自哪个 checkout 时，先运行 `pnpm desktop:whoami -- --all` 核对。

## 内存排查

main 日志里 scope 为 `memory-usage` 的行是各进程内存采样（正式版每 10 分钟一次，dev 每 30 秒
一次；实现见 `src/main/process-monitor/memory-log.ts`）：`main{...}` 是主进程
`process.memoryUsage()` 细分，后面按进程类型分组列出 `app.getAppMetrics()` 的常驻内存，
组内从大到小，单位 MB。排查「越用越卡」时，先按启动分段看 `Browser`（主进程）和最大的
`Tab`（主界面）每小时涨多少：持续上涨、重启才回落就是泄漏；再看 `heapUsed` 与 `external` /
`arrayBuffers` 谁在涨，区分 JS 对象和 Buffer。`mcpBridgeSessions` 是 Codex / Pi MCP 桥上
存活的会话数：每个会话持有一整个 MCP server（连同全部工具 schema），它应随运行中的
Codex / Pi 进程数起落，持续上涨说明有客户端退出后会话没被关闭（见
`mcp-integrations/codexHttpBridge.ts` 的 `closeSessionOwnedTransports`）。该 scope 只写进程类型与数字，已精确放行进
日志上报，不要往这行里加标题、服务名、pid 或路径。

`getAppMetrics()` 的 GPU 数字不含 IOSurface 等显存，macOS 上要看 GPU 进程真实占用用
`footprint -p <pid>`。

确认主进程在涨、要找是谁在涨时，在开发版日志目录的 `log-config.json` 写
`"mainHeapSampling": true`（与 `level` 并列），重启后主进程常驻 V8 采样式堆分析（实现见
`src/main/process-monitor/heap-sampling.ts`），每 30 分钟写一份到 `logs/heap-sampling/`，
保留最近 48 份：`.heapprofile` 可在 Chrome DevTools 的 Memory 面板载入，`.summary.txt` 按
「最近一帧应用代码」和「分配帧」两种口径列出仍存活的采样内存。对比前后几份摘要，持续
变大的那几行就是泄漏点。不要在用户正在用的 GB 级主进程上拍完整堆快照：会冻结一两分钟
并额外占用同等内存。正式版不读这个开关。

## 分层验证

工作目录误报缺失或切到备用目录时，参见[工作目录异常日志判读](../working-directory-diagnostics.md)，
按探测阶段、恢复结果与匿名关联标识区分原因，不要仅凭超时推断掉盘。

本节指导本地验证；提交前按 `development-workflow.md` 的「提交前验证」覆盖改动影响面，
默认使用 `pnpm test:unit:related`，也可采用等效定向测试与相关 package 的类型检查。
本机并发预算由使用者或宿主决定，CI 保留完整单测。根据实际改动选择最小但充分的检查：

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop lint
pnpm --filter desktop exec vitest run <测试文件路径>
pnpm --filter desktop test
pnpm build
pnpm test:unit:related
pnpm test:unit
```

- 改 TypeScript 至少运行相关类型检查和定向测试。
- 跨模块、共享 package、构建链或广泛重构再扩大到 Desktop 全量测试、构建或根级单测。
- 调整 Desktop Vitest worker 或测试分池前，先读取
  [`desktop-unit-test-performance.md`](desktop-unit-test-performance.md)，并用其中的
  benchmark 在相同测试范围下做前后对比。
- 数据库 migration、协议、更新器、权限与用户数据另有高风险专项规则；命中时先读取
  对应规则，不以本页命令替代专项验证。
- 记录实际执行和结果；未执行的高相关检查必须说明原因。

菜单栏状态按钮的原生回归在 macOS 上运行
`node apps/desktop/native/menubar/test.mjs`。它编译完整 Swift helper，并在离屏 AppKit
按钮上检查重复更新、标题、提示文字、远控标识和 Light/Dark 切换；不启动 Cindy 或创建
菜单栏项。该检查属于原生集成层，独立于默认单测池，需在 macOS 上手动执行，未接入 CI。
脚本分别输出编译与测试耗时；Windows/Linux 不支持运行，不能将其计为通过。

## 单页 UI 快速验证

`pnpm ui:check` 只编译被改的真实 renderer 组件，在一个隔离的 Electron 窗口（与 Cindy 同一
Chromium）里按「场景 × 主题 × 语言 × 窗口尺寸」逐个截图、做通用检查后退出，不加载 main、
登录、数据库或 Agent。一个场景约 0.5 秒，整页全矩阵通常在 20 秒内，可以在每次改 UI 后自检，
不必为此启动完整 Desktop。

```bash
pnpm ui:check --changed --theme all
pnpm ui:check --page group-chat --case all --theme all --locale all
pnpm ui:check --page group-chat --case long-device --compare
pnpm ui:check --list
pnpm ui:preview --page device-picker
pnpm ui:check:publish
pnpm ui:check:selftest
```

- `--changed` 按本分支改动选出加载了这些文件的页面；输出里 `UNCOVERED` 的文件**没有被验证**，
  需要补场景、用 `--entry` 临时挂载，或回到完整 Desktop。
- 报告首行 `UI_CHECK passed|failed`，`overview.png`（变体多时还有 `overview-2.png` 等）是截图
  总览，失败原因、宿主缺失接口和被替换的模块都写在 `summary.json`。自检读 overview 判断视觉
  效果，不靠“命令通过”下结论。
- `ui:preview` 只在需要人工手动验收时使用：保持一个窗口、改文件自动重载，关窗或 Ctrl+C 结束。
- 场景数据、宿主模拟、多语言和对比模式的写法见
  [单页验证说明](../../apps/desktop/scripts/ui-page/README.md)。

### 局部 UI 的默认迭代流程

局部样式、排版与交互问题优先沿用上述组件窗口完成复现、修复和人工试用：

- 复用已有 fixture；缺少覆盖时直接挂载真实生产组件，沿用共享样式、字体、主题和翻译，
  不复制 JSX／CSS 做一份外观相似的页面。模拟只补与本次验证无关的宿主依赖；被替换模块
  写入 `stubs`，未覆盖行为写入 `notCovered`。
- 修 bug 先留下失败场景，再用相同输入验证修复。尺寸、换行或抖动问题测实际浏览器布局；
  涉及过渡动画时采样中间帧，不能只比较 CSS 字符串或动画结束后的截图。
- 覆盖 Light／Dark 和受影响的鼠标、键盘状态；排版改动补相关语言与长文案，修改共享组件
  或字体时检查相邻消费者。执行适用的 `--changed` 检查并目检 overview，明确报告失败和缺口。
- 给用户试用时打开 `ui:preview`，说明所用分支和场景；等待用户验收期间保留窗口，不因
  助手回复结束就关闭。验收结束后只收尾本轮拥有的预览进程。
- 组件窗口不加载完整客户端及其用户数据，不需要抢占或重启已有完整客户端验收实例。
  涉及真实宿主、登录、发送、持久化、跨设备或原生窗口行为时，按下表升级验证；构建失败
  或 fixture 通过都不能作为这些行为已经验证的证据。

### 按改动选择验证方式

| 改动 | 先做 | 何时升级 |
| --- | --- | --- |
| renderer 组件的样式、布局、文案、图标、深浅色 | `pnpm ui:check --changed --theme all` | 有 `UNCOVERED` 时补场景或用 `--entry`；文案改动加 `--locale all`；间距、截断类改动加 `--focus <选择器>` 看放大图和实测尺寸 |
| 修已有界面 bug，需要改前／改后对照 | `pnpm ui:check --page <页面> --case <场景> --compare` | 修复依赖真实数据流时补定向 vitest |
| 新组件或还没有页面覆盖的组件 | 写 `tmp/` 下的临时入口：`pnpm ui:check --entry tmp/<名>.tsx` | 会反复回归的组件在 `scripts/fixtures/` 下注册页面 |
| renderer 逻辑、hook、store、数据转换 | 定向 vitest | 结果显示在界面上时再跑 `ui:check` |
| 任务列表、任务页、侧栏等需要完整主界面的样式或交互 | `pnpm restart:desktop:remote -- --mock`（[UI 模拟数据](ui-mock-data.md)） | 依赖真实账号、发送或 Agent 运行时回到隔离 Desktop |
| main、preload、IPC、数据库、登录、发送、跨设备、窗口生命周期 | 定向测试 + 隔离 Desktop（见「Agent 启动入口」） | `ui:check` 不覆盖这些行为，不能替代 |

普通界面改动的 PR 截图直接用单页验证：检查通过后运行 `pnpm ui:check:publish`，它把截图推到
作者 fork 的 `pr-assets/<当前分支>`（不进上游仓库，也不动工作区），并输出一段「UI 变化」：命令、
平台、版本、场景、通过情况、未覆盖的行为和 `--focus` 实测的改前／改后数值，原样写进 PR 正文。

PR 截图给评审看改了什么，不是自检总览的搬运：

- 正文只嵌与改动直接相关的截图，每组并排：带 `--compare` 时只放改前／改后有差异的截图
  （改前 | 改后），否则每个场景一张（Light | Dark）。全量 `overview*.png` 只在末尾给链接，
  不直接贴进正文。
- 修旧问题用 `--compare`；改动集中在一个元素时加 `--focus`，用放大图代替整页截图；场景多时用
  `pnpm ui:check:publish --case <场景>` 选出最能说明改动的那个。
- 场景里只为测试存在的按钮、说明栏标 `data-ui-page-control`，截图时自动隐藏。

登录、发送、跨设备等单页验证覆盖不到的变化，仍按原方式附完整 Cindy 截图，同样只放能说明
改动的画面，裁掉无关区域。

公开截图（PR 正文、评论、发到 fork 的图）的原则：

- 能证明改动就够；不公开能认出真实的人、电脑、账号的信息，以及他人的私密内容；
  数值和界面状态照常展示。
- 优先用 `ui:check` 或 `--mock` 的模拟数据；`--mock` 只在没登录过账号的模拟沙箱里生效。
- 必须用真实账号时，截图前把身份信息换成示例数据（比如通过开发版的 CDP 端口修改页面文字），
  换不掉的部分避开或裁掉，发出前人工确认一遍。
- 发到 fork 的图按提交 SHA 仍能公开访问，删分支撤不回。

`ui:check` 通过只说明列出的场景在真实组件上渲染正确；报告里 `not covered` 列出的行为仍须按
对应流程验收，正式 PR 前的真实运行验收要求不变。

## Linux 系统托盘

Linux 主窗口创建时注册 Electron Tray，提供显示主窗口、打开日志目录、退出 Cindy。
与 Windows 共用菜单动作和活动任务退出确认，但 Linux 使用 `setContextMenu` 发布原生
菜单，切换语言后重新发布；不依赖仅 Windows/macOS 提供的 `right-click` 事件。创建图标后
同时设置悬停提示（`BRAND_NAME`）：不设置时 StatusNotifierItem 的 Title 为空，桌面面板会
回退显示内部图标 Id（如 `Cindy_status_icon_1`）。
实现见 `main/linuxTrayLifecycle.ts` 与 `bootstrap-electron.ts`，回归见
`main/__tests__/linuxTrayLifecycle.test.ts`。

关闭主窗口仍保留 Linux 原有的「最小化／退出」选择，不迁移用户已有偏好。
Hyprland（包括 Omarchy）没有原生最小化能力，因此主窗口的「最小化」及关闭时的
「最小化」选择统一隐藏到 Linux 托盘；其他桌面与副窗口仍使用原生最小化。
策略与回归见 `main/mainWindowCloseBehavior.ts`、`main/__tests__/mainWindowCloseBehavior.test.ts`。
托盘初始化失败时提示并保留窗口。图标创建成功不代表桌面面板一定显示它；自定义 Hyprland
配置未启用托盘宿主时，可再次打开同一安装、同一配置的 Cindy，经已有 single-instance
入口恢复窗口。托盘实际显示、激活、菜单与退出须在 Linux 桌面验证；macOS 上的
单测不能替代 Omarchy/Hyprland、GNOME 或 KDE 的实机验收。

## Windows 窗口恢复实验

Windows 偶发黑屏/灰屏的后台节流对照实验见
[窗口恢复对照](../../apps/desktop/scripts/render-recovery/README.md)。它按需使用 GitHub
Windows runner，独立于默认单测；短流程通过和完整 Cindy 故障已修复必须分开判断。

## Windows 安装目录与授权

NSIS 安装器保留当前用户／所有用户两种范围。普通用户可写的目录无需提权；选择受保护的
目录时，在替换文件和卸载旧版之前探测写权限，仅遇到 Windows `ACCESS_DENIED` 才通过
现有 UAC broker 请求授权。取消授权保留目录选择；文件占用、无效路径等错误提示换目录
或处理占用，不反复申请管理员权限。静默安装同样在卸载旧版之前检查目录。

同账号提权保留原目录和安装范围。当前用户安装若通过另一个管理员账号授权，则停止该次
提权安装，提示选择当前账号可写的目录，或返回选择为所有用户安装；不得把当前用户安装
悄悄登记到管理员账号名下。此改动不调整 Cindy 运行时的权限、用户数据目录或更新器。

实现使用 `resources/installer-directory.nsh` 的目录页和预检查，
`forge.config.ts` 因此关闭上游自带目录页，由 `customPageAfterChangeDir` 插入同款原生页。
不要单独打开上游 `allowToChangeInstallationDirectory`，否则会重复插入页面。

在 Windows 显式运行原生验证（临时目录内编译，不安装 Cindy）：

```bash
node apps/desktop/scripts/check-windows-installer.mjs
pnpm --filter desktop exec vitest run scripts/installer-directory-messages.test.mjs
```

前者编译真实安装器／卸载器，并实跑 Win32 文件访问与账号 SID 探测；UAC 返回值由测试
替身提供，覆盖取消、子进程退出和账号／范围恢复。它不能代替真实 UAC 交互验收。发布前
还需在普通权限 Windows 环境走查：默认目录、自定义受保护目录、允许／取消授权、使用
另一管理员账号、旧版覆盖安装，以及静默安装失败时旧版仍在。原生对话框的 Light／Dark
外观由 Windows 提供，自动测试不代表两种模式已完成目检。

远程桌面 helper 的 CRT 链接验收另运行：

```bash
node apps/desktop/scripts/check-windows-remote-desktop-runtime.mjs
```

这是显式 Windows x64 原生集成验收：编译两个 EXE 与 `.node`，检查 PE 依赖，对照
动态／静态链接在临时目录中遇到不可用 VC++ DLL 时的结果，并以随机测试产品身份实跑
生产 NSIS 钩子的当前用户安装、覆盖安装和卸载。它不改系统 DLL、不安装服务、不操作
正式 Cindy 的安装。该故障注入不能代替干净 Windows 虚拟机、「所有用户」安装或已注册
远程桌面服务的真实验收；编译与安装器子进程不进入默认单测。


## 右侧栏展开、拖宽与恢复

主界面最右侧的内嵌工具栏从收起变为展开时，`LayoutRoot` 按面板宽度与 CSS clamp
计算保持聊天区宽度所需的增量，经本机 `window-sidebar-expansion` IPC 交给
`SidebarWindowExpansion`。窗口左边缘不动，增量止于当前显示器工作区右边缘；
空间不足的部分由窗口内部布局分配。最大化与原生全屏不改窗口尺寸，左侧停靠和
独立工具窗口不触发右扩。启动恢复已展开的侧栏只登记现有几何基准，不重复扩大；
该基准的权威说明见本节末尾「侧边栏与主窗口几何」。

展开后以内容区像素宽度为基准：聊天区与其它停靠面板保持宽度，最右侧栏使用 CSS
剩余空间吸收窗口伸缩；达到最小尺寸后仍遵守原有空间约束。实时缩放不在每个 resize
事件里重写 React 状态或偏好。主动拖中间分隔线前以实测宽度校准份额账本，提交后
重新建立聊天区宽度基准。收起时窗口整体回到展开前的位置和大小（扩展后主动拖宽、
原生移动或缩放都只算临时空间分配，不保留）；关闭、移位或重新展开时解除／重建临时基准。

用户主动调整侧栏后，把实际像素宽度写入布局树 pane 的可选 `preferredWidth`，通过
既有 LayoutStore 保存到 `layout.v1.json`；下次展开及重启后优先恢复该宽度。
旧布局缺少该字段时继续使用原份额，无需迁移；重置布局同时清除该偏好。
中间分隔线在手势提交时保存，macOS / Windows 原生窗口边缘通过 Electron 的
`will-resize` + `resized` 区分手动缩放后保存。程序展开、屏幕空间不足、最大化与全屏
造成的临时变化不覆盖用户偏好。Linux 没有上述原生手势事件，仍可通过中间分隔线保存。

展开／收起时 `sidebarPresentation` 暂时固定内容区旧宽度并保留旧侧栏状态；主进程
回传实际增量后，等待 renderer 观察到对应 viewport 宽度，再在同一帧释放旧宽并切换
侧栏。原生窗口有尺寸变化时不叠加侧栏的 250ms 宽度动画，避免聊天消息先压缩或
拉宽再恢复；无可用空间时保留窗口内动画。快速反向操作丢弃迟到回包。

侧栏开关归聊天区所有，点击展开、再次点击收起；展开后仍留在聊天区原来的角上
（macOS 顶栏右端、Windows 内容区入口）。侧栏自己的顶栏末端显示 × 关闭按钮；
关闭仅收起侧栏，不关闭页签。分离和最大化入口仍属于侧栏，沿用现有主题与多语言文案。

新增 IPC 只允许 Cindy 自有顶层应用窗口操作自身，不进入 device-link 白名单；SSH 或
远程任务仍调整当前查看端窗口，手机没有对应的原生窗口行为。

回归入口：`sidebarWindowExpansion.test.ts`、`sidebarWindowExpansionIpc.test.ts`、
`LayoutStore.test.ts`、`layout/__tests__/sidebarExpansion.test.ts`、
`sidebarPresentation.test.tsx`、`LayoutRoot.test.tsx`、`rootDividerDrag.test.tsx` 与
`RightSidebar.presentation.test.tsx`。覆盖几何边界、快速开关、首次恢复、拖宽后收起、
宽度落盘重载、临时夹取不写偏好，以及原生扩宽后继续拖分隔线。

## 意外退出后的诊断入口

主窗口重启后，`StartupRecoveryDialogs` 在开屏与数据库就绪、更新说明关闭后，
先显示已有的中断任务恢复入口，用户选择继续、暂不继续或关闭后，再询问是否诊断意外退出。
没有中断任务时直接进入诊断提示；任务列表加载期间不会抢先弹诊断，继续任务无需等执行完成。正常退出、更新重启、
显式信号退出和仍在运行的并存实例不触发；多条异常运行记录合并为一次提示。
提示由 `crash-diagnosis.ts` 消费既有启动诊断快照，处理状态留在 main 内存，
窗口重载不重复提示；历史 run marker 的清理仍归启动诊断，不改日志补传标记。
PID 复用延迟核对出的陈旧退出仍只写日志，不触发新提示。

点击「诊断问题」才读取现有白名单与脱敏管道的 main 日志，取退出锚点前后五分钟的
最多 100 条、16,000 字符完整记录，按与退出时刻的距离优先选择，并排除本轮进程启动后的
记录，避免重启噪声挤掉故障现场。无可靠时间或日志不可读时只带退出摘要并说明
材料不足。原生 dump、Agent 日志、任务正文和原始请求不进入这份草稿。
此路径不上传日志，也不改变崩溃自动上传偏好。

诊断沿用错误卡的 `buildErrorDiagnosisPrompt` / `prefillErrorDiagnosisDraft`，
保留已有未发送草稿，用户检查并发送后才交给模型分析。若需反馈，继续使用已有
issue 提交确认卡，不自动公开材料。这里的「意外退出」不等于已证明软件崩溃，
强制终止、断电等原因由诊断结合证据区分。

三个 `crash-diagnosis:*` IPC 仅供本机可信顶层应用窗口，不进入 device-link
allowlist；SSH、远程任务及手机不会误触本机重启提示。此功能不恢复或改变任务执行状态，
诊断失败不会阻止使用应用；关闭提示后仍可从任务已有入口继续中断任务。

验证入口：`crashDiagnosis.test.ts`、`StartupRecoveryDialogs.test.tsx`，以及
`pnpm ui:check --page crash-diagnosis --case all --theme all`。单页场景不覆盖原生崩溃、
真实模型执行或 issue 提交，须与定向测试及完整 Desktop 验收分开报告。

## 侧边栏与主窗口几何

主窗口的位置和大小以没有右侧边栏时的矩形为准。打开侧边栏前保存该矩形，
打开期间分隔线只调整两侧空间分配，原生窗口移动和缩放也不覆盖这份基准；
关闭侧边栏或离开对应页面后恢复打开前的矩形。最大化／全屏时不强制修改窗口边界。
窗口状态持久化同样读取这份基准，重启后若侧边栏仍打开，则从基准重新展开，
不能再次从已保存的主窗口宽度中扣除侧边栏。旧版本保存的矩形作为首次升级后的基准。
同一原生窗口再次打开侧边栏时，恢复上次展开的总宽度，并应用布局中已保存的侧栏宽度；
不能把拖动分隔线后的侧栏宽度当成新增窗口宽度，否则聊天区域会被重置。展开宽度在
窗口生命周期内独立记忆，关闭状态的调整只更新独立主窗口基准；重新打开仍受当前屏幕边界限制。
Windows 的贴边／贴满判断仍读真实窗口（程序自己的展开不算贴满），贴满照常记为最大化。
若打开期间显示器被拔掉或分辨率变小，收起时旧矩形改放回当前工作区内。
实现见 `main/sidebarWindowExpansion.ts`、`renderer/layout/sidebarPresentation.ts`；
回归见 `sidebarWindowExpansion.test.ts` 和 `sidebarPresentation.test.tsx`。
