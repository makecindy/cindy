# 模型目录维护入口

新增模型或修改窗口、价格、推理档位、默认值之前，先读
[`../../docs/dev-rules/model-catalog-maintenance.md`](../../docs/dev-rules/model-catalog-maintenance.md)。

公共模型、供应商预设、接口声明、Harness 参数和默认型号仅来自 Cindy Server 的发布目录。
本包初始目录为空；宿主可安装当前服务端发布，并在离线时读取同源的上次有效快照（LKG）。
不恢复随包 JSON、OSS 回填或 Pi 静态模型表。客户端只维护用户自己的连接、凭证与显式配置；
LKG 是服务端数据的只读镜像，不是另一个可编辑配置源。Pi 的模型和协议仍需服务端独立声明，
不得从订阅 Registry 或其他 Harness 的名单推导。
