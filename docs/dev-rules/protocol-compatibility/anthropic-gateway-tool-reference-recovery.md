# Anthropic 兼容网关的工具引用恢复（#8593）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 的 Anthropic loopback 代理在上游 400/422 明确报出
`content type tool_reference requires a native Anthropic Messages target` 时，
仅将 `messages[].content[]` 中 `tool_result.content[]` 的工具引用转换为保留工具名的文本，
沿现有恢复规则最多重试一次。工具定义、调用参数、结果对应关系和本地历史均不修改；
上游接受的原生引用不触发转换，未知错误照常返回。Tool Search 默认策略与用户显式配置不变。
没有设备协议、relay 或服务端变更；回退该恢复规则即可回到原来的上游错误行为。
