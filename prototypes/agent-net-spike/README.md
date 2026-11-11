# agent-net 验证脚本

只用于验证方案，不进入产品构建，也不是 pnpm workspace 的一部分。第 0 阶段结论见
[`docs/agent-net-plan.md`](../../docs/agent-net-plan.md) §2，第 6 步见 [`results/2026-11-05-edgehub-core`](results/2026-11-05-edgehub-core/README.md)，
第 7 步见 [`results/2026-11-05-traversal`](results/2026-11-05-traversal/README.md)。

2026-11-07 连接号轮换后复跑：Node 驱动 6/6，EdgeHub 的 core／relay／push／punch 各 12/12，
包括加密与路径附加检查；换端口时另查两端换号、旧号作废计数。详见
[`连接号轮换记录`](../../packages/agent-net-core/sim/results/2026-11-07-id-rotation/README.md)。

> 2026-10-30 路线改为自研传输，iroh 不进产品。这里的 iroh 代码只保留作性能参照。
> 2026-11-05（第 6 步）`edgehub.ts` 改成可以换传输：默认跑自研核心（`transport-core.ts`），QUIC（`transport-quic.ts`）留作对照，
> 两种传输跑同一套检查。
> 第 7 步自研传输可以经中转转发（`relay-client.ts`：自建中转的专用通道，或夹带在现有中转的 push 里），先经中转连上，再打洞换到直连。

第 0 阶段 2026-10-30 在一台 macOS 26（arm64）上运行，第 6 步 2026-11-05 在一台 Windows（x64）上运行。
除非注明，都是本机回环，**不是真实网络指标**。

2026-11-07 新增独立 V2 服务接缝：

```sh
pnpm --dir prototypes/agent-net-spike exec tsx --tsconfig tsconfig.json poc-edgehub.ts v2
pnpm --dir prototypes/agent-net-spike exec tsx --tsconfig tsconfig.json poc-edgehub.ts v2-punch
```

两种方式都只起 V2 自主中转，阻断非回环 fetch，不启动 V1 fixture 或请求官方服务。
设备经主人配对证书加入，实际 Noise 密钥绑定已签名目录；第一种关闭 UDP，第二种使用自己的 STUN、
先经中转再直连。运行同一套 12 项 DeviceLinkClient 检查，并增加密文/实际路径验证。
这仍是原型接缝，不是 App 的 V2 开关、安装器、共享业务授权或原生推送实现。
随后新增的生产包 `packages/agent-net` 与 Desktop 私有中转接线不再依赖原型构建；
当前范围、分层测试、打包方式与剩余项见 [`Desktop 接线记录`](results/2026-11-07-desktop-runtime/README.md)。
2026-11-08 的 Mobile 原生、App 私有分享/多资源路由和执行电脑接线已进入生产 packages；
本原型不承载这些业务，当前验证与部署交接入口见 [`交付验证记录`](../../docs/agent-net-delivery-verification.md)。

## 准备

自研传输要先编好核心的 WebAssembly（`rustup target add wasm32-unknown-unknown`）：

```sh
(cd ../../packages/agent-net-core && cargo build --release -p agent-net-wasm --target wasm32-unknown-unknown)
npm install --ignore-scripts   # tsx，以及 QUIC 对照用的 iroh；只跑自研传输时 iroh 不会被加载
```

第 0 阶段的原生基准：

```sh
cd rust-bench && cargo build --release && cd ..
```

iOS 编译要固定 libc（`libc` 0.2.190 之后 `in6_ifreq` 只对 macOS 开放，`netdev` 编译失败）：

```sh
cd rust-bench/mobile-size
cargo update -p libc --precise 0.2.189
cargo build --release --target aarch64-apple-ios
```

## 脚本

| 脚本 | 验证什么 | 结果 |
| --- | --- | --- |
| `npx tsx --tsconfig tsconfig.json poc-edgehub.ts [core\|relay\|push\|punch\|quic]` | 真实 `DeviceLinkClient` 经 EdgeHub 工作，业务帧不经 device-link 中转。`relay`、`push` 是 UDP 全被挡、只经本机起的自建中转转发数据报，`punch` 是先经中转再打洞。自研传输另查抓到的包里没有业务明文和该走的路径 | 五种都 12/12 通过，附加检查都通过 |
| `npx tsx --tsconfig tsconfig.json poc-core-driver.ts` | 自研核心 Node 驱动里 EdgeHub 碰不到的部分：大块数据、IPv6、传输途中换端口、拒绝握手、确认后再关 | 6/6 通过 |
| `node poc-lan.mjs` | 组播发现，账号派生轮换标签，其它账号的节点被忽略 | 2/2 通过，261 ms 发现 |
| `node poc-relay.mjs` | 自建中继回退、回调准入、自动升级直连。要先启动 `iroh-relay` 和准入回调 | 5/5 通过 |
| `node bench-quic.mjs <MiB>` | 官方 Node 绑定的开销 | 19.7 MiB/s |
| `rust-bench` | 原生 QUIC 与模拟瓶颈 | 见下表 |
| `node bench-wss.mjs <MiB>` | v1 形态的基线，`LINK` 和 `SHAPER` 环境变量可加瓶颈 | 见下表 |

## 第 6 步：EdgeHub 上的自研传输和 QUIC

同一个 Node 进程里跑全部 EdgeHub，两种传输轮流各 6 轮，详细见 [`本轮记录`](results/2026-11-05-edgehub-core/README.md)。

| | 自研（中位数） | QUIC 经官方 Node 绑定（中位数） |
| --- | ---: | ---: |
| invoke 往返 p50 / p95 | 0.44 / 0.92 ms | 0.76 / 1.26 ms |
| 3 MiB 结果送达 | 221 ms | 620 ms |

## 第 7 步：经中转和打洞

四种方式轮流各 3 轮，详细见 [`本轮记录`](results/2026-11-05-traversal/README.md)。中位数：

| 方式 | invoke 往返 p50 | 3 MiB 结果送达 |
| --- | ---: | ---: |
| 只走 UDP | 0.47 ms | 286 ms |
| UDP 全被挡，经自建中转的专用通道 | 0.66 ms | 611 ms（7 次的中位数约 300 ms，慢的几次是电脑负载） |
| UDP 全被挡，夹带在现有中转的 push 里 | 0.63 ms | 292 ms |
| 先经中转，再打洞换到直连 | 0.41 ms | 237 ms |

## 第 0 阶段基准

模拟链路：100 Mbit/s、单向 20 ms、队列 50 ms，由 `rust-bench` 的 `shape-udp` / `shape-tcp` 提供。
QUIC 组要设 `STICKY_PATH=1`，否则 iroh 会自动找到更优路径绕过瓶颈。TCP 一侧无法注入丢包，这里只比较限速和时延。

| | 空闲往返 | 满载交互 p50 | 满载交互 p95 | 吞吐 |
| --- | ---: | ---: | ---: | ---: |
| QUIC 原生（两次） | 44 ms | 51 / 74 ms | 54 / 79 ms | 10–11 MiB/s |
| WSS 形态（Node，无 TLS） | 44 ms | 246 ms | 270 ms | 8.8 MiB/s |

| 无瓶颈回环 | 建连 p50 | 吞吐 |
| --- | ---: | ---: |
| QUIC 原生 | 0.54 ms | 330 MiB/s |
| QUIC 经官方 Node 绑定 | 0.71 ms | 19.7 MiB/s |
| WSS 形态（无 TLS） | 0.36 ms | 328 MiB/s |

## 包体

| 平台 | 大小 |
| --- | ---: |
| iOS arm64（`opt-level=s`，strip） | 10.4 MB，gzip 4.0 MB |
| macOS arm64 官方绑定 | 12.0 MB |
| Windows x64 官方绑定 | 16.4 MB |
| Android arm64 官方绑定 | 18.0 MB |
| Linux x64 官方绑定 | 20.0 MB |
| `iroh-relay` macOS arm64 | 11.0 MB |
| 自研核心 WebAssembly（所有电脑平台共用一份） | 276 KB |

官方绑定是未压缩大小，且包含我们用不到的功能。

## 没有覆盖

两台真实设备、iOS / Android 真机、耗电、国内运营商、打洞成功率、经中继的吞吐、WSS 加密封装、EdgeHub 与上游 WSS 的合并。
第 6 步的 EdgeHub 只在本机回环上跑过，没有经 Electron `utilityProcess`，也没有丢包和抖动。
