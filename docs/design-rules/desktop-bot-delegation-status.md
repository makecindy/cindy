# 桌面 Bot 与群委派卡片状态

2026-11-03 设计裁决，补充 [DESIGN.md](DESIGN.md) 的对应 Desktop 范围。

委派卡片开始／进行中使用 warning-accent 橙色呼吸点；等待使用 card-status-awaiting 青色、完成使用 card-status-done 绿色、失败使用 card-status-error 红色。取消和未知保留中性色。沿用 session-status-breathing 的节奏和减少动态效果规则。

仅调整 BotCollaborationCard 中委派卡片的指示样式，任务分配、运行、取消、重试、跳转与消息交接逻辑不变。

浅色和深色均使用语义 token。
