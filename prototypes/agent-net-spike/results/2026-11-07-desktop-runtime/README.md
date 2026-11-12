# Desktop 私有中转 V2 接线 — 2026-11-07

这次把原型之外的生产包接到 Desktop 的实验开关、凭据库、加入/审批、部署控制器和本机中转。
源码尚未发布，未在真实用户服务器部署，也未完成全部 Device Link 业务与 Mobile 验收。
产品边界以 [`完整能力台账`](../../../../docs/product-rules/agent-net.md) 为准。

## 实现与边界

- `packages/agent-net` 提供现有 DeviceLinkClient 的 socket 适配器。证书目录固定根、账号、网络、
  设备签名密钥和 Noise 传输公钥；业务 src 来自认证通道，远控关闭的设备拒绝 link/invoke。
  V2 数据报只走独立服务或 UDP，未接入 V1 push 夹带。
- Desktop 开关经现有 Main IPC 持久化，失败恢复旧值；私钥只交既有 safeStorage，公开 bootstrap 可上传。
  私有配对关系持续至撤销，离线名册最多信任原始接收后的 14 天，缓存读取不会延长期限。
  官方账号证书仍最长 14 天，App 官方 enrollment 尚未接入。
- 本机是独立 V1/V2 内核加同源公共入口。SSH 安装器部署独立 V2 bundle，沿用原有 Node、
  systemd、ACME/Nginx 与进度；TCP 回环 3348，独立 UDP 3479。只上传公开 bootstrap，成功前验证固定根的名册。
  无 Nginx 时公共 TLS 前端读取原 V1 CLI 管理的证书材料并重载；没有给 V1 内核引入 V2 依赖。
- 加入链接的原字段保留，额外 V2 码让新 Desktop 同时提交两份持钥申请；主人验证配对证明和密钥绑定后一次批准。
  旧客户端继续 V1；加入不擅自开启本机 V2。首次启用后，关闭主人电脑的传输开关不停止服务其他设备的中转。
- 已知 V2 对端掉线不自动明文降级。先用签名的 V1 link 握手判断对端当前模式，V2 对端的业务仍留在加密流。
  已经开始的兼容请求仍在原连接回复，不能因中途选择变化把结果发到另一条连接。
- 正常构建校验源码/Cargo 与 WASM 摘要，使用仓内 359804 字节预编译包，不要求 Rust。
  修改核心才显式 `--refresh-prebuilt`；本轮没有改 Rust 协议算法。

## 验证

下列是本地源码测试与回环/容器验证，不是公网、真实 App 业务或手机后台验收。
在合并 `main` 到 `faa1ff31e5` 后重新检查客户端类型与定向测试；服务端内核和 wire 源码与客户端逐文件比对一致。

| 检查 | 范围 |
|---|---|
| Desktop 定向测试 | 73/73，6 文件：vault/身份 2、本机生命周期 17、配置 1、部署控制器 26、设备 API 8、开关/拓扑 19；合计 3.53 秒 |
| V2 socket 集成 | 8 项真实 Rust WASM + HTTP/WS/UDP + DeviceLinkClient；普通 RPC、流式大结果、伪造来源/远控开关、中转中断保留直连、撤销隔离、同时拨号、STUN 不返回、过期缓存 |
| 共用内核与服务 | wire 2、身份 6、内核真实网络/磁盘 12、服务配置/CSR 12，共 32 项；独立 Node 进程烟测通过 |
| V1 兼容 | 共享客户端与中转单测、真实签名配对与重连 interop；同源入口仍拒绝交叉使用两代认证 |
| 分发 | frozen-lockfile 安装、类型检查与 remote-bundles 暂存；缓存摘要覆盖 Cargo 及 WASM 输入变化 |
| 打包 CLI 实跑 | 启动 `resources/agent-net/relay.mjs` 独立子进程、临时测试 CA 和 TLS 公共入口，验证 V1 原路径、固定根配对、认证 WS、密文附件及跨协议认证拒绝，通过；未请求真实 ACME |
| 调度 / 文档 / 测试规范 | bundle 摘要与 workspace runner 自测 104/104；开发文档检查 10/10；测试规范门禁通过（352 文件在原有基线内） |
| Docker | 镜像 `31c215d1150c` 构建、认证 WS、配对、密文附件、Linux 引擎宿主访问实际发布 UDP、命名卷重启、无官方 enrollment，通过 |
| UI | 连接页全部 5 场景 × 明暗两模式 10/10；新文案的开/关场景 × 12 语言 × 明暗两模式 48/48；不涉及真实账号、SSH 或在线设备 |
| i18n | 12 种语言结构与术语门禁通过；不是母语审校或全产品文案审查 |

两个时序问题有真实回归用例：

1. 两端同时拨号不能各自留下不同连接：现在按认证设备 ID 决定同一方向，重复通道立即结束。
2. 撤销一台设备后，晚到的数据报曾以越权为由关闭健康发送者的整个 WS，连带中断第三台设备的 RPC。
   成员到已撤销目标的数据报现按 UDP 语义丢弃；访客越权仍拒绝，客户端撤销通道不排空旧业务。

STUN 查址不阻塞首条 RPC；未完成的查址可随节点关闭取消。初次升级被 401/403 拒绝时，不能拿离线名册重建已被拒绝的身份。
Windows → Podman VM 发布 UDP 的链路此前超时；本次明确从 Linux 容器引擎宿主测试发布端口，不能声称该 Windows 转发链已通过。
本机锁文件安装校验附加 `--offline --ignore-scripts`，Docker 内正常 frozen 安装和构建通过；没有把本机跳过的原生安装脚本记作已执行。
新增开关说明在中、德文截图中分别目检了 Light/Dark 布局；48 场景另有 10 条既有离线设备标签截断告警，未将其当作新增文案溢出。

## 复跑

客户端仓根：

```sh
pnpm install --frozen-lockfile
pnpm --filter @cindy/agent-net typecheck
pnpm --filter @cindy/agent-net-protocol typecheck
pnpm --filter @cindy/agent-net-relay typecheck
pnpm --filter @cindy/device-link exec tsc --noEmit
pnpm --dir apps/desktop typecheck
node scripts/test-workspaces.mjs --tier unit --workspace @cindy/device-link,@cindy/device-link-relay,@cindy/agent-net-protocol,@cindy/agent-net-relay
node scripts/test-workspaces.mjs --tier integration --workspace @cindy/agent-net,@cindy/agent-net-relay
pnpm --filter @cindy/device-link-relay run interop
pnpm --dir apps/desktop exec vitest run src/main/device-link/__tests__/agentNetRuntime.test.ts src/main/device-link/__tests__/selfHostedRelayRuntime.test.ts src/main/device-link/__tests__/selfHostedRelayConfig.test.ts src/main/device-link/__tests__/selfHostedRelayDeploy.test.ts src/main/device-link/__tests__/deviceLinkApi.test.ts src/renderer/features/remote-connection-v2/__tests__/topologyModel.test.ts
node --test scripts/__tests__/remote-bundle-inputs.test.mjs scripts/__tests__/test-workspaces.test.mjs
pnpm --dir apps/desktop build:remote-bundles
pnpm ui:check --page remote-connection-v2 --case all --theme all
pnpm ui:check --page remote-connection-v2 --case default,legacy-off --theme all --locale all
pnpm check:i18n
pnpm check:i18n-glossary
```

服务端仓根：

```sh
pnpm install --frozen-lockfile
pnpm agent-net:typecheck
pnpm agent-net:test
pnpm agent-net:build
pnpm --filter agent-net-server test:smoke
docker build -f agent-net-server/Dockerfile -t cindy-agent-net:local .
pnpm --filter agent-net-server exec tsx scripts/smoke.ts --docker --udp-from-engine-host
```

## 未验收与下一步

现有媒体总仓仍使用选中的 V1 自建存储；供应商分享/共享任务保留官方兼容连接，尚未把业务授权和分享入口搬到 V2 端设备。
通知桥接口不是手机系统推送。官方 App enrollment、Mobile 原生模块、LAN 冷启动发现、运行时进程隔离，
以及旧版明文提示/仅加密开关还没完成。已配对的 V1 成员仍须补充 V2 身份，不能把打开开关当成自动迁移。

SSH 部署控制器使用模拟执行器；没有实际重启用户服务器或当前 Cindy。真实 systemd/ACME/Nginx/防火墙、
任务/文件/远程桌面/媒体/分享的完整入口、手机后台/锁屏、Mac 和手机真实网络仍须分别验收。
此前宽泛的 `ui:check --changed --theme all` 扩展到大量无关页面，已停止，不能记作全仓 UI 通过。
早先的测试规范门禁被两份未改动 Bot 测试里的 `resetModules` 阻断；合并更新后复测通过，本轮没有修改这两份文件或放宽基线。
