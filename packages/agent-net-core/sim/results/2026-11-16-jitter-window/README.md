# 抖动线路上交互流和大数据一起发时的速度，发包上限与收包上限分开（2026-11-16）

核心指纹 `93a4d821a905`（`src/*.rs` 按 LF 逐个 SHA-256 后再取 SHA-1，算法同上一轮），逐文件见 `source-sha256.json`。与
[`2026-11-14-ordered-jitter`](../2026-11-14-ordered-jitter/README.md) 相比改了 `src/congestion.rs`、`src/connection.rs`、
`src/secure.rs`、`src/endpoint.rs`、`wasm/src/lib.rs`、`wasm/node.mts`，以及 `sim/src/lib.rs`、`sim/src/crypto.rs`、`sim/src/migration.rs`、
`sim/tests/streams.rs`、`sim/tests/secure.rs`、`sim/tests/migration.rs`、`sim/tests/bursts.rs`、`sim/mutants.py`。核心 `[dependencies]` 仍为空，线格式不变。

## 起因

2026-11-15 第一次在两台电脑之间的真实线路上和 Device Link 对比（家里经公司 VPN 到办公室，
[`benchmarks/agent-net-session-2026-11-13`](../../../../../docs/benchmarks/agent-net-session-2026-11-13/README.md)「真实网络对比」）：
会话层回传每秒 3–7 MB，原来的 Device Link 14–15 MB。查下来是两件事叠在一起：

1. **抖动线路上低排队模式越发越慢。** 会话层的小请求走交互流，核心进低排队模式，窗口只按最小往返留 1.25 倍。这条线路平常的往返
   比最小往返高三到五成，确认晚回来，窗口先卡住速度，每轮送到的都比估计少一点，带宽估计一轮轮往下掉（采样：每秒 7.3 MB → 2.3 MB）。
2. **包太长，隧道里被拆片。** 核心每个包 1400 字节 UDP 载荷，经 UDP 中转再加 33 字节。同一条 VPN 上用 UDP 回显实测：
   1200 字节每秒 15 MB 不丢、往返 10 毫秒；1400 字节每秒 9 MB 就丢 6%、往返 157 毫秒，每秒 12 MB 丢 32%、往返 184 毫秒；
   每秒 12 MB 时 1372 字节以下不丢。TCP 由隧道按 MSS 截短，不受影响。
3. **Windows 上驱动一直空转。** 之后压测量 CPU 时发现：Windows 上 Node 的 `setTimeout` 和 worker 里的 `Atomics.wait` 都要约 15.5 毫秒
   才醒（Electron 里一样），驱动把短于一个节拍的等待一律改成每轮事件循环看一次时间，传输期间一直占满一个 CPU 核：两端在同一进程时，
   每秒 1 MB 每 MB 要 1.8 秒 CPU，每秒 250 KB 要 6.3 秒（原来的 Device Link 0.05–0.08 秒）。

模拟器里加了一条按这条线路配的 VPN 线路（120 Mbit/s、往返 17 毫秒、不打乱先后的抖动 10 毫秒），复现了第 1 件：
8 MiB 单独传 823 毫秒，夹着交互流的小请求 1220 毫秒。

## 做法

1. **低排队模式的窗口另加确认一直成批到达多出来的量**（Linux BBR 的 `extra_acked`，`update_ack_aggregation`）。
   一段确认里比按带宽估计该送到的多出来的字节，就是路径上在途但还没确认的量；瓶颈排队时确认按瓶颈速度均匀地来，这个值不涨。
   每 5 轮换一个统计窗口，取刚结束的两个窗口里较小的那个、最多一个 BDP；已经在排队时不加；普通模式不加。
2. **自己排的队不当成路径变慢。** 低排队模式连着三轮判断在排队、往返却没降下来时，原来一律认为路径变慢了、把基准抬到现在的值。
   确认挤着到时带宽估计会被抬高（4G 线路上估计 6 MB/s 对线路 2.5 MB/s），降速以后仍超过容量，往返当然降不下来；
   照旧抬基准的话窗口跟着变大，队列越排越长。现在先看最近两轮：实际发出的速率都比送到的高出四分之一以上，就是自己排的，
   把带宽估计降到实际送达的速率、不抬基准。比的是实际发出的速率、不是发送节奏：路径本身变慢时窗口限住了发送，发多少就送到多少。
3. **低排队模式的加速探测连着成功时一次比一次加得多**：5% → 10% → 20% → 25%（普通模式的幅度）。上一次探测带宽涨到了预期的六成以上、
   没在排队、探测的包也没多丢才加倍，有一样不满足就回到 5%。贴着容量时探测总是不成，照样只加 5%；启动结束得早时（真实网络上传
   从每秒 4.1 MB 起，原来 1.8 秒才到 6.5 MB）很快爬回来。
4. **发包上限和收包上限分开**（`Config::send_packet_size`，`Config::send_limit`）。`max_packet_size` 仍是收包上限，两端一致（1400）；
   这一端按 `send_packet_size` 切分片、填握手请求、回握手、发路径验证。核心默认两者相同，行为不变；Desktop 设为 1317
   （经 UDP 中转时 1350，`packages/agent-net/src/transport.ts`）。新旧互通见
   [`docs/dev-rules/protocol-compatibility/agent-net-send-packet-size.md`](../../../../../docs/dev-rules/protocol-compatibility/agent-net-send-packet-size.md)。
5. **Windows 上要不要准时由核心判断**（`Connection::needs_fine_timer`，wasm 导出 `fine_timer`，`wasm/node.mts`）：有数据等着发、
   按发送速率一个节拍要攒下 64 KB 以上（每秒 4 MB 以上）时，驱动照旧每轮事件循环看时间；其余交给计时器，醒来时核心补发攒下的包。
   这只是一个查询，核心自己的行为不变，下面的矩阵和用例不受影响。判断放在核心里，是因为一阵数据开头核心就按起步速率发，不用等驱动量出快慢。

## 试过没留的

全部用 `exp/exp_mixed.rs`（8 MiB、12 个种子）和 `sim/tests/streams.rs`、`sim/tests/sharing.rs` 判断：

- **窗口按「最小往返 + 往返平均多出的部分」算**：VPN 一行 1220 → 1058 毫秒，但 4G 上交互小请求 p99 313 → 952 毫秒（上一轮按「最小往返 + 抖动」
  算时是 1522 毫秒，同一个原因：带宽估计被抬高时，多出来的窗口真的变成了队列）。
- **确认成批到达的量取两个统计窗口里较大的那个**（BBR 原样）：令牌桶开头放行的那一阵也算进去，「限速」一行小请求 p99 75 → 227 毫秒；
  上限改成半个、四分之一个 BDP 也一样。改成 3 轮一个窗口时「漂移」一行 p99 超限，2 轮时又不超：对这个值敏感，留 5 轮。
- **排队时也加窗口**：「校园」一行（随机抖动 3 毫秒、丢 0.8%）p99 26 → 35 毫秒。
- **按发送节奏判断自己排的队**（第 2 条最初的写法）：「漂移」一行路径本身变慢时也被当成自己排的，带宽估计一路往下降，文件 17 → 6.9 Mbit/s。
- **普通模式也按最近几轮的往返当基准**（认不打乱先后的抖动）：单独传 823 → 795 毫秒，但和 TCP 一起时不再让路
  （`tcp_and_agent_net_both_get_a_share` 77 / 21 Mbit/s）、`hidden_queue_is_not_read_as_random_loss` 失败。
- **普通模式也加确认成批到达的量**：多条连接一起发时确认本来就交错着来，浅队列被挤爆（`late_joiners_do_not_keep_overshooting` 丢 22.7%）。
- **启动阶段带宽还在长、往返只高出一点时不结束启动**：普通模式下 4G 普通流小请求 p99 423 → 604 毫秒；只在低排队模式用时，
  「限速」一行照样被令牌桶开头那一阵骗过，所以整条去掉。
- **加速探测阶段窗口跟着探测幅度多留**（真实网络上传那一段探测常被窗口限住、只实现一部分）：模拟器里不快，4G 交互小请求 p99 313 → 555 毫秒。
- **开头那一串量出线路比快发还快时，启动阶段要连着两轮判断在排队才结束**（真实网络上第一轮往返偶尔被 CPU 抬高，启动停在每秒 4 MB）：
  模拟器和矩阵都不变，真实网络 5 轮回传中位 11.7 对 11.3、上传 8.4 对 9.6，在波动范围里，没有留。
- **低排队模式巡航按 1.0 倍、不再略低于带宽**：VPN 一行 1116 → 1055 毫秒，但「校园」一行交互消息 p50 21.9 毫秒（门槛 19.5）、p99 32.5 毫秒（门槛 29）。
- **加速探测几乎全数送到就回到启动阶段**：多条连接挤浅队列时一条的探测因为别的让路而成功，回到启动又冲爆
  （`hidden_queue_is_not_read_as_random_loss` 1 毫秒定时器一行丢 6.6%，门槛 6%）。

第 5 条另用真实线路和端到端压测判断：

- **驱动自己量最近 50 毫秒的发送速率（或收发合计），每秒 4 MB 以上才每轮看时间**（最初的写法）：本机限速线路上速度不变，但真实线路
  （往返约 16 毫秒，一次 20 MiB 一秒多传完）上量出来之前一阵的开头已经按计时器走完了。同一时段交替 6 轮，回传 / 上传平均：
  只算发送 16.5 / 15.5，收发合计 17.6 / 15.4，一直看时间 20.0 / 19.0 MB/s。
- **收方向也判断（对端发得快、确认在等着发时看时间），以及有包在途时也看**：真实线路同一时段交替 8 轮，回传 / 上传平均两条都加 20.5 / 16.6、
  只加收方向 19.3 / 17.7、现在 17.0 / 19.5、一直看时间 17.0 / 19.0 MB/s，差别在波动范围里，模拟器里也分不出。有包在途也看的话，
  零星小消息在还没量过线路的连接上每个都要转一个往返（每秒 1 MB 的线路上 4% 的时间），没有留。

## 结果

**大数据夹着小请求**（`exp/exp_mixed.rs`，8 MiB，12 个种子；原始输出 `runs/before-mixed-8mib-12seeds.txt`、`runs/after-mixed-8mib-12seeds.txt`；
交互流一列，用时 / 小请求往返 p99 / 最长，毫秒）。单独传和普通流小请求两列逐行相同。

| 线路 | 改动前 | 现在 |
| --- | --- | --- |
| VPN 120M 17ms 抖动 10 不乱序 | 1220 / 36 / 37 | 1116 / 37 / 37 |
| VPN 120M 17ms 抖动 5 不乱序 | 757 / 29 / 29 | 740 / 30 / 30 |
| 每秒 1 MB 80ms 抖动 30 不乱序 | 9926 / 1629 / 2329 | 9263 / **516** / 1116 |
| 每秒 1 MB 80ms 抖动 60 不乱序 | 11666 / 2943 / 4043 | 10512 / **1255** / 2041 |
| 4G 20M 70ms 抖动 20 丢 1.5% | 4230 / 313 / 602 | 4134 / 313 / 602 |
| 其余 4 行（跨地区两行、家宽、每秒 1 MB 不抖动） | | 和改动前逐行相同 |

**交互消息和文件一起发**（`sim/tests/streams.rs`，文件走后台流、每 20 毫秒一条交互消息、6 秒，3–4 个种子；新用例
`files_keep_their_speed_beside_messages_on_ordered_jitter` 和原有的 `interactive_messages_stay_fast_beside_a_full_file`）：

| 线路 | 改动前：小请求 p99 / 文件 | 现在 |
| --- | --- | --- |
| VPN 120M 17ms 抖动 10 不乱序（新） | 18 毫秒 / 26.2 Mbit/s | 18 毫秒 / **48.7 Mbit/s** |
| 每秒 1 MB 80ms 抖动 30 不乱序（新） | 1232 毫秒 / 6.7 Mbit/s | **669 毫秒** / 7.4 Mbit/s |
| 4G 20M 70ms 抖动 20 丢 1.5%（新） | 110 毫秒 / 16.0 Mbit/s | 111 毫秒 / 16.3 Mbit/s |
| 校园 40M 15ms 抖动 3 丢 0.8% | 26.2 毫秒 / 38.6 Mbit/s | 26.2 毫秒 / 38.5 Mbit/s |
| 手机 10M 50ms 抖动 30 丢 3% | 183 毫秒 / 8.9 Mbit/s | 185 毫秒 / 8.9 Mbit/s |
| 漂移 | 140 毫秒 / 17.1 Mbit/s | 141 毫秒 / 17.1 Mbit/s |
| 摆动 | 111 毫秒 / 12.3 Mbit/s | 116 毫秒 / 13.0 Mbit/s |
| 限速（令牌桶） | 75 毫秒 / 5.2 Mbit/s | 75 毫秒 / 5.2 Mbit/s |

**真实网络**：见 [`benchmarks/agent-net-session-2026-11-13`](../../../../../docs/benchmarks/agent-net-session-2026-11-13/README.md)
「核心修正后真实网络复测」。同一对电脑、夹着小请求：会话层回传每秒 4.9–7.0 MB → 12.2–15.9 MB（原来的 Device Link 10.5–13.4 MB），
上传 5.1–7.0 MB → 8.3–17.6 MB（Device Link 1.6–2.0 MB），小请求最长 35 毫秒（Device Link 0.14–4.6 秒）。

**原有矩阵**（`matrix/after-*`，和上一轮的 [`after-*`](../2026-11-14-ordered-jitter/matrix/) 比，用
[`compare.cjs`、`share.cjs`](../2026-11-14-bursts/matrix/)）：单连接对比（8 MiB，64 行，16 个种子）Auto、Fast、Lean 用时几何平均都是 0.00%，
没有一行变化超过 1%（这些场景没有交互流，改动只在低排队模式里生效；核心默认的发包上限也没变）。共享矩阵满速、让路、满速 12 个种子三份逐行相同。

**Windows 上的计时**（第 5 条，`exp/exp_mixed.rs` 加 `AGENT_NET_TIMER_US=16000`，8 MiB、12 个种子，`runs/timer16-*`）：现在的写法和一直看时间相比，
跨地区、家宽两行相同，VPN 抖动 10 一行单独传 797 对 823 毫秒、交互流 1023 对 1116 毫秒；一直交给计时器的话家宽慢 10%、交互流慢 28%，
VPN 抖动 10 一行慢 21%、交互流慢 39%。每秒 1 MB 的几行和一直交给计时器相同，本来就不用转。小请求的 p99 在三种写法之间来回跳，
是 4G、抖动线路上丢包和抖动的随机波动，不分先后。端到端压测与真实线路的数字见
[Agent-Net 与 Device Link 详细对比](../../../../../docs/benchmarks/agent-net-vs-device-link-2026-11-16/README.md)「CPU」。

**测试**：`cargo test --profile sim --workspace` 全部通过（137 个）。
- `sim/tests/streams.rs` 新增 `files_keep_their_speed_beside_messages_on_ordered_jitter`：改动前 VPN 一行文件 26 Mbit/s（门槛 35）失败。
- `sim/tests/secure.rs` 新增 `peers_with_different_send_sizes_interoperate`，`sim/tests/migration.rs` 新增
  `switching_networks_works_between_different_send_sizes`：发包上限 1317 的一端和 1400 的一端互通，谁发起、换不换网都试；
  丢包时满长度分片靠校验包在发包上限短的一端算回来。
- `sim/mutants.py` 新增「抖动窗口：」8 条、「包长：」6 条，「加密：回复按自己的包长填充」按新代码改了匹配文本。「抖动窗口：」7 条和「包长：」6 条全部抓到，
  改过匹配文本的「加密：回复按自己的包长填充」也抓到。「普通模式也加窗口」存活，原因写在 `sim/mutants.py` 开头，不列进清单。全量变异仍没跑（原因同上一轮）。
- `sim/tests/bursts.rs` 新增 `coarse_timers_slow_neither_fast_chunks_nor_keep_slow_lines_busy`：按驱动的规则醒（15.6 毫秒的计时器），
  每秒 20 MB 的线路上分块传 8 MiB 和计时器准时一样快，每秒 1 MB 的线路上要一直看时间的时候不到传输时间的 2%（一直看时间是 97%）。
  同文件的测试网络改成应用读到数据当时就回（Node 里应用写数据，驱动当轮就处理）：原来等到下一次醒来，粗计时器下凭空多等一个节拍；
  准时的时候只差几微秒，原有用例全过。`exp/exp_mixed.rs` 只在计时器粗时这样，之前的记录照样能复现。
- `sim/mutants.py` 新增「计时器：」5 条（快的时候也交给计时器、一直看时间、没数据要发也看、门槛改成 1 MiB、改成 8 KB），全部抓到。

## 没做的

- 夹着交互流（低排队模式）时抖动线路上的大数据仍只有不夹时的约六成：真实网络上会话层回传中位每秒 11–12 MB，不夹小请求 20 MB；
  和原来的 Device Link（12.7 MB）大致持平，小请求最长从 0.17–2.8 秒降到几十毫秒。低排队模式的参数已经贴着「校园」「4G」两行的小请求门槛
  （见上「试过没留的」），再往快里调就要拿小请求的延迟换。
- 普通模式（没有交互流）在不打乱先后的抖动线路上仍会提前结束启动、按 0.9 倍巡航：VPN 一行单独传 823 毫秒，线路的 68%。
  试过的几种做法都在和 TCP 共享、浅队列、令牌桶的用例上退步（见上）。真实网络上这条线路的会话层回传已经快过 Device Link，
  这一档的余量留给以后。
- 手机原生库（`agent-net-native`）的发包上限随手机端接入会话层时一起改；它的驱动自己管计时，那时一起看要不要用 `needs_fine_timer`。
- 路径 MTU 探测：现在按 1350 一刀切，没有往上探。更小 MTU 的路径（双重隧道等）仍可能拆片。

## 复现

```sh
cd packages/agent-net-core
cargo test --profile sim --workspace
PYTHONIOENCODING=utf-8 python -X utf8 sim/mutants.py 抖动窗口
PYTHONIOENCODING=utf-8 python -X utf8 sim/mutants.py 包长
PYTHONIOENCODING=utf-8 python -X utf8 sim/mutants.py 计时器
cp sim/results/2026-11-16-jitter-window/exp/exp_mixed.rs sim/tests/        # 实验，跑完删掉
AGENT_NET_BULK_MIB=8 AGENT_NET_SEEDS=12 cargo test --profile sim -p agent-net-sim --test exp_mixed -- --nocapture
# Windows 的计时器：AGENT_NET_WAKE 换成 always、never 是两种对照
AGENT_NET_TIMER_US=16000 AGENT_NET_WAKE=core AGENT_NET_BULK_MIB=8 AGENT_NET_SEEDS=12 cargo test --profile sim -p agent-net-sim --test exp_mixed -- --nocapture
```

单连接对比和共享矩阵的命令同[上上轮](../2026-11-14-ramp/README.md#复现)。
