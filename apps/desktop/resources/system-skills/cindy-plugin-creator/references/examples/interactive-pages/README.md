# 交互页面示例

先读[编写指南 §4.23](../../plugin-interactive-pages.md)，需要字段或方法时查[参考](REFERENCE.md)。
这些都是作者源码，不会自动安装或发布。使用标准 SDK 导入，不需要构建 SDK。
示例最低 Cindy 版本为 **0.1.122-beta**（loader 用到对话文件交接，为 **0.1.123-beta**），执行端和查看端都需要支持此版本能力。
`ghost_forge_scaffold` 的 `withUi: true` 采用 static 示例；省略最低版本时默认为上述要求，
声明更低版本会被拒绝，更高版本会保留。四种基础模板的原工具照常可用。

| 目录 | 用途 |
| --- | --- |
| `loader/` | 后端或 Cindy AI 生成完整页面；页面脚本查询 JSON、保存记录、切换内容 |
| `static/` | 包内静态表单，打开后编辑并保存 |
| `files/` | 按需裁剪的文件、进度、导出、消息及显示能力示例 |
| `PAGE-GENERATION.md` | 《Cindy MCP Apps 页面生成手册》，交给生成页面的 LLM；loader 的 `manual/pages/MANUAL.md` 与它逐字节一致 |

每个目录的 ghost.json、main.js、ui/page.html 构成独立插件。files 另有 settings.html
和 settings.js，用来配置自己的后端凭证；其中网络和文件操作不是默认自动执行的。
loader 中的模拟后端是 main.js 的 mockBackend、fullPage 和 viewFragment；它们不联网，
不需要 Node 或凭证。pageClient 是模拟后端返回的页面脚本，迁往真实后端时一起迁移。

## 跑起来

1. 复制一个目录到自己的源码区，确认运行的 Cindy 支持本章能力。
2. 调用 `ghost_forge_pack({dir})` 生成包。取得安装指示后再调 `ghost_forge_install({dir})`。
3. 使用 loader 时说“打开记录页面”；AI 调用 open_view，未知意图按总览打开。
4. 查询列表后填写标题，点保存；再切换 Form、Chart。查询不改变输入，保存只更新结果。
5. static 也由 open_view 打开，完整逻辑只有一个表单和 save_record。

浅色、深色由 Host Context 提供；不要另存一份主题。示例文字是中文教材内容，正式
插件应按[清单本地化](../../plugin-manifest.md)及宿主语言制作自己的多语言文案。

## 接自己的后端

loader 默认 `USE_MOCK = true`。接入时改为 false，并一起替换 main.js 的 BASE 和
ghost.json 的 network.hosts。凭证声明按[§4.7](../../plugin-network.md)添加。
页面不接触令牌，后端按用户身份检查每次查询和写入。

intent 是用户意图的简短自然语言描述。模拟后端只识别 items、form、chart、overview；
其余回退到 overview，并提示“已按总览打开”。真实后端可用 LLM 理解自然语言意图。

| 工具 | 后端请求 | 返回 |
| --- | --- | --- |
| open_view | POST /view，`{intent,fields,fragment:false}` | `{html}`，完整 HTML 和 module script |
| show_page | 不请求后端，使用 AI 传来的 title/html | 一句话摘要和根 `_meta.view.html` |
| load_view | POST /view，`{intent,fields,fragment:true}` | `{html}`，无脚本的容器内容 |
| api_read | GET /api/items 或 /api/records，query 编码为查询串 | JSON，示例 `{items:[{id,name}]}` |
| api_write | POST /api/records 或 /api/imports/confirm | JSON，示例 `{id,title}` 或 `{batchId,status}` |
| pick_files | cindy.pick，into:library | `{files:[{name,ref,size}]}` |
| upload_files | POST /api/imports/stage；`handoff:` 引用走 upload.handoff，`library:` 引用走 upload.library；离线不上传 | `{batchId,total,rows,errors}` |
| fetch_file | GET /api/files/...，as:library；离线把当前记录写成 CSV | resource_link |
| import_file | 声明 `cindy_handoff_files`：收到交接引用时 POST /view，`{intent:'files',fields:{files:[{ref,name,mimeType,size}]}}`；否则 POST /api/imports/stage，uploadDir；离线不读取文件 | 交接：文件页（名称、大小、带 `data-file-ref` 的按钮）；dir：完整预览页（总行数、出错的行、确认 / 取消） |

api_write 的 JSON 请求体是 `{body,idempotencyKey}`，后端应验证 body 的字段。按
“当前用户 + 请求编号”建立唯一键，重复请求返回第一次的结果；同编号不同内容应拒绝。
示例的内存 Map 仅用于演示，重启不保留。写操作不自动重试。

path 不是任意网址：main.js 先限制相对路径格式，再按工具校验前缀。`../`、完整网址、
编码字符和查询串都不能改写请求目标；查询条件只用 query 传入。部署时进一步缩小
允许的前缀，不需要的工具和能力直接删掉。

后端模板中的所有动态数据都必须转义。整页 HTML 是可信应用代码，不是任意外部
文字。LLM 生成页面也要按插件提供的能力编写，不能把用户文档当可信脚本执行。

## 文件导入

### 从对话交接文件（cindy_handoff_files）

import_file 在参数表里声明保留参数 `cindy_handoff_files`，工具说明写「用户在对话里发的
文件，用 ghost_call 的 attachments 交给本工具」。AI 这样调用：

```js
ghost_call({ ghost_id: 'interactive-loader', tool: 'import_file', args: {},
  attachments: ['<用户在对话里发的文件>'] });
```

Cindy 存一份副本，main.js 只在 `args.cindy_handoff_files` 收到
`[{ref:'handoff:<uuid>',name,mimeType,size,…}]`，不读取文件内容，只把 ref、name、mimeType、
size 交给后端生成文件页：首屏只显示名称和大小，按钮写 `data-file-ref`。用户点击后页面调用
`upload_files({files:[ref], path:'/api/imports/stage'})`，main.js 用 `upload: { handoff: [ref] }`
上传，页面在容器里显示返回的预览，再由 api_write 确认。文件失效（7 天未用或已删除）时上传返回
HANDOFF_UNAVAILABLE，提示用户重新发送。限额和有效期见 [§4.10.3](../../plugin-files-and-library.md)。
离线示例只显示名称和大小并标明「离线示例」，点击后返回标明离线的示例批次。

### 没有交接时：dir 交接单文件

插件没声明交接，或 Cindy 早于 0.1.123-beta 时，AI 从用户附件取得执行电脑上的单文件路径，调用：

```js
ghost_call({
  ghost_id: 'interactive-loader', tool: 'import_file', args: {},
  dir: '<用户交接的单文件绝对路径>'
});
```

main.js 会在这次调用的 args.dir_deposit 中收到交接信息，立即上传到后端暂存接口：

```js
const response = await cindy.fetch({
  url: BASE + '/api/imports/stage', method: 'POST',
  uploadDir: { token: msg.args.dir_deposit.token, fileField: 'file' },
  callId: msg.callId
});
```

检查 ok、status 和 truncated 后解析 `{batchId,total,rows,errors}`，转义后生成预览：总行数、前几行、出错的行和确认 / 取消。
页面只拿批次号，用户点击“确认导入”，通过 api_write 提交 `/api/imports/confirm`。
后端按当前用户核对批次归属、状态和有效期，再执行一次。CSV 可以返回前几行；
XLSX 等格式由后端解析，不能直接当 HTML 预览。

交接有效期 10 分钟、只能使用一次；单文件上限 50 MiB。失败后不要复用旧交接信息，
需要重新交接。不要把 token 放进页面，或留到下一次工具调用才上传。工作目录外的
文件可能需要用户确认。离线模式只返回标明「离线示例」的模拟预览，真实文件上传必须接入后端后验证。

### 从页面选择文件

页面先调用 pick_files，main.js 用 cindy.pick 写入 Library，再把返回的 ref 传给
upload_files。工具检查它确实来自本次插件运行期间的选择，再用 upload.library
传给同一个暂存接口。此路径不是 uploadDir，不使用一次性交接信息。拿到 batchId 后
同样由 api_write 确认。文件字节不经过页面。

本地文件操作在手机和远程查看端可能不可用，应提示回执行电脑操作，不伪装成功。
详细限额见[参考](REFERENCE.md#文件)。
