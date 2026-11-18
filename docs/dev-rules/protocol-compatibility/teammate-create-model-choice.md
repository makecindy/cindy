# 伙伴创建时选择模型

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

伙伴 `create` 表单块在 data 追加可选 `creationModelChain` 元数据，表示支持创建选模并给出默认首选。
旧端忽略该元数据，不会在通用表单中显示 JSON。新 Mobile 看到它才显示现有选择器；
显式选择时动作输入追加 `modelChain`（单条既有 BotModelRoute 的 JSON），省略即跟随伙伴默认。
选择不改全局默认。
主机复用设置页的模型可用性验证；旧手机省略字段照常创建，新手机连接旧主机保留原创建流程。
丢失回执后的重试仍沿用原 requestId 和原模型选择，不覆盖已创建伙伴。
无新增 channel、权限、数据库 migration、服务端改动或原生 fingerprint 变化。
