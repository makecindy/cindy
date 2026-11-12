# 附件类型与直连附件体积

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Mobile 发送的队列附件（`RemoteSerializedAttachment.category`）与 Desktop `AgentInputFileCategory`
对齐，追加 `'file'`：认不出的扩展名不再拒收，按通用文件以 `application/octet-stream` 上传。
主机只按 `category === 'image'` 分流，其余一律作为文件路径交给 Agent，并以 `originalName`
落地保留扩展名，新旧主机都已认得 `'file'`。

附件不设产品层体积上限。直连附件（`cindy-peer-attach://`）的引用去掉固定 2GB 上限，只要求
安全整数；接收端不设收件箱总量上限，只按剩余磁盘空间准入（未写完的上传按剩余待写字节预留）。
OSS 保底仍受服务端 presign 单对象上限（`OSS_ATTACHMENT_MAX_BYTES`，2GB），超过它的附件
没有保底，只能直连发送。`device-link:file-peer` 的 `caps` 追加可选 `largeAttachments: true`；
发送端（Mobile 与 Desktop 控制端）仅在对端声明该能力时直连超过 2GB 的附件，旧主机未声明时
直接放弃直连且不计入失败冷却，随后按 OSS 上限提示失败。旧控制端忽略新增字段，行为不变。
文件读取（`open`）仍沿用 `FILE_PEER_MAX_BYTES`。不新增 channel、relay 类型或持久化 schema，
服务端无需改动。

直连附件上传的提速同样按能力协商：Desktop 主机的 `caps` 追加可选 `streamAttachments: true`，
表示它接受同一附件最多 `PEER_ATTACHMENT_STREAM_WINDOW`（3）个写入块同时在途，并接受以
RPC 二进制正文传来的块（`write` 不带 `data`，原始字节紧跟该请求的最后一个 JSON 分片发送，
单块不超过 1 MiB；在途写入的等待按窗口放宽为 45 秒）。接收端仍按发送顺序逐块落盘、要求
偏移连续，`finish` 照旧校验大小与 SHA-256。旧主机不声明该能力：发送端继续逐块等确认并用
base64 `data` 字段，不向旧主机发送二进制帧（旧运行时收到会关闭连接）。旧发送端不读新字段，
新主机继续接受 base64 块。Mobile 发送端暂沿用逐块方式。不新增 channel、relay 类型或持久化
schema，服务端无需改动。
