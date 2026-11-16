# Agent-Net V2 接线与交付验证（2026-11-08）

客户端分支 `feat/agent-net-phase0`，服务端分支 `feat/agent-net-server`。此记录区分源码实现、本地验证和目标环境验收。
给部署同事的操作手册位于服务端仓 `docs/agent-net-deployment-guide.md`，接口契约为 `docs/agent-net-server.md`。

## 已接入的生产路径

| 用户行为 | 生产入口与结果 |
|---|---|
| 官方、自建、本机中转、加入别人的中转 | Desktop `agentNetRuntime`、`selfHostedRelayRuntime/Deploy`；Mobile `agentNetRuntime/Pairing`；同一 V2 内核，V1 内核并行 |
| 自建服务独立运行 | 主人签名 bootstrap、配对审批、持久名册、STUN、独立 WSS 密文转发；不向官方 Agent-Net 登记 |
| 任务、文件、远程桌面等现有调用 | 保留 DeviceLinkClient 的业务协议/处理器，以 V2 socket 替换传输；共享任务和供应商分享另有资源授权，不能借此取得整个设备权限 |
| Desktop 供应商分享 | `providerShareApi/Host/Guest` 接入 V2 邀请、申请、审批、暂停/恢复/移除/退出；请求 ID 和成员 ID 固定到原中转 |
| 供应商组执行电脑 | 主人签名背书准确的同账号执行电脑证书、generation 和到期时间；原生 Guest 到执行电脑 RPC 通过；旧代次撤销不删除新授权 |
| Desktop/Mobile 共享任务 | `sharedTaskApi` / `useSharedTaskApi`；独立邀请与加入，资源 Host 本地最终权限检查，账号边界作废旧结果 |
| 多条私有来源 | `agentNetSharing` 与 `RoutedDeviceLinkClient` 按根、网络和资源固定线路；来源掉线只暂停其自己的资源，保留已知列表但不刷新权限期限 |
| 第二台同账号设备恢复来源 | 当前自有网络同步设备签名的公开来源；不传邀请、私钥、transport seed、Access Token 或资源内容；新设备仍须出示自己的账号/设备证明 |
| 附件与视频 | 同设备及两类分享绑定接收者和资源；Desktop 按 Range 解密，Mobile 视频/音频以原生 loopback Range 按需解密；普通文件使用既有媒体总仓 |
| 手机通知 | 独立通知密钥、服务端密文投递、原生后台解密/验签/时间窗/重放去重；APNs/FCM 使用运营方匹配 App 的提供方或桥 |
| 仅允许加密 | 无官方证书的私有访客仍可加入明确的私有邀请；已固定资源不能回落官方；V1 旧资源只在允许兼容时可用 |

Mobile 供应商分享继续遵守原产品规则：手机展示/转交邀请，在电脑上运行供应商，不新增手机供应商执行能力。
本机中转的 Host API 使用回环地址，跨电脑分享必须配置可达的 HTTPS 对外地址。稳定域名、network ID、根公钥不能随发布改变。

## 验证结果与复跑

2026-11-08 Windows 工作区执行：

| 命令/范围 | 结果 |
|---|---|
| Desktop 的 Agent-Net、部署控制器、共享任务、供应商、媒体相关 12 个 Main 测试文件 | 458 项通过，4.49 秒 |
| 拓扑、设备弹层、设置深链 3 个文件 | 39 项通过，3.98 秒 |
| Device Link 原有协议与新路由 5 个文件 | 422 项通过，18.78 秒 |
| 构建输入、测试 workspace、设置搜索 runner | 120 项通过；多语言与术语检查通过 |
| Mobile 身份、通知、媒体、账号边界等 9 个文件 | 122 项通过，6.42 秒；视频 App 入口单独 0.98 秒 |
| `pnpm test:agent-net-native` | Rust ABI 测试和 SDK 27 项全部通过；真实原生库，不跳过 native 测试；按需视频仅取头部/所需块，撤销中止新读取 |
| `pnpm --filter @cindy/agent-net-relay test` | 31 项通过；实际 HTTP/WS/UDP、存储、撤销重启；目录容量保护与共同推送桥配置通过 |
| `pnpm check:test-hygiene` | 351 文件在允许基线内，通过；本次未增加基线额度 |
| Mobile `tsc --noEmit` | Windows 和 Mac 通过 |
| Desktop 增量 `tsc --noEmit` | 通过 |
| 服务端 `agent-net:typecheck/test/build` | 通过；协议 4、内核 31、服务 16 项；旧 V1 类型检查和 146 项回归通过 |

本地详细日志位于忽略的 `artifacts/agent-net/full-delivery/`，不提交用户数据或生成构建产物。
新增 Main 分享测试单独约 1.5 秒；Mobile 分享约 1.2 秒。真实 socket/原生互通留在 integration tier。

`ui:check --page remote-connection-v2 --case default,legacy-off --theme all --viewport 1180x1500`
四个变体通过，已目检浅色/深色总览和单图，包含 V1/V2 不同中转说明。
全分支 `ui:check --changed --theme all` 的关联构建持续增长至约 7.6 GiB 内存后由本任务终止，未完成；
上述定向检查不覆盖其它页面、实时 IPC、真实 RTT、SSH 切换或远程桌面。完整 UI 门禁留给 CI/相应环境。

专用测试 Mac 使用独立 checkout，iOS/Android 原生构建、安装通过。模拟器原生探针包含：

- 签名身份匹配与验证；真实 UDP；Bonjour/NSD。
- 1 MiB 分块加密媒体；错误资源绑定和篡改拒绝。
- loopback Range、错误令牌拒绝；AVPlayer/ExoPlayer 实际加载、播放与跳转。
- 通知密文解密、验签、时间窗与重复拒绝。

Mac 上后续 JS 更新前核对原生模块、插件与 Rust 源码和上述构建一致；不把 JS 热加载误报成新原生构建。
这些探针使用测试身份，不登录真实账号，不证明真实 APNs/FCM 已送达。
最终 iOS `mobile:sim:up` 返回 `READY`，原生匹配、bundle 与前台均验证；两端探针包含
`mediaStreamVerified`、`nativeVideoVerified`，全部为 true。早前前台检测与 Android 冷启动 UDP 超时已在重跑中复核。
最终 `mobile:sim:logcheck` 通过；保留一条非失败提示：`setLayoutAnimationEnabledExperimental is currently a no-op in the New Architecture.`
它不表示网络或视频探针失败，完整 UI 行为仍以对应页面验收为准。

服务端最终本地镜像 ID：`sha256:28a3ff93feb6cc55993883664da06dcc869d27e1ca3b4267af841166d7ee3b9c`。
实际 Docker 烟测通过健康、主人配对、认证 WS、加密媒体、引擎宿主到发布 UDP 端口、重启及无需官方登记。
此 ID 是本地镜像，不是已发布镜像 digest；Windows → VM 的 UDP 转发和公网入口需另测。

## 交接后必须记录的环境结果

源码实现和自动化回归已覆盖上述路径；仍不能用它们签署“全部业务无损上线”。目标环境需分别验收：

1. 实际 SSH/systemd/ACME、防火墙、HTTPS/WSS 与公网 UDP；自建服务器和本机中转两种入口。
2. 屏蔽官方 Agent-Net 后，以真实账号测试任务、文件、远程桌面、两类分享及执行电脑；两条私有来源独立恢复。
3. V1/V2 混用、仅加密、退出重入、服务重启、账号切换；保留旧 V1 数据和入口。
4. 物理手机前台/后台/锁屏/系统结束进程、点击恢复、撤销及旧通知隔离，APNs/FCM team/topic/project 必须匹配。
5. 真正 2 GiB 文件和大视频性能；Mobile 原生暂无独立 STUN 查询，局域网/候选直连与 WSS 保底需在目标 NAT 下验收。

没有发布生产服务、区域端点清单或 App 安装包；未动生产签发/推送凭据。上线继续遵循两仓已有部署与原生冷更把关规则。
