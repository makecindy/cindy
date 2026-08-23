# Desktop 开发、启动与验证

> **读取时机**：安装、启动、重启、调试或验证 `apps/desktop` 及其共享 packages 时

本文是 Desktop 开发命令及其使用条件的权威说明；可执行脚本以当前 checkout 的根
`package.json` 与 `apps/desktop/package.json` 为代码事实源。

## Agent 启动入口

Agent 启动 Desktop 只使用仓库根的安全包装命令，并显式选择目标区域。用户只说
「启动开发版 / 启动测试版 / 看当前改动」且没有指定模式时，使用当前 worktree 的
命名隔离沙箱，不要默认共享正式登录态：

```bash
pnpm restart:desktop:remote --region=global -- --isolated=@worktree
pnpm restart:desktop:remote --region=cn -- --isolated=@worktree
```

`--isolated=@worktree` 按 checkout 目录名派生稳定沙箱名（去掉前导 `cindy-`，
再加路径短哈希，例如 `cindy-local-ollama-models` → `local-ollama-models-a1b2c3`）。
同一 worktree 下次还用这个名字，登录态会留在这份沙箱里。

只有用户明确说「共享登录 / 不要重新登录 / 用现有数据 / 不要关当前实例」时才加
`--preserve-running`。不要把「用户没提模式」理解成共享。

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

两个 restart 命令都支持下列参数。脚本本身不加这些旗标时仍是共库 + 正常调度（给人在
终端里手跑）。**Agent 例外**见上一节：用户只说启动开发版时必须加
`--isolated=@worktree`。这些参数只对 dev 生效，不影响用户机器上的正式版。

- `--region=cn|global`（默认 `global`）：切换构建身份与仓内端点清单；中国大陆版
  必须显式传 `--region=cn`，读取 `config/endpoint.json`。
- `--isolated` / `--isolated=<名字>` / `--isolated=@worktree`：使用独立 userData 沙箱，数据库、登录态、会话、定时
  任务与设备身份都与正式版彻底隔离（首次需重新登录）；命名沙箱每个名字一条独立沙箱，
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
非隔离 dev 也使用当前区域对应的正式 profile；`--isolated` 沙箱再按相同区域映射派生目录。
**dev writer 不得把正式 profile 升到当前 checkout 比安装版更新的 schema**：有 pending
migration 就拒绝启动，改用 `--isolated=<名字>`。`--preserve-running` / 共库 passive 仍只读。
跨区域共享、登录态迁移或旧版本回滚应使用显式隔离目录，避免不同构建误用同一 profile。

### 并行多开 dev

restart 的 kill 作用域是**当前 checkout（worktree）**：只停自己这份 checkout 的 dev
进程，其他 worktree／命名沙箱的实例一律保留（2026-07-30 约束：并行沙箱不得被另一个
checkout 的启动器顶掉）。因此并行多开的标准姿势是：**每个实例一个独立 worktree +
`--isolated=<名字>` 命名沙箱**，互不干扰地各自 restart。

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

本节指导**开发过程中的增量验证**；提交（commit／PR）前的强制门禁以
`development-workflow.md` 的「提交前测试门禁」为准（仓库根 `pnpm test:unit:related` 与相关
package 的 typecheck 全部通过；CI 仍跑完整 `pnpm test:unit`）。开发过程中根据实际改动选择最小但充分的检查：

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
