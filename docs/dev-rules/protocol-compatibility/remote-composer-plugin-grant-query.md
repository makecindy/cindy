# 远程输入框的轻量插件授权查询（2026-11-05，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`plugins` 集合新增只读 action `management:ui-consent`，返回 `{version:1, uiCapabilityApproval?, item?}`。
`item` 仅含待确认实例的 `instanceKey`、`name`、`approvalToken`，不含图标、市场、项目或完整 manifest。
控制端按集合 actions 协商；旧主机未声明时仍读原 `management:snapshot` 并在本机投影。
同一 renderer、账号代次与远程电脑共用读取，插件通知（含角标变化）250ms 合并、在途不并发。
最后一个输入框卸载后保留轻量缓存与失效监听 30 秒，期间不发起读取；切换回来复用缓存，若有变化则合并刷新。
离线立即作废缓存，重连重新协商；闲置到期释放订阅，账号代次变化隔离旧结果。
保留期间由共享层监听 relay 与目标 presence；断线前在途结果不回填。查询失败保留待刷新状态，
下次订阅或通知补读，不因失败自动循环重试。
读取期间已排队的新通知在该读取失败后仍合并补读一次；没有新通知的失败不自行循环重试。
relay 换代时清除旧的目标离线结论，不依赖新连接重放增量 presence。
目标 peer 的 reset/reopened 同样使缓存及旧在途结果失效；其他设备的 peer 事件不触发读取。
普通任务、新任务和伙伴输入框共用此逻辑；非插件集合变化不触发。批准、稍后提示、版本复验沿用原事务。
旧控制端继续使用原快照，存量插件批准与数据不变。未新增 channel、权限或传输帧；官方/自建中转均透传原
remote-resource invoke，无需服务端或中转升级。
