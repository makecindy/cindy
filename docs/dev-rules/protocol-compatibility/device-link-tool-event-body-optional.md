# 远程工具正文按需下发（2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端在 link-open / subscribe 的 `capabilities` 里逐项声明，被控端只对声明者改写
`maker:event` 推送；未声明的控制端收到与此前逐字节相同的内容，旧被控端忽略这些声明。
两项能力互相独立（`packages/device-link/src/toolBodyStub.ts`）：

- `tool-result-event-text-optional-v1`：省掉 `tool_result` / `tool_result_full` 事件里的
  `data.fullText`、`data.summary`。Desktop 只用 `resolvedContent` 显示结果，Mobile 只从
  `messages:created` 建工具行，两端都声明。事件本身、顺序、id、`isError` 与 `resolvedContent` 不变。
- `tool-use-event-input-optional-v1`：`tool_use` 事件的 `data.input` 置为 `null`，Codex
  `update_plan` 除外（Mobile 用它更新实时计划）。只有 Mobile 声明；Desktop 用事件 input 立即建行，不声明。

哪一端以后要读这些字段，就必须先撤掉对应声明。共享任务访客与供应商分享对端不适用以上改写。
不新增 channel、relay 类型、权限、数据库 schema 或 Mobile 原生依赖；payload 对中继不透明，
自建中转无需改动。实现见 `apps/desktop/src/main/device-link/toolBodyProjection.ts`，回归见
`dispatchSendSafety.test.ts`（negotiated mobile tool projection）。
