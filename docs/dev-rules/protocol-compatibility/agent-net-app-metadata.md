# Agent-Net 节点 App 自报标识（2026-11-13）

> 通用规则见[跨端协议兼容](../protocol-compatibility.md)；产品规则见
> [Agent 网络「节点与能力」](../../product-rules/agent-net.md#节点与能力)。

## 字段与边界

- `packages/agent-net-protocol` 的 `DeviceMetadata.app?: string` 是 presence 的可选顶层元数据。
  字符规则为 `ID_PATTERN`，首字符为字母/数字，其余允许字母、数字和 `._:@/-`，长度 1–64。
  已知值为 `cindy`、`cindy-friend`，格式合法的未知值照常接受；非法值以现有 WebSocket `1008 / invalid control` 拒绝。
- 内核把 app 合并进会话元数据，并随首帧稳定元数据持久化到 `device.metadata`；目录展开设备与会话元数据，
  因而离线、重启和 capabilities 清空不丢 App 名。旧帧省略字段不抹去已存值。
- `HelloPayload`、`PresenceSnapshot`、Device Link `DeviceView` 及 Desktop 的目录投影增加可选 app，
  把 App 标识送到实时分流与桌面/手机共享可控列表；Cindy 两端 hello 显式报 `cindy`。
  Node SDK 和 portable SDK 都把元数据传入 presence；V1 服务不需要实现这个标识。
- 在线对等帧省略 app 时，用已验目录或同一节点的已知 App 补齐；目录更新也发布给已有在线对等连接。
  Desktop 冷启动目录与实时 presence 共用 App 缓存，缺省帧不擦除已知值，显式值可替换；
  账号/连接边界仍按原入口清空进程内缓存，未知旧设备继续按 Cindy 处理。
- App 与 platform 都是自报值，只用于体验和分流。登录、成员证明、控制开关、撤销名单、通道白名单与最终授权不变。
  **设备证书仍是原来的固定 11 字段，不加 app；capabilities 仍仅为在线能力。**

## 混版本与发布

| 客户端 | 中转 | 结果 |
| --- | --- | --- |
| 新 | 新 | 保存并展示 app，离线与重启保留，按 App 分流 |
| 旧 | 新 | 省略 app 继续工作；旧目录验证只检查证书，忽略新元数据 |
| 新 | 旧 | 旧中转静默忽略 app，连接与业务不变；目录无 app 时按旧版 Cindy 展示 |
| V1 行或缺省 app | 任意 | 按 Cindy 处理，原设备行为不变 |

客户端与服务端可独立升级，没有强制升级窗口。服务端仓在其本地同名 protocol/relay packages
落相同校验、序列化、持久化和 fixture，随 agent-net-server 部署；不从客户端仓跨仓 import。
自建服务器和本机中转消费同一内核，不新增私有协议或额外授权步骤；已部署旧中转继续可用，
升级内核后获得标识保留能力。随包双内核中转的 `RELAY_VERSION` 从 `0.5.1` 升到 `0.5.2`，
沿用现有打包与升级入口，让已部署自建中转能看到升级提示；本机中转随新版随包程序启动。

## 验证入口

- Relay `relay.integration.test.ts`：真实 WS/HTTP/临时存储，覆盖非法格式、64 字符边界、未知 App、旧帧、
  离线及重启后的目录保留，证书验签与原始不透明数据报互通继续运行。
- SDK `portableClient.test.ts`：实际签名/握手与 presence 序列化；既有 socket integration 覆盖混用 V1 和 V2。
- Desktop `agentNetRuntime.test.ts`、`deviceLinkControllerPresenceDirectory.test.ts`：目录投影与冷启动缓存；
  `remoteControlConsent.test.ts`、`dictionarySyncDriver.test.ts`：不向其他 App 发送 Cindy 专用交互。
- 共享 `deviceList.test.ts`、Desktop `myDevicesModel.test.ts`、拓扑 model/popover/batch：其他 App 不进可控目标、
  不出现被控异常、不探测远程切换，缺省值继续原行为；Mobile directory/presence 用例验证同一 app 不在投影中丢失。
- Desktop 新任务/远程项目选择器、机器切换栏和自动项目同步同样使用 App 分流，覆盖在线、离线及误识别后残留的缓存。
  用例在 `controllableDevicePredicate.test.ts`、`machineSwitcher.test.ts`、`deviceLinkRemoteProjects.test.ts`；
  `deviceLinkDeviceListLoading.test.tsx` 验证仅 app 变化时仍发布新目录，避免列表永久沿用首次识别。
- 真实组件场景：`remote-connection-v2` 的 `app-nodes` / `app-nodes-list`，覆盖已知/未知 App、离线标识与旧版 Cindy，
  两种主题及各语言复用同一资源。界面场景不等于真机网络验收。
