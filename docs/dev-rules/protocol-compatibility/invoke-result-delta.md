# invoke 结果增量（侧栏任务列表，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

控制端对 `INVOKE_DELTA_CHANNELS`（目前只有 `local-db:sessions:list`）的读取在 `transfer`
里另带 `delta: 1`，并照旧带已持有结果的 `ifNoneMatch`。被控端为声明了 `delta` 的请求按
（控制端、channel、原样 args）在内存里记住最近一次发出的结果全文（最多 32 条、约 8 MB，
随连接停止清空）；下次请求的 `ifNoneMatch` 正好等于它记住的标签、而结果有变化时，回
`{ result: null, transfer: { tag, delta: { base, length, sample, patch | gzipBase64 } } }`：补丁只含
变了的整行，其余行用基准中的序号引用（`invokeDelta.ts`）。补丁 JSON 不小于 1 KiB（UTF-8 字节）、
控制端声明了 gzip、且压缩后（计入约 16 B 包装：`"patch":` 换成 `"gzipBase64":""`）省 10% 以上时发
`gzipBase64`，否则原样发 `patch`，门槛与省 10% 判据都与整份结果相同；这只是被控端的选择，声明了
gzip 的控制端本就能解任意大小。内容标签、`notModified` 和是否走增量仍按整份结果的 4096 字符
门槛判断。补丁至少要比全文小一半，被控端
发出前先自己套用一遍、逐字比对，不一致就照旧回全文或 gzip。控制端只从发请求时固定的
基准还原，再核对长度与抽样摘要 `sample`（长度加等距抽样字符的 FNV-1a，步长为长度除以 8192
下取整，最多约 16K 个字符，成本有上限、与结果大小无关，用来发现行错位；不是完整性校验），能算
SHA-256 的控制端另核 `tag`；还原有大小上限（与 gzip 解压同为 4M 字符），重复引用大元素也不能展开超限。还原失败时丢掉该基准，
复核调用方仍有效后对这次只读请求不带基准重发一次拿全文；与[历史页增量](device-link-history-view-delta.md)
共用同一段重发逻辑，但只用原超时预算剩下的部分，不足 100 ms 就返回这次失败，下一次读取自然拿全文
（列表刷新各自有重试或下一拍）。
本地传输统计把增量回包单独计数（Desktop debug 行的 `delta`；Mobile `relayTransfers` 只在
收到过增量的通道行出现 `delta`，其余行形状不变）。

旧被控端忽略 `delta`，回 gzip／`notModified`／全文；旧控制端从不声明，被控端不记基准。
relay 与自建中转不解析隧道 payload，帧格式、能力位、握手都不变，无需同步修改中转；
不涉及数据库、权限、Mobile 原生指纹或服务端部署顺序。实现见 `packages/device-link/src/invokeDelta.ts`、
`invokeTransfer.ts`；回归见 `client.test.ts`「invoke 结果增量」、`invokeTransfer.test.ts`、
`sessionListTransport.test.ts`。
