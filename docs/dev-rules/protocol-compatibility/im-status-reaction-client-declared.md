# IM 状态表情由客户端声明

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

官方 Slack / Telegram 的 `hello` 新增可选 `statusReactions`：`queued`、`error` 为
1–64 字符且不含空白的平台原生表情名称；`processing` 为 1–16 个名称，
`expressiveError` 为可选的 1–64 个名称。两仓 `slack-hook-protocol` 的类型、校验和
有效/无效 fixture 同步维护。客户端 `hook-control/statusReactions.ts` 生成平台配置，
Telegram 复用个人 bot 的变体池；X 不发送该声明。

服务端在已认证 hello 的同步段按设备登记，早于 welcome/派发；后续 hello 整体替换，
省略字段清除旧声明。任务使用原路由设备的配置，断线保留最近声明供收口；进程重启后
由重连恢复，在此之前使用兼容默认值。服务端继续负责状态生命周期、实际表情清理与
平台 API 拒绝时的一次标准回落，成功和取消不新增表情。样式不能改变权限或消息归属。

新客户端连旧 server：旧校验器忽略可选字段，照常使用旧样式；旧客户端连新 server：
使用兼容默认值。无需新消息类型或协议版本，无数据库、环境变量、Mobile 原生配置变化，
两仓可独立发布/回滚。完整效果要求两端支持，之后换肤色或表情池只需改客户端。
本次声明仅包含状态表情；进度和终稿文案继续复用已有客户端渲染，服务端命令文案未迁移。
