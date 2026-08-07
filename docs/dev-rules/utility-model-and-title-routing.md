# 轻量一次性模型调用与标题路由

> **状态**：权威开发规则（authoritative）
> **读取时机**：新增或修改标题生成、任务摘要、帮助兜底、语音精修、插件
> `cindy.text.oneshot`，或任何「用户不可见的一次性小模型调用」前

## 1. 单一入口

所有「用户不可见的一次性小模型调用」都必须走 `apps/desktop/src/main/utility-model/oneShotCandidates.ts`
的数据驱动路由（`requestUtilityText` / `requestCustomProviderText` / `requestProviderHttpText`），
**不得新写 per-provider `switch` 分派或重复的 wire fetch**。这覆盖：

- 会话标题生成（`maker-host/title-one-shot.ts`）
- 任务摘要（`sessionTaskSummary.ts`）
- 帮助兜底（`maker-ipc/help.ts`）
- 语音输入精修（`voice-input/`）
- 插件 `cindy.text.oneshot`

理由：这套路由从 catalog 的 `routing.wireProtocol / authStrategy / upstream` 解析 wire、
凭证与端点，支持预设与自定义供应商；新增供应商时数据驱动自动可用，不需要逐家加 case。
历史教训：标题通道曾维护自己的 per-provider switch + 三份重复 fetcher，导致 #1891
（xd 硬编码模型失效）与 #2046（DeepSeek 落进 `default: null`）两次同类故障。

## 2. 标题通道的边界

`title-one-shot.ts` 复用通用层的 `requestProviderHttpText`（wire fetch）与
`requestCustomProviderText`（自定义供应商执行）。保留标题特有的塑造：

- `max_tokens ≤ 32`、`12s` 超时、codex `instructions` 输出约束、`validateTitleOutput` ≤20/40 字校验。
- 只用本会话所属供应商，**不跨供应商兜底**（显式 `providerId` 路径 fail-closed，
  不会把 prompt 漏给 XD fallback chain）。

内置三家（anthropic / openai / xd）仍由 `buildTitleTarget` 显式分派——它们的凭证与端点
需要特殊处理（订阅 OAuth / ChatGPT 桥 / 网关 server 下发端点），与通用层
`requestBuiltinProviderText` 的内置分派同口径。这是凭证特殊性，不是 provider-id 硬编码缺陷：
**新增预设 / 自定义供应商不需要改 `buildTitleTarget`**，它们走 `tryCustomProviderTitle` 的
数据驱动分支。新增内置聊天供应商才需要在 `buildTitleTarget` 与通用层 `requestBuiltinProviderText`
两边各加一个 case（两边一起动，与 `textOneshotPinOptions.isRoutableForOneshot` 同步）。

## 3. 停用轴双查不变量

显式来源路径的候选解析与派发各查一次停用 override（`readModelDisableOverrides`）：
候选解析时查一次 + **派发紧前重查一次**。OAuth 刷新等凭证获取是可能数秒的 await，
期间该 (来源, 模型) 可能被用户停用或被热刷新标成 retired——凭证到手、请求发出的紧前
必须重读 override store 与 active catalog（PR #744 review 第二十一轮的成果，不许简化掉）。

`title-one-shot.ts` 的内置分支用 `canDispatchNow`，自定义分支用派发前的 `isProviderDisabled /
isModelDisabled` 重查，两者语义一致。

## 4. 收敛状态与后续

- 内置三家 fetcher 已统一复用 `requestProviderHttpText`（不再各自维护 HTTP 副本）。
- `provider.titleModel` 字段保留为「偏好提示」（anthropic / openai 的确定性锚点）；
  自定义供应商不声明 titleModel，标题模型从其可选聊天模型里取最经济者。
- 内置三家凭证读取的进一步收敛（如 codex 改用 `getChatgptBridgeAuth` 的 refresh + 连接态门）
  与 `titleModel` 字段去留属 #2097 的契约范围，确认后再推进。
