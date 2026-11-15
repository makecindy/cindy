# 机器实时状态（2026-11-02）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增只读 invoke `maker:machine:status`（`packages/device-link/src/machineStatus.ts`），同账号远控可用，不进共享任务访客白名单。
没有新帧、能力位或 relay 行为，中转（含自建）只转发，不需要适配。旧被控端返回 `CHANNEL_NOT_ALLOWED`，控制端显示 `update_required`；
解析按字段容错，新版本多报的字段被忽略，缺的字段是 `null`，只有 CPU 核数与内存总量缺失才视为无效。
