# 插件详细介绍 `manifest.readme`（2026-11-06，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`ghost.json` 新增可选 `readme`：语言到包内 `.md` 文件的映射，必须提供 `en`，规则正本在
`packages/plugin-protocol/src/readme.ts`，Desktop 镜像同步校验，作者契约见 `FORGE_GUIDE` §2「详细介绍」。
旧客户端把它当未知顶层字段保留（v3）或忽略（v2），只显示 `description`；它**不能**放进 locale
JSON（旧客户端会拒收未知 locale 字段），因此各语言是独立文件。内容只供界面显示，不进入花名册、
`ghost_list` / `ghost_info` 或市场搜索结果。图片只认包内文件，经 `resolveGhostReadmeAssetPath`
解析出的规范路径作键，宿主读成 data URL（单张 ≤ 512 KB、最多 8 张、合计 ≤ 3 MB）；外部、`data:`
与越界地址不显示，渲染进程 CSP 允许远程图片，所以白名单在 `MarkdownRenderer.resolveImageSrc`。

- 已安装插件：新增本机 IPC `ghosts:readme`（不进 device-link 白名单），打开详情页时按需从安装目录
  逐段拒链接、限量读取，不随 `ghosts:list` 广播。远程设备的插件详情暂不显示介绍。
- 自定义市场：`plugin-market:detail` 在详情页请求时于发现租约内读取源副本，填 `PluginMarketDetail.readme`。
- 官方市场：详情请求带 `?readmeLocale=<语言>`，服务端可在 `VisiblePluginDetail.readme` 返回
  `{ path, markdown, images:[{ path, url, mimeType, sha256, sizeBytes, expiresAt }] }`（图片为短期地址）。
  旧服务端忽略参数、不返回字段，客户端不显示介绍；字段不合法时客户端整体丢弃，不影响详情。
  Plugin Server 尚未实现，需在服务端仓同步发布时提取与签发。
- 手机：`plugin-capabilities.data` 仅在声明 `readme` 时追加 `readme: true`，不内联正文或图片。手机打开
  「介绍」时经既有插件集合 invoke 调用 `readme:get`，以 `client.locale` 选语言；Host 返回
  `{ path, markdown, images }`（包内 data URL）或 `null`，未声明时返回 NOT_FOUND。回复按 device-link
  单条消息上限（4 MiB）预留余量控制在 2Mi 字符内，超出的图片按正文顺序丢弃、正文保留。手机只渲染
  Host 返回的 `data:image/` 图片。旧手机忽略新字段；新手机遇到旧 Host 没有该标记，不显示入口。
  不新增 channel、allowlist、relay 帧或协议版本，服务端与 Mobile 原生指纹不变。
