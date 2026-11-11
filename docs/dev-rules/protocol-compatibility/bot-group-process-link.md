# 伙伴群聊过程关联（2026-10-29）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

完成答复在既有 `ChatContentBlock` 列表末尾附可选 `cindy.work-record` v1 card，包含可选执行电脑 `deviceId`（与伙伴当前主力电脑无关；缺失时兼容旧记录），
必需字段仅 `groupId / executionId / sessionId / clientId`；`fallback` 为空，正文与附件次序不变。
旧客户端忽略未知 card 或读取空 fallback，仍能阅读原答复；新版遇到旧消息缺少关联时不补猜任务。
新版 Desktop / Mobile 只在伙伴答复上投影 `process`，群和话题共用组件，并核对群 ID 与伙伴归属。
关联不授予权限：阶段文字通过既有同账号设备授权的 `local-db:messages:around-client-id` 精确读取，
遇到下一个用户输入或本轮终态停止，原始思考和工具结果不进入群消息。
不增加 device-link RPC、relay 帧、权限或数据库 migration；自建中转仍透传既有调用，无服务端代码变更。
没有真实 Chat Server 或自建中转互通验收时，客户端测试不可表述为服务端已验收。

过程关联可附带非负 `durationMs`，在执行终态固定；上传和回执重试不增加该值。旧记录缺少此值时，展开后由原始时间戳计算；未知时间不编造。
