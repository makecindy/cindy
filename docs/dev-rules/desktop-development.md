# Desktop 开发、启动与验证

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

Agent 启动 Desktop 只使用仓库根的安全包装命令，并显式选择目标区域。restart
命令默认使用固定的 `dev` 命名隔离沙箱（等价于自动附加 `--isolated=dev`），
不再默认共享 Cindy 账号登录态与业务数据。OpenAI 模型登录态是刻意保留的例外：
普通 Dev 可只读复用同区域 Release／本机 Codex 已有登录态，能够调用模型，但不能在
Dev 内发起 OpenAI 登录或断开共享登录态。Claude Code 的配置目录同样不隔离：Dev 与正式版
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
  换一个沙箱名字，或由用户自己停掉那个实例后重试。检测靠 helper 进程命令行上的
  `--user-data-dir`，对方实例刚启动还没起 helper 时可能漏检，属尽力而为。
- **CDP 端口**：dev 的 remote-debugging-port 固定 9222，只有先起的实例能绑上。后起
  实例需要 CDP 调试面时，用 `XDT_CDP_PORT=<端口>` 覆写（仅数字生效，dev-only）。
- 同一 checkout 内仍是单实例语义：restart 会替换本 checkout 上一个实例（不论沙箱
  名字），一个 worktree 同时只跑一份 dev。
- 共享 userData 的并行（`--preserve-running` 被动预览）语义不变：不停任何实例、强制
  passive、禁止与 `--isolated` 组合，仅供能证明实例归属的上层编排使用。

Agent 自身仍只走 restart 命令，不直接调 human-only 的 `dev:desktop*`。共享同一 userData
多开时，非 primary 实例用 `--passive` 让出定时任务调度（见上）。

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
