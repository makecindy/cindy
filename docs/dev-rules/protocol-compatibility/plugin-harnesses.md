# 插件任务执行引擎 harnesses（2026-11-18，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。设计见
> [ACP 插件桥接层](../../plans/acp-plugin-bridge.md)。

Ghost manifest 追加 v3 顶层字段 `harnesses?: Array<{ id, name, description?, protocol, entry, locales? }>`（append-only，
v2 `slots` 不映射）：解析器在协议正本 `packages/plugin-protocol/src/pluginHarnesses.ts`，`manifest.ts` 与 Desktop
`shared/ghost.ts` 共用。1–4 项；`id` 为 `^[a-z][a-z0-9-]{0,31}$` 且唯一；`name` 1–64；`description` ≤200；`protocol` 只有 `acp`
生效，其它合法标识保留但不生效、不拒装；`entry` 必须逐字命中 `node.entries`（不能是 `node.entry`），且必须声明 `node`；
每项未知扩展字段原样保留。新包不合规则拒装；已存 Release 与已装快照（`validateStoredGhostManifest` /
`validateInstalledGhostManifest`）只丢弃不合规的 `harnesses`，插件其余能力与批准照旧。未升级的消费者（旧 Desktop、
服务端仓同名 plugin-protocol 未同步前的 plugin-server）把它当未知 v3 字段原样保留、不授予、不拒装；服务端补同一校验时
沿用本仓 fixture（`manifest.test.ts`「harnesses」、Desktop `ghost.test.ts`「harnesses declaration」）。

Host receipt 追加可选 `approvedHarnesses?: string[]`：只来自安装／更新确认里显示过的 `harnesses` 权限行（服务端默认安装与
随包种子视为已批准声明），读写都按当前 manifest 的可运行声明过滤。旧 receipt 缺字段 = 一个都没批准，安装照常有效；旧客户端
读到新字段按未知字段忽略。

插件同源端点（本机 Electron 插件页与远程设置页的同一 fetch 白名单，非 device-link）：`PUT /harnesses` 正文
`{ harnesses: [{ id, available: boolean, reason?: slug, message?: ≤200, version?: ≤64, models?: [{ id: ≤256, name: ≤200, description?: ≤200, group?: ≤200, efforts?: [level] ≤16, defaultEffort?: level }] ≤200 }] }`，
整体覆盖，内容不变不写盘不通知，成功返回规范化后的列表；`GET /harnesses` 读回（按当前清单过滤）。未声明 `harnesses` 403，未安装 404，
格式错误、未声明的 id 或模型 id 重复 400 且不改原状态，其它方法 405；额外字段丢弃。旧 Host 与 Node Host 返回 404，插件按不支持处理；
不认识 `models` 的旧 Host 丢弃该字段，新 Host 读到没有 `models` 的旧记录按「插件不列模型」处理。
`efforts` / `defaultEffort`（2026-11-19）是 Cindy 思考深度 id（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，与 maker-core 从
ACP `thought_level` 取值映射的集合相同）：非数组、非字符串或有 `defaultEffort` 无 `efforts` 400；本版不认识的 id 跳过、不拒整份
（新插件在旧 Host 上不丢模型），按低→高重排并去重，`defaultEffort` 不在 `efforts` 里则丢弃。旧 Host 丢弃这两个字段；旧插件不发，模型没有可选档位。

刷新（Host → 插件逻辑页，经既有 `ghost-pipe:message` / `cindy.onHostMessage`）：打开模型选择器时 Host 发
`{ type: 'harnesses-refresh-requested' }`，同一插件 10 分钟内最多一次，逻辑页不在线不发；插件不回复，重新 `PUT /harnesses`。
不认识该消息的旧插件按未知消息忽略。

Main 内部接口（不跨端）：`cindy-brain/pluginHarnesses.ts` 的注册表与 `nodeRuntimeBroker.spawnHarness`。引擎进程沿用 childSpawn 的
utilityProcess 原样 stdio 模式，stdin 为 base64 字节帧、stdout 为原始字节，wire 不变。实现与回归见
`runtime/ghostHarnessesEndpoint.ts`、`ghostInstallConsent.ts`、`ghostInstallReceipt.ts` 及 `ghostHarnessesEndpoint.test.ts`、
`pluginHarnesses.test.ts`、`nodeRuntimeBroker.test.ts`、`ghostLocalInstallIdentity.test.ts`。
