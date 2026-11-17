# 插件 Agent 模型目录的运行位置（2026-10-27）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

插件同源 `GET /agent-models` 新增可选查询参数 `agent_device_id`（Agent 在哪台同账号电脑或分享来的供应商上；省略 = 本机清单）。无参响应在原 `models` 上追加 `locations: [{agentDeviceId, name}]`，与 Lead `list_available_models` 的 `locations` 同源（同账号在线且开了远程控制的电脑 + 生效中的供应商分享，不含本机）；位置列表读失败时仍返回 200，只省略 `locations`。带参时只投影那台允许远程调用的来源，响应回显 `agentDeviceId`，不附 `locations`。旧 Host 仍拒绝任何查询字符串，带参返回 400；新 Host 其它参数、重复参数、空或超过 128 字符的 id 同样 400。格式合法但那台离线、未知或没开远程控制时返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目，旧客户端应退回无参本机清单。不覆盖 SSH 远程主机目录，不改变 `create_worker` / `agent_device_id` 派工校验。实现与回归见 `electronSandboxAdapter.ts`、`ghostAgentModels.ts`、`workerAgentLocations.ts`。
