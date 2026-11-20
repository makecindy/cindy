# 本机应用使用远程供应商

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`remote-agent` caps 增量增加可选 `localApplication: true`。协商成功后，open 的
`options.localApplication` 携带 MCP 名、`hostToolsOnly` 和授权存储键的 SHA-256 摘要；
不携带调用方的 MCP URL、令牌或存储路径。接收方严格验证字段，并从自己的受控存储根
按控制端／中转身份派生应用目录，再构造到反向隧道的工具入口。

控制端及供应商组中转均要求实际执行端声明该能力；旧端不支持时拒绝启动，不丢弃隔离
声明继续执行。新端收到无该字段的旧请求保持原行为。应用的客户端工具经既有 MCP 通道
返回原调用方；`client-only` 禁止原生文件／命令反向请求。无需服务端或 Mobile 变更，
不扩大 IPC allowlist、设备权限或分享范围，不新增重放策略；一次来源失败不重启其他连接。
回归见 `local-agent/__tests__/remoteCatalog.test.ts`、`remote-agent/__tests__/roundtrip.test.ts`
与 `groupRelay.test.ts`，公开应用合同见 [本机 Agent API](../../local-agent-api.md)。
