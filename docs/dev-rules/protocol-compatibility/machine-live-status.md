# 机器实时状态（2026-11-02）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增只读 invoke `maker:machine:status`（`packages/device-link/src/machineStatus.ts`），同账号远控可用，不进共享任务访客白名单。
没有新帧、能力位或 relay 行为，中转（含自建）只转发，不需要适配。旧被控端返回 `CHANNEL_NOT_ALLOWED`，控制端显示 `update_required`；
解析按字段容错，新版本多报的字段被忽略，缺的字段是 `null`，只有 CPU 核数与内存总量缺失才视为无效。

Node Host 装配该读取后，也在普通中转的同账号链路声明已有的 `background-link-v1`。查询沿用原通道、响应结构和授权；仅有活动状态缺失时，控制端仍可显示其余资源。已部署的官方和自建中转继续透明转发原有帧。手机设备列表沿用在线状态，无需发起资源查询。

设备目录中的 CPU 名称、总内存和系统版本来自 Desktop 与 Node Host 的 `hello.deviceInfo`，和按需读取的资源状态分开。Node Host 在首次连接前采集一次，沿用已有可选字段；macOS 优先报产品版本，读取失败时使用内核版本。
