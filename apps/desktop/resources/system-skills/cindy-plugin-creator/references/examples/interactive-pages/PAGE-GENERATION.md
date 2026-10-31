# Cindy MCP Apps 页面生成手册

给生成页面的模型（对话 AI 或业务后端的模型）和开发者。页面在 Cindy 里叫「交互页面」，即 Cindy 作宿主的标准 MCP Apps 页面。需要 Cindy **0.1.122-beta** 及以上（执行端和查看端）。

## 1. 你要输出什么

- 一个**完整 HTML 文档**（`<!doctype html>` 开头），显示在对话卡片里。
- 用官方 SDK：`import { App } from '@modelcontextprotocol/ext-apps'`。Cindy 为所有页面提供 SDK。**不写 importmap，不从 CDN 或其他地址加载 SDK。**（加载器换出的页面再写映射会被浏览器忽略。）
- 每个页面只建一个 `App`，先 `connect()` 再调其他方法。
- **首屏数据直接写进 HTML**，不要等 `ontoolresult`。
- 动态值一律转义；接口数据用 `textContent` / `value` / 创建元素显示，不拼进 `innerHTML`、`<script>` 或 `onclick`。
- 页面只调用所属插件提供的工具。工具背后是插件自己的存储还是业务后端由插件决定，**后端可选**；不要在页面里写后端地址。

## 2. 最小模板

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>:root{color-scheme:light dark}</style>
</head>
<body>
  <main id="content"><!-- 首屏数据直接写在这里 --></main>
  <form id="form"><input name="title" required><button>保存</button></form>
  <p id="status" role="status">正在连接…</p>
  <script type="module">
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({ name: '页面', version: '1.0.0' }, {}, { autoResize: true });
    const lifetime = new AbortController();
    const LONG = { timeout: 30 * 60 * 1000, maxTotalTimeout: 30 * 60 * 1000, signal: lifetime.signal };
    const status = document.querySelector('#status'), form = document.querySelector('#form');
    async function call(name, args) {
      const result = await app.callServerTool({ name, arguments: args }, LONG);
      if (result.isError) throw new Error(result.content?.find(x => x.type === 'text')?.text || '操作未完成');
      return result;
    }
    let request;
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      if (button.disabled || !form.reportValidity()) return;
      const body = Object.fromEntries(new FormData(form));
      const fingerprint = JSON.stringify(body);
      if (!request || request.fingerprint !== fingerprint) request = { fingerprint, idempotencyKey: crypto.randomUUID() };
      button.disabled = true; status.textContent = '正在保存…';
      try {
        const result = await call('api_write', { path: '/api/records', body, idempotencyKey: request.idempotencyKey });
        status.textContent = '已保存 ' + result.structuredContent.id;
        request = undefined;
      } catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    };
    const theme = c => { if (c.theme) document.documentElement.style.colorScheme = c.theme; };
    app.onhostcontextchanged = () => theme(app.getHostContext() ?? {});
    app.onteardown = async () => { lifetime.abort(); return {}; };
    try { await app.connect(); theme(app.getHostContext() ?? {}); status.textContent = ''; }
    catch { status.textContent = '无法连接，请确认 Cindy 版本后重新打开。'; }
  </script>
</body>
</html>
```

## 3. SDK 方法

| 方法 | 说明 |
| --- | --- |
| `callServerTool({name, arguments}, {timeout, maxTotalTimeout, signal})` | 调插件工具。两个超时都设 `30 * 60 * 1000`（默认只等 60 秒，审批可能更久）。`isError` 为业务失败；拒绝、超时、取消会抛异常，两种都要处理 |
| `sendMessage({role:'user', content})` | 以用户身份发消息回对话，AI 接着处理。只在用户明确点击时调用；可带本卡已有图片的 `resource_link` |
| `updateModelContext({content} 或 {structuredContent})` | 更新给 AI 的上下文，只放精简信息 |
| `openLink({url})` | 用浏览器打开链接。只在响应用户点击时调用；是否另外提示由宿主决定 |
| `downloadFile({contents})` | 弹「另存为」。只在执行电脑可用，先查 `getHostCapabilities()?.downloadFile` |
| `requestDisplayMode({mode:'fullscreen'})` | 请求全屏，以返回的实际模式为准；目前只有桌面端支持 |
| `getHostContext()` / `onhostcontextchanged` | 读 `theme`、`styles.variables`，跟随深浅色 |
| `createSamplingMessage` | 不支持。需要 AI 时用 `sendMessage` 交回对话 |

结果字段：`content` 给 AI 和用户看的摘要与文件引用；`structuredContent` 是 JSON，**AI 也看得到**；根 `_meta` 只给页面。

## 4. 标准工具

| 工具 | 谁调用 | 参数 → 返回 | 用途 |
| --- | --- | --- | --- |
| `open_view` | AI | `{intent}` → `_meta.view.html` 完整文档 | 按意图打开页面 |
| `show_page` | AI | `{title, html}` → 同上 | 对话 AI 自己写页面并显示 |
| `import_file` | AI | 对话交来的文件 → 完整页面 | 导入用户交来的文件 |
| `load_view` | 页面 | `{intent, fields?}` → `_meta.view.html` **容器片段**，无 html/head/body 和脚本 | 换页面里的一块内容 |
| `api_read` | 页面 | `{path, query?}` → `structuredContent` | 读数据 |
| `api_write` | 页面 | `{path, body, idempotencyKey}` → `structuredContent` | 写数据，单独审批 |
| `pick_files` | 页面 | `{accept?, multiple?}`（如 `accept:['.csv']`）→ `structuredContent.files` `[{name, ref, size}]`；取消或失败为 `isError` | 系统文件选择框 |
| `upload_files` | 页面 | `{files:[ref], path, fields?}` → `structuredContent` | 把文件引用交给插件保存或上传 |
| `fetch_file` | 页面 | `{path, name}` → `content` 里的 `resource_link` | 取回文件用于显示或导出 |

- `path` 是插件允许前缀内的相对路径（如 `/api/items`）；不能写完整网址、`../` 或编码字符，查询条件放 `query`。
- 每次调用都可能触发审批：按钮显示「处理中」并能等待。

## 5. 规则

- **凭证**：页面拿不到凭证：需要用户身份的请求走工具，由插件代发、Cindy 注入。页面直接 `fetch` 只能访问插件声明的 `connectDomains`，不带凭证，对方需返回 `Access-Control-Allow-Origin: *`；外部图片、样式要在 `resourceDomains` 声明。
- **局部更新**：换内容用 `load_view` 片段 + 容器 `innerHTML`（只接可信、已转义的片段），或用 `api_read` 拿 JSON 后改 DOM。片段里的脚本不执行，事件用常驻脚本绑定。不重连，输入和状态保留。
- **整页替换的边界**：整份文档只在加载器首屏，以及 AI 调用的整页工具（`open_view`、`import_file`、`show_page`）打开新卡片时替换。页面调用的工具都不返回完整文档；**不要把 `load_view` 片段 `document.write` 进页面**。整页替换后新文档重连，旧请求和审批作废、迟到回复丢弃，已被 Cindy 接收的 `sendMessage` 照常发送。
- **表单**：用 `<form>`，在 `submit` 里先 `preventDefault()` 再调工具；点按钮和回车都会触发 submit。原生 `action` 提交不可用；宿主会兜底拦下没处理的提交和 `form.submit()`（`method="dialog"` 保留原生关闭），但仍必须写 `preventDefault()`。等待时禁用按钮，失败保留输入。
- **写操作**：带 `idempotencyKey`。同一内容重试沿用原编号，内容变了换新编号；写入方按「当前用户 + 编号」去重，同编号不同内容应拒绝。**不自动重试**：超时不等于没写入，取消等待也不等于已撤销，按编号核对。
- **生命周期**：用 `AbortController` 取消等待，`onteardown` 里停止更新 DOM。卡片离屏可能被卸载，重开回到最初的结果；要保留的状态通过工具存取。
- **文件**：页面拿不到本机路径，只能读取本卡已授权文件的只读地址。显示用 `resource_link` 的 `_meta['cindy/file'].url`（临时、仅本卡有效，不自己拼、不持久保存）；需要身份的图片先 `fetch_file`。`upload_files` 一次最多 4 个，单个 64 MiB、合计 128 MiB。拖放不推荐，用 `pick_files`。手机和远程查看时文件选择、导出可能不可用，提示回执行电脑操作。
- **从对话交来的文件**：在 hostContext 的 `cindy/attachments`（见下例），每项是 `resource_link`（`name`、`uri`、`size`，地址同上）。媒体直接显示；`uri` 以 `handoff:` 开头的是交接的 CSV、XLSX（需要 0.1.123-beta 及以上）：首屏只显示名称和大小，不读不解析；生成页面时把引用写进按钮（如 `data-file-ref`），点击时用插件自己的参数名交给工具（如 `files`），不用 `cindy_handoff_files`。要预览才读 `url`；没有 `url` 是文件已失效（7 天未用或已删除），提示重新发送。未声明交接时表格走 `dir`（一次性、10 分钟、单个 50 MiB）：插件立即暂存，批次号和预览写进首屏。

  ```js
  const links = app.getHostContext()?.toolInfo?.tool?._meta?.['cindy/attachments'] ?? [];
  for (const link of links) {
    const file = link._meta?.['cindy/file'];
    if (file?.mimeType?.startsWith('image/')) document.querySelector('#attachments')
      .append(Object.assign(document.createElement('img'), { src: file.url, alt: link.name }));
  }
  ```
- **导入（CSV / XLSX）**：显示文件 → 用户点按钮上传，暂存后返回批次和预览（总行数、前几行、出错的行、「确认导入」「取消」）→ 确认后 `api_write({path:'/api/imports/confirm', body:{batchId}, idempotencyKey})`。解析和校验在工具背后，预览和导入用同一套规则。交接的和 `pick_files` 选的文件都交给 `upload_files`；预览渲染进容器，不换文档。
- **大小**：页面与 Cindy 单条消息 ≤ 4 MiB，卡片保存的结果尽量 ≤ 1 MiB。远程和手机打开时 SDK（约 337 KB，gzip 约 78 KB）随页面传输，页面上限约 3.94 MB，加上 SDK 才超限时不带 SDK 打开，`import` 失败。插件可能对 `html` 长度另有限制（如示例 show_page 限 200,000 字符）。首屏只放必要数据，其余按需读取。
- **不能做**：弹新窗口或让整个窗口跳转。用户文档里的内容不能当脚本执行。

## 6. 常见错误

| 现象 | 怎么改 |
| --- | --- |
| `import` SDK 失败 | 确认执行端和查看端 ≥ 0.1.122-beta；远程打开时缩小页面。不要改用 CDN |
| 页面一直显示加载中 | 别等 `ontoolresult`，首屏数据写进 HTML |
| 直接请求返回 401、被拦截或跨域报错 | 见「凭证」：需要身份走 `api_read` / `api_write`，否则声明域名、对方开 CORS |
| 换内容后页面空白、按钮失灵 | 把片段 `document.write` 进了整个文档；改用 `innerHTML` 替换容器 |
