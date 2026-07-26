# Linux Headless Agent Host

> **状态**：实现交付约定（协议与数据模型仍以对应权威规则为准）
> **目标版本**：Linux Host（CLI + Mobile + Desktop Remote）
> **相关事实源**：[远程与移动端适配](./dev-rules/remote-and-mobile-adaptation.md)、
> [`@cindy/device-link`](../packages/device-link/README.md)、
> [`@cindy/maker-core`](../packages/maker-core/src/index.ts)、
> [`@cindy/model-providers`](../packages/model-providers/src/index.ts)

本文定义 Cindy 在无图形界面的 Linux 主机上的目标产品形态。它不是把 Electron
窗口隐藏起来，而是一个长期运行的 Agent 主机：用户从 SSH 终端、Cindy 手机 App 或 macOS Cindy Desktop
继续同一份工作，主机保存会话、文件上下文与执行状态。

本文不改变现有 Desktop、Mobile 或 Device Link 协议；协议、数据库和实现改动发生时，
仍以对应权威开发规则为准。

## 1. 产品定义与边界

### 1.1 首版承诺

首版服务于**一台 Linux 主机、一个 Unix 服务账户和一个 Cindy 账号**。主机以
`cindy-headless` 守护进程常驻运行，并提供：

- Cindy 账号托管的模型，以及 Claude Code、Codex 两种执行 runtime 的会话执行；
- 本机 workdir、文件、终端、Git、MCP、附件、记忆、定时任务与 Orca 协作；
- 可断开、可重新附着的多会话执行；
- `cindy chat` 的完整终端对话体验和 `cindyctl` 的运维入口；
- 通过既有 Device Link relay 让 Cindy 手机 App 与 macOS Cindy Desktop 查看、继续和控制主机上的会话。

Linux daemon 是这些会话的唯一权威主机：会话、消息、队列、附件和运行状态仅持久化在
Linux 的私有 state root。Mac 与手机是远程视图和控制端，使用与“手机连接 Mac Host”相同的
Device Link invoke、push、topic 与单写入控制权语义；这不是两套本地数据库的离线同步方案。

主机只主动连接 Cindy 服务与 Device Link relay，不开放公网 HTTP 管理端口。systemd
负责启动、重启和日志归集。

定时任务使用共享 `@cindy/maker-scheduler` cron 引擎和 daemon SQLite 存储；它们在
daemon 重启后会重新载入，运行中的陈旧任务按心跳收敛为 `interrupted`，不会重复启动。
任务生成的 Agent turn 与 CLI／手机对话共用运行时资源池，默认最多同时执行两个 schedule
run、四个总 Agent turn。可从终端创建并立即运行、暂停或查看历史：

```bash
cindy schedule create --name "Hourly review" --prompt "Review current CI status" \
  --cron "0 * * * *" --timezone Asia/Shanghai --agent codex --model gpt-5.6 \
  --workdir /srv/work/api
cindy schedule run-now --schedule <schedule-id>
cindy schedule runs --schedule <schedule-id>
```

Orca 协同以同一份 session SQLite 记录 team 与 worker；worker 是正常的 daemon
session，因而同样受单 session 串行与整机 4 turn 预算约束。Lead 可通过
`cindy_orca` MCP 在对话中创建和派发 worker，也可从终端恢复控制：

```bash
cindy orca start --lead-session <lead-session-id>
cindy orca add-worker --lead-session <lead-session-id> --label api --role developer \
  --agent codex --model gpt-5.6 --initial-task "Implement the API layer"
cindy orca list --lead-session <lead-session-id>
cindy orca send --lead-session <lead-session-id> --worker api --message "Review the error paths"
```

Maker Memory 始终保存在 daemon 的私有 state root；Claude Code 直接使用进程内
`cindy_memory` MCP，Codex 经同一 daemon 的随机令牌保护回环 MCP bridge 使用。该
bridge 不开放到 LAN 或公网，Codex thread 未能精确匹配到本地 session 时不会取得
任何 session context。

### 1.2 非目标

首版不提供 Web 控制台、不支持多账号/团队共享主机，也不复刻 Linux 桌面窗口、托盘、
全局快捷键、屏幕操作或本地 GUI 插件面板。浏览器自动化仅在将来以 headless Chrome/CDP
形式单独设计；它不等同于操作用户正在使用的图形浏览器。

手机不能直接调用 shell、读取密钥、编辑 provider、改写高风险全局设置或绕过 Device
Link allowlist。Agent 在获得会话权限批准后执行命令，和手机直接远程调用 shell 是两条
不同的安全边界。

## 2. 用户交互

### 2.1 终端是完整对话界面

`cindy chat` 连接本机 daemon，而不是每次 SSH 登录都临时启动 Agent。SSH 或终端断开后，
运行中的 turn、定时任务和会话仍继续；再次运行命令可恢复同一会话。

```text
$ cindy chat

Create a session
  Workdir     /srv/work/api
  Agent       › Codex
  Provider    › Cindy AI Gateway
  Model       › (当前 Cindy 账号可用模型)
  Effort      › High
  Permission  › Ask before changes

[Enter] Start   [↑↓] Select   [Tab] Change field   [Esc] Cancel
```

交互终端提供轻量选择器；非交互环境使用完全等价的 flags：

```bash
cindy chat new --workdir /srv/work/api --agent codex \
  --provider company-gateway --model company-code-2 --effort high --permission ask

# SSH 重新连接后回到同一 daemon 会话；不会重新启动 agent
cindy chat attach --session <session-id>
```

会话顶部持续展示 `workdir · Agent · model · effort · permission · 当前主机并发`。
对话内提供 `:sessions`、`:agent`、`:provider`、`:model`、`:effort`、
`:permission`、`:steer`、`:stop`、`:approve` 等命令。终端能流式显示回答、计划、
工具调用摘要、文件变更、错误和权限请求；复杂图表、富插件卡片或可视化浏览器内容应
提供文件、链接或后续 Web 打开入口，而非伪装成完整 TUI。

终端可把本机的普通文件或图片随消息带入会话；daemon 会先复制到会话私有的受控
附件目录（目录 `0700`、文件 `0600`），再把副本交给 Agent。因此 SSH 断连、源文件
被编辑或挂载被移除都不会改变已接受 turn 的输入。单文件上限为 50 MiB：

```bash
cindy chat send --session <session-id> --message "review these" \
  --file /srv/work/api/spec.pdf --image /srv/work/api/screenshot.png
```

### 2.2 Agent、模型与配置选择

模型选择器先选 Agent（Claude Code / Codex），再只显示该 Agent 当前可用 provider 下的
模型。它必须读取 `model-providers` catalog 与运行时 `Capabilities`，而不硬编码模型、
effort、fast mode 或 permission mode。不可选项必须说明原因，例如未认证、provider
不可用、当前模型不支持 fast mode 或该 Agent 不支持对应权限档位。

模型 ID 使用明确版本，不使用会漂移的裸别名（如 `opus`、`sonnet`）。模型、provider、
effort、fast mode 和权限选择有四层作用域：

```text
会话 override > 项目/workdir override > 用户默认 > 产品默认
```

“恢复默认”删除相应 override，而不是写入默认值快照。切换运行中会话的 Agent、provider
或模型时，界面必须让用户选择：本 turn 结束后应用、停止当前 turn 后切换，或 fork 新会话；
不得静默改变正在运行请求的凭据或模型。

配置控制面和交互选择器都调用同一套 daemon RPC。用户默认只保存显式 override；
项目默认以规范化的绝对 workdir 为 key；恢复默认删除字段，而不是写入静态默认快照：

```bash
cindy config defaults
cindy config set-default --agent codex --model gpt-5.6 --effort high
cindy config reset-defaults

cindy config set-project-default --workdir /srv/work/api --model gpt-5.6
cindy config project-defaults --workdir /srv/work/api
cindy config reset-project-defaults --workdir /srv/work/api

# 只允许空闲会话重建其 agent runtime；配置从下一 turn 起生效
cindy chat configure --session <id> --model gpt-5.6 --effort high
```

### 2.3 Cindy 登录、模型与可选自定义 provider

Linux 的第一步是登录**Cindy 自己的账号**，不是登录 Codex 或 Claude。`cindy login` 使用
Cindy auth-server 的邮箱或手机验证码；登录后 daemon 使用 Cindy 的 model-access 服务取得
该账号可用的网关模型和短期凭据。Codex/Claude 只是执行 runtime，用户不需要也不应被要求
在服务器上分别执行 `codex login` 或 `claude login`。

```bash
# 企业 SSO：终端打印一次性二维码；用手机扫码，在浏览器完成企业登录即可
cindy login --sso XD
cindy whoami

# Cindy AI Gateway 出现在两种 runtime 的模型选择器中；模型清单随账号实时读取
cindy chat

# 登录成功后 Device Link 自动使用同一 Cindy access token；仍须显式允许远程控制
cindy workdir allow --path /srv/work
cindy device-link enable
```

登录优先把 refresh token 写入 Linux Secret Service；access token 和网关 API key 仅驻留 daemon
内存。无桌面服务器没有可用或已解锁的 Secret Service 时，daemon 自动使用私有 state root 中的
AES-256-GCM 加密 credential vault：vault 文件为 `0600`，随机主密钥为单独的 `0400` 文件，二者都
不进入配置、shell 参数或日志。该 fallback 防止配置/普通备份中的明文泄露，但不把已取得同一 Unix
账号或 root 权限的攻击者误称为受防护边界。凭据持久化成功后，daemon 会保存非敏感账号路由元数据，并在
重启后恢复 Cindy 账号、模型目录和 Device Link。

除 Cindy AI 外，首版仍支持用户明确配置的 API key、OpenAI-compatible 和
Anthropic-compatible provider。它们是高级的本机 override，不会替代 Cindy 账号登录；
`cindy provider add` 收集名称、可用 Agent、endpoint、模型目录与鉴权方式，终端输入 API key
不回显、不进入 shell history。

自定义 OAuth provider 可采用设备码：CLI 显示 URL 与一次性代码，用户在手机或任意浏览器
完成确认。不支持设备码的 provider 不承诺 authorization-code 回调；用户改用 API key 或
显式 token 导入。配置中只保存非敏感元数据和 `secretRef`；Cindy 账号和可选自定义 provider
的秘密优先使用 Linux Secret Service；没有它时 Cindy 账号仅可使用内存登录，其他需要长期保存的
provider 凭据不会降级为明文文件。

自定义 API-key provider 先注册非敏感路由元数据，再单独从 stdin 导入凭据；key 不会
进入 shell 参数、配置文件或事件流：

```bash
cindy provider add --id company-gateway --name "Company Gateway" \
  --agent codex --base-url https://models.example/v1 --model company-code-2
printf '%s' "$COMPANY_GATEWAY_API_KEY" | cindy provider import-secret --provider company-gateway

# 标准 RFC 8628 设备码 provider（URL、客户端 ID 与 scope 是非敏感元数据）
cindy provider add --id company-device-code --name "Company Device Code" \
  --agent codex --base-url https://models.example/v1 --model company-code-2 \
  --device-authorization-url https://auth.example/device \
  --token-url https://auth.example/token --client-id cindy-headless --scopes model.read
cindy provider device-code --provider company-device-code
```

### 2.4 手机与 macOS Desktop 是正式控制端

手机和 macOS Desktop 经现有 Device Link 访问 Linux 主机的会话历史、状态、消息、附件、
文件浏览、任务、Orca 协作和每会话运行时设置。它们复用既有 invoke allowlist、push
allowlist 和 topic 语义：`sessions` 订阅提供轻量列表活动，打开某会话才订阅
`session:<id>` 的完整实时流。

手机上传的附件先以账号隔离的 Device Link 媒体引用到达 Linux；daemon 使用一次性预签名
下载链接校验大小与 SHA-256 后，写入会话私有目录（目录 `0700`、文件 `0600`）再交给 Agent。
附件字节不经过 relay 帧，也不写入 Mac 或手机的会话数据库。

Linux 主机是会话与消息的真相源；手机不是云端全量副本。主机离线时手机不能继续调用
Agent，重连后重新拉取历史和订阅即可恢复。

订阅只授予查看权限；每个 session 同时恰有一个写控制者。CLI、手机与另一台 Desktop 必须先
Linux Headless 沿用既有 Device Link 写入语义：已关联的手机、Mac 和终端都可直接写入同一会话，
由主机按到达顺序处理；不会要求显式 `claim` 或 `takeover`。
再次检查租约，拒绝旧控制者的消息、队列编辑、停止、模型设置、标题/归档、审批与 Orca 操作。
控制端断链、退出会话或被主机断开时自动释放租约。这样不会出现多端混合输入；控制者内部仍是
单 active turn + 持久队列，普通输入按顺序处理，明确 steer 使用 Agent 既有语义。

远程写操作仍受 Device Link 的主机总开关、逐设备撤销、共享 allowlist、会话/文件路径守卫
及主机运行时状态约束。手机可在 session 空闲时切换 Agent、provider、model、effort、
permission 与 fast mode；运行中的 turn 仍由主机拒绝并要求用户等待或停止，避免中途换凭据
或上游。

文件浏览复用 Desktop 的 `file-browser:remote-op` 聚合通道和共享扫描核心。Linux 只会
服务已由 `cindy workdir allow` 显式授权的 root 及其子目录；相对路径穿越和越界 symlink
由共享路径守卫拒绝。读、预览、创建、写入、重命名、删除和文件索引都沿用现有通道的
响应形状，故手机无需 Linux 专用协议；未授权 root 直接拒绝，不会根据会话记录隐式扩大
手机可读的文件范围。

## 3. 会话与执行模型

不同 session 可并行运行；同一 session 同一时间只允许一个写控制者与一个 active turn，后续输入
进入该控制者提交的持久队列或使用 Agent 支持的 steer。首版默认整机最多同时运行 4 个 Agent turn 和 2 个
scheduler run；两项均为高级主机设置。scheduler 和 Orca worker 也进入这份统一资源
预算，不能挤占交互式会话到不可用。

每个 session 绑定自己的 Agent、provider、model、workdir 和运行时设置。多会话可混用
Claude Code 与 Codex；会话切换模型不得影响其他会话。daemon 重启后根据持久化的 session
元数据恢复可继续的会话；短暂 CLI/Mobile 断连只移除订阅和控制租约，不自动关闭 session。

## 4. 技术架构

```text
cindy chat / cindyctl / Cindy Mobile
        │ local control RPC / Device Link relay
        ▼
  cindy-headless daemon (systemd)
        ├─ HeadlessHost adapters → maker-core
        ├─ session storage / SQLite / worktree / scheduler
        ├─ provider catalog, auth and secure credential store
        ├─ agent binaries, MCP, terminal, file and attachment services
        └─ Device Link host bridge and event topic fan-out
```

`HeadlessHost` 是宿主适配层，不依赖 Electron。它向 `maker-core` 注入 session storage、
认证、runtime config、MCP、日志和用户数据根目录；共享包不得自行猜测路径或创建数据。
现有 Desktop 的 `ipcMain` / `BrowserWindow` 依赖由本地 control RPC 和事件总线替换。

本地 control RPC 至少分为四组：

- **Session**：新建、恢复、收发、流、队列、审批、中断、fork 与状态订阅；
- **Catalog**：Agent、provider、模型和 capabilities 的只读查询；
- **Configuration**：用户/项目/会话 override 的读写、删除与有效来源；
- **Input coordination**：所有本地 CLI 与 Device Link 输入收敛到同一会话队列及
  Agent steer / approval 状态机。

Device Link host bridge 适配同一组业务处理器，保持现有白名单、payload、错误模型和
`allowlistHash` 兼容；不得另造手机专用 RPC。任何新增跨端 channel、push 或 relay payload
都必须同步评估 `cindy-protocol` 和服务端兼容性。

用户数据位于服务账户专属的明确 data root，绝不回退到 `cwd`、仓库目录或临时目录。临时
附件使用任务专属临时路径并在完成、失败或取消后清理。workdir 必须经主机已知目录和路径
守卫校验，不能让手机或 CLI 通过构造参数突破授权范围。

## 5. 验收与后续阶段

首版验收至少覆盖：

- CLI 选择器与 flags 等价；模型按 Agent/provider/capability 过滤；override 优先级和
  恢复默认正确；运行中模型切换的三种路径都有明确反馈；
- 多 session 并行、单 session 单 active turn、队列/steer、CLI 断连后继续执行、重新附着；
- CLI、手机、Desktop 可直接写入同一会话；并发写入按主机到达顺序处理；
- managed/OAuth/API-key provider、设备码模拟、凭据脱敏、未认证与不兼容能力的错误提示；
- Device Link 历史读取、实时事件、断线重连和 topic 重建，与既有 allowlist/hash 兼容；
- 无公网监听、本地 socket 权限、默认 `ask` 权限、systemd 重启恢复与日志不泄漏 secret。

### 跨端兼容

Linux、macOS 与手机复用既有 Device Link 会话与写入通道，
控制面和现有消息、队列、审批与事件通道。它不改变 relay envelope 格式，但增加了明确的
会话控制状态推送；旧客户端只能观察，不能绕过主机的写入校验。

后续阶段可单独设计 Web 控制台、复杂插件渲染、headless 浏览器能力、团队共享与多账号
隔离。它们不能以“补一个页面”方式绕过本文件的 daemon、凭据或跨端协议边界。

## 6. Linux 安装与运维

Linux release 按 CPU 架构构建，内含 Node runtime、SQLite 原生模块与所有运行时依赖；
目标服务器不需要预装 Node、npm、编译器，也不会在安装时联网执行 `npm install`。构建机
为每个支持架构发布独立资产（当前命名为 `cindy-headless-linux-x64.tar.gz` 或
`cindy-headless-linux-arm64.tar.gz`）及同名 `.sha256` 校验文件。

推荐从 GitHub Releases 一键安装。公开仓库可直接执行：

```bash
curl -fsSL https://raw.githubusercontent.com/makecindy/cindy/main/apps/headless/scripts/install-from-github.sh | sh
```

当前仓库若保持私有，先创建**只读、仅此仓库**的 GitHub fine-grained token，再执行：

```bash
export CINDY_GITHUB_TOKEN='github_pat_...'
curl -fsSL -H "Authorization: Bearer $CINDY_GITHUB_TOKEN" \
  https://raw.githubusercontent.com/makecindy/cindy/main/apps/headless/scripts/install-from-github.sh | sh
```

脚本会根据 `uname -m` 选择资产，下载 `.sha256` 后验证，再解包并调用正式安装器。若需要
固定版本而不是最新 release，可设置 `CINDY_HEADLESS_RELEASE=<tag>`。

离线或手动安装仍支持：

```bash
cd apps/headless
npm run package:linux
tar -xzf dist/cindy-headless-linux-x64.tar.gz
cd cindy-headless-0.1.0
./install-user-service.sh
```

安装脚本会把 release 放到 `~/.local/lib/cindy-headless`，校验运行时和本机架构，并启用
`systemctl --user` 的 `cindy-headless.service`。守护进程只监听服务账户的 XDG Unix socket，
不暴露 HTTP 管理端口；查看运行状态使用：

```bash
systemctl --user status cindy-headless
cindyctl status
```

服务默认没有远程控制权限。先登录 Cindy 账号；同一账号的 access token 会自动用于 Device
Link。限制手机可选的项目根目录，然后显式打开控制：

```bash
cindy login --sso XD
cindy workdir allow --path /srv/work
cindy device-link enable
cindy device-link status
```

建议安装 `libsecret-tools` 并提供已解锁的 Secret Service。`secret-tool` 不存在或不可用时，
Cindy 使用私有 state root 内的 AES-256-GCM 加密 credential vault；仍不得创建明文凭据文件。

配置文件只保存非敏感的 device ID、区域、模型元数据和用户授权的 workdir roots。关闭服务并保留
会话数据可用 `systemctl --user disable --now cindy-headless`；执行
release 中的 `uninstall-user-service.sh` 只删除 unit，不删除会话数据库和凭据。
