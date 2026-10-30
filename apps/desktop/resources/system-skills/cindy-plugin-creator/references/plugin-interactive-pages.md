## 4.23 交互页面 MCP Apps（mcpApps.ui）

交互页面适合工具结果里的表单、图表和连续操作：模型用 `ghost_call` 打开页面，用户在页面里
继续调用插件 main.js 的同一组工具。页面使用 MCP Apps 标准协议，不需要 Node、额外 MCP
服务或 `mcp.json`。`mcpApps` 是 **Cindy 自定义的包清单格式**，不是 MCP Apps 定义的包格式；
其中工具的 `ui` 元数据沿用标准 `_meta.ui`，便于移植已有页面。

### 先选显示方式

| 需求 | 选择 |
| --- | --- |
| 工具结果里有表单、图表、文件预览，用户要继续操作 | 本节交互页面 |
| 简单结果、几个固定按钮、触发 Agent 继续处理 | [旧 HTML 聊天卡 §4.5](plugin-chat-cards.md) |
| 要跨任务常驻的工作台 | [面板 §5](plugin-panels.md) 或 [主视图 §4.20](plugin-main-view.md) |
| 每个任务独立的侧栏界面 | [任务页 §4.22](plugin-task-view.md) |

页面只负责显示和交互，联网、凭证、文件和 Node 处理由 main.js 代办。不把 `cindy.*` 塞进 View，
不引入 `window` 全局宿主 API。

### 清单与标准字段对照

| 标准 / ChatGPT MCP Apps 写法 | Cindy 写法 |
| --- | --- |
| 工具 `tools/list` 的 `_meta.ui` | 原样放进 `mcpApps.ui.tools[工具名]`；原 `tools[]` 不变 |
| 工具 `_meta.ui.resourceUri` | 引用 `mcpApps.ui.resources[].uri`，由作者指定插件内唯一的 `ui://` URI |
| 资源 `resources/read` 的 `_meta.ui.csp` / `prefersBorder` | 放在对应资源条目的 `csp` / `prefersBorder` |
| 资源 HTML 与 `text/html;profile=mcp-app` | `file` 指向包内静态 HTML；Host 读取并设置标准 MIME，`file` 不进入 `_meta.ui` |
| 资源 `_meta.ui.domain` / `permissions` | 原样校验保留；本期不保证指定源或浏览器权限生效，必须探测能力 |
| 工具返回的 `_meta` / `structuredContent` | `_meta` 只交给页面；`structuredContent` 同时交给模型。联网响应摘要放 `_meta`，不要塞进模型上下文 |
| ChatGPT 专用 `window.openai`、`openai/*` 私有字段 | 不直接兼容；移成标准 App SDK/JSON-RPC，文件处理桥接 main.js |

`mcpApps` 的未知扩展原样保留、不授权。资源的四类 CSP origin：`connectDomains`、
`resourceDomains`、`frameDomains`、`baseUriDomains` 受 `network.hosts` 约束。
`file` 必须是安全的包内相对 HTML 路径，不能越界或用符号链接逃逸。
`resources[].uri` 不重复；`tools` 的键必须在原 `tools[]`，`resourceUri` 必须引用已声明资源。
工具可以只写 `visibility` 而不绑定资源。

`visibility` 只接受 `model` / `app`；有 ui 声明但省略时默认 `["model","app"]`。
不在 `mcpApps.ui.tools` 里的旧工具仍只给模型。`["app"]` 工具不出现在 `ghost_info` /
`ghost_list` 的模型清单，也不能经 `ghost_call` 调用；页面不能调 model-only 工具。

### 示例 A：不需要构建的完整插件

四种脚手架均可叠加 `withUi:true`，例如：

```json
{ "dir": "/你的工作目录/planner", "template": "plain", "id": "interactive-planner", "name": "交互计划示例", "withUi": true }
```

调用 `ghost_forge_scaffold` 后会生成本节页面和 open_planner / save_plan 工具，原模板工具保留。
该选项在开发构建也能推导 `0.1.122-beta` 下限；显式最低版本不得低于它。不加该选项时沿用原模板版本规则。

把下面三个文件按路径保存，直接用 `ghost_forge_pack` 打包。它只在本次运行的内存里暂存标题，
不写文件、不联网。可复制源码也在 [examples/interactive-pages/minimal](examples/interactive-pages/minimal/ghost.json)。

**ghost.json**

```json
{
  "schemaVersion": 3,
  "id": "interactive-planner",
  "name": "交互计划示例",
  "version": "1.0.0",
  "minCindyVersion": "0.1.122-beta",
  "entry": "main.js",
  "command": "interactive-planner",
  "whenToUse": "演示交互页面里的计划表单，打开页面并修改计划标题",
  "tools": [
    { "name": "open_planner", "description": "打开计划表单。返回标题和保存次数。", "parameters": { "type": "object", "properties": { "title": { "type": "string" } } } },
    { "name": "save_plan", "description": "在本次插件运行期间暂存标题，不写文件或发送网络请求。", "parameters": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] } }
  ],
  "mcpApps": {
    "ui": {
      "resources": [{ "uri": "ui://planner/v1", "file": "ui/page.html", "prefersBorder": true }],
      "tools": {
        "open_planner": { "resourceUri": "ui://planner/v1" },
        "save_plan": { "resourceUri": "ui://planner/v1", "visibility": ["app"] }
      }
    }
  }
}
```

**main.js**

```js
let savedPlans = 0;
function handleInteractivePage(msg) {
  if (msg.type !== 'tool-call' || !['open_planner', 'save_plan'].includes(msg.tool)) return false;
  const title = String(msg.args?.title ?? '我的计划');
  if (msg.tool === 'save_plan') savedPlans++;
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
    content: [{ type: 'text', text: `${title}（已暂存 ${savedPlans} 次）` }],
    structuredContent: { title, savedPlans },
    _meta: { note: '这里只在页面显示，不交给模型。' }
  } });
  return true;
}
cindy.onHostMessage(handleInteractivePage);
```

**ui/page.html**

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:var(--color-background-primary,Canvas);--fg:var(--color-text-primary,CanvasText);--muted:var(--color-text-secondary,GrayText);--panel:var(--color-background-secondary,color-mix(in srgb,CanvasText 5%,Canvas));--line:var(--color-border-primary,color-mix(in srgb,CanvasText 18%,Canvas));--radius:var(--border-radius-md,12px)}
*{box-sizing:border-box}body{margin:0;padding:24px;font:14px/1.5 var(--font-sans,system-ui);color:var(--fg);background:var(--bg);overflow-wrap:anywhere}main{max-width:640px;margin:auto;min-width:0}h1{font-size:24px;line-height:1.3;font-weight:550;margin:8px 0}p,label{color:var(--muted)}label{display:block;margin-top:24px}input,button{font:inherit;color:var(--fg);min-height:36px;padding:9px 12px;max-width:100%}input{width:100%;margin:8px 0 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px}button{border:0;border-radius:9999px;background:var(--panel);font-weight:550;cursor:pointer}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible{outline:2px solid var(--color-border-info,var(--fg));outline-offset:2px}#status{padding:12px;background:var(--panel);border-radius:var(--radius);white-space:pre-wrap}@media(max-width:600px){body{padding:16px}h1{font-size:22px}}
</style>
<!-- 能力全集：references/examples/interactive-pages/files/ui/page.html；按需复制，不需要的块可以删。 -->
<main><h1>交互计划</h1>
<p>在页面暂存计划，内容较多时可切换全屏。</p>
<label>计划标题<input id="title" value="我的计划"></label>
<button id="save" disabled>暂存计划</button>
<p id="status" role="status">正在连接…</p>
</main>
<script>
(() => {
  let nextId = 0;
  const pending = new Map();
  const post = message => parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const notify = (method, params = {}) => post({ method, params });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        notify('notifications/cancelled', { requestId: id, reason: '页面等待超时' });
        reject(new Error('等待超时，请核对操作结果，勿自动重试写入。'));
      }, 30 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params });
    });
  }
  const status = document.querySelector('#status');
  function theme(context) {
    if (context.theme) document.documentElement.style.colorScheme = context.theme;
    for (const [key, value] of Object.entries(context.styles?.variables ?? {}))
      document.documentElement.style.setProperty(key, value);
  }
  function render(result) {
    const data = result.structuredContent;
    if (data) document.querySelector('#title').value = data.title;
    status.textContent = (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  }
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (pending.has(message.id)) {
      const call = pending.get(message.id); pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
    } else if (message.method === 'ui/notifications/tool-result') render(message.params);
    else if (message.method === 'ui/notifications/host-context-changed') theme(message.params);
    else if (message.method === 'ui/notifications/tool-cancelled') status.textContent = '调用已取消';
    else if (message.method === 'ui/resource-teardown') post({ id: message.id, result: {} });
  });
  document.querySelector('#save').onclick = async () => {
    const button = document.querySelector('#save'); button.disabled = true;
    try { render(await request('tools/call', { name: 'save_plan', arguments: { title: document.querySelector('#title').value } })); }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: '计划示例', version: '1.0.0' }, appCapabilities: {} })
    .then(result => {
      theme(result.hostContext ?? {});
      notify('ui/notifications/initialized');
      document.querySelector('#save').disabled = false;
      new ResizeObserver(() => notify('ui/notifications/size-changed', { height: document.body.getBoundingClientRect().height }))
        .observe(document.body);
    }).catch(error => { status.textContent = error.message; });
})();
</script>
</html>
```

打开后收到标准 `ui/notifications/tool-result`，表单从 `structuredContent` 取值；按钮经
`tools/call` 调同一插件的 `save_plan`。main.js 返回的 `content` 给模型和页面，根 `_meta`
只给页面；不要把只供页面使用的大数据或说明混入模型文字。普通字符串或对象结果仍可用于文字工具。

### 示例 B：官方 SDK，构建成单个 HTML

复用 A 的 ghost.json / main.js。下面构建会生成同一个 `ui/page.html`，无 CDN 运行依赖。
完整目录：[SDK 示例](examples/interactive-pages/sdk/ghost.json)。在自己的插件源码目录执行：

```sh
pnpm add @modelcontextprotocol/ext-apps
pnpm add -D esbuild
node build.mjs
```

**ui/page.template.html**

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
body{margin:0;padding:16px;font:14px/1.5 var(--font-sans,system-ui);color:var(--color-text-primary);background:var(--color-background-primary)}
input,button{font:inherit;color:inherit;background:var(--color-background-secondary);border:1px solid var(--color-border-primary);border-radius:8px;padding:10px;min-height:44px;box-sizing:border-box;max-width:100%}
label{display:block}input{width:100%;margin:8px 0}button{cursor:pointer}p{overflow-wrap:anywhere}
</style>
<h1>交互计划</h1>
<label>计划标题<input id="title" value="我的计划"></label>
<button id="save" disabled>暂存计划</button>
<p id="status" role="status">正在连接…</p>
<!-- APP_SCRIPT -->
</html>
```

**ui/app.js**

```js
import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: '计划 SDK 示例', version: '1.0.0' }, {}, { autoResize: true });
const status = document.querySelector('#status');
function theme(context) {
  if (context.theme) document.documentElement.style.colorScheme = context.theme;
  for (const [key, value] of Object.entries(context.styles?.variables ?? {}))
    document.documentElement.style.setProperty(key, value);
}
function render(result) {
  if (result.structuredContent) document.querySelector('#title').value = result.structuredContent.title;
  status.textContent = (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
}
app.ontoolresult = render;
app.onhostcontextchanged = theme;
app.ontoolcancelled = () => { status.textContent = '调用已取消'; };
document.querySelector('#save').onclick = async () => {
  const button = document.querySelector('#save'); button.disabled = true;
  try {
    render(await app.callServerTool({ name: 'save_plan', arguments: { title: document.querySelector('#title').value } }, {
      timeout: 30 * 60 * 1000,
      maxTotalTimeout: 30 * 60 * 1000,
      onprogress: progress => { status.textContent = progress.message ?? `已处理 ${progress.progress}`; }
    }));
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
};
await app.connect();
theme(app.getHostContext() ?? {});
document.querySelector('#save').disabled = false;
```

**build.mjs**

```js
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const result = await build({ entryPoints: [fileURLToPath(new URL('ui/app.js', root))], bundle: true, write: false, format: 'esm', minify: true });
const template = await readFile(new URL('ui/page.template.html', root), 'utf8');
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(new URL('ui/page.html', root), template.replace('<!-- APP_SCRIPT -->', () => `<script type="module">${script}</script>`));
```

`esbuild` 把 SDK 与业务代码一起打入 HTML。单独的相对 JS 文件不由 View 自动供片。
不要直接引用外链 CDN：CSP 默认拒绝，只有资源 origin 在 `resourceDomains` 且主机在
`network.hosts` 中才允许；即使允许，也要考虑离线与供应链风险。通常应本地打包。

### 主题、尺寸、全屏与滚动

先用 `ui/initialize` 返回的 `hostContext`，再处理 `ui/notifications/host-context-changed`。
SDK 对应 `app.getHostContext()` / `app.onhostcontextchanged`。`theme` 是 light/dark；
把 `styles.variables` 应用到根元素，颜色用 `--color-background-primary`、
`--color-background-secondary`、`--color-text-primary`、`--color-text-secondary`、
`--color-border-primary`，不固定成白底黑字。示例 A/B 同时处理初始值和切主题事件。

用 SDK `autoResize` 或标准 `ui/notifications/size-changed` 上报真实内容高度。
内联高度为 80–5000 像素；超出或宿主锁高后在卡片内滚动。不要把 `100vh` 和 autoResize
一起用，也不要层层套固定高度滚动容器：宿主分配高度被当成新内容高度，会反复追涨。
连续增高受 5000 像素上限约束；短时间振荡会锁高，宽度变化后再测量。内容多时请求全屏：

```js
await app.requestDisplayMode({ mode: 'fullscreen' });
// 返回的 mode 才是实际模式；退出用 inline，重新读取 hostContext.containerDimensions。
```

离屏 View 会卸载，页面应按可重建的方式渲染结果；不要依靠页面长期驻留做后台工作。

### 调用、等待与进度

页面调用与 AI 调用同一工具时审批一致，由任务权限模式决定。页面调用本插件 app-visible
工具时，宿主复用 `ghost_call` 的工具风险分类；点击、页面加载和定时器触发都适用同一规则。
Ask 下普通插件工具交给用户确认，已被工具策略标记为自动放行的工具直接执行；
工具策略的自动放行例外继续生效；其他调用在 Auto 下进入统一审阅并注明“由插件交互页面发起”；
完全访问跳过工具审批。

需要确认时，插件页面和自定义 MCP 页面共用卡片头与输入框上方的审批浮层，指向同一个请求。
插件工具采用会话审批时，可选“本任务内总是允许”；逐次审批工具不提供此项。
此授权只适用于同任务、同服务、同工具的页面调用，与 AI 调用的授权独立；不持久化，
重启、配置变化、任务结束或清空后失效。自定义 MCP 页面的逐次确认或破坏性工具仍不提供此项。
完全访问也会处理正在等答复的页面审批。

审批通过后，宿主签发绑定任务、卡片文档、插件实例和批准版本的一次性票据；
票据只用于身份绑定，不代表额外授权，不要自己构造或保存票据。main.js 内部的联网/凭证、
工作目录写入、派活等能力继续执行各自检查，不能用页面审批抵消工作目录写入确认，
也不得伪造 Agent 附件或 `save_dir` 过户。
选文件、另存为是用户选择动作，不是审批；完全访问不代批安装和交互页面能力确认。

页面自己也有 RPC 超时。短请求用合理预算；等待系统选文件时 SDK 可以像 B 一样设
`timeout` / `maxTotalTimeout` 为 30 分钟，手写 RPC 要同步取消并提示，不自动重试写操作。
带 `callId` 的文件/目录 pick 在实际选择和导入期间续命，硬上限 30 分钟，不改变全局 330 秒。
本插件虚拟服务页面调用的等待预算与此一致；自定义 MCP 页面 60 秒限制尚未解决（#7748）。
调用取消不会物理关闭已经打开的系统面板；迟到选择被丢弃，不落盘、不签票。

main.js 使用已有进度消息：

```js
cindy.send({ type: 'tool-progress', callId: msg.callId, progress: 1, total: 10, message: '正在处理' });
```

省略数值仍是旧心跳。View `tools/call` 带 `_meta.progressToken` 才收到标准
`notifications/progress`；SDK `onprogress` 代办这一步。宿主至少 200ms 合并一次，进度只增不减，
结束/取消后不再转发。不能假定客户端收进度就一定延长超时。宿主导入/下载/读取组包有真实字节进度；
上传发送阶段只表示“正在上传”，不把已读字节冒充已发送字节，工具结果表示成功或失败。

### 文件从哪里来，怎么给页面

Library 落盘路径只接受安全 ASCII，每段最多 64、整条最多 256 个 JavaScript 字符，生成文件名须为目录和前缀预留长度；中文原名可另作显示名。

| 场景 | 页面 / main.js 分工 |
| --- | --- |
| 显示本插件文件 | main.js 返回标准 `resource_link`，View 读 `_meta["cindy/file"].url` |
| 系统选择图片/附件 | app-only 工具调 `cindy.pick({mode:'file',into:'media'或'library',...})`；页面看不到本机路径 |
| 拖入或粘贴 | View 分片调 app-only 工具，main.js 用 Library writeBegin/Chunk/Commit 或 deposit_media |
| 后端下载附件 | main.js `cindy.fetch({as:'library',path,...})` 流式写库，带 sha256 |
| 导出给用户 | 探测 `hostCapabilities.downloadFile`，标准草案 `ui/download-file`；或 main.js Library saveAs |
| 上传后端 | main.js `upload:{hashes}` / `upload:{library:[paths]}` / 一次性 `uploadDir:{token}` |
| 发图给 AI | View `ui/message` 发送本卡已授权的本插件媒体图片 resource_link |

```js
// main.js 的工具结果；不把绝对路径放进消息。
const result = { content: [{ type: 'resource_link', name: '报告', uri: 'library:exports/report.pdf', mimeType: 'application/pdf' }] };
// View 收到结果后：
const link = result.content.find(x => x.type === 'resource_link');
const readOnlyUrl = link?._meta?.['cindy/file']?.url;
```

URI 可为 `cindy-media://blobs/<hash>.<ext>` 或 `library:<库内相对路径>`。Host 只给本卡入参、
工具结果、用户在本卡选取/上传的本插件文件签发 URL；跨插件、越界路径或伪造指纹拒绝。
URL 位于本卡源下的 `/__cindy/files/<随机票据>`，只读、支持 Range，可供 img/media/fetch。
`ghost_call.attachments` 的图片引用在 `hostContext.toolInfo.tool._meta["cindy/attachments"]`。
View 销毁、停用、版本变更或文件删除后 URL 失效。媒体引用/Library 键可长期保存，pick deposit
票据一次性消费，二者不要混用。声明 Node 的插件可在 main.js 拿系统选择文件的 path，不能传给 View。

单条 View 消息上限 4 MiB；建议原始字节每片 ≤2 MiB，为 Base64/JSON 留空间。
Electron 沙箱中的 file input 已验证；拖放验证了 DOM 事件，未证明每个平台原生拖放都一致，
不可用时用系统选择框。普通 Library 单次 write ≤16 MiB；后台上传一期单件 64 MiB、总量 128 MiB，
超限返回 `TOO_LARGE` 和 `limitBytes`，更大文件需要流式上传，本期不做；uploadDir 沿用自己的限额。
完整参数见[选择文件 §4.14](plugin-directory-picker.md)、[网络 §4.7](plugin-network.md)、
[文件与作品库 §4.10](plugin-files-and-library.md)。

`ui/download-file` 接受 EmbeddedResource（text/blob，受消息大小限制）或已授权的本插件
ResourceLink。宿主弹系统另存为框、净化文件名；不代页面下载任意 URL。`ui/message` 的媒体
图片会进入真实消息附件链，保留“外部应用来源”，不成为主人授权；其它 resource_link 仍是文字
上下文，不支持向 `ui/update-model-context` 塞图。

### 网络和凭证：只在 main.js 发请求

联网和凭证都由 main.js 通过 `cindy.fetch` 发出，凭证由宿主注入，规则见 [§4.7](plugin-network.md)。

### 动态内容：推荐通用外壳，也可以用静态模板

**推荐：通用外壳。** AI 理解意图 → 模型工具 `open_view({ intent })` → 后端生成整页 HTML
→ 包内外壳渲染 → 后续操作用 `data-intent` 声明，由外壳调用 app-only 的
`load_view({ intent, fields })`。外壳本身仍是包内静态文件，不在运行时生成或改写供片文件；
变化的是工具结果里的 HTML。保持这份约定时，改界面只需改后端，不用重新发布插件。

`open_view` 返回一句 `content` 摘要和根 `_meta.view.html`。宿主把完整结果保存到交互卡片，
外壳在第一次 `ui/notifications/tool-result` 就直接渲染；模型侧剥掉根 `_meta`，只看到摘要，
不必让页面重复请求首屏。需要模型使用的业务数据另放 `structuredContent`。
下面省略握手、主题、尺寸上报和错误处理，完整版见
[shell/ui/page.html](examples/interactive-pages/shell/ui/page.html)；配套
[ghost.json](examples/interactive-pages/shell/ghost.json) 和
[main.js](examples/interactive-pages/shell/main.js) 默认模拟后端，不联网、不用凭证。

```js
// 外壳：render 会移除可执行标签、on* 属性和 javascript: 链接，见完整示例。
if (message.method === 'ui/notifications/tool-result') render(message.params);
// 后端 HTML 用 data-intent 声明操作，外壳委托给同一 app-only 工具。
const result = await request('tools/call', {
  name: 'load_view', arguments: { intent: action.dataset.intent, fields }
});
render(result); // 读取 result._meta.view.html，替换当前内容。
```

**也可以：包内模板负责排版。** 工具返回内容，模板按数据切换视图；适合界面固定、需要离线，
或者希望市场审核看到完整界面的场景。下方能力全集的「动态内容」卡片就是这种写法：
页面片段放根 `_meta`，业务数据放 `structuredContent`，不可信文字用 `textContent`。

**边界：**

- 页面不带凭证。页面 `fetch` / `<img>` 的 origin 要分别列在 CSP 的 `connectDomains` /
  `resourceDomains`，域名也须在 `network.hosts` 内；宿主不会为页面请求注入凭证。
  需要身份的请求走「页面 `tools/call` → app-only 工具 → main.js `cindy.fetch`」，
  域名与凭证声明按 [§4.7](plugin-network.md)，不要把令牌放进 HTML。
- 后端 HTML 当作插件自身代码，只接收可信来源，后端必须转义所有数据。示例外壳保留
  `<style>` 和内联 SVG，移除 `script / iframe / object / embed / base / meta / link`、
  `on*` 属性与 `javascript:` 链接，不执行后端脚本。这不是任意 HTML 的安全隔离器；
  CSS 和链接也会影响页面。`innerHTML` 插入的脚本默认不执行，但内联事件或主动创建的
  脚本可能执行，不能只靠这个特性处理不可信内容。
- 使用通用外壳时，市场审核只能看到外壳，不能据此审核运行时后端生成的全部界面。
- **表单怎么提交：** 外壳接管提交按钮 click、文本框 Enter，并保留 submit 监听；
  验证并收集字段 → `tools/call` 调用 app-only 工具 → main.js 用 `cindy.fetch` 发到
  声明过的域名，凭证由宿主注入。这是表单提交的正规方式。原生提交受 sandbox
  （无 `allow-forms`）和 CSP `form-action 'none'` 双重拦截，任何地址都提交不出去。
  页面自己 `fetch` 只能访问 `connectDomains` 内的地址，永远不带宿主凭证。
  从 basic-host 等允许原生表单的宿主移植时，必须改用上述桥接方式。
- 鉴权图片由 main.js 用 `cindy.fetch({ url, as: 'media', callId: msg.callId })` 取回，
  凭证照常注入。检查 `ok`、HTTP 状态及 `media` 后返回标准 `resource_link`
  （`uri: r.media.url`，`mimeType` 用实际类型）；页面以资源 `_meta['cindy/file'].url`
  设置 `img.src`，沿用本卡只读授权链，不绕道 data URI。

### 安装、升级和多端

声明 `mcpApps.ui` 的包要求 `minCindyVersion >= 0.1.122-beta`，beta.1 和稳定版均满足。
这是打包门槛和市场兼容投影，不是客户端安装闸门。旧 Host 保留未知顶层 `mcpApps`，只返回文字，
不识别 app-only visibility；不能依靠旧 Host 隐藏工具。升级后，缺 `uiCapabilityApproved` 的
普通插件仍可用原工具，只不读未批准页面，可从任务提示条或详情手动确认，无需重装。

历史已安装清单和市场已发布版本中的不合法 `mcpApps` 仅原样保留，不启用页面，也不提示确认页面能力；原有工具继续可用。新打包和本地新安装仍严格拒绝不合法声明。

普通安装列出页面资源、域名、页面可调用工具；新增资源/域名/开放工具需要确认。
单独改 URI 名称（同一 file）或只改 HTML 内容不扩权；同时改域名或工具范围仍重新确认。
服务端 `defaultInstall` 下发方是完全信任方：默认首装、组织接管、同源更新、仍具资格的恢复
随安装批准静默授予页面能力，不询问、不提示。旧版缺批准事实时按当前资格重新校验真实包补齐。
普通手动安装、自定义市场、本地包、Forge 或失去资格的插件不代批；审核和展示清单不等于授权。
停用、卸载、版本变更、换号、睡眠撤销页面；晚到的结果不再交付。

同账号手机/远程 Desktop 可以复用执行电脑的确认事务；访客不能确认。旧控制端的泛化安装确认
不授新页面权限；旧执行端没有能力标记时提示升级。同一执行电脑的“以后再说”跨查看端共享。
手机和远程本期不转发执行电脑本地文件。受影响卡片显示“文件内容请在执行电脑查看”，
普通标准页面仍可交互；没有 downloadFile 能力时明确拒绝，不要显示必定失败的导出按钮。

### 本地调试清单与常见错误

1. 在已核实版本的执行电脑用 `ghost_forge_pack({dir:源码绝对路径})`，修复结构、HTML 路径、域名和版本报错。
2. 用 `ghost_forge_install({dir:源码绝对路径})` 自测，按返回的 instance/namespace 精确寻址。
3. 在任务里说“请用交互计划示例打开标题为本周安排的计划表单”，模型经 ghost_call 调 open_planner。
4. 改标题、暂存，核对模型文字和 View 的 structuredContent；确认 app-only 工具不出现在模型清单。
5. 切 Light/Dark、窄宽度和全屏，检查主题、高度、滚动、离屏重建；等待文件选择时避免页面自身短超时。
6. 核对拒绝、取消、停用/更新、断链、旧端和手机文件降级，不在日志中打印凭证。

仓库验证：`node apps/desktop/scripts/plugin-ui.verify.mjs` 会打开官方 SDK、手写 JSON-RPC 与
本节 A/B 与能力全集示例，并经过生产 `packGhostDir` 校验。文件链由 `plugin-files.verify.mjs` 验证，
系统对话框替身只在独立测试进程，原生操作与 30 分钟实机停留需另行测试。

| 现象 / 码 | 排查 |
| --- | --- |
| `MCP_APP_TOOL_NOT_VISIBLE` | 工具未在本插件声明为 app，或调用了 model-only 工具 |
| `MCP_APP_RESOURCE_NOT_FOUND` | resourceUri 没有对应资源，检查作者 URI 与 resources 一致 |
| `MCP_APP_FILES_LOCAL_ONLY` | 手机/远程无法读取执行电脑文件，按占位提示处理 |
| `MCP_APP_SERVER_CHANGED` | 插件停用/更新/账号变化，旧卡已撤销，重新调用生成卡片 |
| `CANCELLED` | 页面卸载或用户取消；别自动重放写操作 |
| `TOO_LARGE` | 读取返回的 limitBytes，减小附件或分片 |
| CSP 拒绝资源 / 连接 | origin 未在对应 csp 数组或 host 未声明；不要关闭 CSP 绕过 |

### 可裁剪的能力全集（无构建）

复制 [files 目录](examples/interactive-pages/files/ghost.json) 的 ghost.json、main.js、settings.html、
settings.js 和 ui/page.html，即可用 ghost_forge_pack 打包。页面与最小脚手架共用宿主主题变量、
基础排版和圆角；四组按钮（含动态内容卡片）各有状态、耗时、可展开和复制的结果区，窄屏单列，宽屏两列。
每块都标了“不需要可以删”：删功能时也删对应工具、页面按钮与未使用的权限声明。

| 分组 | 可直接参考的能力 |
| --- | --- |
| 基础 | 动态内容（固定模板、HTML 片段与业务数据分离）、表单回写、全屏、主题变量、ui/message、update-model-context、model-only 拒绝、长任务进度 |
| 文件 | 系统选图/视频/附件、拖放粘贴分片、本卡只读预览、下载到 Library、saveAs、ui/download-file、处理后上传、发图给 AI |
| 宿主 | 工作目录写入确认、kv、非敏感设置、upload.hashes、uploadDir、经模型展示旧卡片 |
| 联网 | user 凭证请求、401 对照和返回结果展示；只显示状态码与前 2 KiB 响应，不显示请求头或令牌 |

动态内容卡片默认在 main.js 模拟后端，不联网、不需要配置凭证，安装后即可切换概览和明细。
需要接入真实后端时，将 `mockDynamicBackend` 换成 `cindy.fetch`，域名与凭证按 §4.7 声明。

使用联网卡片前，先将 `api.example.com` 换成自己的后端，并同时修改 main.js、
network.hosts 和 inject.hosts。user 来源的凭证按精确域名注入，页面不直接联网、不读取凭证。
示例不带本机测试服务、假凭证或故障切换开关。后端需提供：

- GET `/files/report`：返回非敏感业务 JSON；不得回显 Authorization、API key 或 cookie。
- GET `/files/unauthorized`：固定返回 401 和非敏感错误正文，供页面作失败对照（调试用，可删）。
- GET `/files/download`：附件正文；POST `/files/upload`：接收 multipart，仅返回安全的文件摘要。

main.js 将响应摘要放在 `_meta.showcase`，联网工具仅供 app 调用；不会自动交给模型。
通用正文仍需作者按业务做字段白名单，示例的 Bearer/JWT 遮盖不能代替后端不泄漏密钥。
只有用户明确点击发消息/发图时发送所选内容，更新上下文只发送表单标题。
401 的处理沿用 §4.7，示例不在工具层另实现重试。

调用 open_showcase 打开页面。首次联网前在插件详情配置自己的 user 凭证；settings.html 仅存显示名称。

文件上传单件 64 MiB、合计 128 MiB；拖放示例主动限制 16 MiB、每片 1 MiB，`writeChunk.seq` 从 1 开始递增，超过用系统选择框。
三个进度分别用于长任务、导入/下载实际字节、上传的读取/发送阶段；发送阶段没有虚构字节百分比。
本地验证只替换测试进程的系统对话框；真实文件选择和作者自己的后端仍需在执行电脑自测。
