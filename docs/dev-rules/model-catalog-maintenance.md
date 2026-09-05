# 模型目录：数据归属、更新与验收

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增模型，更新窗口、价格、推理档位、默认值，或排查模型信息显示错误之前

新增模型的支持工作必须覆盖实际运行时的数据源。修改本仓内置 JSON、通过单元测试，
都不能单独证明用户拿到的模型配置已更新。本规则描述客户端与 Server 的职责边界，
不改变根 `AGENTS.md` 的跨仓修改边界。

## 1. 先找数据归属

| 内容                                                             | 应维护的位置                                                                                                               | 客户端职责                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 统一模型目录中的名称、窗口、最大输出、推理档位、参考价及默认标记 | `cindy-server` 的 `model-access-server/catalog/providers.json`；若部署配置了 `MODEL_CATALOG_URL`，还需核对那份远程完整快照 | 同步 `packages/model-providers/catalog/model-registry.json` 作为内置兜底，正确消费实际下发值 |
| Gateway 的实际可用性、路由能力与实价                             | Gateway／Server 对应控制面                                                                                                 | 保留实际路由与价格来源，不用 registry 参考价覆盖 Gateway 实价                                |
| 请求协议、SDK 字段兼容、能力透传与 token 计量                    | 本仓对应 harness／bridge／host                                                                                             | 根据具体通道能力适配，测试最终请求与用量                                                     |
| Pi 原生模型元数据                                                | Pi 上游与本仓 `tools/pi/sync-model-catalog.mjs`、`catalog/pi-model-catalog.json`                                           | 保留上游原生字段，区分公共 API 与订阅协议，遵守 `pi-harness.md`                              |
| 旧任务的上下文占比                                               | 客户端历史读取与展示路径                                                                                                   | 正确区分历史快照、当前目录与运行数据；不能用显示特判掩盖源目录错误                           |

同一模型在公共 API、订阅、Gateway，以及不同 Agent 下的能力可能不同。先列出实际
`provider + agent + model` 路由，再判断哪些字段共用、哪些需要 `perAgent` 或独立条目。
公共 API 总窗口、Codex 默认工作窗口、可选最大窗口、有效窗口和压缩阈值不是同一个值。
参考价也不等于订阅实际扣费；标准／Fast、缓存读／写、长输入分档需分别核实。

## 2. 核对真实发布链路

客户端入口是 `packages/model-providers/src/source.ts` 的 `loadCatalog`，Desktop 由
`apps/desktop/src/main/maker-host/createDesktopProviderService.ts` 装载并刷新活动目录。
公共目录接口为当前配置的 `modelAccessApiBaseUrl` 下的 `/api/model-catalog/catalog`；
还可能存在本地覆盖、上一份有效缓存及旧 OSS 兼容来源。不要仅凭文件名或注释认定当前来源。

- Server 仓库文件是随制品发布的基线。改文件不等于部署完成；配置了远程覆盖源时，
  还必须检查远程源是否会覆盖该基线。Server 的实际行为以其当前代码、部署配置和接口为准。
- 客户端 registry 是带 `updatedAt` 的**完整快照**，不是字段级合并。
  `selectNewerModelRegistry` 会保留较新的有效版本；同 revision 异内容属于冲突。
  新客户端内置快照较新时可以暂时胜出，但不能据此省略 Server 更新：下一份较新的
  Server 快照若仍含错误数据，会再次覆盖回来。
- 发布新快照时，`updatedAt` 必须递增且内容不可变；与本次协同发布的客户端内置版本
  一并核对。价格的 `effectiveFrom`／`verifiedAt` 表达价格生效与核实日期，不能为了
  提升目录 revision 随意改成发布时间。
- 修模型数据时保留用户显式 override，不顺带更换默认模型或默认推理档位。

## 3. 新模型或配置更新的工作顺序

1. **核实通道事实**：查官方模型文档、定价和所用 harness 的实际发现结果；记录来源与
   核实时间，列出 API／订阅／Gateway 的差异。不要只从模型名猜协议或能力。
2. **检查线上现状**：读取目标部署的公共目录，摘录模型条目与 registry revision；同时
   检查客户端活动目录来源、实际路由和 override。检查多个部署时分别记录结果。
3. **分别修改责任侧**：Server 维护发布目录，客户端同步兜底及必要协议／计量适配。
   数据已能解决的问题不新增客户端硬编码；客户端协议缺口也不能靠改目录假装解决。
   需要跨仓配套时，在交付说明中列出对应变更与发布依赖。
4. **做有区分力的回归**：覆盖不同路由窗口、标准与 Fast 价格、缓存与长输入分档，
   以及上游原生元数据优先。涉及显示时覆盖旧任务重新打开、目录刷新、新一轮上报、
   显式长窗口、缺失／歧义来源与 Pi 运行时窗口。
5. **按运行结果验收**：确认部署后公共接口已返回目标条目，客户端实际接受目标 revision，
   再验证选择模型、请求参数和新旧任务显示。只跑本地 fixture、只成功启动登录页、或
   只通过 CI 时，明确记录尚未完成的运行验收，不宣称线上支持已闭环。

### 同步内置兜底时的具体操作

先完成 Server 的目录修正，再把其 `modelRegistry` 整体同步到
`packages/model-providers/catalog/model-registry.json`，保留相同的 `updatedAt` 和内容。
在客户端仓执行以下命令，参数指向已经审阅的 Server worktree 快照：

```sh
node --input-type=module - /path/to/cindy-server/model-access-server/catalog/providers.json <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const { modelRegistry } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!modelRegistry?.updatedAt || !Array.isArray(modelRegistry.models)) {
  throw new Error('Server snapshot has no modelRegistry');
}
writeFileSync('packages/model-providers/catalog/model-registry.json',
  JSON.stringify(modelRegistry, null, 2) + '\n');
JS
```

不要把 Server 的整份 `providers.json` 覆盖到客户端：其中 providers、presets 与 Pi
运行时配置各有消费契约。同步后核对两份 registry 的解析结果完全相等，并检查原有
直连 route 和历史价区间是否丢失。默认模型选择器及用户显式设置不随同步迁移；若离线
兜底中的默认档与当前 Server 已发布值不同，应在交付说明中逐项披露对齐结果。

2026-09-05 对齐发现的典型差异包括：OpenAI 订阅与 XD 路由窗口混用、Sonnet 5 已取消
的涨价仍留在旧兜底、Opus Fast 缓存价缺项、Grok 长输入分档过时，以及 DeepSeek
直连参考价 route 缺失。此类修正先落 Server，再同步兜底，不能再维护两份独立数字。
既有 GPT-5.x 公共 API 长输入参考价仍用于历史／显式长窗口估值，不表示订阅默认窗口
应扩大；Astra 当前订阅参考价只覆盖 272K，超出仍返回未知。未核实的历史价格不补猜。

Pi 的原生目录和请求兼容仍留在客户端。删除临时补项前，必须验证随包 Pi 已原生支持
相同模型、协议及参数；仅 Server 新增了该模型，不足以证明可以删除兼容代码。

## 4. 上下文显示错误的排查顺序

先检查活动目录是否就写错了窗口，再检查当前路由的运行时上报与校正，最后检查旧任务
持久化快照及显示优先级。数据库里同一个大窗口数值，可能来自过去的上报，也可能来自
当前错误目录被当作 verified 写入；**仅凭旧任务或截图不能判断是哪一种**。

修复显示时复用运行时已有的路由判定，保留数据来源边界。目录错误应回到 Server／发布
源修正；不要把某个模型的正确数字硬编码进圆环，也不要用取最小值一律压掉显式长窗口。

相关规则：[`configuration-and-overrides.md`](configuration-and-overrides.md)、
[`pi-harness.md`](pi-harness.md)、[`remote-and-mobile-adaptation.md`](remote-and-mobile-adaptation.md)。
