# 伙伴 V1 其余远程入口退役（2026-11-08）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

待办、工作台／自动跟进、例行任务与伙伴私信随伙伴 V2 移除（产品规则见
[伙伴运行时](../../product-rules/cindy-bots-runtime.md)）。新 Host 对旧控制端的稳定应答：

- `teammates` 集合动作 `send-message` / `verify-message` / `message-receipt`（跨电脑伙伴私信）返回
  `UNSUPPORTED_CAPABILITY`；升级前排队、尚未派发的 V1 私信在恢复时丢弃。旧私信线程只读可看；
  `maker:bot-direct-message:changed` 推送已删除。
- `todos:<botId>` 资源返回空列表（不报错）；例行任务集合与 routine Skill 页返回 `NOT_FOUND`；
  `settings:<botId>/follow-up` 返回 `NOT_FOUND`。
- `management:settings`：`autonomy.get` 回答「关闭」，`autonomy.set` / `autonomy.reset` 与全部 `routines.*`
  返回 `UNSUPPORTED_CAPABILITY`；这些操作不再列入 `caps`（`BOT_SETTINGS_RETIRED_OPS`），新控制端不显示对应页。
- 本机专用的 `local-db:bots:autonomy:*`、`local-db:bots:workbench:*`、`local-db:bots:todos:*` 与推送
  `maker:bot-autonomy:changed` 已删除（均未进 device-link 白名单）；`maker:bot-workbench:changed`
  保留原名，表示关联项目或伙伴开的任务变化。
- 云端偏好键：`companion.todo.v1:<id>` 不再上传或应用，`companion.routine.v1:<id>` 不再上传；本机仍拥有这两个
  前缀以清除自己的旧行。旧电脑上传的例行任务按 routine id 一次性转为伙伴项目的自动化。
  `companion.workbench.v1` 照旧（关联项目）。
- 插件 `routineEvents` / `will-routine-run` 照常解析与安装但不再触发，`routine-request` 管子的
  status / publish 返回稳定的空操作（见 [插件安全与编写](../plugin-security-and-authoring.md)）。

不新增 channel、relay 帧、服务端字段或数据库迁移；手机原生指纹不变。
