# 插件远程授权的实例身份

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

远程授权中的 `ghostId` 绑定实际安装的物理 storage part，不使用裸逻辑 ID 替代企业实例。
企业键 `_ns__<namespace>__<id>` 最长 167 字符；只对该合法键扩展校验，其他 OAuth
事务、设备与启动 ID 仍限 128 字符。签名 transcript、v3 字段及频道不变，不能截断或
增加 alias fallback。Desktop 与 Mobile 复用同一握手 parser；长企业键要求控制端也具备
该校验能力，旧端的短键行为保持不变。
