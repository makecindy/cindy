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

媒体生成硬规则：插件沙箱和 panel 不直接提交生成请求，不持有 endpoint、凭证、
轮询或下载逻辑。当前 Agent 自己决定如何把插件的普通结果转换为 `media` 调用，并根据
Guide 组装请求；Core 负责鉴权、Guide、安全边界、任务状态与结果入库。插件可以提供
业务参数、参数规范化、模型偏好和可选 UI，但不负责执行底层请求。

插件获取结果不需要专用回调协议：

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
