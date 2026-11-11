# 远程模型显式窗口（#9501）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:provider:list` 的模型行可选增加 `contextWindowOverride`，仅表示来源电脑的显式工作预算。
原 `contextWindow` 与 `contextWindowMax` 的默认／容量含义不变；远程 Agent 选择共用投影合入
有效窗口，设置页保留默认及恢复默认语义。旧提供端缺字段时沿用原值，旧使用端忽略字段；
提供端和使用端均升级后生效。分享备用执行目录在发布时将有效预算写进原 `contextWindow`，
不增加服务端字段。运行时仍在实际执行电脑读取本机窗口与压缩比例。

无新帧、channel、allowlist、权限、订阅或请求；官方及自建中转透传原 invoke JSON，无需升级。
回归通过供应商服务、隧道序列化、远程选择与备用目录发布生产入口验证；不改变连接恢复机制。
