# 模型配置最小示例

> 参考示例，不是生产目录。架构和修改位置见 [模型配置与下发](../dev-rules/model-catalog-maintenance.md)。
> 每个 JSON 块都是独立、完整的 Registry，供真实 parseModelRegistry 校验；放入完整 Catalog 时使用 modelRegistry 字段。
> 示例名称、日期、窗口、标签和内存均为演示数据，不说明真实服务可用或当前推荐；发布仍需版本与媒体兼容检查。

从仓库根目录、依赖已准备好的环境执行：

```sh
pnpm --filter @cindy/model-providers test -- src/__tests__/documentedModelCatalog.test.ts
```

校验直接提取本文 JSON 块，已纳入 model-providers 标准单测与 CI，不另维护重复 fixture。

## 1. 新增公共型号和接入声明

公共资料通过 modelRef 关联；route 决定接入目标。无实报和用户覆盖时窗口为 128000。示例不配置真实账号，也不证明该供应商可用。

<!-- example: base-model -->
```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-10T00:00:00.000Z",
  "baseModels": [
    {"id": "example/model", "aliases": ["model"], "defaults": {"name": "Example Model", "contextWindow": 128000}}
  ],
  "models": [
    {
      "id": "example-entry",
      "name": "Example Model",
      "modelRef": "example/model",
      "routes": [{"providerId": "example-provider", "modelId": "model", "agents": ["codex"]}]
    }
  ]
}
```

## 2. 调整某条供应商路由的默认窗口

只影响匹配这条 providerId/modelId 的默认资料；窗口为 64000。供应商若明确实报 80000，最终采用 80000。

<!-- example: route-default -->
```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-10T00:00:00.000Z",
  "baseModels": [
    {"id": "example/model", "aliases": ["model"], "defaults": {"name": "Example Model", "contextWindow": 128000}}
  ],
  "models": [
    {
      "id": "example-entry",
      "name": "Example Model",
      "modelRef": "example/model",
      "routes": [
        {
          "providerId": "example-provider",
          "modelId": "model",
          "agents": ["codex"],
          "defaults": {"contextWindow": 64000}
        }
      ]
    }
  ]
}
```

## 3. 设置 Codex 的工作默认

perAgent 和 routes 同级，无实报时 Codex 窗口为 32000；实报仍优先。不要在这里填 pi，Pi 成员和默认资料走 providers[].models.pi。

<!-- example: agent-default -->
```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-10T00:00:00.000Z",
  "baseModels": [
    {"id": "example/model", "aliases": ["model"], "defaults": {"name": "Example Model", "contextWindow": 128000}}
  ],
  "models": [
    {
      "id": "example-entry",
      "name": "Example Model",
      "modelRef": "example/model",
      "routes": [
        {
          "providerId": "example-provider",
          "modelId": "model",
          "agents": ["codex"],
          "defaults": {"contextWindow": 64000}
        }
      ],
      "perAgent": {"codex": {"contextWindow": 32000}}
    }
  ]
}
```

## 4. 纠正实报，仍保留用户最高优先级

供应商实报 80000 时修正为 72000；若用户显式配置 16000，最终采用 16000。不要把普通默认值放进 forceOverrides。

<!-- example: forced-correction -->
```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-10T00:00:00.000Z",
  "baseModels": [
    {"id": "example/model", "aliases": ["model"], "defaults": {"name": "Example Model", "contextWindow": 128000}}
  ],
  "models": [
    {
      "id": "example-entry",
      "name": "Example Model",
      "modelRef": "example/model",
      "routes": [
        {
          "providerId": "example-provider",
          "modelId": "model",
          "agents": ["codex"],
          "forceOverrides": {"contextWindow": 72000},
          "overrideReason": "结构演示：假设已核实该接入错误报告窗口；生产必须写真实原因"
        }
      ]
    }
  ]
}
```

## 5. 新增本地候选包装，暂不推荐

仅说明包装字段；标签和内存数字均为假设，不可下载或用于真实推荐。featuredIds 为空表示没有推荐，不删除这个候选或本机已安装模型。正式推荐需补齐本地筛选规则要求的证据。

<!-- example: local-candidate -->
```json
{
  "schemaVersion": 4,
  "updatedAt": "2026-09-10T00:00:00.000Z",
  "baseModels": [
    {"id": "example/model", "aliases": ["model"], "defaults": {"name": "Example Model", "contextWindow": 128000}}
  ],
  "models": [
    {
      "id": "example-entry",
      "name": "Example Model",
      "modelRef": "example/model",
      "routes": [{"providerId": "example-provider", "modelId": "model", "agents": ["codex"]}]
    }
  ],
  "localModels": {
    "version": 1,
    "models": [
      {
        "id": "example-local",
        "modelRef": "example/model",
        "name": "Example Local",
        "aliases": ["example"],
        "variants": [{"libraryName": "example:8b-q4", "sizeBytes": 4294967296, "minUnifiedMemoryGb": 16}],
        "runtimeProfile": "plain"
      }
    ],
    "featuredIds": []
  }
}
```

图片、视频、音频与向量示例及额外下发条件见 [V4 全类型规范](../model-registry-v4-media.md)。
