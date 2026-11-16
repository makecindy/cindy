# GitHub 公共读取能力

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`git-context:github-read` 只在同账号授权链路开放，控制端先检查 `github-read-v1`。未声明的旧电脑返回明确不支持，既有 `pr-status` 的关联范围过滤与链接打开不变。新通道不进入共享任务访客 allowlist；中转仍转发原 invoke / invoke-result 帧，不引入服务器消息种类。关联新增 `associationSource / associationOrigin` 可选字段；旧消费者按原字段兼容，新消费者默认只显示宿主投影的明确有效关联。详见 [功能合同](../../product-rules/github-status-and-associations.md)。
