# 伙伴模型链里的模型组

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 产品规则见 [模型组 §6.2](../../product-rules/model-groups.md#62-伙伴用模型组2026-11-20-用户裁决)。

- **路由字段**：`ModelRoute`（`packages/maker-shared/src/modelRoute.ts`）追加可选 `modelGroup`（组 id，≤64 字）。
  这一项其余字段仍是一条完整可用的具体路由。旧端解析丢弃未知字段，按具体模型运行；旧端改动并保存伙伴模型时
  丢掉组、留下具体模型。新端 `normalizeModelRoute` 保留该字段。
- **组目录随表单下发**：伙伴设置的 `models` 表单块与新建伙伴的 `create` 表单块在 data 追加可选 `modelGroups`，
  内容是伙伴所在电脑的模型组配置（与 `model-groups.json` 同形：路线名、选法、例外、推理强度、来源的
  agentKind / 供应商连接 id / 模型 id / 运行位置），只有同账号可读的目录级标识，不含凭证。这台电脑没有模型组时省略。
  控制端按不可信数据解析：Desktop 复用 `normalizeModelGroupsConfig`，Mobile 只保留显示所需字段并限 32 组 × 16 来源。
  旧控制端忽略该字段，组项按具体模型显示。
- **选择与补全**：控制端选组只在这一项写上 `modelGroup`（具体模型暂为原来的模型，新加的一项用组里第一个来源）。
  伙伴所在电脑保存（`models` 动作）或新建（`create` 动作）时，先按组的规则预览一次，把具体模型换成组此刻会选的来源；
  这台电脑没有这个组时去掉组、按控制端带来的具体模型；组暂时用不了时保留原来的具体模型。补全后照常经既有模型可用性验证。
- **旧主机**：不下发 `modelGroups`，新控制端不显示模型组；即使带 `modelGroup` 提交，旧主机解析丢弃字段，按具体模型保存。
- 无新增 channel、权限、数据库 migration、服务端或中转改动（字段在既有 remote resource 读写 payload 内，自建中转透明转发）、
  原生 fingerprint 变化。
- 实现：主机 `localDb/ipc/botRemoteSettingsResource.ts`、`botRemoteEditors.ts`、`botRemoteManagement.ts`、
  `maker-host/bot-model-chain-settings-store.ts`（`listBotModelGroupsForRemote`、`fillBotModelGroupRoutes`）；
  Desktop 控制端 `renderer/features/bots/remoteBotSettingsData.ts`、`RemoteBotSettings.tsx`、`BotModelChainEditor.tsx`；
  Mobile `src/session/companionProfileData.ts`、`CompanionModelChain.tsx`、`UnifiedModelPickerSheet.tsx` 与两个平台视图。
