# Registry V4 全类型模型规范

沿用 Registry V4、现有目录接口、版本比较、缓存和用户配置结构，不新增 Registry 版本。
本文记录客户端规范；服务端目录发布和正式版调用验收单独进行。
架构入口见 [模型配置与下发](dev-rules/model-catalog-maintenance.md)，字段与成员规则见 [模型资料优先级](product-rules/model-metadata-precedence.md)。

## 类型与资料

聊天、图像、视频、通用音频生成、语音合成、语音识别、实时音频和向量共用
`baseModels[].defaults`、`models[].modelRef`、`routes[].defaults/forceOverrides`。

| mode | 类型 | Provider 兼容投影 |
| --- | --- | --- |
| `chat` / `responses` | 聊天 | `models[agent]` |
| `image_generation` | 图像生成 | `imageModels` |
| `video_generation` | 视频生成 | `videoModels` |
| `audio_generation` | 通用音频生成 | `audioModels` |
| `audio_speech` | 语音合成 | `audioModels` |
| `audio_transcription` | 语音识别 | `audioModels` |
| `realtime` | 实时音频 | `audioModels` |
| `embedding` | 向量 | `embeddingModels` |

新增的可选公共字段是 `mode`、`modalities: { input: string[], output: string[] }` 和
`officialDocs`（HTTPS）。与名称、说明、窗口等资料采用相同的严格校验和合并规则。
`mode` 是用途，输入输出模态是能力：能输入图片的聊天型号仍是聊天，不能据此声明作图。
已知媒体类型不进入 Agent 聊天选择器。未知 mode 仍按既有规则归为其它能力，不能默认为聊天。

字段缺失表示继承；modalities 的数组整体替换，显式空数组表示清空该方向的能力。
公共字段只收跨来源资料，不接纳凭证、客户端发现状态或表单临时字段。

## V4 示例

```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-09T00:00:00.000Z",
  "baseModels": [{
    "id": "vendor/new-image",
    "aliases": ["new-image"],
    "defaults": {
      "name": "New Image",
      "mode": "image_generation",
      "modalities": { "input": ["text", "image"], "output": ["image"] }
    }
  }],
  "models": [{
    "id": "vendor/new-image",
    "name": "New Image",
    "modelRef": "vendor/new-image",
    "nativeApi": "openai-images",
    "routes": [{ "providerId": "vendor", "modelId": "new-image", "agents": [] }]
  }]
}
```

媒体接入路由的 `agents` 必须为空；聊天路由仍要求合法且非空的 Agent 列表。
类型来自公共型号或接入条目。`nativeApi` 可记录既有聊天协议，以及
`openai-images`、`openai-videos`、`xai-videos`、`openai-audio-speech`、
`openai-audio-transcriptions`、`openai-realtime`、`openai-embeddings`。
协议标识是元数据，不等于该客户端已有对应执行器；Pi 仍只接受其原有四种聊天协议。

## 继承与刷新

所有类型沿用同一优先级：公共默认 → 供应商默认 → 供应商明确实报 → 有理由的
`forceOverrides` → 用户显式覆盖。公共资料通过明确 modelRef 或唯一精确别名关联，
不把模糊名称当成身份。未知用户型号仍可手动设置类型。

- 既有 Provider 媒体列表保留为消费接口，V4 资料统一由 Registry 投影，不再为新型号
  另建媒体资料库。显式名单（包括 `[]`）决定成员，不被公共条目补回。
  V4 以 Registry 声明完整媒体名单时省略对应 Provider 数组，客户端据此派生；
  仍下发旧媒体数组时尊重它的成员，只补全型号资料。
- 对已接入的图片/视频账号发现路径，成功快照限定该路径的账号成员；这不是所有发现接口的通用删除规则。
  自定义刷新、Pi 显式名单及 Gateway 分别按 [成员来源表](product-rules/model-metadata-precedence.md#模型成员空列表与失败) 处理。
  同 ID 的供应商新资料会更新，旧静态值不能压住实报。
  精确匹配 provider/model 路由的 `retired` 仍排除新请求并清理默认项；其它来源的同名
  型号不受该退役记录影响。
- Gateway 的实时成员、可用性和实价保持其权威；公共条目不擅自扩大 Gateway 成员。
- 用户供应商继续使用现有 runtimes 配置，类型和模态保存在原型号项里；媒体列表从
  这些型号投影。新增公共资料不会自动增加用户私有成员，也不更换地址或凭证。
- 自定义型号表单可选择媒体类型或恢复继承；刷新选择器、确认和保存均保留显式类型。
- 统一模型管理页展示上述类型，既有停用偏好同样作用于音频型号。

## 执行与兼容边界

OpenAI 订阅图像执行器发送目录准入后选中的上游型号 ID，不再只允许 `gpt-image-2`。
实际是否可选仍由现有目录与来源检查决定；不能根据 API 官宣推断订阅账号已开放。
其它媒体执行器及 Gateway Guide 保持各自协议与凭证边界，不添加新认证方式。

V1–V3 解析保持原有契约；新媒体字段、媒体原生协议和空 Agent 路由属于 V4。
服务端以后按这套本地规范维护下发数据；旧消费者需要其既有媒体列表投影，不能直接
接收严格解析器不认识的字段。客户端实现不构成 Server 已实现或已部署的证明。

### 发布前置条件

相同 `registrySchemaVersion=4` 或 `schemaVersion=5` 请求不能证明
客户端认识本次扩展。服务端在没有独立、可验证的客户端能力协商前，必须继续对这些
请求返回已发布客户端能解析的旧形状，不得直接全量下发新增音频空 Agent 条目、新
Registry 字段或原生协议枚举。LKG/内置兜底不能当作兼容方案。未来下发实现需补充
能力识别及旧形状投影，并用已发布客户端严格解析器验证；本地消费与管理实现
不代表该服务端发布前置条件已经满足。Registry 维持 V4，不因这些媒体扩展
递增版本；在上述发布条件完成前，新增目录资料只在本地配置/内置路径生效。


本地离线目录把 OpenAI GPT Image 2.5 Sunburst / Flare（以及旧代 GPT Image 2）、Gemini/xAI 图像、xAI 视频资料纳入 Registry，并补入
已有音频、识别、实时与向量型号的公共资料。公共音频/向量资料不虚构订阅接入路由。
请求尺寸、时长、音色、返回格式仍归现有执行协议；统一目录不提供通用媒体参数表单，
也不会让尚未实现的音频协议自动变得可调用。

验证覆盖 V4 全类型解析和投影、用户配置持久化、实报与覆盖优先级、目录刷新、
停用展示、旧版拒绝新字段以及图像请求发送未硬编码的新 ID。真实账号作图、
服务端热下发及正式版 UI 验收不能用本地测试替代。
