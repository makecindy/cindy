# 同 Harness 换电脑接续原生记录

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`remote-agent` caps 增加可选 `nativeHistoryTransfer: true`，仅同账号 owner 可用；缺省、旧端或分享中转继续使用 handoff。
发送端在查询能力前同时拒绝来源与目标的 `share:<id>` 任务位置及已解析的分享 peer；不以跨账号对端自报能力作为原生历史传输授权。
同通道新增 `native-history` 操作，携带任务 ID 与 export/import/read/write/restore/release 命令。
接收端自行决定原生目录，不接收目标路径；Pi 源路径必须在本机 Pi home 内。临时句柄绑定账号代次、控制端与任务，
每段至多 512 KiB，顺序与 SHA-256 完整性校验通过才导入；原生 ID 重新生成，源记录不修改。
Pi 只改写副本首行的 session ID 与 cwd，使其指向接收端工作目录；消息、工具结果、分支与压缩记录保持原字节。
临时转录放 userData/native-history-transfers 的私有目录，结束后清理，空闲 10 分钟回收。
16 个传输的上限同时计算创建中的快照，创建失败释放名额。Claude 原生迁移通过已有 vendorOptions 传递内部
`_cindyRequireNativeResume`：适配器等待 CLI 的初始化握手并拒绝静默新建，恢复失败交回宿主切换事务。
该标记覆盖手动、配额均衡与启动失败换电脑；普通 Claude 无效会话自愈保持原语义。启动迁移无法保存原子回退所需的边界时，先还原源位置与 ID，再返回失败，不打开副本。
这些命令不加入只读／断链自动重放名单。恢复失败回落已有的原子 resume fallback，不把切账号或清空历史当普通失败。
失败目标的关闭仅作尽力清理，断链错误不能阻止配额探测还原源路由或手动切换提交原子摘要回退；清理等待后仍须复核账号与历史代次，取消与改选继续阻止迟到提交。
配额探测成功后，正式路由写入若失败，同样关闭目标并还原源位置/原生 ID，再向调用方报错，不保留无边界记录的半切换状态。
边界消息增加可选 `nativeHistory: restored | fallback`，桌面与手机在 fallback 时显示「已用摘要接续」；旧客户端忽略新增字段，
仍能读取原有 handoff/resumed。无服务端、数据库 schema、环境变量或 Mobile 原生配置变化。
回归：`relocateNativeHistory.test.ts`、`nativeHistoryTransfer.test.ts`、`nativeHistoryStorage.test.ts`、`sessionAgentSwitchHandler.test.ts`、device-link `remoteAgent.test.ts`。
配额均衡的同账号提议复用既有 `kind: auto`，桌面与手机不弹常规换电脑确认。实际需要摘要时，宿主通过既有 permission
确认卡（`hostOwnedConfirmation: native_history_fallback`）询问，支持同账号远控回答；取消、超时保留原电脑与原生记录。
旧客户端已支持 auto 和通用 permission 卡；共享来源仍沿用原来的 ask/记住偏好，不自动扩大授权。
