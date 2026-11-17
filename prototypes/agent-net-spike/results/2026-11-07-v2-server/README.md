# 独立 V2 服务与自主中转验证 — 2026-11-07

本次是服务与协议接缝验证，不是 App 上线。实际端到端业务、混合版本、原生后台及系统推送尚未验收。
实现位于两仓的 `packages/agent-net-protocol` / `packages/agent-net-relay`，
独立服务在 `cindy-server/agent-net-server`；产品验收正本见
[`agent-net.md`](../../../../docs/product-rules/agent-net.md)。

## 已跑结果

| 检查 | 结果与范围 |
|---|---|
| 独立服务测试 | 29/29：wire 2、身份/内核 15、配置与官方 CSR 12；真实本地 HTTP/WS/IPv4/IPv6 UDP、临时磁盘与重启 |
| 客户端测试分层 | unit 的 wire/identity 与 integration 的真实网络分别登记并通过；workspace runner 自测 97/97 |
| 类型 / 构建 | 两个新 package、独立服务、原型类型检查通过；Node SDK/内核打包、服务产物及 Docker 构建通过 |
| V2，仅中转 | DeviceLinkClient 12/12 + 密文/路径 2/2；3448 个数据报都经 V2 中转，UDP=0 |
| V2，中转转直连 | DeviceLinkClient 12/12 + 密文/路径 2/2；3586 个包，其中 44 个经中转、3542 个经 UDP |
| 独立 Node 进程 | 健康、主人配对、WS 来源、密文附件、发布 UDP、重启保留目录/附件、官方 enrollment 404，通过 |
| Docker/Linux 宿主 | 镜像启动、主人配对、WS、密文附件、实际发布 TCP/UDP、命名卷重启、无官方 enrollment，通过 |
| Windows → Podman UDP | 未通过：发布端口请求超时；容器内与真正的 Linux 引擎宿主访问发布端口正常，不把该 Windows 转发链标为通过 |
| 目标环境 / 真实手机 | 未部署官方环境或用户服务器；无公网容器 UDP、系统推送、App 后台/锁屏、完整业务验收 |

V2 两种原型方式阻断非回环 fetch，不启动 V1 fixture。主人签发证书，名册的传输公钥来自已验证的目录，
并绑定真正参与 Noise 握手的私钥。测试中的 rogue 具有网络证书，但未被本机业务名册授权，
因此仍须在传输准入被拒绝。中转转直连的数字是同机回环，不可用作公网打洞成功率或性能结论。

这里的 push 是 DeviceLink 协议帧，并非手机系统推送；两类分享检查是委托准入/范围与附件，
不是供应商分享和共享任务的完整业务授权。附件范围/恢复检查使用小对象与分片，2 GiB 额度未做容量压测。
所有主人私钥只在验证进程内存中；中转仅收到公开 bootstrap、证书与密文。

## 复跑

客户端仓根：

```sh
node scripts/test-workspaces.mjs --tier unit --workspace @cindy/agent-net-protocol,@cindy/agent-net-relay
node scripts/test-workspaces.mjs --tier integration --workspace @cindy/agent-net-relay
pnpm --dir prototypes/agent-net-spike exec tsc --noEmit
pnpm --dir prototypes/agent-net-spike exec tsx --tsconfig tsconfig.json poc-edgehub.ts v2
pnpm --dir prototypes/agent-net-spike exec tsx --tsconfig tsconfig.json poc-edgehub.ts v2-punch
```

服务端仓根：

```sh
pnpm install --frozen-lockfile
pnpm agent-net:typecheck
pnpm agent-net:test
pnpm agent-net:build
pnpm --filter agent-net-server test:smoke
docker build -f agent-net-server/Dockerfile -t cindy-agent-net:local .
pnpm --filter agent-net-server test:smoke:docker
```

VM-backed 容器引擎的 Linux 宿主发布端口可显式用下列命令验证，不能替代上一条 Windows 侧链路：

```sh
pnpm --filter agent-net-server exec tsx scripts/smoke.ts --docker --udp-from-engine-host
```

后续接入必须按 [完整能力台账](../../../../docs/product-rules/agent-net.md#v2-自建与本机中转的完整能力2026-11-07-用户确认)
保留四种线路、原有入口和完整能力。本表记录首次服务接缝检查；后续 Desktop 私有中转的运行时/部署接线与补测见
[`Desktop 接线记录`](../2026-11-07-desktop-runtime/README.md)，仍不得仅因接缝检查通过就宣称「完全无损」。
