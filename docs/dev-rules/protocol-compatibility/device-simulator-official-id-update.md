# 设备模拟器官方 ID 更新

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

市场请求携带 `x-cindy-plugin-migrations: simulator-id-v1` 表示客户端支持这一次官方
`baguette-simulator` → `cindy-simulator` 安装身份迁移，不是权限或发布者凭证。
Server 保留原市场资源 ID 和不可变旧 Release；无能力声明的客户端继续获取旧 ID 包。
有声明的客户端获取新 ID 包，列表、详情、下载的 ghostId 必须与选中包的 manifest.id 一致。
新客户端访问旧 Server 时仍按旧 ID 运行。只有 Server 全量升级且客户端支持已发布后，
才可审核上架新包；不能只靠引用改名宣称旧安装已迁移。
回滚 Server 前须通过既有版本选择恢复旧 Release；不可在新包仍为 current 时回滚到不识别迁移的 Server。
迁移过的客户端保留新安装和原数据键，不会自动降级成旧 ID 或再装一个旧副本。
事务失败回滚是恢复尚未提交的旧安装，不是支持任意降级客户端二进制。迁移后不得退回不认识
该 receipt 字段的客户端并重建注册表；回退应保留这段兼容读取能力，避免重新派生数据键。
