# 模型公共资料、供应商资料与用户覆盖

裁决日期：2026-09-08。模型资料按字段合并，最终采用以下优先级（低到高）：

1. `modelRegistry.baseModels[].defaults`：模型公共资料。
2. 接入条目及 `routes[].defaults`，再叠加该条目的 `perAgent`：供应商、运行时默认资料。
3. 供应商接口明确返回的资料。没返回的字段继续继承默认；不能把客户端合成值当成供应商事实。
4. 匹配路由的 `forceOverrides`：经核实必须纠正的字段，必须填写 `overrideReason`，可填写 `overrideVerifiedAt`（日期）。普通默认值不能暗中强制覆盖供应商。
5. 用户显式配置：自定义供应商表单中的字段，以及本机 `model-catalog-overrides.json`。文件中的公共型号补丁先应用，具体供应商／运行时补丁最后应用。

字段缺失表示继承；`false` 表示明确关闭；数组整体替换，`efforts: []` 表示无可调思考档；`defaultEffort: null` 表示无指定默认档。最终默认档必须适配实际支持的档位，不能凭默认值增加能力。

图像、视频、音频生成、语音合成、识别、实时音频和向量使用同一 V4 分层。
`mode`、`modalities` 与 `officialDocs` 同样可继承、实报和显式覆盖；模态数组整体替换，
显式空数组不补回。媒体资料不授予账号成员资格，也不能解锁尚未实现的请求协议。
详见 [V4 全类型规范](../model-registry-v4-media.md)。

## 数据结构

```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-08T07:00:00.000Z",
  "baseModels": [
    {
      "id": "maker/model",
      "aliases": ["model"],
      "defaults": { "name": "Model", "contextWindow": 128000 }
    }
  ],
  "models": [
    {
      "id": "existing-entry-id",
      "name": "Model",
      "modelRef": "maker/model",
      "routes": [
        {
          "providerId": "supplier",
          "modelId": "model",
          "agents": ["codex"],
          "defaults": { "contextWindow": 64000 },
          "forceOverrides": { "maxOutputTokens": 8000 },
          "overrideReason": "已核实供应商错误报告输出上限",
          "overrideVerifiedAt": "2026-09-08"
        }
      ]
    }
  ]
}
```

公共字段范围是名称、说明、分组、上下文、最大输出、思考档位、默认档、Fast 与图片输入能力。Fast 通常是供应商能力，应放在路由默认值中。价格、余额、账号可用性、模型成员、协议、地址和凭证不通过公共模型继承。参考价格继续绑定原来的供应商路由，实价仍来自计费控制面。

`modelRef` 只引用明确的公共型号；aliases 必须在整表唯一。新供应商没有专属条目时，仅在精确公共 ID 或明确 alias 匹配后继承公共资料。不剥任意前缀、不用模糊名称猜型号，也不继承另一供应商的强制修正。订阅桥接已有的 ID 归一规则继续适用。

保留现有 entry、provider、上游 model ID 和 `[1m]` 变体。一个模型可以同时有本地包装与云端接入，共用 `modelRef`；本地量化标签、包装体积、运行内存、平台限制、推荐证据仍留在 `localModels`。不同权重或不同版本不能仅因名字相似而共用型号。

## 用户文件与恢复默认

文件位于当前账号的用户数据目录，沿用已有 `model-catalog-overrides.json`，不上传到服务器。以下示例只保存用户修改的字段：

```json
{
  "version": 1,
  "baseModels": { "maker/model": { "name": "我的显示名" } },
  "patches": {
    "supplier:model": {
      "base": { "contextWindow": 32000, "supportsImageInput": false },
      "perAgent": { "pi": { "defaultEffort": null } }
    }
  },
  "localModels": {
    "featuredIds": [],
    "patches": { "qwen38-27b": { "name": "我的本地模型" } }
  }
}
```

`baseModels` 是按公共 ID 的稀疏补丁；`patches` 支持已有订阅、Cindy AI、自定义供应商模型及 Pi。补丁不能凭空增加账号可用模型，尚未出现的条目静置。原有 `additions` 仍只适用于允许实体化的订阅根，不开放 Gateway 伪造。退役条目仍需完整合法 addition 才能复活。

键中的供应商段使用 `encodeURIComponent` 编码，模型段保持原文。例如旧自定义 xAI 的运行时 ID 是 `custom:xai`，对应键为 `custom%3Axai:grok-model`；`xai:grok-model` 仍指内置 xAI，`custom:xai:grok-model` 仍指供应商 `custom` 的模型 `xai:grok-model`，三者不混用。

`localModels` 支持 `patches`、完整 `additions`、`removedIds`、`featuredIds`；空推荐数组明确不推荐任何模型。名称和包装仍需通过本地域校验，不能下发命令、路径或下载 URL。删除补丁或对应字段就是恢复继承，远端刷新不会写回或删除这些用户字段。

自定义供应商的接口结果单独保存在 `discoveredMetadata`；表单只持久化用户显式设置。旧数据缺少来源标记时保守保留旧名称和窗口，不猜测用户意图。刷新供应商信息会更新发现快照，不把发现值转成用户 override。
从预设新建时只保存 `catalogPresetId` 引用；模型默认资料读取当前目录，接口结果仍单独记录。
预设地址与协议仍按创建时配置保存，只有它们与当前预设一致时才继承该供应商的默认资料；用户换端点后停止继承。
旧连接已有的显式快照不自动转为继承。官方 API 入口没有同名服务端预设时，仍通过精确型号匹配读取公共资料；不把入口中的提示值保存成用户覆盖。

## 发布、兼容与验证

服务端显式切换后，Model Access 数据库的已发布版本是数据正本。CN 主写，Global 经公共 API 读取并持久化缓存；外部模板共用，Cindy AI 成员与实价保持区域权威。原 Server JSON 仅用于首次迁移，客户端 bundled 是已发布版本的离线构建产物。`baseModels`、模型引用和本地域必须整体校验、发布和同步；坏快照、回退 revision 和同 revision 冲突沿用上一份合法快照。

复用当前公共目录接口并协商 Registry V5；服务端增加模型域数据库表，版本 1–4 使用兼容投影。旧 V1/V2/V3 客户端收到展开后的旧字段，保留上游 ID；不支持的公共引用、覆盖指令与图片字段被移除，空默认以缺省表达。

V5 的 `productDefaults` 独立保存默认使用窗口、思考档、Fast、显示默认和推荐引擎；`perAgent` 保存已适配引擎的差异。这些产品选择在能力解析后、用户覆盖前应用，不增加能力或模型成员。订阅、API、Cindy AI 分开配置；共享上游 ID 的 `[1m]` 配置按具体目录 ID 区分。模板模型的产品默认只由端点、协议和路由仍匹配的 `catalogPresetId` 连接继承。

显示默认遵守 `configuration-and-overrides.md` 的可见性例外：已初始化清单不随发布扩展或重置；新用户首次初始化及用户明确恢复默认的路线采用当前目录默认。`disabledPresetIds` 只过滤添加入口，已有连接仍读取模板资料。

恢复思考 / Fast 默认删除对应覆盖。远程与 Mobile 等待主机 renderer 落盘确认；旧主机或保存失败不能虚报成功。目录刷新不直接改写活动任务；用户主动恢复时遵守所在界面的任务操作语义。

供应商总容量与客户端工作预算分开：既有 GPT 272K 工作预算继续保留，实际容量放在 `contextWindowMax`；用户显式窗口覆盖仍优先。协议和实际执行能力门禁继续由运行时负责，元数据不能解锁未实现协议或伪造可售性。

验收至少覆盖缺字段继承、供应商优先、force 修正、用户最高、显式 false/null/空数组、未知供应商公共识别、刷新与保存、旧版解析、离线与坏快照回退。模型推荐标准另见 [本地模型筛选](local-model-selection.md)，仍只按能力、速度和实际运行内存筛选。
