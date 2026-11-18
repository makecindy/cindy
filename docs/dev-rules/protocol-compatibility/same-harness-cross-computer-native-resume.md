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
配额探测因目标此刻接不了而失败（供应商组失败判定为 `unavailable`：连不上、`REMOTE_AGENT_BUSY` 任务数已满、不提供这个模型等）时不发确认卡，
还原源路由后原样报错，由配额均衡留在原电脑发送并退避；只有目标能接、原生记录恢复不了才询问。无协议变化。
旧客户端已支持 auto 和通用 permission 卡；共享来源仍沿用原来的 ask/记住偏好，不自动扩大授权。

## 原生记录随任务备份（2026-11-18 用户裁决）

Pi 任务在同账号另一台电脑执行时，任务所在电脑在成功轮次落库后后台拉取完结快照。只有 owner
被控端声明 `nativeHistoryBackup: true`，主端在原有 open 载荷回传 `acceptsNativeHistoryBackup: true`，
被控端才在成功 `pi/agent_settled` 对应的 done 上附一次会话内检查点。缺任一能力位就沿用原行为。
任务的 `share:<id>`、分享 peer、经分享转发的 run、外部应用和 SSH 工作区都不参与。检查点只在两台
电脑的 Agent 通道交付，任务宿主消费后去掉它再广播。

`native-history` 增量命令 `checkpoint-export {runId, checkpoint, prefix?: {bytes, sha256}}` 只接受
当前 owner 控制端本身、指定任务和仍静止的该 run。被控端自己从绑定的 Pi session id 定位会话文件，
检查文件仍未变化、以完整记录收尾，而且末条原生消息对应本次成功的模型回复。正在执行下一轮或改过
模型、回退、压缩、撤权、关闭的 run 拒绝取快照。普通 export/import 仍要求关闭写入中的会话。
检查点回复包含旧字段 `id, manifest` 和 `offset`。被控端复算源前缀 SHA-256，匹配才跳过该前缀，
否则从 0 开始。增量 read/release 携带 `backup: true`，使用隔离的临时句柄，不能凭它读取其他导出
或还原到任何指定路径。read 通过可选 `limit` 限制单段长度。
任务宿主仅发布字节数和整份 SHA-256 均通过、且持久会话 id、执行电脑、清空／回退／删除代次和
完成消息锚点仍匹配的备份。原电脑链路不可达时，备份作为原生迁移的来源，仍走原有目标校验；如果新一轮
已经推进历史水位，或者校验、目标原生恢复失败，沿用现有交接。

目录是 `userData/owners/<账号键>/native-history-backups`，私有目录／文件在 POSIX 创建为
0700／0600。备份按字节保留原生**对话与工具记录**，包括用户已经交给 Agent 的正文；只打开绑定
会话文件，禁止读取、复制登录状态、订阅／供应商密钥、私钥、授权文件、钥匙串以及 Harness 配置／认证
文件。删除任务、清空、回退／删除消息、切换原生 id 或引擎会使原备份失效，宿主在变更后清理，
并在同账号启动和下次写入时清除作废或崩溃残留。保留期 7 天，每个任务一份、每份至多 16 MiB，
每个账号至多 8 份，超限优先回收最旧备份。发布使用同目录临时文件和原子替换。

每台任务宿主一次只拉一份，最多待处理 16 个任务，同任务只保留最新尝试，失败只等待下一次成功
轮次。稳定前缀命中时只传新增字节和一次 export/release；每次只拉一段，128 KiB 原文每段间隔至少
250 ms，速率上界约 512 KiB/s 原文或 683 KiB/s Base64，另有帧头和加密开销。首次或前缀失效的
整份传输受同一上限约束，搭乘现有后台调用的链路，轮次完成、发送和下一轮不等待它。实际生产中转
可用容量未测量。多个任务宿主的限速独立，被控端仍共享既有 16 个临时传输名额和每段字节上限。
故障只影响当前任务的备份请求，切换时只换该任务的历史来源，沿用原有设备／中转
连接、重试与复位策略；回归覆盖两个控制端共享被控端时互不授权或失效。
中转路由只透传已签名的既有 `maker:remote-agent:v1` 业务载荷，不解析快照字段，不需升级自建中转。
没有新 relay kind、allowlist、Mobile 配置或数据库 schema 变更。
回归见 `nativeHistoryBackup.test.ts`、`nativeHistoryTransfer.test.ts`、`nativeHistoryStorage.test.ts`、
`relocateNativeHistory.test.ts` 和 `roundtrip.test.ts` 的双控制端用例。

Claude Code 和 Codex 保持按需迁移。隔离探测中 Claude CLI 在 result 后仍会追加记录。Codex 0.166.0
的成功小样本在通知时已有 rollout 和线程状态行，上游仍允许先交付终态、再刷新普通 rollout。
因此两者的终态事件均不作为全量自动备份的落盘屏障。[Codex 0.166.0 完成轮次的写盘顺序](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/tasks/mod.rs#L854-L882)
