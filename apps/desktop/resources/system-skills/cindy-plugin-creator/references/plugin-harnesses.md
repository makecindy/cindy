## 4.6.4 提供任务执行引擎(harnesses)

插件可以把一个支持 [Agent Client Protocol](https://agentclientprotocol.com)(ACP)的外部 Agent
(如本机安装的某个 CLI)提供给 Cindy,作为任务的「执行引擎」。Cindy 用统一的 ACP 引擎驱动它:
发送、停止、工具确认、模型切换都走 ACP,不为某个具体 CLI 写特例。

Cindy **只启动你包里声明过的 JS 入口**,不执行你提供的命令;入口自己找到并启动外部 Agent,
把字节原样转发。

### 声明

`harnesses` 只在 `schemaVersion: 3` 有效,必须同时声明 `node`,且每项的 `entry` 必须**逐字命中**
`node.entries` 里的一项(不能是 `node.entry` 主入口——主入口走插件宿主协议):

```json
{
  "schemaVersion": 3,
  "minCindyVersion": "1.2.3",
  "node": { "entry": "worker.js", "protocol": "json-rpc-stdio", "entries": ["dsh-acp.js"] },
  "harnesses": [{
    "id": "dsh",
    "name": "DeepSeek Harness",
    "description": "Runs the dsh CLI on this computer",
    "protocol": "acp",
    "entry": "dsh-acp.js",
    "locales": { "zh-CN": { "name": "DeepSeek Harness", "description": "运行本机的 dsh 命令行" } }
  }]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 小写字母开头,小写字母、数字、`-`,最长 32,插件内唯一 |
| `name` | 必填,1–64 字 |
| `description` | 可选,最长 200 |
| `protocol` | 目前只有 `acp` 生效;其它值保留但不生效,也不出现在安装确认里 |
| `entry` | `node.entries` 里的一项 |
| `locales` | 可选,按语言给 `name` / `description`;找不到时用同语言其它地区,再回到默认文案 |

最多 4 项。旧版 Cindy 把整个字段当未知字段保留,不拒装也不生效。

### 安装确认

安装确认单列一项「提供执行引擎:<名称>」,说明引擎可以在用户的任务里读写工作目录、执行命令,并使用与
内置 Pi 相同范围的 Cindy 工具。更新时新增引擎、改名或换 `id` 都算权限变多,需要用户再次确认。
在 Cindy 认识此字段之前就已安装的版本不会自动生效,下一次更新时作为新增权限确认。

### 发布可用状态

外部 Agent 可能没装、版本不够。插件页面(设置页、面板等)检测后用 `PUT /harnesses` 发布每个引擎的
状态,整体覆盖上一次;内容没变时没有副作用,可以每次启动或打开设置页时发布:

```js
await fetch('/harnesses', {
  method: 'PUT',
  body: JSON.stringify({
    harnesses: [{
      id: 'dsh',
      available: false,
      reason: 'not-installed',
      message: 'Install with npm i -g @deepseek-ai/dsh (Node 24.9+)',
    }],
  }),
});
```

| 字段 | 说明 |
| --- | --- |
| `id` | 必须是清单里声明过的引擎 |
| `available` | 必填,`true` / `false` |
| `reason` | 可选,小写字母、数字、`-` 的短标识,如 `not-installed` |
| `message` | 可选,最长 200 的纯文本,不可用时作为提示原样显示 |
| `version` | 可选,最长 64,检测到的外部 Agent 版本 |
| `modes` | 可选,Agent 自己的工作模式,用 Cindy 权限档 id:`default` / `acceptEdits` / `auto` / `plan`,按 Agent 的顺序;`defaultMode` 是 Agent 启动时所在的模式。对 ACP 引擎,取它 `mode` 配置项里能对上这些 id 的取值(`accept-edits` 对应 `acceptEdits`) |
| `models` | 可选,这个引擎的模型列表,最多 200 个:`[{ id, name, description?, group?, efforts?, defaultEffort? }]`。`id` 最长 256、必须是引擎自己在任务里切换模型时接受的取值(ACP 的 `model` 配置项取值);`name` / `description` / `group` 最长 200 的纯文本;`id` 不能重复。`efforts` 是这个模型可选的思考深度,用 Cindy 的档位 id(`minimal` / `low` / `medium` / `high` / `xhigh` / `max`),`defaultEffort` 是引擎不指定时用的那一档 |

只接受这些元数据,其它字段丢弃,不能借它传命令。`GET /harnesses` 读回当前状态。格式错误或写了
未声明的 `id` 返回 400,`error` 说明原因,原状态不变;清单没声明 `harnesses` 时返回 403。
从没发布过的引擎按「未知」处理:允许尝试启动,失败时显示入口进程的报错。

Cindy 存下最新状态,显示引擎列表时只读这份记录,**不调用插件**。卸载时一起删除;停用时保留但不显示。
旧版 Cindy 没有这个端点(404),插件应按「不支持」处理。

**模型列表**:和普通供应商一样,模型由来源自己提供。发布了 `models` 时,模型选择器按它列出这个引擎的
模型;没发布时,列出引擎上一次跑任务时自己报告的模型(之前只有「默认模型」)。怎么拿到模型由插件决定,
例如向外部 Agent 读取它的模型配置。**刷新**也和普通供应商同一时机:用户打开模型选择器时,Cindy 给提供
引擎的插件的逻辑页发一条 `{ type: 'harnesses-refresh-requested' }`(经 `cindy.onHostMessage`),同一个
插件 10 分钟内最多一次;插件收到后重新检测并 `PUT /harnesses` 即可,不需要回复。

**思考深度**:模型带上 `efforts` 后,模型选择器在这一行末尾显示档位,配置浮层里用和内置模型一样的滑杆
选择;新建任务和任务里切换都会把选中的档位交给引擎。对 ACP 引擎,档位就是它 `thought_level` 配置项里
与 Cindy 档位 id 相同的取值(例如 `low` / `high` / `max`),Cindy 用这个值去切换,其它取值(例如 `off`)
没有对应档位、不要上报。ACP 只公布当前模型的 `thought_level`,要列出每个模型的档位,可以在插件自己的
探测会话里逐个切换模型读取(不发提示,不会调用模型)。不认识的档位 id 会被跳过;不发 `efforts` 的模型
没有可选档位。

**工作模式**:发布了 `modes` 时,输入框的权限菜单列出这些模式,末尾固定是 Cindy 的「全部允许」;没发布时是
「逐项确认 / 全部允许」。用户切换模式时 Cindy 让 Agent 切到对应模式(ACP 的 `mode` 配置项),Agent 请求权限时
仍由用户逐个确认,选「全部允许」才自动同意。

**插话**:ACP v1 每个会话同一时间只跑一个 prompt,没有「往正在跑的这一轮里补一句」的方法。Agent 支持生态里通行的
`_session/steering` 扩展(claude-agent-acp、codex-acp 等已实现)时,在 `initialize` 结果的**顶层** `_meta` 里声明
`{ "steering": { "supported": true } }`,用户就能在任务运行中插话:Cindy 发请求
`_session/steering`,参数 `{ sessionId, prompt: ContentBlock[], _meta: { steering: { idleBehavior: "promptRequired" } } }`,
Agent 把内容注入当前这一轮后回 `{ "outcome": "injected" }`,插话之后的回复继续走这一轮的 `session/update`,这一轮的
`session/prompt` 等插话的工作做完再返回。Agent 这一轮已经结束时回 `{ "outcome": "promptRequired", "reason": "noRunningTurn" }`
且不要自己开新一轮,Cindy 会把这条消息作为下一轮发送。没有声明的 Agent 照旧:运行中输入的消息排队,等这一轮结束再发。

入口原样转发字节时什么都不用做,外部 Agent 自己声明、自己处理。入口会改写 `initialize` 回包时要保留 `_meta.steering`;
外部 Agent 本身不支持时,不要替它声明,否则 Cindy 会把插话发给它而收不到 `injected`。

**聊天里的每轮权限闸**:用户把任务接到飞书、微信等聊天后,群聊、访客和个人微信发来的消息带一条「这一轮哪些操作必须先让
用户确认」的规则,内置引擎在执行每个工具前检查它。插件引擎要让 Cindy 看到这一轮的每一次工具调用,才能执行这条规则。
Agent(或入口)能做到时,在 `initialize` 结果的**顶层** `_meta` 里声明 `{ "permissionGate": { "supported": true } }`。
声明支持后，每条 `session/prompt` 的 `_meta.permissionGate` 都带 `turnId`。受限轮次另外带
`scope: "all-tool-calls"`，Agent 在这轮及其后台工作中执行任何工具前都发 `session/request_permission`。
所有审批请求都要在顶层 `_meta.permissionGate.turnId` 原样回传发起这项工作的轮次 ID。新一轮开始后，
旧轮次的审批请求会拒绝。Agent 自己原本无需询问的调用可同时带 `routine: true`。Cindy 能识别操作和输入且
渠道规则允许时会直接同意读取和搜索，其余请求走审批。只允许文字回复的轮次拒绝全部工具请求。

`toolCall.kind` 照 ACP 填写(`read`、`edit`、`delete`、`execute` 等),执行命令时把命令放在 `rawInput.command`:聊天的安全
规则按它们判断,例如群聊里不能删除文件。没有声明的 Agent 收不到这类轮次,聊天里提示当前引擎不支持,主人私聊的普通消息
照常运行;任务处在「全部允许」时这类轮次同样不运行,与内置引擎一致。声明了就必须做到,做不到时不要声明。

### 入口进程

用户在任务里选了你的引擎后,Cindy 以插件 Node 运行时的「原样 stdio」模式启动 `entry`(与
[§4.12.4 childSpawn](plugin-node-worker.md#4124-宿主代启子进程childspawn) 同一通道,但由 Cindy 发起,
不需要声明 `childSpawn`)。一个任务一个进程:

- 工作目录是系统临时目录,环境与插件 Node 进程相同(不含宿主的密钥类环境变量);
- `process.stdin` / `process.stdout` 只承载 ACP JSON-RPC,每条消息一行;日志写 `process.stderr`,
  Cindy 截断后写入插件日志;
- 入口退出就是 Agent 退出;外部 Agent 退出时入口也要退出;
- 插件停用、更新、卸载前,Cindy 先结束这些进程。

一个最小的转发入口(参数是常量,不拼接用户输入):

```js
// dsh-acp.js
const { spawn } = require('node:child_process');
const agent = spawn(findDsh(), ['--profile', 'acp'], { stdio: ['pipe', 'pipe', 'inherit'] });
process.stdin.pipe(agent.stdin);
agent.stdout.pipe(process.stdout);
agent.on('exit', (code) => process.exit(code ?? 1));
agent.on('error', (error) => { console.error(String(error)); process.exit(1); });
```

`findDsh()` 由你实现。在 `PATH` 中查找可执行程序，找不到就向 stderr 写明原因并退出。Windows 上若只有
npm 的 `.cmd` 启动器，从可信的安装目录定位该包声明的 JavaScript 入口，再用独立安装的 `node.exe` 和参数
数组启动入口。上例中的参数为固定值。

引擎在安装插件的电脑上运行。手机可以选择被控电脑提供的引擎来新建普通任务。每次新建本机任务的自动化也可以选择插件引擎。

### 让用户的其他电脑与分享好友免装使用

用户可以在自己账号的另一台电脑上新建任务，也可以把引擎分享给好友——对方无需安装插件或 CLI，就能让
Agent 在装了插件的这台电脑上运行：用这台的程序、登录和额度，项目文件与命令仍在任务所在的那台电脑。这类任务里，
Agent 自带的读写文件、执行命令的工具只能碰到 Agent 所在的电脑，而项目不在这里，所以必须关掉，改用 Cindy 经 MCP 提供的工具。

支持同账号远程调用的引擎，在 `PUT /harnesses` 对应条目设置 `remoteWorkspace: true`(只在 `available: true` 时有效)。
不设置时，这个引擎只能运行本机任务。用户还要在插件设置里为该引擎打开「允许被远程调用」，默认关闭；
开关由 Cindy 提供，插件不能替用户打开。

若引擎同时支持跨账号分享给好友，还需在 `PUT /harnesses` 对应条目设置 `guestWorkspace: true`(与 `remoteWorkspace: true` 一起发布)。
声明 `guestWorkspace: true` 后，插件详情页会显示「远程与分享」入口，允许用户生成一次性分享链接并管理授权成员。

- 同账号远程任务启动时，入口进程的 `process.argv` 会收到固定参数 `--cindy-remote-workspace`；
- 跨账号分享受邀者任务启动时，入口进程的 `process.argv` 会收到 `--cindy-remote-workspace` 和 `--cindy-guest-workspace`。

看到 `--cindy-remote-workspace` 时入口必须做到：

- **只对这一次启动关掉 Agent 自带的文件与命令工具**，包括读写与搜索文件、执行命令、后台任务、切换目录，
  以及在本机运行模型写的代码的工具。用这次启动的命令行参数、环境变量或一份独立的配置实现，
  **不要改写用户的全局配置**：用户自己在终端里用这个 Agent 时，它的工具必须照旧可用。
- **做不到就不要启动**。Agent 的版本不支持关闭工具、关不干净或无法确认时，向 stderr 写明原因并以非零
  状态退出，不要带着自带工具继续运行，否则它会在错误的电脑上读写文件。新版本 Agent 可能新增工具，
  建议启动前读回它的实际配置，只放行确认无害的工具。Agent 没有办法读回配置时，入口改为在任务进行中检查它
  报告的工具调用，出现自带的文件或命令工具就结束任务。
- **让 Agent 在一个空目录里启动**，不要用用户的主目录或项目目录作为它的工作目录。

当同时看到 `--cindy-guest-workspace` 时，入口还必须做到：

- **隔离分享者本机的个人配置、技能、自定义命令、记忆与会话列表**，避免受邀者的会话读取分享者的个人提示词、
  本地插件/MCP 配置或列举历史会话（但保留 CLI 登录凭据使其可正常访问模型服务）；
- **关掉 Agent 在分享者本机直接发起网页抓取的工具**（如 `WebFetch` / `tool-web`），防止受邀者借分享者网络访问内网地址；
  Cindy 会在受邀者自己的电脑上通过 `cindy_exec` 提供 `WebFetch`。

Cindy 在 `session/new` 的 `mcpServers` 里交给 Agent 的全部是任务所在电脑的工具(HTTP 传输，
带 `Authorization` 头)。其中 `cindy_exec` 提供 `Bash`、`BashOutput`、`KillShell`、`Read`、`Write`、`Edit`、
`NotebookEdit`(受邀者任务还包含在受邀者本机执行的 `WebFetch`)，在任务所在电脑上执行。Agent 握手时没有声明 `mcpCapabilities.http` 的，这类任务会被拒绝；
Agent 实际能连 HTTP 的 MCP 服务却没有声明时，由入口在转发 `initialize` 的回包时补上。
`session/new` 的 `cwd` 是一个只含项目说明文件的目录，路径仅用于对话，不代表项目在这台电脑上。
Agent 收不到 Cindy 的系统提示，Cindy 会在新会话的第一条消息前附一段说明，告诉它项目在哪、该用哪些工具。

Cindy 按工具调用里的名称和参数显示卡片，并在用户同意后核对随后执行的操作。Agent 把这些工具报告成别的样子时
(例如套一层通用的 MCP 调用器，真正的参数嵌在里面)，入口在转发 `session/request_permission` 与
`tool_call` / `tool_call_update` 时把 `title` 和 `rawInput` 还原成被调用的工具和它的参数：`cindy_exec` 的工具
用原名(`Bash`、`Read`、`Write` 等)，`command`、`file_path` 等保持在 `rawInput` 顶层。不还原时，用户确认过的
命令与实际执行的对不上，需要确认的高风险操作会一直被任务所在电脑拒绝。

插件引擎目前不加入多机供应商组或备用机委托。

### 显示账号用量

当引擎可用，并且主 Node worker 使用 `json-rpc-stdio` 时，可以在 `PUT /harnesses` 对应条目设置
`reportsUsage: true`。用户查看任务时，Cindy 向该插件主 worker 调用 JSON-RPC 方法 `usage`，
参数为 `{ "harnessId": "dsh" }`。插件设置页也可以复用这个方法。无数据时返回 `null`。
worker 只返回账号可显示的快照，例如：

```json
{
  "updatedAt": 1893456000000,
  "windows": [{ "label": "Weekly", "remainingPercent": 80, "resetsAt": 1894060800000 }],
  "balances": [{ "currency": "CNY", "amount": "12.30" }]
}
```

时间使用 Unix 毫秒，额度填剩余百分比（0–100），余额填币种及十进制字符串。只返回有依据的字段：
可单独提供窗口或余额，也可两者都提供。标签应能区分套餐、模型组和周期。账号用量按需读取，
请把凭据留在 worker，避免把快照写入引擎列表。任务本身的上下文占用继续由 ACP `usage_update` 上报。

### 多个账号（未发布）

外部 Agent 能把登录与会话历史放进指定目录时（类似 Claude 的 `CLAUDE_CONFIG_DIR`、Codex 的 `CODEX_HOME`），可以让用户在 Cindy 里
给这个引擎添加多个账号：Cindy 像内置供应商一样在账号之间分配任务、设置并发上限和权重、额度用完时换号，并显示每个账号的身份。
做不到按目录隔离登录的 Agent（例如登录固定存在系统钥匙串里）不要声明登录方式，只报告原有登录的身份即可。

1. 在 `PUT /harnesses` 对应条目加 `accounts`(只在 `available: true` 时有效，主 worker 须为 `json-rpc-stdio`)：

   ```json
   { "id": "dsh", "available": true,
     "accounts": { "methods": [{ "id": "api-key", "label": "DeepSeek API Key", "kind": "secret", "secretLabel": "DeepSeek API Key" }] } }
   ```

   `kind` 为 `browser`(你的 worker 打开浏览器完成登录)或 `secret`(Cindy 弹窗收一个 Key 交给你)，最多 4 种。`methods: []` 表示只报告原有登录
   的身份、不能添加账号。
2. Cindy 加的账号运行任务时，入口的 `process.argv` 末尾多两项 `--cindy-account-dir <绝对路径>`。只对这一次启动让 Agent 的登录、写入的设置和会话
   历史都用这个目录(例如设置 `DSH_HOME`)，**不要回落到原有登录**；目录用不了就向 stderr 写明原因并以非零状态退出。没有这个参数时就是原有登录，
   行为不变。与 `--cindy-remote-workspace` / `--cindy-guest-workspace` 同时出现时，分享模式的隔离以这个目录为来源。
3. 主 worker 处理下面的方法(不带 `accountDir` 都指原有登录)：
   - `accountStatus({ harnessId, accountDir? })` → `null` 或 `{ state: "signed-in" | "signed-out", identity?: { email?, name?, detail? }, plan?, fingerprint?, models? }`。
     身份只给能显示的：邮箱、用户名，或「API Key ····abcd」这类说明；`fingerprint` 是同一账号的稳定摘要(例如 Key 的 sha256 前缀)，只用来识别重复登录；
     `models` 只在这个账号的模型和引擎清单不同时给。
   - `accountLogin({ harnessId, accountDir?, methodId, secret? })` → `{ ok: true }` 或 `{ ok: false, error: "cancelled" | "timeout" | "busy" | "unsupported" | "invalid-secret" | "failed", message? }`。
     浏览器登录最长等 11 分钟，等待期间至少每 20 秒发一次进度 notification 或写一行 stderr，否则 60 秒没有动静就会超时。`secret` 只用来写进
     这个账号目录里 Agent 自己的凭据存储，不要写日志、不要回传。
   - `accountLoginCancel({ harnessId, accountDir? })` → `{ ok: true }`，结束正在等待的登录。
   - `usage` 多一个可选参数 `accountDir`，返回那个账号的用量。窗口可以加 `windowMinutes`(窗口长度，例如 5 小时为 300)和 `models`(这个窗口只限这些模型)，
     Cindy 据此优先用快要作废的额度。
4. 让 Cindy 能换号：Agent 在 `session/new`、`session/load`、`session/resume`、`session/prompt` 因账号原因失败时，入口在 JSON-RPC 错误里加
   `error.data._meta.cindy = { kind: "usage-limit" | "auth-required" | "overloaded", resetsAt?: <毫秒>, model? }`：额度用完(有周期重置的给 `resetsAt`，
   余额不足这类没有重置时刻的不给)、需要重新登录、服务繁忙或限流。其余消息原样转发。没有分类时 Cindy 只能识别启动失败和 `-32000` 登录失效。

旧版 Cindy 不会传这个参数，也不会调用这些方法，插件照旧按原有登录运行。
