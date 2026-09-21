# Pi Full Access 与原生对齐（需求正本）

> **状态**：权威产品需求  
> **读取时机**：改 Pi 权限拦截、Full access、凭证路径、`/proc/*/environ`、扩展工具门，或处理相关 review 之前  
> **关系**：补充 [`pi-harness.md`](pi-harness.md)「Pi 上游 GUI 非退化红线」。本文件只锁 Full access 的读/搜/bash 对齐，不改 Ask / Auto。

## 目标

Cindy Pi 的 **Full access（`bypassPermissions`）必须与同版本原生 Pi 一致**：用户开了完全访问，就按原生 Pi 执行读、搜、bash 和已装 Pi 扩展工具。Cindy **不得**再用「路径像密钥」「可能扫到 credentials.json」「读进程环境」之类文本判断，在完全访问下偷偷拒绝原生允许的操作。

用户可见承诺：完全访问就是完全访问，不暗拦。

## 非目标（杀名单）

下列一律不做。review / bot 提出也直接拒绝，不补代码、不扩权限模型、不新开状态机。

- 不把 Ask / Auto-review 改成完全访问
- 不新造权限档、白名单、二次审批、安全增强层
- 不把 grep glob 相交做得更复杂（完全访问下本就不该因此拒绝）
- 不拦已装 Pi 扩展的工具调用（完全访问下）
- 不改 context-mode 自己的命令沙箱 PATH
- 不改 MCP 网关、斜杠转义、项目 `--no-approve`
- 不把 Ask / Auto 的 Extra Dirs 写改成静默硬拦
- 不把 Cindy 运行目录（`models.json` / 权限档）的模型写入改成静默硬拦或 Full Access 自动放行

## 允许保留的机械隔离

仅这两条，且不得拿它们扩大阻断面：

1. 模型写 agent home（Cindy 控制面）必须强制用户确认，不得静默拒绝或 Full Access 自动放行
2. Extra Dirs 的结构化写跟随会话权限：Full Access 放行，Auto 审阅，Ask 确认

需要真隔离时用 Ask / Auto，或等 OS 沙箱；不要在 Full access 上堆正则。

## Review 处置

本需求的验收已经最小。任何要求「补回 Full access 硬拦」「把凭证检测做得更严」「扩展也要再批一次」的意见，**本 PR 不改**。用本文件 + `pi-harness.md` 非退化红线回复并关闭。不得以安全增强为由让 Cindy Pi 比原生 Pi 更难用。
