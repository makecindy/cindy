## 4.0.4 媒体模型配置与调用边界

媒体上层能力由插件定义，Cindy Core 只提供两项低级能力：

1. 插件设置页 / panel 按类型读取当前可用模型，用来保存插件自己的模型选择；
2. 当前 Agent 执行插件能力时，使用永久注册的 Cindy Core `media` 工具发起调用。

设置页 / panel 没有 preload 桥，直接走同源只读端点。插件必须声明 `cindy` 顶层字段，
并在 `cindy.image` 或 `cindy.video` 中声明至少一个动作：

```js
const result = await (await fetch('/media-models?type=image')).json();
// → {
//   ok:true,
//   type:'image',
//   models:[{
//     id,
//     name,
//     providerId,
//     modalities:{ input:['text','image'], output:['image'] }
//   }],
//   defaultModelId:string|null,
//   defaultProviderId:string|null
// }
```

`type` 只接受 `image` / `video`。Host 按模型 `mode` 切大类，并结合插件在
`cindy.image/video` 声明的动作、模型 `modalities`、Guide operation 与当前客户端
协议支持度，只返回当前真正可执行的模型。单个模型的 Guide 缺失、损坏或版本过新只隔离
该模型，不拖垮整个目录。

响应只把已归一化的 `modalities.input/output` 与来源 `providerId` 交给插件，
不下发 Guide、endpoint、凭证或 Host 内部兼容判定。插件可把用户选择的模型 id 存进自己的
`/kv`，但必须同时保存 `providerId`，并把这对精确选择交给当前 Agent；同一个模型 id
可由多个 Provider 提供，不能按 id 去重或自行改换来源。付费请求前 Core 会再次校验。

插件与 Agent 不需要新的媒体协议，继续使用现有工具调用链：

1. Agent 用 `ghost_call` 调用插件的业务工具；
2. 插件通过普通 `tool-result` JSON 返回业务参数、面板里保存的模型选择或其它上下文；
3. 同一个 Agent 读取结果后，自行调用 Cindy Core `media` 工具；
4. 如果插件需要最终媒体，Agent 再调用插件的普通接收工具，并通过顶层
   `ghost_call.attachments` 显式交接；Host 复用通用 attachments 授权链，把授权后的
   指纹注入 `args.attachments`，避免把本地绝对路径暴露给插件。插件自行保存业务状态
   与更新 UI。

第 2 步的字段完全由插件定义，Host 不识别 `mediaIntent`、`nextTool` 等保留字段，也不
自动把插件结果转成媒体请求。下面只是普通结果示例，字段名不是平台契约：

```js
const prefs = await (await fetch('/kv')).json();
await cindy.send({
  type: 'tool-result',
  callId: msg.callId,
  ok: true,
  result: {
    prompt: msg.args.prompt,
    selectedModel: prefs.imageModelId,
    sceneOptions: { aspectRatio: msg.args.aspectRatio }
  }
});
```

走 Agent 媒体流程时，Agent 自己决定如何把插件的普通结果转换为 `media` 调用，并根据
Guide 组装请求。Core 负责鉴权、任务状态与结果入库。插件可以提供业务参数、模型偏好和 UI。

插件也可在 `cindy.models` 声明 `media_request`，经安装或更新审批后，走
[Cindy AI 媒体直调](#cindy-ai-媒体直调)自行提交和查询。两条路径的网关地址、
凭证和路由都由 Host 管理。直调由插件管理业务状态和查询时机，使用同一模型和返回的 `jobRef`
查询或下载视频。旧客户端不支持时，提示用户更新，或在插件已实现 Agent 流程时使用该流程。

走 Agent 媒体流程时，由 Agent 显式把生成结果交给插件：

```js
// Agent 侧：Core media 成功后通过通用附件参数交给插件
ghost_call({
  ghost_id: 'cindy-art',
  tool: 'receive_media',
  args: { caption: prompt },
  attachments: [resultUrl]
});

// 插件侧：msg.args.attachments 是已授权指纹；插件自行写 /kv 并广播面板
```

Host 不理解“画廊”或其它插件业务，也不会因为一次 `media` 成功自动唤醒、回调任意插件。

### Cindy AI 媒体直调

在 `cindy.models` 声明 `media_request` 并完成安装或更新审批后，插件可以用当前账号的
Cindy AI 模型额度。Host 校验模型与操作。插件传入模型 ID 和业务参数，无需 Agent 会话。

```js
const result = await cindy.send({
  type: 'cindy-request', kind: 'media_request',
  operation: 'image.generate', model, body: { prompt: '一只纸鹤' },
});
```

- `image.generate`、`video.generate`、`audio.speech` 提供 `body` 对象。图像和视频使用该模型官方 Guide 的 JSON 参数。
- `audio.transcribe` 提供由文本字段组成的 `body` 和受管音频的 `audioHash`。可用 `deposit_media` 寄存已有音频，文件表单由 Host 构造。
- 异步视频提交返回 `jobRef` 时，使用同一 `model` 和 `jobRef` 调用 `video.poll`。仅在模型提供独立下载接口时调用 `video.content`。引用绑定账号和插件实例，最长保留 30 分钟，重启或淘汰后失效。

`ok: true` 表示收到网关响应，先检查 HTTP `status`，再用 `contentType` 和 `encoding` 解读
`body`。二进制响应使用 base64。请求和响应各自最多 32 MiB，Guide 可设更低上限。
`ok: false` 返回 `errorCode` 和 `message`。收到 `OUTCOME_UNKNOWN` 时避免自动重提，以免重复扣费。
通过 `minCindyVersion` 声明经过验证的最低版本。旧客户端不支持时提示更新，权限拒绝时保留拒绝结果。
