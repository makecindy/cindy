# Codex 提问身份与活动回执（2026-11-07）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

既有 interaction 通道增加可选问题 `id` 和请求 `isBlocking`。新端按 ID 保存/返回答案，
宿主兼容旧端的题干/header 键；字段缺省仍是同步阻塞问题，不要求升级中转。
仅看到 `isBlocking=false` 的客户端发送 `{kind:"ask_user_question",answers:{},inProgress:true}`
停止宿主的空闲计时；这是非终局活动回执，不落库、不消费 resolver、不清卡片。
无新字段的旧宿主不会收到这类回执。Desktop、手机及自建 relay 都沿原 resolveInteraction
透传，未增加 channel 或远端执行入口。权限请求仍由原权限路径校验来源与请求归属。

MCP 表单的问题可选携带 `answerConstraints`（required、choices、minLength、maxLength）。新端保留 choices 的所有精确枚举值（包括 Other），提交前就地校验并保留草稿，取消使用独立动作；普通模型问题不携带该字段，原自由回答行为不变。旧端忽略新字段，执行端仍校验回传值；不得把旧端未校验的数据作为有效内容接受。无新通道/中转帧，官方与自建 relay 沿现有 interaction 透传。pattern、format 等暂不支持的验证约束在展示前明确报错并取消，不回传不符合 schema 的 accept。
