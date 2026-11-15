# 项目显示名的跨设备镜像

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`sidebar-settings:get-project-aliases` 是只读的主机别名快照；返回主机平台、账号代次和
`local:` / `remote:` 项目身份对应的别名，不传播主机作为控制端保存的 `device:` 覆盖名。
`local-db:project-aliases:changed` 使用 `{}` 失效通知和账号标记，沿既有 `sessions` topic
转发。控制端首次订阅、重连及既有列表刷新时补拉；在途读取期间收到变更时丢弃旧结果并补拉。
完整空快照表示别名已清除，临时读取失败保留最后有效名称。退出账号、移除或撤销设备时清理镜像，
迟到响应不得恢复已清理的数据。

新主机与旧控制端保持原行为；新控制端连接不支持该读取通道的旧主机时使用目录名。
只新增读取与通知准入，不开放远程别名写入，不改数据库或 relay 格式。
名字按物理来源设备和完整主机项目身份匹配；Windows 本地路径按主机平台比较，SSH 身份和
POSIX 大小写保留。既有分组若包含不同主机项目身份，仍显示原目录名，不能任取一条别名覆盖整组。
桌面控制端已有的本地 `device:` 覆盖名继续优先。分组键、任务标题、工作目录和路由均不随别名改变。

实现与回归见 `packages/maker-shared/src/projectAliasSync.ts`、`projectAliasSync.test.ts` 和
`projectAliasPresentation.test.ts`；移动端首页、设备详情、抽屉与搜索筛选共用同一份镜像。
