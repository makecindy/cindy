# 分享供应商备用执行（2026-11-08）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`provider-share-availability-v1` 是设备能力声明。服务端 `/provider-shares/availability/:shareId/:action`
新增注册、目录、分配、任务准入、状态与无内容用量接口；跨区域只开放 guest 目录/分配/查询/状态，
沿用该分享的 guest credential，不接受本区域 Access Token 替代。服务端收到的身份全部来自认证上下文。
`received` 增加可选 `standbyOnline`，原 `hostOnline` 继续表示 O 的物理在线状态；新版客户端另存
`hostDeviceOnline` 并将有效可用状态投影到本地 `hostOnline`。旧客户端忽略新字段、保持旧行为。
没有新能力的 M 不被选择；没有新接口的服务端不获得备用权限。既有 device-link 帧与协议版本不变。
新增 PostgreSQL 表须先迁移再部署。发布顺序为服务端后 Desktop；新能力只在 O 在线成功登记后生效。
备用 M 每轮发送前以独立 `executionId` 调用 `accept` 占用容量，完成后以原分配 generation 和本轮
executionId 调用 `complete`；打开任务的无 executionId `accept` 只确认归属。G 的状态遥测不能释放
已接受任务的容量。完成回执在准入请求发出前捕获，响应丢失时也会尝试释放原轮次，失败沿原任务收尾路径重试；
撤权后仍可释放原轮次，旧回执不能释放后续轮次。服务端记录取消标识，先到的释放回执可阻止迟到准入。
这是本次备用执行能力的配套接口，需使用包含上述接线的 Desktop；不改变既有在线 O 的委派路径。
