# 普通 IM 问题卡（2026-11-13）

双方协商 `im-question-cards-v1` 后，官方 Slack、飞书／Lark 可以用
`interaction.request` 的可选 `questionMode: blocking | async` 与 `questionCode`
承载普通 `ask_user_question`。同一 interactionId 可更新正文和按钮；无选项时 buttons
允许为空。非 question 请求不能带这些字段；旧请求的校验和权限语义不变。
文字答案只允许放在 `interaction.decision` 的 `buttonId=question:reply`＋`answerText`。
终态 `interaction.cancel` 仍是最终答案的权威收口。两仓使用同一 protocol-notice fixture。

新客户端只有在 server welcome 宣告能力后启用；新版服务端接收不含可选字段的旧请求
保持原呈现。客户端与 Slack／飞书服务端可独立升级，无数据库 migration 或新环境变量。
需要两端都升级并重新握手才能启用；本地测试通过不代表已部署。
