# 模型公共资料、供应商资料与用户覆盖

裁决日期：2026-09-08。模型资料按字段合并，最终采用以下优先级（低到高）：

1. `modelRegistry.baseModels[].defaults`：模型公共资料。
2. 接入条目及 `routes[].defaults`，再叠加该条目的 `perAgent`：供应商、运行时默认资料。
3. 供应商接口明确返回的资料。没返回的字段继续继承默认；不能把客户端合成值当成供应商事实。
4. 匹配路由的 `forceOverrides`：经核实必须纠正的字段，必须填写 `overrideReason`，可填写 `overrideVerifiedAt`（日期）。普通默认值不能暗中强制覆盖供应商。
5. 用户显式配置：自定义供应商表单中的字段，以及本机 `model-catalog-overrides.json`。文件中的公共型号补丁先应用，具体供应商／运行时补丁最后应用。

字段缺失表示继承；`false` 表示明确关闭；数组整体替换，`efforts: []` 表示无可调思考档；`defaultEffort: null` 表示无指定默认档。最终默认档必须适配实际支持的档位，不能凭默认值增加能力。

继承完成后，已声明路由的模型若仍缺少 efforts，最终可选条目使用 [] / null，不指定推理档位，不因缺项删除模型。该兜底不写回资料层，也不覆盖供应商实报。显式空数组仍表示无可调档；非空档位缺默认时仅从已声明档位按共同规则选默认，不能凭名称猜档位。

图像、视频、音频生成、语音合成、识别、实时音频和向量使用同一 V4 分层。
`mode`、`modalities` 与 `officialDocs` 同样可继承、实报和显式覆盖；模态数组整体替换，
显式空数组不补回。媒体资料不授予账号成员资格，也不能解锁尚未实现的请求协议。
详见 [V4 全类型规范](../model-registry-v4-media.md)。

## 数据结构

### 多连接的身份与隔离

同一种供应商可以有多个账号或 API 连接。沿用 `providerId` 标识连接实例，
`model` 标识该连接下的上游模型，`agentKind` 标识执行 Harness；调用目标由三者
共同确定。供应商与模型的显示名可以重复，也可以改名，不用于路由、凭证查找或持久化关联。
不新增模型接入 ID，不要求模型 ID 在所有连接间全局唯一。

OpenAI 本机 Codex 登录与独立授权账号共享 OpenAI 公共目录及桥接规则；
`providerCatalogId` 仅用于公共定义查找。凭证、发现快照、限额、具体连接的价格及窗口覆盖、
收藏与可见性继续使用连接实例 ID。三个 Harness 的公共模型资料与接入声明由服务器目录维护；
客户端原生目录只补旧快照缺失字段及运行时兼容细节，不能作为第二份公共模型白名单。
账号发现没有返回某个模型（包括空结果），不等于明确禁止该模型。

现有协议保留两种兼容表示：Codex/Claude Code 的 Registry 根与桥接声明，及
`providers[].models.pi` 的逐 Harness 声明。旧 Registry 的 agents 枚举不能直接加入 Pi；
顶层 Codex/Claude Code 空数组仍由 Registry 实体化，不能解释成关闭。
Pi 显式列表决定成员（包括空数组与撤下条目）；缺字段才使用随包兜底，不把其他 Harness
的名单复制成 Pi 路由。服务器声明的新模型不要求先出现在 Pi SDK 名单中；有明确原生协议
即可构造 models.json。OpenAI 订阅仍使用专用 Codex Responses 认证传输。

旧顶层 Pi 条目的静态资料是旧格式兜底，不能标为账号 discovery；
Registry 的公共定义／显式条目／路由／perAgent 继续覆盖旧默认，账号实报与用户覆盖另行优先。
已解析的名称、窗口、输出上限、档位、输入能力和价格必须进入实际运行配置。
原生同协议的 compat、header、sampling 仅补实现细节；换协议不复用旧 serializer 的参数。
用户自定义连接及 Pi 原生扩展继续保留，不由公共目录撤下其模型。
缺少某 Harness 路由时界面说明“尚未配置”，不声称上游明确不支持；没有真实路由不生成
可发送候选。未连接、未安装及付费状态继续使用各自现有状态。

任务、定时任务和辅助调用保存完整调用目标；明确选中的默认供应商也保存其连接 ID。
旧数据中未指定连接的记录继续解析默认来源。显式连接断开、删除或不再提供模型时，
来源解析返回不可用，不能把另一个账号显示为当前账号；用户已开启的运行失败自动切换
仍按原设置执行。运行中任务保留停用／退役模型的实际来源展示。

Pi 已识别的 OpenAI 订阅连接之间可复用同一运行时：每个账号必须有独立原生路由，
主代理与子代理在原生切换确认后同步身份。回合中切换延迟到回合结束；启动快照没有
目标路由时保留原来源、历史与待发消息，不静默改用其他账号。其他凭证形态仍按原保护处理。

已有同 Harness、同模型共享的思考档位／Fast 偏好仍保留，恢复时按目标连接实际能力校正；
这些操作偏好不承载账号身份。新增供应商登录适配时应复用上述连接机制，登录协议、
限额接口及 Harness 执行能力仍需分别适配。

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

Server `catalog/providers.json` 是数据正本；客户端 `catalog/model-registry.json` 是同 revision、同内容的离线副本。`baseModels`、模型引用和本地域必须随整个 Registry 一起校验、发布和同步，禁止只复制子域造成悬空引用。坏快照、网络失败、回退 revision 和同 revision 冲突沿用上一份合法快照。

复用当前目录接口与 Registry V4 协商，不增加请求或数据库表。旧 V1/V2/V3 客户端收到展开后的旧字段；不同资料的多条路由在兼容响应中拆成独立条目，保留上游 ID，额外条目使用派生目录 ID。旧协议不支持的公共引用、覆盖指令与图片字段被移除，空默认以缺省表达。

供应商总容量与客户端工作预算分开：既有 GPT 272K 工作预算继续保留，实际容量放在 `contextWindowMax`；用户显式窗口覆盖仍优先。协议和实际执行能力门禁继续由运行时负责，元数据不能解锁未实现协议或伪造可售性。

验收至少覆盖缺字段继承、供应商优先、force 修正、用户最高、显式 false/null/空数组、未知供应商公共识别、刷新与保存、旧版解析、离线与坏快照回退。模型推荐标准另见 [本地模型筛选](local-model-selection.md)，仍只按能力、速度和实际运行内存筛选。
