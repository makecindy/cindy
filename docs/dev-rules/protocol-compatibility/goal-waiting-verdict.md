# 目标模式 waiting 裁决与跨端 waitingSince

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

goal 裁决契约新增第四态 `waiting`（模型声明本轮无可做之事、进展取决于会话外事件）：controller
不再立即续跑，目标保持 active 挂起，等事件唤醒——worker 回报/用户消息进队（既有
sessionIntervention 信号）、手动 resume（GOAL_RESUME 放行 active+waiting）、打开会话
（既有 resume-on-open）、30 分钟安全网重检轮。持久层六态 `GoalStatus` 与 `session_goals`
schema 不变；`GoalStatusPayload` additive 追加 `waitingSince: number|null`（不新增状态枚举值，
手机端 `MobileGoalStatus` 不变，`MobileGoalStatusPayload` 追加可选 `waitingSince?`：旧手机端
忽略未知字段按 active 显示，旧 Host 不发该字段时新手机端按 undefined 处理）。无新 channel、
无 allowlist 变化、无 SQLite migration。
