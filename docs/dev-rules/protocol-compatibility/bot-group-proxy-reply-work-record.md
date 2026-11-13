# 群聊代答的工作记录兼容（2026-11-03）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

已发布 Desktop 在普通和个人代答的完成请求中附带 `cindy.work-record` revision 1，
`fallback: ""` 表示它只保存定位信息、不增加正文。Chat Server 须允许这一已知版本的空 fallback，
否则会以 `INVALID_INPUT` 拒收完整回复；租约过期后重复执行还可能让模型返回 `NO_REPLY`。
未知卡片或工作记录的未知版本仍要求非空 fallback。客户端请求形状不变，需全部 API 副本升级；
本地 HTTP + PostgreSQL 回归不代表生产已部署，不自动补发旧回复。无 Device Link、中转或鉴权变化。
