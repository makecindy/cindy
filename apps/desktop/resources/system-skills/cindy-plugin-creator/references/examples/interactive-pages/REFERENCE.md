# 交互页面按需参考

从[§4.23 指南](../../plugin-interactive-pages.md)进入；完整代码以本目录示例为准。
这里列作者需要查询的参数、能力和失败处理，不要求在每个页面都实现。
交给生成页面的 LLM（后端里的模型或 Cindy 对话中的 AI）的规则只写在
《Cindy MCP Apps 页面生成手册》（[PAGE-GENERATION.md](PAGE-GENERATION.md)）；loader 用 `manual.items` 挂上同一份。

## 清单

| 字段 | 写法和约束 |
| --- | --- |
| mcpApps.ui.resources[].uri | 插件内唯一 ui:// URI |
| file | 包内相对 HTML 路径，不能越界或用符号链接逃逸 |
| prefersBorder | 可选，是否需要卡片边框 |
| csp.connectDomains | 页面自己连接的 origin；不会注入 Cindy 凭证 |
| csp.resourceDomains | 页面外部图片、脚本等资源的 origin |
| csp.frameDomains / baseUriDomains | 可嵌入 frame / base 的 origin |
| domain / permissions | 可选标准元数据；不能假定当前宿主一定提供对应浏览器能力 |
| tools[工具名].resourceUri | 引用已声明资源；工具也必须在 tools[] 中 |
| tools[工具名].visibility | model、app 或两者；有 UI 声明时省略代表两者 |

CSP 各 origin 必须符合 network.hosts。只经工具调用后端时，connectDomains 和
resourceDomains 都可为空。标准 SDK 由宿主提供，不必给 CDN 增加白名单。
mcpApps 是 Cindy 的清单写法；标准页面使用 App SDK，不使用 window.openai。

Cindy 为所有页面始终提供 SDK，不检测页面是否 import。包内页面首个文档自带 importmap 时
作者映射优先，用 null 禁止导入的映射同样保留；加载器换出的页面再写映射会被浏览器忽略。
新页面直接裸 import，不写 importmap。

## 等待、取消与页面生命周期

SDK 调用默认等待时间不足以覆盖所有用户确认。工具调用统一显式设置两个预算：

```js
const lifetime = new AbortController();
app.onteardown = async () => { lifetime.abort(); return {}; };
const result = await app.callServerTool({ name: 'api_read', arguments: { path: '/api/items' } }, {
  timeout: 30 * 60 * 1000,
  maxTotalTimeout: 30 * 60 * 1000,
  signal: lifetime.signal,
  onprogress: p => { status.textContent = p.message ?? '处理中…'; }
});
```

进度不是审批心跳，不保证不断到达。isError 表示工具返回失败；Promise 拒绝也要
处理，例如取消、超时和页面关闭。进度条在成功、失败、取消时都要结束。取消页面
等待并不证明写入已撤销，仍按请求编号查询结果。

需要工具自己报告进度时，在 main.js 发送：

```js
cindy.send({ type: 'tool-progress', callId: msg.callId,
  progress: 1, total: 3, message: '已处理第一部分' });
```

progress 保持递增；total 可省略。cindy.pick、上传、下载等文件操作已报告自身进度，
不必重复发。页面关闭时清理自己的计时器、订阅和事件；不依赖文档替换清除所有
JavaScript 状态。临时输入要由页面自行保存，卡片重开默认显示最初工具结果。

整页替换并重新连接后，旧请求会被取消，旧回复不会交给新页面。已被 Cindy 接收的
sendMessage 消息仍会继续发送；不要因旧页面未收到回执而重复发送。尚未接收的消息
可能因换页取消。工具调用取消也不代表写入已撤销，仍需按请求编号核对。

## SDK 方法

| 方法 | 用途及注意 |
| --- | --- |
| callServerTool | 调页面可见的本插件工具；检查 isError 和 Promise 拒绝 |
| getHostContext / onhostcontextchanged | 初始主题、样式、尺寸约束及后续变化；回调中重新读取完整 context |
| getHostCapabilities | 调可选能力前检查，尤其 downloadFile |
| sendMessage | 向对话发送用户可见内容；只由明确点击触发，不用来隐藏执行写操作 |
| updateModelContext | 提交需要 AI 了解的精简上下文，不触发完整页面重新生成 |
| openLink | 打开外部链接，只在响应用户点击时调用；是否另外提示由宿主决定；不当宿主鉴权接口 |
| requestDisplayMode | 请求 inline / fullscreen，使用返回的实际模式 |
| downloadFile | 保存本卡文件或嵌入资源；先检查能力，用户取消即停止 |
| createSamplingMessage | 当前不支持，返回 Method not found；不要用它代替 Cindy 的模型能力 |

几个独立调用例子（均需先 await app.connect）：

```js
await app.sendMessage({ role: 'user', content: [{ type: 'text', text: '请解释所选记录。' }] });
await app.updateModelContext({ structuredContent: { selectedIds: ['record-1'] } });
await app.openLink({ url: 'https://example.com/help' });
await app.requestDisplayMode({ mode: 'fullscreen' });
const context = app.getHostContext();
app.onhostcontextchanged = () => applyTheme(app.getHostContext() ?? {});
```

sendMessage 可带本卡已授权图片的 resource_link；不能拿任意网址冒充本卡附件。
updateModelContext 会将数据交给 AI，不要把页面私有内容整包提交。完整按钮处理、
能力不可用时的提示和下载参数见 [files/ui/page.html](files/ui/page.html)。

## 文件

工具在 content 返回 `{type:'resource_link',uri,name,mimeType?}`。Library URI 如
`library:exports/result.pdf`，媒体 URI 如 `cindy-media://blobs/<hash>.<ext>`。页面
读取该内容块的 `_meta['cindy/file'].url` 用于预览或读取，不拼 URL，不暴露本机路径。
URL 是临时的；持久保存 ref、媒体指纹或 Library 相对路径。

```js
const link = result.content.find(item => item.type === 'resource_link');
const file = link?._meta?.['cindy/file'];
if (file?.url && file.mimeType?.startsWith('image/')) {
  const image = document.createElement('img');
  image.src = file.url; image.alt = link.name;
  document.querySelector('#preview').replaceChildren(image);
}
```

对话交来的媒体附件（`ghost_call.attachments`）由宿主放进 hostContext，每项同样是
resource_link，按上面的方式读 `_meta['cindy/file'].url`，换页重连后仍可读取。表格类
附件要由声明了 `cindy_handoff_files` 的工具接收（示例的 import_file，0.1.123-beta 起，见
[§4.10.3](../../plugin-files-and-library.md)）：`uri` 以 `handoff:` 开头，首屏只显示名称和大小，
点按钮再把引用交给 upload_files；没有 `url` 表示已失效。没声明时插件经 dir 暂存，再把批次号
和预览写进首屏 HTML。

```js
const attachments = app.getHostContext()?.toolInfo?.tool?._meta?.['cindy/attachments'] ?? [];
```

| 入口 | 限制和选择建议 |
| --- | --- |
| pick into:media | 图片、音视频、glb；单件 50 MiB，插件寄存总额 1 GiB |
| pick into:library | 通用文件；单件 8 GiB，仍受磁盘可用空间约束 |
| pick 多选 | 最多 32 个；失败可能附上已成功文件，保留它们并提示未完成项 |
| upload.library / upload.hashes / upload.handoff | 三选一；最多 4 个，单件 64 MiB，总量 128 MiB |
| uploadDir | 一次性交接，10 分钟；单件 50 MiB，总量 500 MiB，最多 500 文件 |
| as:library | 边下载边写入；成功后才提供完整文件，单件 8 GiB |
| 页面拖放或 file input | 按不超过 2 MiB 原始字节分片，main.js 用 Library 写入；大文件优先 pick |

页面消息包含 JSON 后不得超过 4 MiB，卡片持久结果应保持在 1 MiB 内；不要把 SDK
或大文件字节重复塞进 HTML。远程传输还有额外开销，文件用引用传递。嵌入式下载
也受消息大小限制；一次下载最多 16 个文件，每个都由用户选择保存位置。

文件选择在取消时返回 CANCELLED，系统对话框尚未关闭时可能返回 BUSY；不要
自动反复弹窗。把工具调用的 callId 带给 pick/fetch。手机或远程端不能假定支持
执行电脑的文件选择、导出和本地文件预览；失败时提示回执行电脑，不回退读取别处文件。

PDF、CSV、XLSX 等附件不是图片。可以由后端解析并返回文本或表格预览；不要
把未知文件内容直接当 HTML。需要鉴权的图片由 main.js 用 as:media 获取，再返回
resource_link，不能让页面直接请求接口或把令牌拼进图片 URL。

## 常见错误

| 现象 | 先检查 |
| --- | --- |
| 标准 import 无法解析 | 执行端及查看端是否为 0.1.122-beta 或更新；远程打开时页面加 SDK 是否超出体积限制；不要改用任意 CDN 绕过 |
| 页面自带 importmap 或从 CDN 加载 SDK，被拦截或加载失败 | 删掉自带映射和外部 SDK 加载，直接写 `import { App } from '@modelcontextprotocol/ext-apps'`，SDK 由 Cindy 提供 |
| 远程打开报 MCP_APP_RESOURCE_TOO_LARGE | 页面本身超出体积限制；页面合格但加上 SDK 才超时会不带 SDK 打开，裸 import 失败。缩小 HTML，通过工具按需读数据，不要改用 CDN |
| 页面一直等初始结果 | 是否在加载器之后再次等待 ontoolresult；数据应已在首屏 HTML 中 |
| MCP_APP_TOOL_NOT_VISIBLE | 工具是否在清单中对 app 可见，名字是否一致 |
| fetch ok:true 但业务失败 | 检查 HTTP status，非 2xx 不当成功 |
| HTTP 401 | 凭证配置和后端的校验规则；写操作不要自动重发 |
| CSP 拦截 | 是否误用页面 fetch；确需外部资源才精确声明 origin |
| 表单没有效果 | 检查是否忘了 preventDefault()、是否依赖原生 action；应在 submit 中调用工具 |
| 文件读取失败 | 使用本次结果提供的 URL，文件是否仍存在，是否在执行电脑查看 |
| 超时或取消 | 收起等待，核对写入结果后才重试，沿用请求编号 |
| 页面关闭再开丢失输入 | 默认从最初结果恢复；需要恢复编辑状态时自行保存并读取 |
