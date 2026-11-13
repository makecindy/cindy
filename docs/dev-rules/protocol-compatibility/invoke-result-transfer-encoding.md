# invoke 结果传输编码（弱网减流量）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端 `invoke` payload 可选携带 `transfer: { gzip?: 1, ifNoneMatch?: string }`：注入了解压
能力就声明 `gzip: 1`；本机持有同一被控端、同一 channel 与 args 的上一份大结果时，带上它的
内容标签。被控端照常执行 handler，只改写发出的 ok 结果：序列化后不小于 4096 个 UTF-16 code unit 的结果附带
`transfer.tag`（SHA-256）；标签与 `ifNoneMatch` 相同时回 `{ result: null, transfer: { tag,
notModified: true } }`；否则在控制端声明可解、结果不小于 1 KiB（UTF-8 字节，
`INVOKE_TRANSFER_MIN_GZIP_BYTES`）且压缩确有收益时回 `{ result: null, transfer:
{ tag?, gzipBase64 } }`。1–4 KB 的结果只压缩、不带标签，不进控制端 32 条缓存（避免小结果把
值得短路的大页挤出去）；同一读取的结果变小到只压缩、不带标签时，控制端丢掉该键原来的缓存。这只是
被控端的选择，控制端声明 gzip 后本就能解任意大小，新旧组合都兼容。共享 DeviceLinkClient 在交给调用方之前还原成普通结果，并只用发请求
时固定的缓存快照还原，回包前被淘汰也不影响；标签对不上时返回错误，不返回旧数据。
缓存快照在本地准入队列出队、实际发送时读取，结果解码后才释放准入配额：
等待期间已有同键结果到达时，后续请求能携带最新标签，避免重复整包；不跳过远端 handler。
解压有输出上限（4M 字符，与传输层单条逻辑消息同量级）：解码器边解边计数，超过即中止并
返回错误，不先整段展开；被控端对超过上限的结果不编码，仍走原有的超限处理。

handler 每次都执行，`notModified` 只省略字节完全相同的结果，因此对所有 channel 语义不变，
不需要逐 channel 登记。控制端缓存按设备、channel、args 键控，最多 32 条、约 8 MB，只在内存，
随客户端 `stop()` 清空（Mobile 退后台停连例外，见下文）；共享任务与供应商分享等跨账号 peer 不使用该编码。旧被控端忽略
`transfer` 回普通结果；旧控制端从不携带 `transfer`，被控端也就不会编码。Desktop（同时作为
被控端与控制端）注入 zlib 与 SHA-256，Mobile 只注入 pako 解压（已有依赖，不改原生指纹）。
relay 不解析隧道 payload，无服务端改动、数据库 migration 或部署顺序要求。实现见
`packages/device-link/src/invokeTransfer.ts`，回归见同目录 `__tests__/invokeTransfer.test.ts`
与 `client.test.ts`「invoke 结果传输编码」。

Mobile 退后台停连（`client.stop({ retainResultCache: true })`）保留同一 client 的 invoke 结果
缓存，回前台的列表等重复读取仍能换 `notModified` 或[增量](invoke-result-delta.md)；账号、登录状态
或中转线路变化时 Mobile 会换新 client，中转移除本设备与其它停止路径照旧清空。只保留主连接的缓存：
随它一起停止的其它连接（跨账号连接、按资源安装的分享连接，以及 Agent 网络开启时给旧对端用的
中转连接）照旧清空。缓存只在内存、按目标设备键控，只在被控端确认标签相同时才采用，被控端每次
重新授权执行。

Desktop 的压缩保持 gzip level 4 与同步发送／错误处理契约，手机与电脑、电脑与电脑
共用这一实现。收益按 gzip 的 base64 长度（加约 48 字节的传输包装）与原始 JSON 的 UTF-8
**字节数**比较，缩小超过 10% 才采用；gzip 的 1 KiB 门槛同样按 UTF-8 字节计，标签门槛、解压上限
与缓存预算仍按原有字符数计。Node 编解码及数字统计复用
`@cindy/device-link/node-compression` 独立入口，跨平台主入口与 Mobile 不加载 Node 模块。
DEBUG 统计只记原始／gzip／wire 字节与压缩耗时（按 5 分钟窗口汇总，单次 ≥100ms 单独记），
不记录正文或凭证。
回归见 Desktop `device-link/__tests__/transferCodec.test.ts`（实际 zlib／pako 解码）。

Mobile 开启本地诊断时，在原有 30 秒／卡顿区间统计内汇总 `relayTransfers`：每个 channel
首次写入 socket 的请求数、收到的响应数、还原正文前的响应 payload UTF-8 字节数、
`notModified` 与 gzip 命中数。前者不把准入等待或取消算作已发送，也不重复计重传；
后者不包含 envelope、分片头、ACK 与重传字节，不是总线上流量。peer 直连不经过此计数。
传输行按响应 payload 字节数降序只保留前六个通道，`relayTransfersOmitted` 标明省略的
通道数；与 push／invoke 列表一起保持在单条日志的 120 值预算内，不能当作全部通道总量。
旧 `invokeCount` 仍是业务调用次数，不能与已发请求数混用。不开诊断时不序列化计量，
不记录请求参数、正文、设备／任务 ID，不改变传输协议或恢复策略。
