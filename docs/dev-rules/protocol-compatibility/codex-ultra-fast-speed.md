# Codex 超快速度

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

客户端内部沿用 `fastMode`：`false` 为标准、`true` 为快速、`"ultrafast"` 为超快。
SQLite 的原有 `fast_mode` 列保留 0/1，新增值 2；Drizzle 与原始 SQL 写入共用映射，
不修改历史 migration。旧客户端读到 2 时回落标准，不破坏已有 0/1 数据。

远程任务／自动化／收藏读模型与设置推送保持旧布尔字段，超快另外携带
`fastModeTier: "ultrafast"`（收藏为 `fastTier`）。新客户端在传输入口恢复内部速度值，
旧客户端继续读取快速开关；消息正文与工具输出不做转换。写操作仍由 Host 按当前账号、
模型及执行引擎校验。新版连接旧 Host 时没有 `supportsUltrafastMode`，不显示超快选项。
新建超快收藏在旧端可读，但旧端无法精确编辑该档位；冲突检查保留 Host 原配置。

新建任务默认值读取与草稿变更推送沿用同一投影；按模型保存的 `fastModeByModel` /
`fastByModel` 保留布尔字典，用 `fastModeByModelTiers` / `fastByModelTiers` 附加档位。
伙伴 `capabilities` 中的 `modelChain`、`modelChainOverride`、`modelOverride` 同样保留
旧布尔字段。仅遍历这些明确的设置结构，不扩展到任意内容对象。

`supportsUltrafastMode` 只来自账号的 Codex `model/list` 或缓存的 `service_tiers`，
不能按模型 ID 或全局 registry 推断资格。完整的超快配置需要执行端与查看端都支持本功能。
没有服务端、原生 Mobile 配置或模型内核版本变更。
