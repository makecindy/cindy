# 手机直连群的设置管理

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

## 同账号跨设备伙伴候选

Desktop `chatServer.ownedBots` 返回账号所有可加入的伙伴；`botId` 表示 actor 的稳定 externalId，
不再保证存在本机 Profile。可选 `avatar`、`homeDeviceId` 用于候选展示，旧调用方可忽略。
建群仍提交 externalId，成员邀请仍提交 actorId；手机经电脑的 `create` / `add-member` /
`set-members` 保留原 input，新主机允许缺少本地行但能在 ownedBots 中确认的 externalId，
本机隐藏行继续拒绝。旧主机可能返回 MEMBER_UNAVAILABLE，手机保留错误，不伪报加入成功。
没有新服务端路由、迁移或原生模块改动；加群不改变 homeDevice 或执行授权。

## 群解散与个人列表移除

`GET /me` 明确声明 `groupLifecycleVersion: 1` / `conversationListStateVersion: 1` 才启用对应动作。
缺能力或旧副本拒绝时显示不可用，不回退为 archive 或兼容 delete。服务端合同及迁移由
`xindong/cindy-server#921` 提供；该 PR 的实际启动迁移核验与部署仍为独立上线条件。

`POST /conversations/:id/dissolve` 带 operationId 与正整数 expectedRevision，只允许 joined owner
（包括合法伙伴主人代演），且 kind 必须是 group。`dissolved_at` 是不可撤销的终态，归档只是其
旧客户端只读兼容投影。保留原历史权限，停止现有执行与分工、失效邀请均由服务端事务负责；
Desktop 收到终态后还会中止本机未完成的规划，沿原 lease 链停止执行；本机终止规划无需追加取消规划写入。

`POST /conversations/:id/list-state` 带 operationId、hidden 与本人列表 expectedRevision（初始0）。
它只移除本人账号跨设备列表，不退出、不删历史、不停止其他人的执行。已退出者通过
`GET /conversation-list-state` 获取状态，无需先读已无权限的群快照。启动及重连先取个人状态，
只合入更新的修订；成功回包或本人 human actor scope 的 `conversation.list.changed` 才清理本地
列表、选择与未读镜像，失败保留列表。手机同时订阅群和本人 human scope，代演不替换账号订阅。
同账号并发全量同步共用一次请求；普通聊天刷新复用已同步状态与事件，启动、重连及手机主动刷新重新读取。
同步失败不把缓存标记为已就绪。手机列表重新挂载时先纳入已有个人状态，直连离线也不恢复旧电脑回包。
actor scope 遇到 RESET_REQUIRED 时，在在途读取完成后重新读取个人状态，再按服务端 head 续订；
Desktop 与 Mobile 均受当前账号、socket 身份保护。个人移除成功时由仍挂载的聊天页完成返回列表，
设置面板因列表更新先卸载不会吞掉成功导航，离开页面后的旧回包也不能改变新页面。
手机收到跨设备本人 hidden 事件也由当前聊天页返回列表，本机回执与事件共用一次导航；
设置面板每次关闭/身份切换都会清空 busy，旧打开周期的请求不能覆盖新周期状态。
Desktop 解散或变更期间遇到在途 heartbeat，会合并排队一次后续租约检查，避免漏掉权威终止。

现有 `bot-group-chat` 投影可选追加 supportsDissolve、supportsListRemoval、supportsGroupLeave、dissolvedAt；远程资源
动作 `dissolve` / `leave` / `hide` 分别转发相同的服务端动作。hide 的 opaque result 返回
`{listState:{conversationId,hidden,revision}}`，手机按修订合入同一账号投影，阻止旧电脑列表复活。
Desktop 既有群变化推送新增 list 类型及可选 listState；旧窗口忽略未知类型仍会刷新列表。
旧客户端与服务端可独立升级；完整行为要求服务端全副本及使用的客户端均支持。无新增 channel、
SQLite schema、Mobile 原生依赖或 fingerprint 输入。

现有 `bot-group-chat` 数据可选追加 `supportsSettingsManagement`。仅服务器群的新版 Host
声明该能力，手机读取最新群详情和已有成员角色后才开放管理。设置动作可带
`expectedRevision`，Host 在调用服务前核验，群信息 PATCH 和归档继续携带该编辑版本给
Chat Server。新增资源动作 `add-member` (`botId`) 只邀请一个本机可见伙伴，不替换成员名单；
移出仍使用已有 `remove-member` 和 actor ID。旧手机忽略能力并保留原动作；新版手机遇到旧
Host 显示更新提示。账号切换、关闭设置、断连或撤销设备使旧读取和未发出的操作失效。
管理电脑按当前群 ID 精确读取，不以截断的群列表作为存在性门槛。普通内容刷新保留同一次
设置页已核实的管理资格，实际发送前仍复核电脑身份和最新权限；新详情确认撤权或群不可见后禁用。
Chat Server 返回的 `REVISION_CONFLICT` 保留为公开错误码，新手机显示冲突提示并保留草稿，
旧客户端沿用未知错误码的通用失败提示，不自动重试写操作。
复用原有 collection、channel、订阅、账号和群权限，不扩 IPC allowlist、relay、服务端
schema、数据库或 Mobile 原生指纹。完整管理需要两端客户端更新。
