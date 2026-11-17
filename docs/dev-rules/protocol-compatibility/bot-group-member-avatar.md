# 群内独立头像

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Chat Server 的 `/me.capabilities` 新增可选 `groupMemberAvatar: 1`；Desktop 的群投影对应
`supportsMemberAvatar`，未声明时不展示换头像入口，也不退回账号头像编辑器。
成员投影沿用 `avatar` 返回当前群的有效头像，并新增可选 `groupAvatar`（可空覆盖值）和
`defaultAvatarUrl`（账号头像）。旧桌面与手机忽略新增字段，沿既有 `avatar` 显示路径读取。
手机经电脑读取群资源时，成员解析须保留有效的 HTTPS `avatarUrl`，交给现有头像组件显示；
缺失或非法地址沿用原头像回退。回归覆盖群头像、恢复账号头像与旧数据解析，不新增手机编辑入口。
Desktop 既有 `chatServer.manage` 增加 `avatar` action；本机校验裁剪字节后复用 OSS 头像上传，
复用 `POST /conversations/:id/nickname`，仅提交当前成员与可选 `avatar` 公开地址，`null` 恢复账号头像。
该接口的 `nickname` 与 `avatar` 均为可选，至少提供一项；未传的字段保持原值，不回传缓存昵称。
昵称请求的旧字段、空串归一化、响应和幂等摘要保持兼容；不新增头像 HTTP 路由。
不新增 IPC channel 或设备互联权限。新服务端先部署，客户端随后发布；旧客户端在新服务端仍可读，
旧服务端拒绝新 action，不能写入全局账号资料。服务端新增可空列，回滚保留列与已保存头像。
