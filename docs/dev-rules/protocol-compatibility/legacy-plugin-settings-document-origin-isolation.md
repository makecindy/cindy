# 原插件设置页的文档来源隔离

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`settings:open` 可选返回 `documentIsolation: true`；新手机仅见到明确标记后才在既有
加密 settings 通道发送 `{ kind: "document", epoch }`。epoch 是单租约内递增的正安全整数，
相同值幂等、较旧值拒绝；不增加 channel、权限或持久化字段。Host 每代生成的 UUID
继续使用插件既有 `mobilePageId` 契约，旧来源只保留同租约通知投递资格，不能创建或回答
新确认、目录选择或其它交互。关闭租约清理全部来源。

旧手机连接新 Host 时忽略新增能力、沿用旧语义；新手机连接旧 Host 时不发新命令，
配置读取、保存与包内导航照旧，完整跨文档确认隔离须两端都更新。插件本身无需更新，
不改变已装批准、凭证、KV、版本或原生指纹。实现与时序验证见
[原配置页协议](../../remote-plugin-oauth.md#手机原配置页授权的增量能力)。
