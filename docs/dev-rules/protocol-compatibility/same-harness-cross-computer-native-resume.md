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
失败目标的关闭仅作尽力清理，断链错误不能阻止配额探测还原源路由或手动切换提交原子对话重放；清理等待后仍须复核账号与历史代次，取消与改选继续阻止迟到提交。
配额探测成功后，正式路由写入若失败，同样关闭目标并还原源位置/原生 ID，再向调用方报错，不保留无边界记录的半切换状态。
边界消息保留可选 `nativeHistory: restored | fallback`。2026-11-18 用户裁决：配额均衡的同账号提议
继续复用 `kind: auto`；恢复原生记录失败后，宿主先还原源路由，再用重放内容自动接续，取消原有
`native_history_fallback` 确认卡。确认探测判定为 `unavailable`（离线、任务数已满、不提供模型等）时，
还原源路由后原样报错，配额均衡留在原电脑发送并退避。共享来源继续用原有询问及偏好。

跨 Harness 的全量／增量接续、换电脑回落及共享来源，用同一构造器按时序重放可读的用户、助手、工具和思考记录。
重建同一 Harness 也使用同一预算。已核实窗口按 30% 计，最多 100,000 token，按每 UTF-16 单元约一个
token 保守计；找不到目标窗口时沿用 16,000 的保守上限。空闲重建最多 16,000，仍以新消息为新话题。
满窗后若宿主即将重送一条已知文本，预算另扣这条输入，为系统内容和输出预留 35% 窗口。
超限先保留整段历史中的用户原文。用户消息本身放不下时，优先保住最初的请求和最近的消息，
较早的长消息保留首尾。助手回复优先保留最近全文，较早回复先摘录。较早的工具调用、工具结果和
思考保留一行概要，给出调用标识、参数摘录或结果状态和长度，空间不足再从最早的概要开始省略。
缩减时单条工具结果或可读思考最多使用总预算的 25%。记录仍按原顺序输出，每处省略都有标记。原生图片字节、思考签名、密文和已遮盖的思考不随文本重放。
重放由宿主生成，保留工作台账、按权限检索原文的指引与结束标记。

`agent_switch` 和 `context_rebuild` 增加可选 `handoffCoverage: complete | condensed`。前者表示预算内
带齐可重放文本，后者表示较早记录有省略或缩短。原生接续可不填。数据库标记的 `content.handoff` 保有
发送全文，重启后仍按既有消费位恢复 pending。新分隔条在普通列表、推送和镜像缓存中最多带 2,048 字符、JSON 编码 6 KiB 的预览，
旧端忽略 coverage 字段并照常读 `handoff`／`resumed`。沿用既有消息投影和 Agent send 通道，relay 传输协议、
数据库 schema 与 Mobile 原生配置均无变化。

回归：`relocateNativeHistory.test.ts`、`nativeHistoryTransfer.test.ts`、`nativeHistoryStorage.test.ts`、
`sessionAgentSwitchHandler.test.ts`、`agentHandoff.test.ts`、device-link `remoteAgent.test.ts`。
