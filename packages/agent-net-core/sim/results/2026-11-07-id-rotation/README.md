# 连接号轮换（2026-11-07）

备用号交换、按路径换号、作废和补号已实现；尚未接入产品。先完成实现和测试，再更新本记录、核心 README 与计划。
环境：Windows x64，rustc 1.98.1（48a229cea），Node v24.22.1。核心 `[dependencies]` 仍为空。

## 实现

- 每条连接最多 8 个有效收包号：握手号 + 7 个备用号；`Endpoint` 随机分配，避开当前端口上的句柄和有效别名。
- 发往每条新路径的第一份验证包就取未用过的号；本地地址变化（通知或被对端验证发现）时轮换在用路径。
  只换端口也一样，验证失败和离开的路径用过的号作废，退回备用路径时重新取号。
- 加密控制帧 10 是带代次的完整快照：有效本地号列表、请求作废的对端序号列表；帧 11 确认代次。
  丢了重发，乱序不回滚，旧确认不能停止新快照的重发。普通数据包仍是 4 字节目的号，最大控制包 130 字节。
- 作废前的旧号继续接收；收到有效作废请求后立即删分发别名，迟到包直接丢，可靠层用新号补发未确认数据。
  关闭连接会删掉全部别名。上层仍用初始的稳定句柄，不受换号影响。
- 缺号暂用旧号、单独计数，新号送到后自动替换。直接使用 `SecureConnection` 时由驱动添加备用号、同步分发表；
  经 `Endpoint` 使用时自动管理。Rust、WASM、Node 均提供换号／缺号／作废／控制包／重发计数。

## 结果

| 验证 | 结果 |
| --- | --- |
| `cargo test --profile sim --workspace` | 128 通过，0 失败；沿用 1 个性能剖析用例、1 个文档示例的跳过 |
| 固定换网对照 | 306/306，两次实现均完整交付，防放大上限不变，无空转；需禁止的跨地址复用为 0 |
| 随机换网，启用备用号 | 0–1999 加 6 个历史回归种子，2006/2006；最终一轮 56.32 秒，不含编译 |
| NAT／中继切换 | 300 个随机种子和固定 NAT 组合、退回中继／再打洞全部通过；最终文件 34.80 秒 |
| 7 个专项连接号用例 | 交号和确认全丢、快照乱序、8 次连续通知耗尽号、有效号篡改、迟到旧号、关闭清别名、64 条连接撞号、共享号与两种连续换网回归；合计约 0.03 秒 |
| 变异测试 | 不换号、不作废、不重发、作废仍在用的号，4/4 被测试捕获 |
| Node 驱动 | 6/6，IPv4／IPv6、大数据、拒绝握手、结束流、知道／不知道换端口；换端口时两端换号且旧号作废 |
| EdgeHub 原型 | core、relay、push、punch 各 12/12；加密与路径附加检查均通过 |
| WASM release | 359804 字节；同工具链编译 `ebe20d411a` 为 334263 字节，增加 25541 字节（7.64%） |
| Clippy | 普通全工作区检查通过；严格 `-D warnings` 仍被原有告警阻断。独立编译原提交作对照，去重诊断均为 13 项，新增 0 项 |

Clippy 既有告警包括 `manual_checked_ops`、`needless_range_loop`、`chunks_exact_to_as_chunks` 等，
本次没有放宽仓库规则或修改无关代码。对核心、UDP、WASM 单独屏蔽已核实的三类原有 lint 后，`-D warnings` 通过；
不能将此写作整个工作区严格检查全绿。

专项用例并入已有 `secure.rs`，整个文件实测 2.44 秒。换网文件包含 306 场景各跑有号／无号两遍的对照，
实测 16.56 秒，属于 Rust 专用 integration tier，未进入 JS 默认 unit；较慢的原因是实际协议时序和网络矩阵验证。

### 306 场景对照

同一确定性网络、相同应用数据，`run_moves` 不提供备用号，`run_rotating_moves` 提供并补满 8 个。
17 个种子 × 知道／不知道换网 × 0／1%／10% 丢包 × 下载／连续换网／抢先复制，共 306 个场景。
连续换网含换端口，抢先复制每 8 包一次，领先 5 毫秒。逐行结果见 [`matrix.csv`](matrix.csv)。

| 合计 | 无备用号 | 轮换 | 变化 |
| --- | ---: | ---: | ---: |
| 完成时间（微秒） | 475453298 | 475003206 | −0.095% |
| 换网恢复时间（微秒） | 295470718 | 297260118 | +0.606% |
| 两端发出线上字节 | 1641485146 | 1656873558 | +0.937% |
| 作废后迟到的包 | 0 | 42 | 丢弃后数据仍完整 |

控制包会改变链路的队列和丢包抽样，单个场景可快可慢，不能声称速度和恢复逐项无变化。
新矩阵保留 5% 总用时、10% 恢复时间的聚合回归上限；原有换网用例的恢复、吞吐、防放大断言未改。

主动通知、且有备用号时，客户端新旧地址上的号无重叠；服务端发往不同真实地址的号也无重叠，
包括第一份验证包。客户端不知道换网时，被发现前的旧号包单独作为允许的边界，不作零重叠保证。
矩阵客户端缺号 0 次；服务端缺号 743 次，全部来自抢先复制场景中反复验证伪造地址，非攻击场景均为 0。
打洞还覆盖交号包尚在中继队列里就开始验证的情况：允许按既定规则暂用旧号，复用不能超过缺号计数。

## 测试找出并修复的边界

1. 握手尚未确认就换地址：初始号绑定需跟着握手回复走，否则会误把唯一可用号作废。
2. 号不足时验证路径借用数据路径的号：验证失败不能作废仍被数据路径引用的号。对应变异必须变红。
3. 刚跟随对端换路径，自己紧接着换网：拥塞估计的「最近换过」窗口不能抑制换号。
4. 一次系统通知后验证包全丢、随后又悄悄换网：旧通知不能使第二次验证漏掉换号。
   对新的目的号发来的验证仍轮换，重复验证只轮换一次；因此一次通知后发现新验证也可能再用一个备用号。

## 兼容与边界

新增控制帧尚无旧实验核心的协商，两端需一起更新；V1 Device Link 的帧、客户端和部署没有改变。
专用中继与 push 夹带均转发原有不透明加密数据报，不解连接号或控制帧；本机真实自建中转原型验证通过，
无需修改内核或重新部署。V2 独立服务端尚未实现或部署。

轮换只减少固定连接号造成的关联，不隐藏地址、时间、大小、明文包号等流量特征，中继仍认识两端。
系统未通知时发现前的包、缺号时的回退仍可被关联。本轮没有手机实机 Wi-Fi／蜂窝、后台／锁屏或真实公网复测，
旧真机结果不能当作这一版换号实现的实机验收。

## 复跑

在 `packages/agent-net-core`：

```powershell
cargo test --profile sim --workspace
$env:AGENT_NET_ROTATION_REPORT = Join-Path (Get-Location).Path 'target/id-rotation-matrix.csv'
cargo test --profile sim -p agent-net-sim --test migration rotating_ids_survive_the_migration_matrix -- --nocapture
Remove-Item Env:AGENT_NET_ROTATION_REPORT
$env:AGENT_NET_SEEDS = '2000'
cargo test --profile sim -p agent-net-sim --test migration rotating_ids_survive_random_moves -- --nocapture
$env:AGENT_NET_SEEDS = '300'
cargo test --profile sim -p agent-net-sim --test traversal -- --nocapture
Remove-Item Env:AGENT_NET_SEEDS
python sim/mutants.py '连接号轮换'
cargo clippy --workspace --all-targets
cargo build --release -p agent-net-wasm --target wasm32-unknown-unknown
```

`AGENT_NET_ROTATION_REPORT` 必须用可写路径；用绝对路径避免 Cargo 从 sim 包目录运行时解释错相对路径。
在 `prototypes/agent-net-spike`：

```sh
npx tsx --tsconfig tsconfig.json poc-core-driver.ts
npx tsx --tsconfig tsconfig.json poc-edgehub.ts core
npx tsx --tsconfig tsconfig.json poc-edgehub.ts relay
npx tsx --tsconfig tsconfig.json poc-edgehub.ts push
npx tsx --tsconfig tsconfig.json poc-edgehub.ts punch
```

本轮原型输出见 [`node-driver.txt`](node-driver.txt)、[`node-core.txt`](node-core.txt)、
[`node-relay.txt`](node-relay.txt)、[`node-push.txt`](node-push.txt)、[`node-punch.txt`](node-punch.txt)。
