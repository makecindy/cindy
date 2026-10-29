## 4.12 随包 Node 工作进程与 stdio MCP(node 能力)

插件需要随包代码、CLI、JS 依赖、可复用 worker 状态或 stdio MCP 时，使用顶层
`node` 字段描述现有 Node 工作进程。这里不再有 `node` Slot，也不要求客户端
预登记某个具体 CLI；Agent 发起插件工具调用时，是否运行由外层 `ghost_call`
的既有授权系统决定。

`main.js` 永远还是浏览器沙箱代码。声明 node 后，主机额外为**这个插件**按需
启动一个独立 Node 进程；同一插件的多个会话复用它，不同插件绝不共用进程。通信链固定为：

```
Node worker ↔ JSON-RPC stdio ↔ 你的 main.js ↔ Cindy 主机能力
```

Node 不能直接拿到 `cindy`、Electron IPC 或 Agent 会话。它向主机发反向 JSON-RPC
请求时，主机会固定返回 `-32601`；需要 Cindy 能力时，Node 先把数据回给 `main.js`，
再由 `main.js` 调 Cindy 通道。插件自主调用继续按 manifest 验权；当前
Agent tool-call 内的网络与 workdir 操作按 §4.2 复用 Agent 授权。

### 4.12.1 自定义 Node 服务(JSON-RPC stdio)

这不是“只能做 MCP”。你可以把 worker 当成任意本地 Node 服务，只要用一行一个
JSON-RPC 2.0 对象收发。stdout **只能写协议消息**，日志写 stderr：

```js
// node/worker.cjs
const readline = require('node:readline');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'taptap/connect') {
    const result = await connectTapTap(request.params); // 这里可用完整 Node/CLI 能力
    reply({ jsonrpc: '2.0', id: request.id, result });
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not found' } });
});
```

`main.js` 调用：

```js
const response = await cindy.node.request({
  method: 'taptap/connect',
  callId: msg.callId, // tool-call 内透传
  cancelWithCall: true, // 显式启用授权卡和随调用结束的生命周期
  params: { projectId: 'demo' },
  timeoutMs: 30000 // 可选 1000–120000，缺省 30000
});
if (!response.ok) throw new Error(response.message);
const result = response.result;
```

当前工具触发的登录等前台请求应同时传入 `cancelWithCall: true` 和主机下发的
`callId`。显式启用后，主机只接受当前插件的在途调用；取消、超时或交卷后，该
Node 请求及其子进程一并结束，晚到的授权或子进程启动会被拒绝。只传旧 `callId`
或不启用开关都保持既有独立 RPC 生命周期，不自动弹授权卡、不回收后台进程；
设置页等无 tool-call 的入口不能伪造或复用调用编号。

#### 下载公开大文件与进度

声明 node 和 network.hosts 后可用 cindy.downloads.start({id,url,sha256,bytes})；
只接受声明的 HTTPS 主机（每次重定向复核），不发送 Cookie、凭证或自定义请求头。
SHA-256 和精确字节数必填，单文件最多 8 GiB。下载从获得队列槽位起最多 2 小时（含重试，不计排队），不改变 Node 调用期限。返回 {ok:true,token,bytes,sha256,fromCache}，
没有宿主路径。取消用 cindy.downloads.cancel({id})。
订阅 onHostMessage 的 download-progress 事件：data 含 id、phase、loaded、total、speedBps；
phase 为 queued/downloading/verifying/retrying/completed/failed/cancelled，retrying 另含 attempt、delayMs。
无 loaded/total 时显示不确定进度，下载成功不等于解包成功。

将 token 放入 cindy.node.request 的 downloadTokens，例如 {archive: token}；params 必须是对象且
不能自带 downloads。Host 校验同账号、同插件、批准身份与文件身份后，仅向 Node 注入
params.downloads.archive。Node 在本次 RPC 结束前读取或复制文件，不得把宿主路径回传面板或写进日志。
旧请求不带 downloadTokens 时保持原有 params 语义。旧宿主无 downloads 时提示升级。

下载队列与宿主更新隔离，传输逐块写盘并支持校验、重试与续传。每账号所有插件的缓存
合计最多 16 GiB（含在途预留及每项 64 KiB 管理空间）；不淘汰正在下载或被 Node RPC 借用的文件，满额且无可回收项时失败。
缓存可被回收，重启后 token 失效，重新 start 可复用经校验的文件。卸载插件回收其下载缓存；
停用、账号切换或批准身份改变会拒绝旧凭据，不增加用户授权步骤。

#### Node Worker 的持久化凭证绑定

本地 IMAP/SMTP 等协议确实需要 Worker 使用凭证明文时，在
`node.secretBindings` 声明凭证键与允许注入的方法。设置页仍只负责收单：

```js
// settings.js:输入框里的值立即交给主机 safeStorage,不要进 /kv / 日志 / BroadcastChannel
await fetch('/secrets/mail_code', {
  method: 'PUT',
  body: JSON.stringify({ value: authorizationCode })
});
// GET /secrets 只能看到 { key:'mail_code', saved:true, tail? },永远没有明文
```

浏览器 `main.js` 发给 Node 的业务参数里不要放凭证：

```js
await cindy.node.request({
  method: 'mail/action',
  params: { action: 'search', query: '账单' }
});
```

宿主现查清单，只有 method 与目标 entry 同时命中绑定时，才从 safeStorage
读取本插件自己的键，并在发往 Worker 的 JSON-RPC 保留字段中临时注入：

```js
// worker 收到的 request；cindy 字段由宿主铸造，main.js 自报同名字段会被忽略
const authorizationCode = request.cindy.secrets.mail_code;
```

规则与红线：

- `secretBindings` 最多 4 条，每条 `methods` 1–16 个；省略 `entry`
  只绑定主入口，不能借同名方法把凭证送去其它入口；
- 在途工具调用显式携带 `cancelWithCall: true` 和 `callId` 时，缺少本次方法/入口声明的手动凭证会先显示既有保密输入卡，
  远程任务复用签名加密输入桥；用户提交后才进入 Worker。显式登录或更换 Token 可带
  `promptSecrets: true`（要求上述显式生命周期开关），即使已保存也重新显示卡片；取消不清除原凭证。
  没有在途调用或旧 Host 不支持此接线时仍返回 `PERMISSION_DENIED`，不会回退到聊天收取
  Token。设置页继续使用 `/secrets`，不要把输入放入业务 RPC 或 BroadcastChannel；
  完成本次卡片提交后，Host 在 Worker 私有 `request.cindy.secretInputCompleted` 标记
  `true`。要求本次人工填写的登录方法必须检查该标记；旧 Host 缺标记时拒绝执行，不能
  因其忽略新请求字段而静默复用旧 Token；标记不能由插件 main.js 自报；
- 若手动凭证只用于登录方法，可用 `setup: { requires: [] }` 保留既有 CLI 登录及其它工具，
  由具体绑定方法触发卡片。此配置就绪仅表示凭证已保存；插件还需执行最小只读权限验证。
  这个增量只涉及插件→本机 Host 的 Node 请求；远程卡片和输入协议不增加字段；
- 宿主不会直接把明文交给 `main.js`、Agent 参数或写入宿主日志；但 Worker
  收到明文后可以主动回传、落盘或写日志，浏览器侧代码和 Agent 也可能因此间接
  获得它。插件详情的能力清单会逐条披露此风险，只安装可信来源插件；
- Worker 用完不要缓存、落盘、回传或写日志；每次请求都以
  `request.cindy.secrets` 的当次值为准；
- `node.secretBindings` 与 `network.secrets` / `network.connections`
  共用插件内凭证键命名空间，撞名拒装；声明它必须同时提供 `settingsHtml`。

长任务(构建/打包这类几分钟量级的活)加 `maxTotalMs` 开启**有动静就续期**:
`timeoutMs` 变成"沉默窗口"——worker 只要还在输出(stdout 协议消息或 stderr
日志)就不断续期,绝对上限 `maxTotalMs`(最长 15 分钟):

```js
const built = await cindy.node.request({
  method: 'build/run',
  params: { projectId: 'demo' },
  timeoutMs: 60000,     // 沉默 60 秒判死
  maxTotalMs: 900000    // 就算一直有动静,最多也只等 15 分钟
});
```

worker 侧配合:干长活时定期发进度 notification(或往 stderr 打日志)即可;
彻底静默超过 timeoutMs、或总时长到 maxTotalMs,都会收到 TIMEOUT。mcp-stdio
的 `tools/call` 同样适用(MCP 进度通知天然就是"动静")。

多进程:在 `node.entries` 申报额外入口后,`cindy.node.request` 带 `entry`
指名调用(缺省 = 主入口 `node.entry`);每个入口一个独立进程、独立空闲回收,
协议与生命周期声明全体共用:

```js
const built = await cindy.node.request({
  entry: 'node/build.cjs',           // 必须逐字命中 node.entries,否则整单拒
  method: 'build/run',
  params: { projectId: 'demo' }
});
```

worker 可以发不带 id 的 notification 报进度，主机会转成 main.js 的
`node-notification` 事件；进程启动/停止/崩溃会转成 `node-status`(额外入口的
状态事件带 `entry` 字段,主入口不带)：

```js
// worker
reply({ jsonrpc: '2.0', method: 'progress', params: { percent: 50 } });

// main.js
cindy.onHostMessage((msg) => {
  if (msg.type === 'event' && msg.name === 'node-notification') {
    // msg.method / msg.params
  }
  if (msg.type === 'event' && msg.name === 'node-status') {
    // msg.state = starting / running / stopped / crashed
  }
});
```

### 4.12.2 stdio MCP

Node 可通过既有 `secretBindings` 引用本插件 OAuth 账号，不必复制或重新授权：
`{ key: 'access_token', label: '账号', methods: ['service/run'], oauthSecret: '已有的 network.secrets OAuth key' }`。
引用必须指向同一插件的 `source:'oauth'` 声明；它不是新的可填写 Secret，设置页继续使用
`/oauth` 管理多账号。`cindy.node.request({ method:'service/run', authAccount: accountId, params })`
可选择账号，省略时使用该 OAuth 槽的默认账号。Host 刷新后仅把 access token 放入 Worker 的
`cindy.secrets.access_token`，不交付 refresh token；未绑定的方法不注入。
Worker 与它启动的 CLI 是受信任的原生代码，会接触短期令牌；不得回传、落盘或记录令牌，
每次调用使用独立子进程环境，不修改全局 `process.env`。令牌失效后的写操作不能自动重放。

把 `protocol` 改成 `"mcp-stdio"`，worker 实现标准的逐行 JSON-RPC MCP server。
Cindy 会统一完成 `initialize` + `notifications/initialized`，你的 main.js 不要重复初始化，
直接调用标准方法：

```js
const listed = await cindy.node.request({ method: 'tools/list', params: {} });
const called = await cindy.node.request({
  method: 'tools/call',
  params: { name: 'build_game', arguments: { projectId: 'demo' } }
});
```

MCP server 的 sampling / elicitation / roots 等 server→client 反向请求第一版不开放；需要
这类能力时仍按“结果回 main.js，再由 main.js 申请 Cindy 能力”的链路设计。

### 4.12.3 打包和生命周期红线

- 用户不需要安装 Node、npm、CLI 或 MCP。运行时由 Cindy 随包提供；你必须在制作阶段
  把依赖打成单个 worker 文件或连同静态资源放进目录；**禁止**在安装/首次运行时执行
  `npm install`、`npx`、`postinstall` 或从网络下载可执行代码；
- Forge 会跳过 `node_modules`，推荐用 esbuild/rollup 预打包成 `worker.cjs`。Node 包
  最多 2048 个文件、解压后 256MB、.cindy 128MB；超限直接拒绝；
- `on-demand` 首次 `cindy.node.request` 才启动，缺省空闲 120 秒关闭；停用、更新、
  卸载、退出 Cindy 都立即关闭。`resident` 会随插件启用一直运行，详情页单独显示；
- 每个插件最多 32 条在途请求；单次 params 256KB、单行 stdout 1MB。单次请求缺省
  30 秒、上限 120 秒;长任务用 maxTotalMs 开启"有动静就续期",绝对上限 15 分钟
  (见 §4.12.1)。进程崩溃只影响
  自己，所有在途请求收到结构化失败，下次请求可重新启动；
- **最重要的安全事实**：Node 进程不是浏览器沙箱，它拥有当前登录系统账号能拿到的
  本机权限，能读写文件、联网、起别的进程。Cindy 会在插件详情中显著展示这项能力，
  但安装不会追加确认弹窗；不需要本机能力的插件不要声明 node，用户也只应安装可信来源。
- macOS 的 Node 工作进程及宿主代启的 Node 子进程保留 Cindy 的系统权限责任归属，
  可在系统允许范围内使用 Cindy 已获得的系统授权。尚未取得的权限仍由系统决定是否需要
  授权；原生子进程的签名与用途声明也会影响结果。这不额外开放 Cindy IPC 或托管凭证。

### 4.12.4 宿主代启子进程(childSpawn)

有些库(如 `@taptap/maker`)会在肚子里自己 `spawn(process.execPath, [脚本, 参数])`
——在 Cindy 的 worker 里这条路是死路(正式包关 RunAsNode,生出来的不是 Node)。
声明 `"childSpawn": true` 后,worker 里多一个全局窄接口,可以请宿主**代启**一个
已申报入口的原样 stdio 子进程:

```js
// worker 里(仅普通 worker 模式有;子进程里没有——树深恒为 1)
const child = await globalThis.__CINDY_NODE__.spawnEntry(
  'node/maker.cjs',                 // 必须逐字命中 node.entry / node.entries
  ['__maker-proxy']                 // 启动参数(≤16 条、单条 ≤2048 字符),
);                                  // 子进程看到的 argv 就像被 node 正常启动
child.stdout.on('data', (buf) => { /* 字节原样到手 */ });
child.stdin.write('{"jsonrpc":"2.0",...}\n');
child.on('exit', (code) => { /* 级联生死:worker 停,孩子必停 */ });
child.kill();
```

给第三方库改道的惯用垫片——在 require 它**之前**打补丁:

```js
const cp = require('node:child_process');
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  if (cmd === process.execPath) {
    // 把 [脚本绝对路径, ...其余参数] 映射到申报入口 + 参数
    return wrapAsChildProcess(globalThis.__CINDY_NODE__.spawnEntry('node/maker.cjs', args.slice(1)));
  }
  return realSpawn(cmd, args, opts);
};
const maker = require('@taptap/maker'); // 之后它的自启动全部走了正道
```

红线与钳制:

- 只能启动 `node.entry` / `node.entries` 里**逐字申报过**的 JS——这不是任意
  命令执行,连 node 命令行参数都不存在;
- 每插件同时在世的子进程最多 4 个;子进程不能再生孙进程(接口只在 worker 有);
- stdio 由宿主纯字节中继(base64 帧,不参与 JSON-RPC 协议、不受逐行检查),
  但**只适合文本/协议流**,别拿它传大文件;
- 级联生死:worker 退出/被停/插件停用,子进程一并收掉,不留孤儿。

### 4.12.5 随包 CLI 的登录授权卡片

优先调用通用 `globalThis.__CINDY_NODE__.bindAuthorization()`。在**当前 JSON-RPC 请求处理函数内**
同步捕获返回的 authorize 函数，再交给 CLI 输出/浏览器启动回调。调用方必须以
`cancelWithCall: true` 显式启用；它只绑定这一次仍在途的 `callId`，不允许后台启动或复用。可传入的请求为：

```ts
type AuthorizationRequest =
  | { kind: 'device'; url: string; userCode?: string; expiresAt?: number }
  | { kind: 'browser'; url: string; expiresAt?: number }
  | { kind: 'loopback'; url: string; callbackUrl: string; state: string };
// device/browser 只表示页面已打开；之后原 CLI 继续轮询、保存、校验。
// loopback 远程回 {kind:'callback', state, code} 或 {kind:'callback', state, error}；
// 本机回 {kind:'opened'}，原 CLI 自有 localhost listener 接受浏览器回调。
const authorize = globalThis.__CINDY_NODE__?.bindAuthorization();
if (!authorize) throw new Error('Authorization cards unavailable');
const result = await authorize({ kind: 'device', url: verificationUri,
  userCode, expiresAt: Date.now() + expiresInSeconds * 1000 });
// 由现有 provider SDK/CLI 完成后续操作；RPC 成功必须晚于实际领取/保存/校验。
```

`browser` 用于上游提供 HTTPS 确认页的扫码或浏览器确认，不传二维码图片、Cookie、
账号密码或任意 CLI 命令。`device` 的 userCode 原样保留（1–32 位字母/数字/空格/连字符），
不把私有 device_code 当用户码。expiresAt 是绝对毫秒时间且不能延长宿主五分钟上限。
目标必须命中已安装插件的 OAuth origin / network hosts；GitHub/TapTap 继续用已审查的精确规则。

`loopback` 只支持原 CLI 的 Authorization Code + PKCE S256：url 内唯一 state、redirect_uri、
response_type=code、client_id、code_challenge 与 code_challenge_method=S256 必须完整；
callbackUrl 必须与 redirect_uri 精确相等，且为 localhost、127.0.0.1 或 [::1] 的显式非特权
端口 HTTP URL。不能改写上游登记的 redirect、降低 PKCE 或抢占别人端口。verifier 留在源 CLI；
远程 callback 只经 bootstrap 私有 Promise 交给这一次可信 Node 调用，用原 provider SDK
交换，不经 stdout/main.js/Agent。既有 CLI 若仅有固定监听器，需要在其受审查适配器内消费
此私有结果；Host 不代发任意 HTTP。不要把 callback code 放到 argv、日志或 RPC 结果。

普通 API Key/PAT 不走这个 Node 接口：沿用 `network.secrets` / `node.secretBindings`
声明，由 Host 原密码卡收集，远程端支持时经签名输入桥直接写对应 vault key。插件不读取输入，
不要求用户把密钥发给模型。保存只证明配置已落地，上游权限由实际业务调用核验。

兼容入口继续保留：

当第三方 CLI 使用「浏览器授权、发起端轮询」时，Node worker 可在**当前请求处理函数内**
捕获 `globalThis.__CINDY_NODE__.bindDeviceAuthorization()` 返回的函数，再在 CLI 输出回调
里调用 `await authorize(httpsUrl)`。同一请求只接受一个链接。Node 请求必须带来自当前
`tool-call` 的 `callId`，并显式设置 `cancelWithCall: true`；宿主反查插件、任务和 owner，插件不能自选任务。无绑定时返回
undefined；不支持时明确报错，远程流程不能回退到在执行设备开浏览器或把链接交给模型。

宿主创建含真实授权域名的卡片，用户点击后由当前设备的可信 Host 打开链接。远程链接只走既有
加密授权事务；这个 Promise 只代表浏览器已打开，**不代表登录完成**。CLI 仍在原设备轮询，
凭据由原 CLI 保存；Node RPC 只有在真实领取/保存和检查完成后才返回成功。取消卡片/任务、
断开控制端或事务到期会取消该 Node RPC 及其绑定子进程。不要把 URL、轮询码或 token 放进
stdout 的 RPC 结果、通知、模型回复或错误；业务状态返回固定摘要。此卡片不改变 Host 的
network setup/readiness，不能拿 CLI 的登录结果冒充宿主凭据配置已完成。
