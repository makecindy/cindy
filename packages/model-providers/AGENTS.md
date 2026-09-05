# 模型目录维护入口

新增模型或修改窗口、价格、推理档位、默认值之前，先读
[`../../docs/dev-rules/model-catalog-maintenance.md`](../../docs/dev-rules/model-catalog-maintenance.md)。

本包的内置目录是客户端兜底，不能替代 Cindy Server 的发布目录。先核对公共目录接口、
当前生效的 registry revision 与实际路由，再决定应修改 Server 数据、客户端兼容代码，
还是两者都改。Pi 原生目录有独立来源，不从订阅 registry 推导公共 API 配置。
