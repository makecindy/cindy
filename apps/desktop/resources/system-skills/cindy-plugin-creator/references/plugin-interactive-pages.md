## 4.23 交互页面 MCP Apps（mcpApps.ui）

交互页面让一次工具结果变成可操作的页面。AI 根据用户意图打开页面；之后用户填写表单、
查询数据或点击按钮，由页面脚本调用插件工具完成，不必每次等 AI 再说一句。页面使用
官方 `@modelcontextprotocol/ext-apps` 的 `App`，插件的 `main.js` 提供工具和网络能力。

按“生成首屏 → 显示页面 → 页面接管交互”介绍编写方法。完整源码在
[示例目录](examples/interactive-pages/README.md)，字段、文件和 SDK 方法查
[按需参考](examples/interactive-pages/REFERENCE.md)。

**版本提示**：本章标准 SDK 导入和加载器整页替换要求 Cindy **0.1.122-beta 或更新版本**，
插件声明 `minCindyVersion: "0.1.122-beta"`，执行端、手机和远程查看端都需升级。

### 1. 先选界面，再选首屏来源

| 用户要做什么 | 选哪种界面 |
| --- | --- |
| 在工具结果里看表格、填写表单、连续操作 | 本章交互页面 |
| 看简单结果、点固定按钮、让 AI 继续处理 | [聊天卡片 §4.5](plugin-chat-cards.md) |
| 使用跨任务常驻的工作台 | [面板 §5](plugin-panels.md)或[主视图 §4.20](plugin-main-view.md) |
| 使用当前任务的侧栏页面 | [任务页 §4.22](plugin-task-view.md) |

| 首屏来源 | 适用场景 | 起点 |
| --- | --- | --- |
| 后端生成完整 HTML | 界面随意图变化，希望修改后端就能更新界面 | loader 的 open_view |
| 包内静态 HTML | 小表单、固定图表，界面和插件一起发布 | static |
| Cindy 对话中的 AI 生成完整 HTML | 用户临时需要组合界面，数据由既有工具提供 | loader 的 show_page |

首屏可以来自后端、包内静态 HTML 或对话 AI；后端是可选的，插件也可以只用自己的存储
（[library §4.10.1](plugin-files-and-library.md)）和 Cindy 能力自闭环。之后页面脚本
查询 JSON、更新局部；无论首屏由谁生成，都遵守同样的工具、凭证和数据规则，不必每点
一次按钮就重新生成界面。

### 2. 运行完整示例

复制 [loader](examples/interactive-pages/loader/) 到自己的插件源码目录。默认
`USE_MOCK = true`，在 main.js 内模拟后端，不联网、不需要账号或凭证。可以直接
打包；要安装时，先取得用户明确的安装指示。

```js
// 打包只生成 .cindy，不会安装或发布。
ghost_forge_pack({ dir: '<插件源码目录的绝对路径>' });
// 用户明确要求安装后，使用同一个源码目录。
ghost_forge_install({ dir: '<插件源码目录的绝对路径>' });
// 然后在 Cindy 中说：“打开记录页面”。
```

默认示例不上传真实文件。操作顺序和接后端的方法见[示例说明](examples/interactive-pages/README.md)。

### 3. 在 ghost.json 声明资源和工具

工具仍声明在 `tools[]`，包括只供页面调用的工具。`mcpApps.ui.resources`
把一个 `ui://` 名字对应到包内 HTML；`mcpApps.ui.tools` 指定页面和可见性。
下面是从[完整清单](examples/interactive-pages/loader/ghost.json)抽出的对应关系：

```json
{
  "mcpApps": { "ui": {
    "resources": [{
      "uri": "ui://interactive-loader/v1", "file": "ui/page.html",
      "prefersBorder": true,
      "csp": { "connectDomains": [], "resourceDomains": [] }
    }],
    "tools": {
      "open_view": { "resourceUri": "ui://interactive-loader/v1", "visibility": ["model"] },
      "show_page": { "resourceUri": "ui://interactive-loader/v1", "visibility": ["model"] },
      "load_view": { "visibility": ["app"] },
      "api_read": { "visibility": ["app"] },
      "api_write": { "visibility": ["app"] }
    }
  } }
}
```

`model` 表示 AI 可发现和调用；`app` 表示页面可调用。只写 `["app"]` 的工具
不会出现在 AI 工具清单中，也不能直接 `ghost_call`。省略 visibility 时，有 UI
声明的工具同时对两者可见；未写 UI 声明的工具仍只对 AI 可见。需要文件时再加入
示例里的文件工具，删掉不用的能力声明。不要用一个工具靠参数切换读和写。

### 4. main.js 为第一次调用准备整页

AI 调 `open_view({intent})`，main.js 把意图发给固定后端，后端返回完整 HTML。
完整页面应有自己的样式、HTML 和 module script；初始化数据直接放进页面，不需要
页面为了显示第一屏再请求一次。网络走 `cindy.fetch` 并带当前 `msg.callId`。

```js
const response = await cindy.fetch({
  url: 'https://api.example.com/view', method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ intent: msg.args.intent }), callId: msg.callId
});
if (!response.ok || response.status < 200 || response.status >= 300 || response.truncated)
  throw new Error('页面暂时无法加载。');
const page = JSON.parse(response.body);
cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
  content: [{ type: 'text', text: '页面已准备好。' }],
  _meta: { view: { html: page.html } }
} });
```

`ok: true` 只表示代发完成，HTTP 4xx/5xx 仍可能在里面，必须检查 `status`。
错误用 `{isError:true, content:[{type:'text',text:'可采取行动的提示'}]}` 返回。不要把
堆栈、响应头、令牌或未经控制的服务错误正文转给页面和 AI。

`content` 是给 AI 和用户的一句话摘要。根 `_meta.view.html` 给页面，不放进模型
上下文；`structuredContent` 适合 JSON 数据，但它也对 AI 可见。HTML 内不要放
凭证，也不要把不必要的大数据塞进结果。

由 AI 写首屏时使用 show_page({title,html})，返回结构相同。生成页面的 LLM（后端模型或
对话 AI）读[MCP Apps 页面生成手册](examples/interactive-pages/PAGE-GENERATION.md)；
loader 用 `manual.items` 挂上同一份，show_page 说明指向 `ghost_manual`。页面不能
创造插件未提供的能力。

### 5. 加载器显示首屏，生成的页面自己连接

[加载器](examples/interactive-pages/loader/ui/page.html)收到第一次结果后，
取 `_meta.view.html` 替换自己。它不包含业务内容，不删除脚本，不维护按钮协议，
也不向页面提供额外的 window 全局对象。

```js
import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: '页面加载器', version: '1.0.0' });
app.ontoolresult = async result => {
  const html = result._meta?.view?.html;
  if (result.isError || typeof html !== 'string') return;
  await app.close();
  document.open();
  document.write(html);
  document.close();
};
await app.connect();
```

生成的页面用同一个标准 import，创建自己的 App 并 connect。Cindy 为所有页面始终
提供 SDK 并随宿主升级，无需 CDN，也不写死 SDK 文件地址；自带 SDK 的页面仍可用自己的副本。

生成的页面不要等初始 `ontoolresult` 再渲染：加载器已接收它，重新连接不会
重发最初的输入和结果。把首屏数据写进 HTML，或在确实需要新数据时主动调用
只读工具。卡片卸载再打开会从最初的工具结果恢复，不保证保留未提交的输入。

### 6. 页面读 JSON，只更新需要的部分

页面首次显示后由自己的脚本接管，这就是常见的 C/S 写法。下面查询列表并更新
内容，不重新生成整页，也不改表单里的输入。完整实现见
[loader/main.js 的 pageClient](examples/interactive-pages/loader/main.js)。

```js
const result = await app.callServerTool({
  name: 'api_read', arguments: { path: '/api/items', query: { keyword: 'A' } }
}, { timeout: 30 * 60 * 1000, maxTotalTimeout: 30 * 60 * 1000 });
if (result.isError) throw new Error('查询未完成。');
const list = document.querySelector('#items');
list.replaceChildren();
for (const item of result.structuredContent.items) {
  const row = document.createElement('li');
  row.textContent = item.name;
  list.append(row);
}
```

数据用 `textContent`、`value` 或创建 DOM 元素展示。不要把接口返回的名称、用户
输入或文件内容当 HTML 拼进去。按钮等待期间禁用，成功后显示结果，失败时显示
可读错误。进度可选，不代表完成；不要用一直旋转的按钮代替错误处理。

### 7. 表单和写操作

使用 `<form>`，在 `submit` 事件里先调用 `preventDefault()`，再调用工具。
点击提交按钮和在输入框按 Enter 都会自然触发 submit，无需额外处理点击或键盘。
CSP 的 `form-action 'none'` 禁止原生 action 提交；提交数据必须走工具。
页面自己的 fetch 不会带 Cindy 保管的凭证。

下面省略了按钮状态和请求编号管理；完整写法见
[静态表单](examples/interactive-pages/static/ui/page.html)。

```js
form.onsubmit = async event => {
  event.preventDefault();
  try {
    const result = await app.callServerTool({ name: 'api_write', arguments: request }, {
      timeout: 30 * 60 * 1000, maxTotalTimeout: 30 * 60 * 1000
    });
    if (result.isError) throw new Error('保存失败，请核对结果后重试。');
    status.textContent = '已保存';
  } catch (error) { status.textContent = error.message; }
};
```

request 包含 `path`、`body` 和 `idempotencyKey`。等待期间禁用重复提交，失败时保留输入。

同一内容重试沿用 request 中的编号；用户改了内容才创建新请求。写入方（插件存储
或后端）按“当前用户 + 编号”去重，正式后端用数据库唯一约束，并拒绝同编号不同内容。
**不要自动重试写操作**：超时不等于未写入，应查询结果或用原编号重新提交。

### 8. 偶尔切换整块内容，保留脚本

多数交互使用 JSON；需要改变布局时，调用 `load_view({intent,fields})`，后端返回
可信的内容片段，替换指定容器。这里约定返回的是容器内容，不含另一份 html/head/body
和脚本。`open_view` 返回完整文档，两者不要混用。

```js
const result = await app.callServerTool({
  name: 'load_view', arguments: { intent: 'form', fields: { title: 'Record A' } }
}, { timeout: 30 * 60 * 1000, maxTotalTimeout: 30 * 60 * 1000 });
if (result.isError) throw new Error('页面未更新。');
document.querySelector('#content').innerHTML = result._meta.view.html;
bindContentEvents();
```

innerHTML 只接转义过动态值的可信模板，不接普通数据。片段中的 script 不执行；
常驻脚本负责绑定事件。要保留的输入先存到页面状态，替换后恢复。

整份文档只在加载器首屏替换；标准工具集里没有向页面返回完整文档的工具，页面
不要把 load_view 片段 write 进整个文档。换内容一律替换容器，保留脚本和连接。

### 9. 接上真实后端与文件

不需要业务后端时，main.js 直接把数据存在插件自己的存储里（library，§4.10.1），
页面写法不变；需要后端数据时再按下面接入。

把示例 `USE_MOCK` 改为 false，同时替换 BASE 和清单里的占位域名。路径由 main.js
校验：只允许相对路径、固定前缀，不接受完整网址、父目录或编码绕过。后端继续
验证当前用户对记录的权限，路径白名单不能代替后端鉴权。

凭证只由 main.js 发起的 cindy.fetch 使用，值由 Cindy 注入；页面和 main.js 都不要
尝试读回。声明方式见[网络 §4.7](plugin-network.md)。

文件有两种常用入口：页面调用 pick_files 选择文件，再 upload_files 上传；或者 AI
用 `ghost_call.dir` 交接单文件，import_file 在这次调用里立即上传暂存，只把批次号
和预览交给页面，用户再点确认。不要把交接 token、本机路径或原始文件字节放进 HTML。
完整步骤见[文件导入示例](examples/interactive-pages/README.md#文件导入)。

预览图片或下载文件时，工具返回 resource_link，页面读取内容块的
`_meta['cindy/file'].url`。不要自己拼只读地址，也不要把临时地址当持久引用。
其他文件类型、体积限制和能力检测见[参考页](examples/interactive-pages/REFERENCE.md#文件)。

### 10. 硬性规则与验收

| 必须做到 | 原因和写法 |
| --- | --- |
| 每个页面只创建一个 App | 所有交互共用该实例；替换文档前关闭旧实例 |
| 直接导入 Cindy 提供的 SDK | 写 `import { App } from '@modelcontextprotocol/ext-apps'`；不写 importmap，不从 CDN 或其他地址加载 SDK |
| 页面不接触凭证 | 经 main.js 的 cindy.fetch 代发，不将 token 放进 HTML、日志或结果 |
| 表单走桥接 | submit 中先 preventDefault()，再调用工具；不用原生 action |
| 数据用 textContent | 生成页面的一方（插件、后端或 AI）转义动态值，不把用户数据拼进脚本或事件属性 |
| 读写分成两个工具 | main.js 固定读写目标（存储或后端地址），按相对路径白名单路由 |
| 两个超时均设 30 分钟 | timeout 和 maxTotalTimeout 都设 30 * 60 * 1000，允许等待授权 |
| 写入使用请求编号 | 写入方去重；失败保留编号，不自动重试 |
| 处理取消与卸载 | 用 AbortController 停止等待，关闭后不继续更新 DOM |
| 支持浅色和深色 | 从 getHostContext 取主题，监听 onhostcontextchanged，不写死白底黑字 |
| 明确结果归属 | content/structuredContent 给 AI；页面专用内容放根 _meta |

使用 `new App(info, capabilities, {autoResize:true})` 自动报告尺寸，通过
`app.getHostContext()` 取主题和 styles.variables。表单应能适应窄屏。
全屏、下载等能力先探测，不能把桌面成功当成所有查看端都支持，详见参考页。

打包后实际打开页面：检查首屏只请求一次；查询不清掉表单输入；按 Enter 和点击
都只保存一次；HTTP 401/500 显示错误；取消后按钮恢复；重复编号不会新增记录；
浅色、深色和窄屏没有溢出。最后关闭再打开卡片，确认恢复的是哪一屏。
清单校验通过不代表页面脚本、网络和交互正常。

### 按场景找完整代码

| 你要实现 | 看哪里 |
| --- | --- |
| 后端生成首屏、AI 生成首屏 | [loader 清单](examples/interactive-pages/loader/ghost.json)与[main.js](examples/interactive-pages/loader/main.js) |
| 最小加载器 | [loader/ui/page.html](examples/interactive-pages/loader/ui/page.html) |
| JSON 查询、写入、内容切换 | [loader/main.js 的 pageClient](examples/interactive-pages/loader/main.js) |
| 包内固定表单 | [static](examples/interactive-pages/static/) |
| 文件交接、暂存、预览、确认 | [文件导入说明](examples/interactive-pages/README.md#文件导入) |
| 文件、下载、进度及其他 SDK 方法 | [files 能力全集](examples/interactive-pages/files/) |
| 字段限制、方法能力与常见错误 | [按需参考](examples/interactive-pages/REFERENCE.md) |
