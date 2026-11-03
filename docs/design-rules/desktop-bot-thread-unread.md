# 桌面 Bot 与群话题未读提示

2026-11-03 设计裁决，补充 [DESIGN.md](DESIGN.md) 的对应 Desktop 范围。

Bot／群话题入口、话题面板、右下角话题／提及胶囊及其展开列表，未读点统一使用 card-status-done 绿色。Bot 主消息流新消息分隔线恢复 main 的原样，不新增点、不调整文字与线条。保留话题回复数量、定位、关闭、关注和已读确认逻辑；胶囊的结构与位置不变。

此裁决覆盖 DESIGN.md 中这些 Desktop Bot／群位置原有 bot-unread-bg 蓝色的描述。Session 消息流与 Mobile 不变，不全局修改未读 token。

浅色和深色均使用语义 token。
