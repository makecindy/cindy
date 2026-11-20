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
