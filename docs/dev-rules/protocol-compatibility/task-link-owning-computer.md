# 任务链接保留所属电脑

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

任务查询返回可选 `sessionUrl`，沿用 `cindy://session/<id>?device=<deviceId>`。
桌面外部打开与冷启动缓存的 session payload 新增可选 `deviceId`，Main、preload 和
Renderer 均保留它。导航先与本机设备 ID 比较；远端链接先登记现有会话 origin，
再通过原传输层读取，不把相同 ID 的本机伙伴任务当作目标。设备判断沿用入口导航器的
最新点击判据，迟到结果不覆盖后续点击。没有设备参数的旧链接保持原导航流程。
设备比较与链接生成均使用 auth 注册的本机标识，包含隔离开发实例的覆盖值。
外部入口与正文链接按设备和任务 ID 一起挑选远端镜像；显式 origin 优先于其它设备
的同 ID 分片，快照刷新不会将后续读取改到另一台电脑。
不增加 IPC channel、远程授权、重试或连接恢复；离线目标仍由现有传输层报告。
回滚后新增查询字段可忽略，但旧 Desktop 从外部打开远程链接仍有丢失设备参数的限制。
回归入口：`deepLink.test.ts`、`deepLinkIslandEntryBridge.test.ts`、
`botSessionOwners.test.ts`、`orcaSessionIdentity.test.ts`。
