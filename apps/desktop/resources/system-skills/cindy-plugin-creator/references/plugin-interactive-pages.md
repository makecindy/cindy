## 4.23 交互页面 MCP Apps（mcpApps.ui）

需要独立页面、输入框/任务栏入口、消息展示或宿主草稿操作时，继续使用同一个 MCP Apps 资源，
并阅读[插件界面扩展](plugin-host-ui.md)。该增量尚未发布，不能按本章历史版本下限判断支持。

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
| 包内静态 HTML | 小表单、固定图表，或模型只传 JSON、由页面统一渲染；界面和插件一起发布 | [static](examples/interactive-pages/static/) |
| Cindy 对话中的 AI 生成完整 HTML | 用户临时需要组合界面，数据由既有工具提供 | loader 的 show_page |

后端可选：插件也可以只用自己的存储（[library §4.10.1](plugin-files-and-library.md)）
自闭环，页面写法不变。无论首屏由谁生成，之后页面脚本都查询 JSON、更新局部，遵守同样的
工具、凭证和数据规则。

结构化首屏可沿用 static 的接线：模型调用开页面工具，插件先校验，再把只供页面的数据放入
结果根 `_meta`，由卡片保存首屏快照；页面在 connect 前注册 `ontoolresult`，从根 `_meta` 取数据，
只在用户操作时再调工具，不靠挂载时自动查询来显示首屏。卡片每次重新挂载都会重跑页面脚本；
页面调用工具仍按权限模式审批，Ask 模式下未获自动批准或记住授权的调用会逐次询问。
static 原例使用 `structuredContent`，那部分数据也会进入模型。
包内页面直接收到首次结果；加载器换出的新页面则不会重收已消费的结果，所以后者必须把首屏数据写进 HTML。
嵌套字段写进真实 `parameters` schema，不只放在可选读取的 Manual；分工见 [§3.6](plugin-manual.md)，
调用时校验见 [§3](plugin-tools.md)。schema 上限为 `JSON.stringify(parameters).length <= 16_384`。

### 2. 运行完整示例

复制 [loader](examples/interactive-pages/loader/) 到自己的插件源码目录。默认
`USE_MOCK = true`，在 main.js 内模拟后端，不联网、不需要账号或凭证。可以直接
打包；安装前先取得用户明确的指示。

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
摘自[完整清单](examples/interactive-pages/loader/ghost.json)：

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
示例里的文件工具，删掉不用的能力声明。

Manual 或模型可见工具说明提到页面专用工具时，写清“由页面调用”，并指出模型应先调用的开页面工具。
模型误调会收到仅供页面调用的提示及可用页面入口；没有入口时列出模型可见工具，不应据此判断插件缺少能力。

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

本例由 AI 调用，`content` / `structuredContent` 进入模型，根 `_meta.view.html` 给页面。
页面调用的结果归属及告知 AI 的方法见 [§3](plugin-tools.md)；HTML 不放凭证或不必要的大数据。

由 AI 写首屏时使用 show_page({title,html})，返回结构相同。生成页面的 LLM（后端模型或
对话 AI）读[MCP Apps 页面生成手册](examples/interactive-pages/PAGE-GENERATION.md)；
show_page 说明让 AI 先调 `ghost_forge_guide({section:"pages"})` 读宿主的这份
（旧版可自带一份）。页面不能创造插件未提供的能力。

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

生成的页面用同一个标准 import，创建自己的 App 并 connect。SDK 由 Cindy 为所有页面
提供并随宿主升级，不用 CDN，不写死 SDK 地址；自带 SDK 的页面仍可用自己的副本。

生成的页面不要等初始 `ontoolresult` 再渲染：加载器已接收它，重新连接不会
重发最初的输入和结果。把首屏数据写进 HTML。离屏销毁与重建的触发条件、输入和浏览位置的保留办法，
见[页面生命周期](examples/interactive-pages/REFERENCE.md#等待取消与页面生命周期)。

小草稿和浏览位置可使用[内置页面状态辅助模块](#92-内置页面状态辅助模块)，不需要额外安装依赖。

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
点提交按钮和按 Enter 都会触发 submit，不用另外处理。
CSP 的 `form-action 'none'` 禁止原生 action 提交；提交数据必须走工具。

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

request 包含 `path`、`body` 和 `idempotencyKey`；失败时保留输入。

同一内容重试沿用 request 中的编号；用户改了内容才创建新请求。写入方（插件存储
或后端）按“当前用户 + 编号”去重，正式后端用数据库唯一约束，并拒绝同编号不同内容。
**不要自动重试写操作**：超时不等于未写入，应查询结果或用原编号重新提交。

### 8. 偶尔切换整块内容，保留脚本

多数交互使用 JSON；需要改变布局时，调用 `load_view({intent,fields})`，后端返回
可信的内容片段，替换指定容器：只含容器内容，不含 html/head/body 和脚本；
`open_view` 才返回完整文档，两者不要混用。

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

整份文档只在加载器首屏替换；不要把 load_view 片段 write 进整个文档，换内容一律替换
容器，保留脚本和连接。

### 9. 接上真实后端与文件

把示例 `USE_MOCK` 改为 false，同时替换 BASE 和清单里的占位域名。路径由 main.js
校验：只允许相对路径、固定前缀，不接受完整网址、父目录或编码绕过。后端继续
验证当前用户对记录的权限，路径白名单不能代替后端鉴权。

凭证只由 main.js 发起的 cindy.fetch 使用，值由 Cindy 注入；页面和 main.js 都不要
尝试读回。声明方式见[网络 §4.7](plugin-network.md)。

页面选文件：pick_files 写入 Library，再 upload_files 上传。接收用户在对话里发的表格，
必须用声明了 `cindy_handoff_files` 的工具（0.1.122-beta 起，规则见
[§4.10.3](plugin-files-and-library.md)）：AI 用 ghost_call 的 attachments 交给它 → Cindy
存副本，插件只收到 `handoff:` 引用 → 首屏只显示名称和大小，按钮带上引用 → 用户点击时
插件用 `upload.handoff` 上传，或页面在本机读取。工具说明写明「用户在对话里发的文件，
用 ghost_call 的 attachments 交给本工具」。没声明就只能走 `ghost_call.dir`：一次性票据
须在那次调用里立即暂存，做不到点按钮才处理。不要把交接 token、本机路径或原始文件字节
放进 HTML。完整步骤见[文件导入示例](examples/interactive-pages/README.md#文件导入)。

```json
{ "name": "import_file",
  "parameters": { "type": "object", "properties": { "cindy_handoff_files": { "type": "array" } } } }
```

预览图片或下载文件时，工具返回 resource_link，页面读取内容块的
`_meta['cindy/file'].url`。不要自己拼只读地址，也不要把临时地址当持久引用。
其他文件类型、体积限制和能力检测见[参考页](examples/interactive-pages/REFERENCE.md#文件)。

### 9.1 宿主保存单张卡片的页面状态

根 `_meta` 保存首屏数据；页面状态保存之后的页码、筛选、展开项和小草稿；
插件 kv 保存插件级配置／偏好，业务数据仍放插件自己的存储或服务端。
交互页面不能直接访问 `/kv`；通过工具把各卡片状态放进同一份 kv 会共享容量、
遇到整份覆盖竞争，还需要工具审批和挂载后的额外读取，不用于替代此接口。

在 `ui/initialize` 的响应里检测
`hostCapabilities.experimental['cindy/view-state']`，其 `version` 为 1，
`maxBytes` 为 65536，`maxSessionBytes` 为 1048576。
支持时 `hostContext['cindy/view-state']` 是保存的对象或 null；读失败时不声明能力，
不能把“没有能力”当作“没有旧状态”。旧宿主不支持时保留页面正常交互，使用插件自己的保存入口。
恢复值仅在初始化时交还，不随 host-context-changed 推送，也不在保存后回传。

以下是内层页面经现有 parent 桥接发送的原始请求（不要另起第二个初始化连接）：

```js
// 完成 ui/initialize 并检测上述能力后；id 在本页现有请求管理器中必须唯一。
parent.postMessage({jsonrpc:'2.0', id:'save-draft-1',
  method:'cindy/view-state/set', params:{state:{version:1, page:3, draft:'待提交'}}}, '*');
// 宿主提交成功后回复 {jsonrpc:'2.0', id:'save-draft-1', result:{}}。
// 接收器先确认 event.source === parent，再按 id 匹配成功或 error；超时不算已保存。
```

整体替换，传 `state:null` 清除；页面不能指定账号、任务或卡片键。
根只能是 JSON 对象或 null，容器深度最多 16、节点最多 8192，大小按紧凑 JSON 的 UTF-8 计。
拒绝执行电脑专用的 resource_link（cindy-media:/library:/handoff:），不要存凭证、令牌或临时文件地址。
给状态带业务 `version`，页面升级时识别旧格式；恢复后结合当前数据校正页码等值，
不要让晚到的工具结果覆盖用户的新输入。状态不交给模型、main.js、Node 或 MCP 服务端；
确需让插件知道的内容仍由页面明确调用工具传递。

变化时保存，可在页面防抖；不要等卸载才保存，隐藏后停止请求和计时器。
成功表示本次值或本页更新值已经提交；宿主只合并在途写之后的待写值，
被合并的请求一起收到同一次提交的成功或失败。每页最多 32 个未完成保存请求。
`-32602` 表示此值不能保存（格式、大小、任务额度等），`-32603` 表示暂时无法保存；
失败不改原持久值，不自动重试旧快照。卡片或账号失效沿用权限错误，旧宿主无此方法为 `-32601`。
多端同时打开不会同步，最后提交的整份状态覆盖之前状态；重要协同编辑使用业务存储。

删除消息会删除整批被删除消息的状态；删除任务会删除它及连带旁聊的状态。
清空、rewind、归档和卸载插件保留状态，仍占任务额度；卸载插件不会删除页面状态，删除任务会删除。
暂不可用的卡片不交还状态，恢复合法可见性后才可恢复；分叉／复制任务不带页面状态。
删除是删除数据库记录，不承诺清除数据库旧页或历史备份。

### 9.2 内置页面状态辅助模块

`@cindy/ext-apps` 和 `@cindy/ext-apps/react` 是 Cindy 为页面提供的内置模块，随客户端升级，
**不要 npm 安装**。使用打包器时将这两个名字标成 external，保留浏览器运行期 import。
作者已有的精确、前缀、null 和 scopes 映射保持优先；React 由页面传入正在使用的实例，宿主不再加载一份。
远程预算不足时先省略这两个附加模块，不能挤掉原来能带上的官方 SDK。
执行端或查看端较旧、附加模块被省略时，动态 import 会失败；catch 后保留本地 UI，不能假报保存成功。
静态 import 失败会使整个模块脚本不执行，不能靠它后面的 try/catch 退化。

作者负责：选择字段；初始化恢复后结合当前业务数据校正；用户变化时调用 setter；
默认对象带 `version`、格式改变时递增；模块缺失时做动态 import 退化。
辅助模块负责无能力时保持本地值、默认 500ms 防抖、在途请求合并和错误处理。
默认值或恢复值不会自动保存；恢复值不是对象、缺少 version 或版本不同则回默认值，原历史值不会被自动覆盖。
页码超过现有总页数等业务校正仍由页面做，不要让晚到的工具结果覆盖用户已改的输入。

原生 JS 在 `await app.connect()` 后创建一次：

```js
const mod = await import('@cindy/ext-apps').catch(() => null);
const initial = { version: 1, page: 1, draft: '' };
let local = initial;
const state = mod ? mod.createViewState(app, initial) : {
  get: () => local,
  set: next => { local = typeof next === 'function' ? next(local) : next; },
  flush: () => Promise.reject(new Error('VIEW_STATE_UNSUPPORTED')),
  dispose() {}
};
render(state.get()); // 在第一次业务渲染前校验恢复值的字段和范围
input.addEventListener('input', () => state.set(s => ({ ...s, draft: input.value })));
done.addEventListener('click', async () => {
  try { await state.flush(); showSaved(); }
  catch { showSaveError('尚未确认保存'); }
});
// 加入页面现有 teardown 清理：state.dispose()；不要覆盖其它清理逻辑。
```

官方 `App` 没有可叠加的 teardown 注册接口；如果页面要自己设置 `app.onteardown`，请在创建
`createViewState`（或 React hook）之前设置。辅助模块随后会在该处理器上叠加页面状态写出，
之后再赋值会替换这层写出逻辑。

`set(value | updater)` 返回 void，更新本地状态且失败不回滚屏幕；使用完整不可变对象。
同值不重发。`-32602` 只提示一次固定错误，不打印状态；暂时错误或断线也不自动重试。
同一失败值重复 set/flush 不重试，下一次真实变化才再保存。
`flush()` 取消防抖并等待调用时的值或本页更新值提交，失败则 reject；它不是业务提交。
默认值也可通过显式 flush 保存；无能力时报 `VIEW_STATE_UNSUPPORTED`。
`dispose()` 停止未发送的保存，不关闭 App；已发请求的取消不意味着没写入。不要等离屏才保存。

React 在挂载组件前加载模块并固定 hook；传入的 React 必须与页面渲染器是同一份：

```jsx
const [core, hooks] = await Promise.all([
  import('@cindy/ext-apps').catch(() => null),
  import('@cindy/ext-apps/react').catch(() => null)
]);
const useViewState = core && hooks ? hooks.createViewStateHooks(React).useViewState
  : (_app, initial) => React.useState(initial);
const initial = { version: 1, draft: '' };
function Editor({ app }) {
  const [state, setState] = useViewState(app, initial, { debounceMs: 500 });
  return <>
    <textarea value={state.draft} onChange={e => setState(s => ({ ...s, draft: e.target.value }))}/>
    <button onClick={async () => {
      try {
        if (!core) throw new Error('VIEW_STATE_UNSUPPORTED');
        await core.flushViewState(app); showSaved();
      } catch { showSaveError('尚未确认保存'); }
    }}>完成</button>
  </>;
}
```

同一 App 实例共用一份 controller 和最新页面状态，不与自行发送状态 RPC 混用。
可以同时挂载多个 hook，它们订阅同一个值；函数式 setter 总是基于最新值计算，
一个组件修改后其它组件也会更新，卸载一个组件不影响其它组件或在途保存。
原生 JS 与 React 也可共用同一 App；模块可用时，JS 用 `state.subscribe(render)` 监听本页变化，
回调中用 `state.get()` 读取，订阅返回取消函数；取消订阅不会 dispose 共享 controller。
这是同一页面里的共享，不是跨设备或跨卡片实时同步。
React 18 及以上使用作者传入的 `useSyncExternalStore`；最低支持 React 16.8，
缺少该 API 时用订阅加提交后复查的传统 hooks 回退，只保证旧版非并发渲染；
并发渲染必须使用 React 18+ 并传入完整的 React 实例。
重复调用 createViewState 或组件卸载再挂载不会退回初始化快照，默认值和防抖设置沿用首次创建；
组件卸载不取消已发出的保存，页面关闭时再 dispose。React setter 会同步交出最新值，
同一事件中随后调用 flushViewState 会确认这份值，不需要 flushSync。
React 的 `app` 在连接前传 null，已连接后传 App；连接前用户已编辑时以编辑值为准。
要首屏就是恢复值，先等 connect 完成再挂载业务界面；app 为 null 时不承诺隐藏默认界面。
正常组件卸载且 App 仍连接时会尽力发送已修改值；页面关闭后不继续请求，未收到成功回执的最后输入不保证保存。
`flushViewState(app)` 找到同一 App 的 controller，不要为“完成”按钮临时创建另一个。

类型提示唯一来源是 [cindy-ext-apps.d.ts](examples/interactive-pages/cindy-ext-apps.d.ts)。
把此声明放入作者项目 `types/cindy-ext-apps.d.ts`，TypeScript 的 include 加 `types/**/*.d.ts`；
JS 可用 `// @ts-check` 和 `/// <reference path="./types/cindy-ext-apps.d.ts" />`（按文件位置调整）。
它只提供编辑器类型，不是模块实现，也不能让旧宿主获得新能力。React 项目沿用已有的 JSX 类型。

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
| 明确结果归属 | 区分模型与页面调用，见 [§3](plugin-tools.md)；只供页面的数据放根 _meta |
| 工具状态能跨进程回收接回 | 插件进程随时可能被回收，进程内存只当缓存；交给页面的引用和状态必须存入插件自己的持久存储，或能根据卡片最初的工具结果重建，确保进程重启、卡片重新挂载、换设备查看后仍能接回；离屏后的页面状态见[页面生命周期](examples/interactive-pages/REFERENCE.md#等待取消与页面生命周期) |

使用 `new App(info, capabilities, {autoResize:true})` 自动报告尺寸，通过
`app.getHostContext()` 取主题、styles.variables 和 locale。表单应能适应窄屏。
全屏、下载等能力先探测，不能把桌面成功当成所有查看端都支持，详见参考页。

打包后实际打开页面：检查首屏只请求一次；查询不清掉表单输入；按 Enter 和点击
都只保存一次；HTTP 401/500 显示错误；取消后按钮恢复；重复编号不会新增记录；
浅色、深色和窄屏没有溢出。最后关闭再打开卡片，确认恢复的是哪一屏。
另测进程回收后的恢复：对 on-demand Node 进程，等所有请求和宿主代启子进程结束后，
停止调用并等待超过 `idleTimeoutSeconds`（缺省 120 秒），再翻页、刷新、进详情，并关闭任务后重新打开；
确认能接回状态，无法恢复时给出可操作的提示，不要把缓存丢失误报成账号或页面契约变化。
再用不提“页面/UI”的普通业务提问，检查模型是否按工具 description 主动打开页面。
清单校验通过不代表页面脚本、网络和交互正常。

经 Node 的结果要先满足 [§4.12](plugin-node-worker.md) 的单行限制，不能按更宽的页面通道放大；根 `_meta` 同样计入预算，页面和卡片限额见[参考](examples/interactive-pages/REFERENCE.md)。

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
