# 自定义供应商的视频接口（xAI / MiniMax / 中转站 /v1/videos 兼容）

自定义 API、CPA/Sub2API 等 HTTP 中转只要提供同一视频协议，就共用 Core
已有的异步调用、持久化、轮询、下载和媒体入库流程。连接产品名、CLI 如何登录
不参与协议判断。内置网关与 SuperGrok 的既有路径保留。

## 配置

1. 在供应商的连接设置中，选中持有视频 API 地址和 Key 的连接，勾选
   对应的 xAI、MiniMax 或 `/v1/videos` 视频接口。同一个供应商只保留一个明确的视频连接和协议，
   不改变图片连接或其他引擎的对话地址、模型、凭证。
2. 模型清单缺少视频成员时，手动添加接口实际支持的模型 ID。在模型详情中选择
   「文字生成视频」或「文字生成视频和图片转视频」。只有声明图片输入的模型
   才进入 Art 的 Image-to-video 下拉。「跟随模型目录」删除用户类型与模态覆盖。
3. 重新打开 Art 详情，为 Video generation、Image-to-video 选择该来源的模型。

连接地址接受 origin、`/v1` 或路径前缀，如 `https://relay.example/proxy/v1`；
没有 `/v1` 时追加，前缀保留。模型 ID 原样发送，不剥离或猜测厂商前缀。

## 协议与能力边界

| 阶段 | 接口 | 响应 |
| --- | --- | --- |
| 生成/图生视频 | `POST /videos/generations`，JSON | `request_id` |
| 查询原任务 | `GET /videos/{request_id}` | `status`，完成为 `done`，失败为 `failed`/`expired` |
| 成品 | `video.url` | 公开 URL 走隔离下载；固定任务内容引用走原 API，分块读取 MP4、识别 MIME 并入仓 |

必填 `prompt`；图生视频再提供一张 `image: {url}`，支持 Cindy 受管图片引用。
当前适配保守开放 1–15 秒、480p/720p/1080p 和协议支持的画幅。
可选参数不传则跟随上游默认；图生视频不默认写入 16:9，避免改变原图画幅。
显式 fps、音轨开关、尾帧、多参考图和其他字段会在付费提交前拒绝，不静默丢弃。
这些范围是本版适配边界，不代表所有同协议模型都具有相同能力。

依据：[xAI 视频生成](https://docs.x.ai/developers/model-capabilities/video/generation)、
[图片转视频](https://docs.x.ai/developers/model-capabilities/video/image-to-video)。
OpenAI 官方 Sora Videos API 已于 2026-09-24 停止服务，本次不新增其适配器；
见 [官方历史说明](https://developers.openai.com/api/docs/guides/video-generation)。
仍提供 `/v1/videos` 任务格式的中转见下文；Gemini/Veo 原生协议和其他私有接口尚未适配。

## MiniMax 兼容视频接口

连接设置里的「使用 MiniMax 兼容视频接口」与 xAI 选项互斥，同一连接只选一种协议
（`videoApi: "minimax-videos"`）。配置步骤与上文相同。适用 MiniMax-H3 系列，以及原样转发
MiniMax V2 视频接口的中转。

| 阶段 | 接口 | 响应 |
| --- | --- | --- |
| 生成/图生视频 | `POST /v2/video_generation`，JSON | `task_id` |
| 查询原任务 | `GET /v2/query/video_generation/{task_id}` | `task.status`，完成为 `succeeded`，失败为 `failed`/`cancelled` |
| 成品 | `task.content.url` | 公开 URL 走隔离下载；MiniMax 自有域名自动下载，其他来源走既有下载审批 |

- MiniMax 的版本号在接口路径里（`/v2/...`），不在 `/v1` 下。连接地址按上文规则规范化后，
  去掉末尾的 `/v1` 作为接口根；路径前缀保留，如 `https://relay.example/proxy/v1` 的接口根
  是 `https://relay.example/proxy`。中转若改写了 MiniMax 的路径，本协议无法调用。
- body 使用 MiniMax 原生格式：`content` 里必须且只能有一条非空 `text`（最多 7000 字符）；
  图生视频再放 1–2 条 `image_url`，`role` 为 `first_frame`/`last_frame`（省略视为首帧），
  支持 Cindy 受管图片引用。`resolution`（480P/768P/2K）与 `duration`（4–15 秒整数）必填；
  文生视频必须给 `ratio` 且不能用 `adaptive`，图生视频可省略或用 `adaptive` 跟随原图。
- 参考图／参考视频／参考音频生成、H3-Context-IR、视频再生成和其他字段在付费提交前拒绝。
  各型号的分辨率差异（如 Max/Highspeed/Lite 不支持 2K）交给上游校验，不在客户端穷举。
- 复用 Server 已有 MiniMax V2 Guide 的参数、示例和说明，自定义连接使用去掉网关 `/minimax` 前缀的接口路径。
- 协议参与连接绑定摘要，切换协议后停止旧任务请求；恢复原协议后可继续，不把协议塞进 Guide ID 或协议 revision。

依据：[MiniMax 视频生成](https://platform.minimax.io/docs/guides/video-generation)、
[创建任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、
[查询任务](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)。

## 中转站 /v1/videos 接口

多数中转站（tu-zi、new-api 系网关等）把各家视频模型统一成 OpenAI Videos 形式的任务接口。
连接设置里的「使用 OpenAI 兼容视频接口（/v1/videos）」开启它（`videoApi: "openai-videos"`），
与 xAI、MiniMax 选项互斥。地址规则与 xAI 相同：保留 `/v1`。

| 阶段 | 接口 | 响应 |
| --- | --- | --- |
| 生成/图生视频 | `POST /videos`，JSON | `id` |
| 查询原任务 | `GET /videos/{id}` | `status`：`queued`/`in_progress`，完成为 `completed`，失败为 `failed`/`cancelled`/`expired` |
| 成品 | `video_url`（tu-zi）或 `url`（new-api）；没有 URL 时使用 Guide 的 `poll.contentPath` | 中转站自己的 `/videos/<原任务ID>/content` 用原连接凭证读取；该中转站域名（含子域名）下的其他地址自动下载，不带凭证；其他主机走下载审批 |

- 请求体按 tu-zi 文档的 MiniMax-H3 写法：必填 `prompt`；OpenAI 风格字段 `seconds`（字符串）、`size`，
  与模型自身字段 `content`、`duration`、`ratio`、`resolution` 可以并存，另有可选 `watermark`。
  `content` 沿用上文 MiniMax 的规则：一条 text，图生视频再放 1–2 张首帧／尾帧。
  标准图生视频格式使用 `input_reference`，值为一条 Cindy 图片引用或 1–2 条图片引用的数组；
  与 MiniMax-H3 的 `content` 二选一。文生视频不能用 `adaptive` 画幅。各字段的取值范围由中转站和模型决定，客户端只
  做类型与格式检查。
- 视频／音频参考素材、remix 等其他字段在付费提交前拒绝。各家中转站对字段的映射不同，
  验收以实际出片为准。
- 已完成任务只提供 `/videos/{id}/content` 时，按 Server Guide 声明的 `poll.contentPath` 下载原任务。
  未声明该字段的既有 Guide／任务仍按响应里的成片 URL 读取，不在客户端猜测新路径。

依据：[tu-zi 视频生成任务 API](https://api.tu-zi.com/docs/api/reference-relay-openai-video)、
[new-api 查询视频](https://github.com/QuantumNous/new-api-docs/blob/main/docs/api/query-video.md)。

## 兼容与失败恢复

- `videoApi`（`"xai-videos"`、`"minimax-videos"` 或 `"openai-videos"`）是可选用户配置，缺省关闭；不自动改变已装 Art 的偏好、
  批准记录、权限指纹或付费来源。客户端保存连接选择，Server 提供协议说明，无需更新 Art 包。
- 视频与图片分别绑定明确的连接；同名模型不会从其他引擎借用 Key。多个明确来源
  冲突时拒绝派发，在连接设置重新选择唯一视频来源即可恢复。
- 鉴权为该连接的 Bearer API Key，或仅回环的无鉴权。模型级地址必须同源，
  带凭证的请求不跟随重定向。公开 URL 下载不携带生成凭证，未知来源走既有下载审批。
  若结果是 `/videos/<原任务ID>/content`，只读取原连接下由已保存任务 ID 构造的固定
  内容接口，使用原连接凭证，不解释任意 URL 为可带 Key 的地址，不跟随重定向。
  此 API 资源读取同样分块落私有临时文件、校验归属、MIME 后入仓，并最多重试同一个 GET 三次。
  写入按实际累计字节受可用磁盘预算限制，预留 256 MiB 和入库副本空间；写入前复查剩余空间。
  超预算或无法探测空间时取消读取、清理临时文件，不自动重试下载，原任务结果保留。
- 新调用从 Server 读取客观协议说明，客户端只绑定已有连接并执行；读取公开资料不要求
  Cindy 登录或网关额度，也不向 Server 发送该连接的地址、Key 或摘要。说明不可用时不提交。
- 调用快照分别保存 Server 协议版本和 `binding.connectionRevision` 连接摘要，不保存 Key/请求头；跨客户端重启保持绑定。
  地址、Key、来源引擎或业务请求头变化时停止旧任务请求，恢复原连接后可查询原任务。
  旧任务只做兼容读取，不改写原记录；恢复原任务不依赖重新获取 Server Guide。
- 一次付费提交保存任务 ID，之后只查询它。完成响应先持久化，下载或入库恢复
  不重新生成；签名地址过期时只刷新原任务。提交结果未知时禁止自动重提。
  即使等待响应期间连接变化，已返回的有效任务 ID 仍先保存到原调用与原连接绑定下；
  查询与下载继续要求原连接，恢复原连接即可继续读取，不向替换连接发送请求。
- 新付费请求在参考图读取和调用占用完成后，实际发出 POST 前再次检查模型、来源及能力。
  若已停用或连接已改变则不提交，保留原 prepared 调用；恢复原配置后可继续使用同一调用。
  已付费任务的查询与结果恢复不受展示/停用开关影响。
  视频参数严格检查类型；受管参考图展开后再次校验图片 MIME，视频或音频不能作为图片提交。
- 新来源使用 Core 媒体能力；冻结的旧 `cindy-request` 视频入口不扩展。
- 出现在目录或通过接口探测不等于真实出片。验收需分别从 Art 执行两种操作，
  保存受管视频、检查实际时长/画面、确认任务退出运行状态，并区分准备与生成耗时。
