# Device Link 测试与跨仓互操作

客户端与 relay 服务端独立维护、独立发布。客户端仓不启动服务端源码，不依赖私有仓或生产凭据。

## 一条命令验证连接恢复

在本仓完成 `pnpm install --frozen-lockfile` 后运行：

```bash
pnpm test:device-link
# 兼容既有 Mobile 入口；无需修改 Mobile package.json 或 runtime fingerprint
pnpm --filter mobile test:e2e:reconnect:local
```

两者运行相同套件：`scripts/device-link/reconnect.test.ts`。测试创建仅监听
`127.0.0.1`、端口由 OS 分配的 WebSocket fixture，结束或断言失败后关闭 socket 与恢复定时器。
不需要 Redis、数据库、开发登录接口、真实账号、Metro 或模拟器。

套件另用独立子进程把 `--interop` 入口接到已启动的 fixture，核对指定地址确实被连接、
不会静默回退，以及 URL/token 不进入输出；该检查仍不代表真实服务端互操作已验收。

`client-ci` 的 `verify-checks` 必跑这条命令，失败会阻断汇总的 `verify`；
公开 fork PR 无需 secrets。它与现有单测互补，不替代 `pnpm test:unit:related`。

### 实际运行哪些生产模块

- Desktop 与 Mobile 共用的 `DeviceLinkClient`：真实 `ws` socket、hello、可靠握手、
  ACK、请求配对、心跳和自动重连；没有手工制造客户端 close/online 回调。
- Mobile 的 `DeviceLinkTopicRegistry`、`PeerRecoveryScheduler` 和
  `rehydrateDeviceLinkPeer`：通过真实 invoke 补订阅、消息与输入状态快照。
- Desktop 的 `createSubscriptionReplayScheduler`：首次订阅失败后通过真实链路退避重试。

`clientHarness.ts` 只提供测试账号、内存消息/IPC 和恢复核心的宿主适配。
它不挂载 React Provider、不启动 Electron/Agent/SQLite；前后台与 host 重启用例验证
恢复核心的 pause/resume 和 client 实例重建，不代表真实 iOS 杀进程或 OS 网络事件接线已验收。

### 固定回归场景

| 注入故障                               | 必须验证                                                            |
| -------------------------------------- | ------------------------------------------------------------------- |
| 控制端 TCP 断开                        | 同一个 client 自动创建新 socket，补回订阅、缺失消息和输入状态       |
| 后台释放订阅、前台返回                 | Mobile 恢复核心补齐数据，健康 socket 不被替换                       |
| 网络路径半开、出站帧黑洞               | 心跳自行发现失活，网络恢复后同步继续                                |
| 两个控制端共用被控端，其中一个停止 ACK | 仅故障 peer 被复位；另一端的在途请求、新请求和 host socket 保持可用 |
| 返回结果帧丢失                         | 可靠重发最终交付，同一请求不重复执行                                |
| 被控 client 实例重启                   | 新可靠流重新握手、补订阅与权威快照                                  |
| relay close 1013                       | 自动重连遵守拥塞冷却，前台 connectNow 不绕过冷却                    |
| Desktop 首次订阅瞬态失败               | 既有订阅调度器自动重试并真正送达                                    |

时间采用真实定时器，注入较短、有限的 timeout/backoff；等待具体状态，不依靠固定 sleep
猜测完成。1013 用例注入关闭码，验证客户端冷却；服务端聚合背压算法、重放洪峰公平性仍由
服务端集成测试与共享客户端的预算单测覆盖，不能据此声称生产背压全链路已通过。

## 显式连接独立测试 relay

```bash
# 由独立测试环境注入，不要把 token 写在命令、仓库文件或日志里：
# CINDY_TEST_RELAY_URL          完整 ws(s)://.../api/device-link/ws，无 query/凭据
# CINDY_TEST_HOST_TOKEN         测试被控设备的短期 access token
# CINDY_TEST_CONTROLLER_TOKEN   同一测试账号、另一测试设备的短期 access token
pnpm test:device-link --interop
```

此入口运行 `scripts/device-link/interop.test.ts`，使用当前 checkout 的正式客户端连接
外部 relay，验证握手、Mobile 同步和本端 socket 断开后的自动恢复。缺少配置直接失败，
不会静默 skip、回退本地 fixture，也不尝试旧开发登录接口。身份从 hello-ack 获取，
不硬编码服务端 deviceId。输出不打印 URL/token/鉴权头。

仅使用**专用隔离测试环境**签发的两台测试设备身份，不能使用日常账号或正在连接的设备：
用例会注册一个允许被控的内存 host，并主动断开自己创建的 socket。脚本不启动、停止、
清库或修改外部服务，测试环境创建和销毁由其所有者负责。

独立 relay 需要其自身的测试 auth/JWKS、Redis 与数据库。服务端仓按自己的文档与
CI 运行鉴权、跨账号隔离、多实例路由和真实背压测试；客户端公开 CI 不 checkout
该仓、不跨仓源码 import、不使用 submodule。互操作验收记录应包含客户端 SHA、
服务端构建版本和实际结果，不能将本地 contract fixture 的通过结果当成此项通过。

## 分层覆盖与维护

| 层                    | 入口/源                                                               | 主要职责                                                           |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 共享协议/客户端单测   | `pnpm --filter @cindy/device-link test`                               | 能力降级、分片/ACK/预算、可靠顺序、故障半径、allowlist/topics      |
| Desktop main/renderer | `apps/desktop/src/**/__tests__/deviceLink*.test.*` 及远程同步相关测试 | IPC 双层门禁、requestId 去重、outbox、镜像对账、连接状态和来源保护 |
| Mobile 单测           | `apps/mobile/src/__tests__`                                           | 快照/订阅核心、peer 调度、页面接线与本地状态                       |
| 本仓真实 socket 集成  | `pnpm test:device-link`                                               | 正式客户端与恢复核心在实际 WS 断链/丢帧下的协作                    |
| 外部 relay 互操作     | `pnpm test:device-link --interop`                                     | 当前客户端与显式提供的独立测试服务实际互通                         |
| 独立服务端测试        | 服务端仓自己的测试入口                                                | JWT/JWKS、账号边界、Redis/数据库、多实例路由、限流与背压           |
| 实机验收              | 手机 + Desktop                                                        | 原生 AppState/网络切换、OS 休眠、GUI、真实 Agent 和长时间弱网      |

修改恢复逻辑时同时更新定向单测与本仓 socket 场景，避免单 peer 测试掩盖共享连接的
故障放大。修改 wire 时按 [协议兼容规则](../../docs/dev-rules/protocol-compatibility.md)
核对两端实现，并运行独立 relay 互操作；只改 fixture 不能证明跨版本兼容。

测试资源和日志遵守 [本地存储规则](../../docs/dev-rules/credentials-and-local-storage.md)。
真实故障率需要结合业务请求成功率、恢复时间与其他 peer 是否受影响衡量，
不把每次 heartbeat miss 都等同于用户故障。
