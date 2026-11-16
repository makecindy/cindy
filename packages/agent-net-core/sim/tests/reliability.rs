//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::Connection` 的公开接口，断言对端读到的字节流完整、有序、不重复，
//!   坏包不崩溃，内存有上限。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 1 步通过标准。自研传输没有上游兜底，这些不变量一旦被破坏，
//!   上层任务数据就会静默损坏。
//! - 现有覆盖缺口：这是新模块，device-link 的可靠层测试覆盖的是另一套实现。
//! - 最小失败输入：每条失败都打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；固定场景的输入写在各用例里。
//! - tier：Rust integration，虚拟时间，无真实网络；独立通过 Cargo 运行，未接入 pnpm unit runner。
//!   用 `--profile sim` 打开溢出检查，默认 200 个种子；`AGENT_NET_SEEDS=10000` 跑扩展矩阵。
//! - 实测耗时：2026-10-31，独立突发日程模型下，本机 10000 个默认种子、三策略各 1000 种子及固定用例共 92.21 秒；
//!   包含性能回归和恶意包压力验证，不作为 5 秒内轻量单测。记录见 sim/results/2026-10-31-optimization/network-v2/tests.txt。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use agent_net_core::{Config, Connection, PacketError, RecoveryPolicy};
use agent_net_sim::{CorePeer, LinkProfile, Peer, Rng, Shifted, Workload, random_case, run, run_case, scenarios};

/// 抓到过真实 bug 的种子，每次都跑。这些问题几十万个种子才出现一次，默认的 200 个碰不到。
const HARD_SEEDS: [u64; 10] = [643, 910, 2181, 2383, 3052, 179_502, 449_978, 526_708, 558_214, 2_003_576];

fn seed_count() -> u64 {
    std::env::var("AGENT_NET_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(200)
}

fn seed_start() -> u64 {
    std::env::var("AGENT_NET_SEED_START").ok().and_then(|value| value.parse().ok()).unwrap_or(0)
}

/// 不管网络多差，对端读到的都必须和发送的完全一致，并且要能传完。
#[test]
fn every_seed_delivers_an_intact_ordered_stream() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => {
            let start = seed_start();
            HARD_SEEDS.into_iter().chain(start..start + seed_count()).collect()
        }
    };
    let mut failures = Vec::new();
    for seed in seeds {
        let case = random_case(seed);
        let outcome = run_case(&case);
        if !outcome.finished || outcome.violation.is_some() || outcome.spurious_wakes > 0 {
            failures.push(format!(
                "seed {seed}: finished={} violation={:?} spurious_wakes={} at {}us\n  config={:?}\n  a={:?}\n  b={:?}\n  workload={:?}\n  states={:?}",
                outcome.finished, outcome.violation, outcome.spurious_wakes, outcome.finish_us, case.config, case.a_link, case.b_link, case.workload, outcome.final_states
            ));
            if failures.len() == 5 {
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} failing seeds:\n{}", failures.len(), failures.join("\n"));
}

/// 真实设备用系统时钟，连接建好时时钟早已不是 0。核心只能依赖时间差：整体平移时钟以后，每一步都要和从 0 开始一样。
/// 2026-11-03 发现 300 个种子里有 42 个不一样：统计段、最小 RTT、发送节奏等的起点留成了 0，
/// 模拟器里 0 恰好是建连时刻，真实设备上是很久以前。模拟验证过的行为在真实设备上并不成立。
#[test]
fn shifting_the_clock_changes_nothing() {
    // 1421 和 1899：乱序确认回来时更早的包判不判丢，只在起点不对时不一样，三千个种子里只有这两个。
    for offset in [1u64 << 40, 123_456_789_012_345] {
        for seed in HARD_SEEDS.into_iter().chain([1421, 1899]).chain(0..seed_count()) {
            let mut case = random_case(seed);
            case.config = Config { recovery_policy: [RecoveryPolicy::Auto, RecoveryPolicy::Lean, RecoveryPolicy::Fast][seed as usize % 3], ..case.config };
            let peer = |at: u64| Shifted { peer: CorePeer::new_at(case.config.clone(), at), offset_us: at };
            let base = run(peer(0), peer(0), case.a_link.clone(), case.b_link.clone(), &case.workload, seed);
            let shifted = run(peer(offset), peer(offset), case.a_link.clone(), case.b_link.clone(), &case.workload, seed);
            assert_eq!(base.trace, shifted.trace, "seed {seed} at offset {offset}: finish {} vs {}us, {} vs {} packets", base.finish_us, shifted.finish_us, base.packets, shifted.packets);
        }
    }
}

/// 连接建好以后先空闲一阵：`idle_until` 之前不接受写入。
struct IdleFirst {
    peer: CorePeer,
    idle_until: u64,
}

impl Peer for IdleFirst {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize {
        if now_us < self.idle_until { 0 } else { self.peer.write(now_us, data) }
    }
    fn read(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        self.peer.read(now_us, out)
    }
    fn input(&mut self, now_us: u64, packet: &[u8]) {
        self.peer.input(now_us, packet)
    }
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8])) {
        self.peer.pump(now_us, sink)
    }
    fn wake_at(&self) -> Option<u64> {
        let inner = self.peer.wake_at();
        if self.idle_until > 0 { Some(inner.map_or(self.idle_until, |at| at.min(self.idle_until))) } else { inner }
    }
    fn on_wake(&mut self, now_us: u64) {
        if now_us >= self.idle_until {
            self.idle_until = 0;
        }
        self.peer.on_wake(now_us)
    }
    fn buffered(&self) -> usize {
        self.peer.buffered()
    }
    fn is_dead(&self) -> bool {
        self.peer.is_dead()
    }
}

/// 连接建好后空闲一阵才开始发（应用晚写入），之后要和立刻就发一样快。
/// 2026-11-03 发现：判断限速的第一个统计段从建连算起，空闲时间被算进送达速率，浅队列上开头的丢包被当成
/// 撞到了很低的限速。这条线路 64 个种子平均慢 14%。
#[test]
fn idle_before_the_first_send_does_not_slow_the_transfer() {
    let scenario = scenarios().into_iter().find(|scenario| scenario.label.starts_with("小队列")).expect("scenario");
    let config = Config { send_window: 512, recv_window: 512, send_buffer_bytes: 4 << 20, ..Config::default() };
    let workload = Workload { a_to_b_bytes: 2 << 20, ..Workload::default() };
    let idle = 66_000;
    let (mut immediate, mut late) = (0u64, 0u64);
    for seed in 1..=16 {
        let peer = |idle_until| IdleFirst { peer: CorePeer::new(config.clone()), idle_until };
        let outcome = run(peer(0), peer(0), scenario.link.clone(), scenario.back.clone(), &workload, seed);
        assert!(outcome.finished, "seed {seed}");
        immediate += outcome.finish_us;
        let outcome = run(peer(idle), peer(0), scenario.link.clone(), scenario.back.clone(), &workload, seed);
        assert!(outcome.finished && outcome.spurious_wakes == 0, "seed {seed}: {outcome:?}");
        late += outcome.finish_us - idle;
    }
    assert!(late * 100 <= immediate * 103, "starting {idle}us late took {late}us in total, starting at once {immediate}us");
}

/// 可复现是整套调试方法的基础：同一种子必须走出逐事件相同的过程。
#[test]
fn same_seed_replays_the_same_run() {
    for seed in [3, 41, 977] {
        let case = random_case(seed);
        let (first, second) = (run_case(&case), run_case(&case));
        assert_eq!(first.trace, second.trace, "seed {seed}");
        assert_eq!(first.wire_bytes, second.wire_bytes, "seed {seed}");
    }
}

/// 接收方长时间不读时，发送方必须停下来等，而不是撑爆内存或误判连接已死；恢复读取后继续传完。
#[test]
fn slow_reader_stalls_the_sender_and_recovers() {
    let config = Config { recv_window: 32, send_window: 32, send_buffer_bytes: 64 * 1024, ..Config::default() };
    let link = LinkProfile { delay_us: 20_000, ..LinkProfile::default() };
    let workload = Workload {
        a_to_b_bytes: 1024 * 1024,
        read_pause: Some((10_000, 40_000_000)),
        ..Workload::default()
    };
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link, &workload, 1);
    assert!(outcome.finished, "{outcome:?}");
    assert_eq!(outcome.violation, None);
    assert!(outcome.finish_us >= 40_000_000, "the sender did not wait for the reader");
    let bound = config.send_buffer_bytes + 2 * (config.recv_window as usize) * config.max_packet_size;
    assert!(outcome.peak_buffered <= bound, "peak {} over bound {bound}", outcome.peak_buffered);
}

/// 接收方恢复读取后，发送方要立刻知道窗口开了。靠对方下一次探测的话，最坏要多等好几秒。
#[test]
fn reopened_window_is_announced_immediately() {
    let config = Config { recv_window: 32, send_window: 32, ..Config::default() };
    let link = LinkProfile { delay_us: 20_000, ..LinkProfile::default() };
    let pause_end = 40_000_000;
    let workload = Workload { a_to_b_bytes: 256 * 1024, read_pause: Some((10_000, pause_end)), ..Workload::default() };
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link, &workload, 7);
    assert!(outcome.finished, "{outcome:?}");
    assert!(outcome.finish_us < pause_end + 1_000_000, "took {}us after the reader resumed", outcome.finish_us - pause_end);
}

/// 超时后不能把窗口内所有包再发一遍：瓶颈放不下，只会全部丢掉再来一轮，线上流量能到数据量的几十倍。
#[test]
fn timeouts_do_not_resend_the_whole_window() {
    let config = Config { send_window: 512, recv_window: 512, ..Config::default() };
    let link = LinkProfile { bits_per_second: 1_000_000, delay_us: 20_000, queue_us: 5_000, ..LinkProfile::default() };
    let payload = 256 * 1024;
    let workload = Workload { a_to_b_bytes: payload, ..Workload::default() };
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link, &workload, 8);
    assert!(outcome.finished, "{outcome:?}");
    // 现在约 1.9 倍，不加限制是 96 倍。这条链路的队列放不下一个包，全靠发送节奏。
    assert!(outcome.wire_bytes < 3 * payload, "{} bytes on the wire for {payload}", outcome.wire_bytes);
}

/// 两端窗口配置不一致时（第 4 步握手之前确实可能），发送方会超发。收不下的分片绝不能被确认，否则数据就丢了。
#[test]
fn segments_beyond_the_window_are_retried_not_lost() {
    let large = Config { recv_window: 512, send_window: 512, ..Config::default() };
    let small = Config { recv_window: 8, send_window: 512, ..Config::default() };
    let link = LinkProfile { delay_us: 5_000, ..LinkProfile::default() };
    let workload = Workload {
        a_to_b_bytes: 256 * 1024,
        read_interval_us: 20_000,
        read_bytes: 4_096,
        ..Workload::default()
    };
    let outcome = run(CorePeer::new(large), CorePeer::new(small), link.clone(), link, &workload, 9);
    assert!(outcome.finished, "{outcome:?}");
    assert_eq!(outcome.violation, None);
}

/// 短暂断网要自动恢复，彻底断开要在限定时间内放弃，不能永远重传。
#[test]
fn outages_recover_or_give_up_within_the_deadline() {
    let config = Config::default();
    let link = |outage: (u64, u64)| LinkProfile { delay_us: 10_000, outages: vec![outage], ..LinkProfile::default() };
    let workload = Workload { a_to_b_bytes: 256 * 1024, ..Workload::default() };

    // 断网必须早于传输完成：无限速时 256 KiB 不到 50 毫秒就能传完。
    let short = (5_000, 8_000_000);
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link(short), link(short), &workload, 2);
    assert!(outcome.finished, "{outcome:?}");

    let forever = (5_000, u64::MAX);
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link(forever), link(forever), &workload, 3);
    assert!(!outcome.finished);
    assert_eq!(outcome.violation, None);
    assert!(outcome.finish_us <= config.dead_after_us + 1_000_000, "gave up at {}us", outcome.finish_us);
}

/// 下面几条守的是“比 KCP 好”的来源，每条都对应一次真实踩过的退化。上限留了约 25% 余量，
/// 只拦回退，不当性能基线用。
fn path(bits_per_second: u64, delay_us: u64) -> LinkProfile {
    LinkProfile { bits_per_second, delay_us, jitter_us: 1_000, queue_us: 50_000, ..LinkProfile::default() }
}

fn bulk(link: &LinkProfile, window: u32, bytes: u64, seed: u64) -> agent_net_sim::Outcome {
    let config = Config { send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..Config::default() };
    let workload = Workload { a_to_b_bytes: bytes, write_chunk: 4096, ..Workload::default() };
    run(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link.clone(), &workload, seed)
}

fn overhead(outcome: &agent_net_sim::Outcome, bytes: u64) -> f64 {
    outcome.wire_bytes as f64 / bytes as f64 - 1.0
}

/// 随机丢包不能被当成带宽下降：丢 30% 时送达速率每轮只剩 70%，不补偿的话传 64 MiB 要 332 秒。
/// 短传输看不出来，要传得够久，带宽估计才会塌下去。
#[test]
fn random_loss_does_not_collapse_the_rate() {
    let link = LinkProfile { loss: 0.30, ..path(100_000_000, 20_000) };
    let outcome = bulk(&link, 4096, 64 << 20, 11);
    assert!(outcome.finished, "{outcome:?}");
    assert!(outcome.finish_us < 8_000_000, "took {}us", outcome.finish_us);
    assert!(outcome.final_stats[0].expect("stats").bandwidth > 1_000_000);
}

/// 自己排的队不能当成别人的。有随机丢包的长往返线路上队列常常是自己排的，这时只算送达不算丢包的话，随机丢包率被压低，
/// 补得不够：2026-11-03 试过排队时一律这样算，山区那条线路窗口 1024 时对比矩阵里慢 23%。
/// 2026-11-05 持续满发时随机丢 16% 以内不再补偿，山区线路上几乎不再自己排队，两种算法差不到 1%，改看跨境线路：
/// 4 个种子各传 16 MiB 共 20.7 秒、随机丢包率估计 10.0%；排队时一律只算送达是 29.8 秒、6.8%。
#[test]
fn own_queue_does_not_hide_random_loss() {
    let scenario = agent_net_sim::scenarios().into_iter().find(|scenario| scenario.label.starts_with("跨境")).expect("scenario");
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 16 << 20, ..Config::default() };
    let workload = Workload { a_to_b_bytes: 16 << 20, write_chunk: 4096, ..Workload::default() };
    let (mut total, mut estimate) = (0, 0);
    for seed in 1..=4 {
        let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), scenario.link.clone(), scenario.back.clone(), &workload, seed);
        assert!(outcome.finished, "seed {seed}");
        total += outcome.finish_us;
        estimate += outcome.final_stats[0].expect("stats").random_loss_ppm as u64;
    }
    assert!(estimate / 4 >= 85_000, "random loss read as {} ppm", estimate / 4);
    assert!(total <= 24_000_000, "took {total}us in total");
}

/// 瓶颈溢出不能算成随机丢包，否则越丢越快。这条链路除了队列溢出没有别的丢包。
#[test]
fn queue_overflow_is_not_mistaken_for_random_loss() {
    let bytes = 2 << 20;
    let link = LinkProfile { queue_us: 10_000, ..path(5_000_000, 30_000) };
    let outcome = bulk(&link, 128, bytes, 12);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.random_loss_ppm < 100_000, "overflow read as {} ppm random loss", stats.random_loss_ppm);
    assert!(overhead(&outcome, bytes) < 0.45, "overhead {:.3}", overhead(&outcome, bytes));
}

/// 乱序不是丢包：判错一次之后要放宽窗口，不能每个晚到的包都重传一遍。
#[test]
fn reordering_is_learned_and_stops_being_retransmitted() {
    let bytes = 2 << 20;
    let link = LinkProfile { reorder: 0.10, reorder_extra_us: 30_000, ..path(100_000_000, 20_000) };
    let outcome = bulk(&link, 128, bytes, 13);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.retransmitted_segments < 60, "{} retransmissions", stats.retransmitted_segments);
}

/// 乱序时晚到的包照样堵窗口：它到之前后面的数据交付不了。校验包能提前把它算出来，不用干等。
#[test]
fn late_packets_are_repaired_like_lost_ones() {
    let bytes = 8 << 20;
    let link = LinkProfile { reorder: 0.10, reorder_extra_us: 30_000, ..path(100_000_000, 20_000) };
    let outcomes: Vec<_> = (1..=4).map(|seed| bulk(&link, 128, bytes, seed)).collect();
    let finish = outcomes.iter().map(|outcome| outcome.finish_us).sum::<u64>() / 4;
    assert!(finish < 2_400_000, "took {finish}us");
}

/// 干净的网络上不能多花一个字节：不重传、不捎带，开销只有包头和确认。
#[test]
fn clean_paths_carry_no_redundancy() {
    let bytes = 2 << 20;
    let link = LinkProfile { jitter_us: 0, ..path(100_000_000, 20_000) };
    let outcome = bulk(&link, 128, bytes, 14);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert_eq!((stats.retransmitted_segments, stats.bundled_segments), (0, 0));
    assert!(overhead(&outcome, bytes) < 0.02, "overhead {:.3}", overhead(&outcome, bytes));

    // 1 毫秒的抖动会让个别包被误判，这不能算成丢包率，否则干净网络也要发校验包。
    let bytes = 8 << 20;
    let outcome = bulk(&path(100_000_000, 20_000), 128, bytes, 14);
    assert_eq!(outcome.final_stats[0].expect("stats").parity_packets, 0);
    assert!(overhead(&outcome, bytes) < 0.03, "overhead {:.3}", overhead(&outcome, bytes));

    // 小消息的包有空位，这里才看得出有没有多捎带。
    let config = Config::default();
    let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link, 2_000, 200, 20_000, 14);
    assert!(report.wire_bytes / 2_000 < 260, "{} bytes per message", report.wire_bytes / 2_000);
}

/// 自动策略将小消息的冗余分到独立包，丢失后不应再等下一条消息。
/// 5% 随机丢包下旧捎带策略的 p99 约 41 ms；自动策略应靠近 20 ms 单程延迟，且流量有界。
#[test]
fn lost_messages_do_not_wait_for_the_next_one() {
    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 20_000) };
    let config = Config::default();
    let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link.clone(), 2_000, 200, 20_000, 15);
    assert_eq!(report.delivered, report.sent);
    assert!(report.percentile_ms(95.0) < 50.0, "p95 {}", report.percentile_ms(95.0));
    assert!(report.percentile_ms(99.0) < 30.0, "p99 {}", report.percentile_ms(99.0));
    assert!(report.wire_bytes < 4 * 2_000 * 200, "{} wire bytes for 400000 payload bytes", report.wire_bytes);

    // 手动选择省流量确实应减少线上字节，而不是只改变配置名称。
    let config = Config::for_policy(RecoveryPolicy::Lean);
    let lean = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link, 2_000, 200, 20_000, 15);
    assert_eq!(lean.delivered, lean.sent);
    assert!(lean.wire_bytes * 4 < report.wire_bytes * 3, "lean {} bytes, auto {} bytes", lean.wire_bytes, report.wire_bytes);
}

/// 长 RTT 路径上丢一条小消息，后面十几条都被堵住。丢包率估计在两次丢包之间会掉下去，
/// 捎带要保持住；连接开头还没测过，第一个丢包要一个往返才发现，也要先捎带着。
#[test]
fn small_messages_stay_covered_on_long_paths() {
    let config = Config::default();
    let link = LinkProfile { loss: 0.005, ..path(100_000_000, 125_000) };
    let mut merged = agent_net_sim::LatencyReport::default();
    for seed in 1..=8 {
        let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 2_000, 200, 20_000, seed);
        assert_eq!(report.delivered, report.sent);
        merged.samples_us.extend(report.samples_us);
    }
    assert!(merged.percentile_ms(99.0) < 135.0, "p99 {}", merged.percentile_ms(99.0));
    assert!(merged.percentile_ms(99.9) < 135.0, "p99.9 {}", merged.percentile_ms(99.9));

    // 丢得重时一份副本不够：连着丢两个包就要等一个往返，后面十几条都被堵住。
    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 150_000) };
    let mut merged = agent_net_sim::LatencyReport::default();
    for seed in 1..=8 {
        let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 2_000, 200, 20_000, seed);
        assert_eq!(report.delivered, report.sent);
        merged.samples_us.extend(report.samples_us);
    }
    assert!(merged.percentile_ms(99.0) < 200.0, "p99 {}", merged.percentile_ms(99.0));

    // 第一个丢包发现之前的消息。
    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 150_000) };
    let mut merged = agent_net_sim::LatencyReport::default();
    for seed in 1..=8 {
        let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 40, 200, 20_000, seed);
        assert_eq!(report.delivered, report.sent);
        merged.samples_us.extend(report.samples_us);
    }
    assert!(merged.percentile_ms(95.0) < 175.0, "p95 {}", merged.percentile_ms(95.0));
}

/// 反复断网时，超时要一次判完所有超龄的包，否则每次断网后要好几秒才恢复。
/// 断网时发的小消息要带上堵住队伍的最老分片：网一通第一个包就把它送到。
/// 已经由副本确认的稀疏原包也要及时释放在途预算；八个固定种子的 p99 应低于 2 秒。
#[test]
fn repeated_outages_recover_fast() {
    let link = LinkProfile { bits_per_second: 30_000_000, delay_us: 30_000, jitter_us: 10_000, loss: 0.02, burst_every_us: 5_000_000, burst_len_us: 1_000_000, burst_loss: 1.0, queue_us: 100_000, ..LinkProfile::default() };
    let bytes = 8 << 20;
    let finish = (1..=4).map(|seed| bulk(&link, 1024, bytes, seed).finish_us).sum::<u64>() / 4;
    assert!(finish < 4_000_000, "took {finish}us");

    let config = Config::default();
    let mut merged = agent_net_sim::LatencyReport::default();
    for seed in 1..=8 {
        let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 2_000, 200, 20_000, seed);
        assert_eq!(report.delivered, report.sent);
        merged.samples_us.extend(report.samples_us);
    }
    assert!(merged.percentile_ms(99.0) < 2_000.0, "p99 {}", merged.percentile_ms(99.0));

    // 零散丢包加短断网：断网一过，最老的分片要跟着第一个包回去。
    let link = LinkProfile { bits_per_second: 15_000_000, delay_us: 40_000, jitter_us: 12_000, loss: 0.04, burst_every_us: 4_000_000, burst_len_us: 400_000, burst_loss: 1.0, queue_us: 120_000, ..LinkProfile::default() };
    let mut merged = agent_net_sim::LatencyReport::default();
    for seed in 1..=16 {
        let report = agent_net_sim::run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 2_000, 200, 20_000, seed);
        assert_eq!(report.delivered, report.sent);
        merged.samples_us.extend(report.samples_us);
    }
    // 2026-11-05 持续满发时随机丢 16% 以内不再补偿，653.9 → 661.3 毫秒；不补偿的代价，用户选了浅队列上少丢包。
    // 断网时不捎带最老的分片是 667.8：这个机制只救最慢的那一点消息，p95 反而略好。
    assert!(merged.percentile_ms(99.0) < 665.0, "p99 {}", merged.percentile_ms(99.0));
}

/// 大传输不能把瓶颈队列一直顶满，否则同一连接上的交互全部多等一个往返。
#[test]
fn bulk_transfers_do_not_keep_the_queue_full() {
    let bytes = 32 << 20;
    let outcome = bulk(&path(100_000_000, 20_000), 1024, bytes, 16);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.srtt_us < stats.min_rtt_us * 3 / 2, "srtt {} over min {}", stats.srtt_us, stats.min_rtt_us);
}

/// 启动阶段要在队列堆起来时就停，等带宽不再增长才退出会把队列挤爆。
#[test]
fn startup_stops_before_overflowing_the_queue() {
    let bytes = 8 << 20;
    let outcome = bulk(&path(100_000_000, 20_000), 2048, bytes, 17);
    assert!(outcome.finished, "{outcome:?}");
    assert!(overhead(&outcome, bytes) < 0.15, "overhead {:.3}", overhead(&outcome, bytes));
}

/// 被窗口限住时节奏不能再压一层：丢包后窗口一打开就要立刻补上，不能再按实测速率慢慢发。
#[test]
fn window_limited_transfers_refill_immediately() {
    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 20_000) };
    let total: u64 = (1..=8).map(|seed| bulk(&link, 128, 8 << 20, seed)).map(|outcome| outcome.finish_us).sum();
    assert!(total / 8 < 4_000_000, "took {}us on average", total / 8);
}

/// 确认帧只带最新几个区间时，晚到的包永远等不到确认，只能白白重传。高丢包加乱序时这部分能占一半重传。
#[test]
fn late_packets_get_acknowledged() {
    let bytes = 8 << 20;
    let link = LinkProfile { bits_per_second: 50_000_000, delay_us: 90_000, jitter_us: 15_000, loss: 0.08, reorder: 0.03, reorder_extra_us: 40_000, queue_us: 100_000, ..LinkProfile::default() };
    let total: u64 = (1..=4).map(|seed| bulk(&link, 1024, bytes, seed).final_stats[0].expect("stats").retransmitted_segments).sum();
    assert!(total / 4 < 700, "{} retransmissions", total / 4);
}

/// 长往返路径上，初始窗口发完以后要接着慢慢发，不能空等一个往返：窗口多空出半轮，传完就要多等半个往返。
#[test]
fn long_paths_keep_sending_before_the_first_ack() {
    let bytes = 2 << 20;
    let link = path(20_000_000, 300_000);
    let outcome = bulk(&link, 128, bytes, 31);
    assert!(outcome.finished, "{outcome:?}");
    assert!(outcome.finish_us < 7_450_000, "took {}us", outcome.finish_us);
}

/// 连接开头撞上一阵断网，不能把它当成限速：断网一过就要回到全速。
#[test]
fn outage_during_startup_is_not_read_as_a_rate_limit() {
    let bytes = 8 << 20;
    let link = LinkProfile { outages: vec![(100_000, 280_000)], ..path(100_000_000, 20_000) };
    let outcome = bulk(&link, 128, bytes, 32);
    assert!(outcome.finished, "{outcome:?}");
    assert!(outcome.finish_us < 2_285_000, "took {}us", outcome.finish_us);
}

/// 窗口被卡住时重传再丢一次要多等一个往返，所以这时候重传要发两份。
#[test]
fn blocked_windows_are_not_held_up_by_a_lost_retransmission() {
    let link = LinkProfile { loss: 0.30, ..path(100_000_000, 20_000) };
    let total: u64 = (1..=4).map(|seed| bulk(&link, 128, 8 << 20, seed)).map(|outcome| outcome.finish_us).sum();
    assert!(total / 4 < 9_000_000, "took {}us on average", total / 4);
}

/// 断网时只发少量探测，网络一恢复就要全速续传：长断网后带宽估计会清零，
/// 不能让这段时间的统计把上限压低，也不能因为旧的 RTT 误以为有队列而提前结束启动。
/// 恢复时刻和探测时刻的相对位置决定等多久，所以要试几个不同的恢复时刻。
#[test]
fn outages_cost_little_traffic_and_recover_quickly() {
    let config = Config::default();
    let bytes = 1 << 20;
    let workload = Workload { a_to_b_bytes: bytes, ..Workload::default() };
    let ends: Vec<u64> = (0..12).map(|step| 20_000_000 + step * 411_000).collect();
    let (mut total_after, mut total_wire) = (0, 0);
    for &end in &ends {
        // 传到一半断网：连接已经有 RTT，恢复时间才有意义。
        let link = LinkProfile { bits_per_second: 10_000_000, delay_us: 10_000, queue_us: 50_000, outages: vec![(100_000, end)], ..LinkProfile::default() };
        let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link, &workload, 20);
        assert!(outcome.finished, "{outcome:?}");
        total_after += outcome.finish_us - end;
        total_wire += outcome.wire_bytes;
    }
    let count = ends.len() as u64;
    // 1 MiB 按 10 Mbit 传完约 840 毫秒。
    assert!(total_after / count < 1_300_000, "took {}us after the path returned", total_after / count);
    assert!(total_wire / count < 3 << 20, "{} bytes on the wire", total_wire / count);
}

/// 短中断比长断网常见得多，恢复要更快。实测路径上这一条把 p99 从 800 毫秒压到 415 毫秒。
#[test]
fn short_outages_recover_within_a_few_round_trips() {
    let config = Config::default();
    let workload = Workload { a_to_b_bytes: 256 * 1024, ..Workload::default() };
    // 恢复时刻和探测时刻的相对位置决定等多久，要看平均值。
    let ends: Vec<u64> = (0..12).map(|step| 1_500_000 + step * 137_000).collect();
    let mut total = 0;
    for &end in &ends {
        let link = LinkProfile { bits_per_second: 5_000_000, delay_us: 50_000, queue_us: 50_000, outages: vec![(150_000, end)], ..LinkProfile::default() };
        let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link, &workload, 25);
        assert!(outcome.finished, "{outcome:?}");
        total += outcome.finish_us - end;
    }
    assert!(total / (ends.len() as u64) < 1_150_000, "took {}us on average", total / ends.len() as u64);
}

/// 初始超时比 RTT 短时，每个包都会先被判丢，迟到的确认也要算 RTT 样本。
/// 之前这里前 4 秒都没有 RTT，超时一直按 200 毫秒走。
#[test]
fn rtt_is_learned_even_when_every_packet_times_out_first() {
    let bytes = 8 << 20;
    let link = LinkProfile { loss: 0.01, ..path(20_000_000, 300_000) };
    let outcome = bulk(&link, 1024, bytes, 26);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.srtt_us > 500_000, "srtt {}", stats.srtt_us);
    assert!(stats.timeout_losses < 200, "{} timeouts", stats.timeout_losses);
    assert!(outcome.finish_us < 12_000_000, "took {}us", outcome.finish_us);
}

/// 断网一秒、恢复后往返从 20 毫秒变成 140 毫秒（换了路由或网络，自己不知道）：重传超时比新的往返短，
/// 每个包都先被超时判丢、再被确认。判丢后才到的确认也要算往返样本，否则超时永远追不上，每个确认还把退避清零。
/// 2026-11-05 换网模拟里查出来：修好之前这里要 9.7 秒、775 次超时判丢；加密连接换网时还会叠上别的问题，上传要 76 秒。
#[test]
fn rtt_is_relearned_when_the_path_gets_longer() {
    // 延迟漂移的周期取得很长就是一次跳变：开头十六分之一（2 秒）是基础延迟，之后单程多 60 毫秒。
    let link = LinkProfile { wander_us: 60_000, wander_period_us: 32_000_000, outages: vec![(1_000_000, 2_000_000)], ..path(20_000_000, 10_000) };
    let outcome = bulk(&link, 1024, 8 << 20, 27);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.srtt_us > 130_000, "srtt {}", stats.srtt_us);
    assert!(outcome.finish_us < 8_000_000, "took {}us, {} timeouts, {} spurious", outcome.finish_us, stats.timeout_losses, stats.spurious_losses);
}

/// 未测得 RTT 时，250 ms 的干净路径会先碰到 200 ms 初始超时。
/// 旧版会重传同一时刻到期的多个包；先探测并保留其余确认机会，流量应仍接近净载荷。
#[test]
fn initial_timeout_keeps_the_first_flight_available_for_measurement() {
    let bytes = 256 << 10;
    let link = LinkProfile { jitter_us: 0, ..path(100_000_000, 125_000) };
    let outcome = bulk(&link, 1024, bytes, 71);
    assert!(outcome.finished, "{outcome:?}");
    assert_eq!(outcome.violation, None);
    assert!(outcome.final_stats[0].expect("stats").srtt_us >= 250_000);
    assert!(outcome.wire_bytes < bytes * 103 / 100, "{} wire bytes for {bytes} payload bytes", outcome.wire_bytes);
}

/// 令牌桶和配额限速没有队列，RTT 不变，放行阶段的速率还远高于上限。
/// 实测路径上曾因此发出去 4 倍的数据，这里要收敛到上限附近。
#[test]
fn rate_limiters_are_found_without_any_rtt_signal() {
    let bytes = 16 << 20;
    let link = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 45_000, jitter_us: 5_000, queue_us: 20_000, bucket_bytes_per_second: 708_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() };
    let outcome = bulk(&link, 1024, bytes, 21);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    // 上限会周期性放开一档试探，结束瞬间的值不固定，这里只看发现了没有。
    assert!(stats.rate_limits_found > 0, "never found the limit");
    assert!(overhead(&outcome, bytes) < 0.6, "overhead {:.3}", overhead(&outcome, bytes));
    assert!(outcome.finish_us < 26_000_000, "took {}us", outcome.finish_us);
}

/// 限速丢包不能当成随机丢包。窗口受限时尤其容易错：之前这里算出 30% 的“随机丢包”，又发了一堆副本。
#[test]
fn rate_limited_loss_is_not_read_as_random() {
    let bytes = 16 << 20;
    let link = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 45_000, jitter_us: 5_000, queue_us: 20_000, bucket_bytes_per_second: 708_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() };
    let outcome = bulk(&link, 128, bytes, 22);
    assert!(outcome.finished, "{outcome:?}");
    let stats = outcome.final_stats[0].expect("stats");
    assert!(stats.random_loss_ppm < 50_000, "read as {} ppm random loss", stats.random_loss_ppm);
    assert!(stats.bundled_segments < 500, "{} duplicates", stats.bundled_segments);
    assert!(overhead(&outcome, bytes) < 0.30, "overhead {:.3}", overhead(&outcome, bytes));
}

/// 抖动把包的先后错开几毫秒是常事，不能都当成堵窗口的空洞：校验会占满余量，反而把数据挤掉。
#[test]
fn jitter_is_not_counted_as_holes() {
    let link = LinkProfile { bits_per_second: 20_000_000, delay_us: 35_000, jitter_us: 20_000, loss: 0.015, queue_us: 200_000, ..LinkProfile::default() };
    let finish = (1..=4).map(|seed| bulk(&link, 128, 8 << 20, seed).finish_us).sum::<u64>() / 4;
    assert!(finish < 5_200_000, "took {finish}us");
}

/// 校验包要真的省下往返：窗口被占满时丢一个包不用等重传，算回来的分片也不用再发一遍。
#[test]
fn parity_recovers_losses_without_a_round_trip() {
    let link = LinkProfile { loss: 0.01, ..path(100_000_000, 20_000) };
    let outcomes: Vec<_> = (1..=4).map(|seed| bulk(&link, 128, 8 << 20, seed)).collect();
    let stat = |pick: fn(&agent_net_core::Stats) -> u64, side: usize| outcomes.iter().map(|outcome| pick(&outcome.final_stats[side].expect("stats"))).sum::<u64>() / 4;
    let finish = outcomes.iter().map(|outcome| outcome.finish_us).sum::<u64>() / 4;
    assert!(stat(|s| s.recovered_segments, 1) >= 50, "recovered {}", stat(|s| s.recovered_segments, 1));
    assert!(stat(|s| s.retransmitted_segments, 0) < 8, "{} retransmissions", stat(|s| s.retransmitted_segments, 0));
    assert!(finish < 2_300_000, "took {finish}us");

    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 20_000) };
    let total: u64 = (1..=4).map(|seed| bulk(&link, 128, 8 << 20, seed).final_stats[0].expect("stats").retransmitted_segments).sum();
    assert!(total / 4 < 120, "{} retransmissions", total / 4);
}

/// 校验的开销要跟着丢包率走，丢得重时一组修不过来也不能退回到逐个重传。
/// 2026-10-31 产品决定改为速度优先：窗口 128、路径还有余量时，自动策略要追上 KCP 最快配置
/// （同条件下极速+FEC5/5 为 2036 ms、额外字节 160%，调优+FEC 为 2116 ms），流量仍要明显少于它。
/// 原先的上限是 2190 ms、28%。
#[test]
fn parity_share_stays_close_to_the_loss_rate() {
    let bytes = 8 << 20;
    // 窗口 1024 时带宽才是瓶颈，校验包要挤掉数据，开销要低得多；丢得重时重传还要发两份，不然窗口卡住。
    for (window, loss, finish_limit, overhead_limit) in [(128, 0.05, 2_110_000, 1.30), (128, 0.30, 2_800_000, 1.30), (1024, 0.05, 1_100_000, 0.13), (1024, 0.30, 1_700_000, 1.20)] {
        let link = LinkProfile { loss, ..path(100_000_000, 20_000) };
        let outcomes: Vec<_> = (1..=4).map(|seed| bulk(&link, window, bytes, seed)).collect();
        let finish = outcomes.iter().map(|outcome| outcome.finish_us).sum::<u64>() / 4;
        let cost = outcomes.iter().map(|outcome| overhead(outcome, bytes)).sum::<f64>() / 4.0;
        assert!(finish < finish_limit, "window {window} loss {loss}: took {finish}us");
        assert!(cost < overhead_limit, "window {window} loss {loss}: overhead {cost:.3}");
    }
}

/// 双向都在传时，每个包都带着确认，校验包放不进去。这时不能继续往这一组加新数据，
/// 否则分片数会超过校验帧能表示的上限，对端直接拒收。
#[test]
fn parity_is_not_starved_by_piggybacked_acks() {
    let config = Config::default();
    let link = LinkProfile { loss: 0.01, ..path(100_000_000, 20_000) };
    let workload = Workload { a_to_b_bytes: 2 << 20, b_to_a_bytes: 2 << 20, write_chunk: 4096, ..Workload::default() };
    let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config), link.clone(), link, &workload, 27);
    assert!(outcome.finished, "{outcome:?}");
    assert_eq!(outcome.violation, None);
    assert!(outcome.final_stats[0].expect("stats").parity_packets > 0, "parity never sent");
}

/// 窗口探测恰好遇上确认帧把包填满时，探测要留到下一个包，不能写到缓冲外面。
#[test]
fn window_probe_waits_when_an_ack_fills_the_packet() {
    // 包头 3 字节加确认帧 14 字节，正好 17 字节。
    let config = Config { max_packet_size: 17, send_window: 8, recv_window: 1, ..Config::default() };
    let mut sender = Connection::new(config.clone(), 0);
    let mut receiver = Connection::new(config.clone(), 0);
    assert!(sender.send(0, &[7u8; 64]) > 0);

    // 接收方收下一个分片后窗口就满了，发送方被卡住，只能靠探测。
    let data = packet_with(&config, &mut sender, 0);
    receiver.on_packet(1_000, &data).expect("valid data");
    receiver.tick(10_000);
    let ack = packet_with(&config, &mut receiver, 10_000);
    sender.on_packet(11_000, &ack).expect("valid ack");
    let mut out = vec![0u8; config.max_packet_size];
    while sender.poll_transmit(11_000, &mut out).is_some() {}
    sender.tick(12_000);
    sender.tick(config.probe_initial_us + 20_000);

    // 探测到期的同时，对端的数据让发送方也有确认要发。
    assert!(receiver.send(config.probe_initial_us, b"reply") > 0);
    let reply = packet_with(&config, &mut receiver, config.probe_initial_us + 20_000);
    sender.on_packet(config.probe_initial_us + 21_000, &reply).expect("valid data");

    let mut sent = 0;
    while sender.poll_transmit(config.probe_initial_us + 22_000, &mut out).is_some() {
        sent += 1;
        assert!(sent < 8, "packet loop did not stop");
    }
    assert!(sent >= 2, "the ack and the probe need a packet each, sent {sent}");
}

/// 校验包只能修复长度合法的分片。算出来的长度不对时什么都不能写进流里：
/// 这里的空洞被填上的话，后面的数据全都错位。
#[test]
fn parity_with_an_impossible_length_is_ignored() {
    // 长度的最高位表示带流头，两种都要试。
    for high_byte in [0xFF, 0x7F] {
        let config = Config::default();
        let mut sender = Connection::new(config.clone(), 0);
        let mut receiver = Connection::new(config.clone(), 0);
        assert_eq!(sender.send(0, b"payload"), 7);
        let data = packet_with(&config, &mut sender, 0);
        receiver.on_packet(1_000, &data).expect("valid data");

        // 第 0 个分片已收到，第 1 个缺失。长度校验的高字节不是 0，解出来的长度超过校验内容。
        let mut forged = vec![0xA0, 0, 1, 4, 0, 0, 2, 0, high_byte, 0xFF];
        forged.extend_from_slice(&[0x11; 32]);
        receiver.on_packet(2_000, &forged).expect("well-formed frame");
        assert_eq!(receiver.stats().recovered_segments, 0);
        let mut out = [0u8; 64];
        assert_eq!(receiver.recv(3_000, &mut out), 7, "stream gained bytes it never received");
    }
}

/// 校验帧的每个字段都可能是假的：覆盖范围落在窗口外、和已交付的数据交错、序号重复、长度乱写。
/// 这里还没有认证，假校验能写进错的内容，但不能崩溃，也不能让内存涨上去。
#[test]
fn forged_parity_never_panics_or_grows_memory() {
    let config = Config { recv_window: 64, send_window: 64, ..Config::default() };
    let bound = config.send_buffer_bytes + 2 * (config.recv_window as usize) * config.max_packet_size;
    let mut rng = Rng::new(0xFEC);
    let mut buffer = vec![0u8; config.max_packet_size];
    let mut drain = [0u8; 4096];
    let (mut parity_frames, mut recovered) = (0u64, 0u64);
    for episode in 0..seed_count() {
        let mut sender = Connection::new(config.clone(), 0);
        let mut victim = Connection::new(config.clone(), 0);
        let mut now = 0;
        let mut number = 1 << 16;
        let chunk = vec![episode as u8; 1 + rng.below(1300) as usize];
        for _ in 0..64 {
            sender.send(now, &chunk);
        }
        while let Some(size) = sender.poll_transmit(now, &mut buffer) {
            now += 100;
            // 留下空洞，校验才有东西可算。
            if rng.below(5) != 0 {
                let _ = victim.on_packet(now, &buffer[..size]);
            }
        }
        for _ in 0..64 {
            now += 100;
            number += 1;
            let mut forged = packet_header(number as u32);
            forged.push(4);
            let first = match rng.below(4) {
                0 => rng.next_u64() as u16,
                _ => rng.below(96) as u16,
            };
            forged.extend_from_slice(&first.to_be_bytes());
            forged.push(2 + rng.below(63) as u8);
            forged.push(rng.below(128) as u8);
            let length: u16 = if rng.below(2) == 0 { rng.below(32) as u16 } else { rng.next_u64() as u16 };
            forged.extend_from_slice(&length.to_be_bytes());
            let size = 1 + rng.below(config.max_packet_size as u64 - forged.len() as u64 - 1) as usize;
            forged.extend((0..size).map(|_| rng.next_u64() as u8));
            parity_frames += victim.on_packet(now, &forged).is_ok() as u64;
            victim.check_invariants();
            victim.tick(now);
            if rng.below(4) == 0 {
                let _ = victim.recv(now, &mut drain);
            }
            while victim.poll_transmit(now, &mut buffer).is_some() {}
            assert!(victim.buffered_bytes() <= bound, "episode {episode}: {} over {bound}", victim.buffered_bytes());
        }
        recovered += victim.stats().recovered_segments;
    }
    // 确认真的走到了解码：假校验大多解出非法长度，但总有一些能通过。
    assert!(parity_frames > seed_count() * 32, "only {parity_frames} frames were parsed");
    assert!(recovered > 0, "decoder never ran to completion");
}

/// 第一批包的确认间隔能直接测出路径速率，不用多爬两三个往返。
#[test]
fn first_flight_measures_the_path() {
    let bytes = 4 << 20;
    let link = LinkProfile { jitter_us: 0, ..path(100_000_000, 20_000) };
    let outcome = bulk(&link, 1024, bytes, 24);
    assert!(outcome.finished, "{outcome:?}");
    assert!(outcome.finish_us < 440_000, "took {}us", outcome.finish_us);

    // 长往返时，包列贴着自身发送速率只能测出路径容量的下界，启动不能停在那里。
    let link = LinkProfile { loss: 0.05, ..path(100_000_000, 150_000) };
    let finish = (1..=8).map(|seed| bulk(&link, 1024, 8 << 20, seed).finish_us).sum::<u64>() / 8;
    assert!(finish < 2_550_000, "long path took {finish}us");
}

fn packet_with(config: &Config, pump_from: &mut Connection, now: u64) -> Vec<u8> {
    let mut out = vec![0u8; config.max_packet_size];
    let size = pump_from.poll_transmit(now, &mut out).expect("a packet to send");
    out.truncate(size);
    out
}

/// 确认从没发过的包或分片，等于让发送方丢弃还没送达的数据，必须拒绝且不改变状态。
#[test]
fn acknowledgement_of_unsent_data_is_rejected() {
    let config = Config::default();
    let mut victim = Connection::new(config.clone(), 0);
    let mut peer = Connection::new(config.clone(), 0);
    assert_eq!(victim.send(0, b"payload"), 7);
    let data = packet_with(&config, &mut victim, 0);
    peer.on_packet(1_000, &data).expect("valid data");
    let valid_ack = {
        peer.tick(10_000);
        packet_with(&config, &mut peer, 10_000)
    };

    // 把包号改成没发过的。ACK 帧从第 3 字节开始，最大包号在帧内第 1–3 字节。
    let mut forged_packet = valid_ack.clone();
    forged_packet[4..7].copy_from_slice(&1000u32.to_be_bytes()[1..]);
    assert_eq!(victim.on_packet(11_000, &forged_packet), Err(PacketError::InvalidAck));
    assert!(victim.has_unacked_data(), "forged ack released data");

    // una 位于帧内第 6–8 字节，改成超过已发送范围。
    let mut forged_una = valid_ack.clone();
    forged_una[9..12].copy_from_slice(&1000u32.to_be_bytes()[1..]);
    assert_eq!(victim.on_packet(11_000, &forged_una), Err(PacketError::InvalidAck));
    assert!(victim.has_unacked_data(), "forged una released data");

    // 区间跨度超过实际包号时，减法会下溢成巨大的包号，等于确认了不存在的包。
    let mut forged_range = valid_ack[..17].to_vec();
    forged_range[16] = 1;
    forged_range.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
    assert_eq!(victim.on_packet(11_000, &forged_range), Err(PacketError::InvalidAck));
    assert!(victim.has_unacked_data(), "forged range released data");

    victim.on_packet(12_000, &valid_ack).expect("the real ack still works");
    assert!(!victim.has_unacked_data());
}

/// 包头：首字节高 3 位是版本，低 4 位和后两个字节是包号低 20 位。
fn packet_header(packet_number: u32) -> Vec<u8> {
    let [_, high, middle, low] = packet_number.to_be_bytes();
    vec![0xA0 | (high & 0x0F), middle, low]
}

fn crafted_data_packet(packet_number: u32, sn: u32, payload: &[u8]) -> Vec<u8> {
    let mut packet = packet_header(packet_number);
    packet.push(1);
    packet.extend_from_slice(&sn.to_be_bytes());
    packet.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    packet.extend_from_slice(payload);
    packet
}

/// 版本位对不上的包一律不认，将来改线格式时新旧两端不会把对方的包读错。
#[test]
fn packets_of_another_version_are_rejected() {
    let mut victim = Connection::new(Config::default(), 0);
    let mut packet = crafted_data_packet(0, 0, b"payload");
    victim.on_packet(0, &packet).expect("current version");
    packet[0] ^= 0x40;
    assert_eq!(victim.on_packet(0, &packet), Err(PacketError::Malformed));
}

/// 攻击者可以直接构造格式合法的包。超大分片要拒收，窗口外的序号不能占内存。
#[test]
fn crafted_flood_cannot_grow_receive_buffers() {
    let config = Config { recv_window: 16, ..Config::default() };
    let mut victim = Connection::new(config.clone(), 0);
    // 长度字段的最高位表示带流头，所以最长只能写到 32767。
    let oversized = crafted_data_packet(0, 0, &vec![1u8; 30_000]);
    assert_eq!(victim.on_packet(0, &oversized), Err(PacketError::Malformed));
    assert_eq!(victim.buffered_bytes(), 0);

    let mut rng = Rng::new(0xF100D);
    let payload = vec![2u8; 1000];
    for number in 0..50_000u32 {
        let sn = rng.below(1 << 31) as u32;
        let _ = victim.on_packet(number as u64, &crafted_data_packet(number, sn, &payload));
        victim.check_invariants();
    }
    let bound = config.recv_window as usize * config.max_packet_size;
    assert!(victim.buffered_bytes() <= bound, "{} over {bound}", victim.buffered_bytes());
}

/// 第 1 步还没有加密，网络上任何人都能发包。垃圾数据和被篡改的真实包都不能让进程崩溃或内存失控。
#[test]
fn hostile_packets_never_panic_or_grow_memory() {
    let config = Config { recv_window: 64, send_window: 64, ..Config::default() };
    let rounds = seed_count() * 20;
    let mut rng = Rng::new(0xF022);
    let mut victim = Connection::new(config.clone(), 0);
    let mut sender = Connection::new(config.clone(), 0);
    let mut buffer = vec![0u8; config.max_packet_size];
    let mut valid: Vec<Vec<u8>> = Vec::new();
    let bound = config.send_buffer_bytes + 2 * (config.recv_window as usize) * config.max_packet_size;
    let mut now = 0u64;

    for round in 0..rounds {
        now += 100;
        if round % 32 == 0 {
            sender.send(now, &[round as u8; 900]);
        }
        sender.tick(now);
        while let Some(size) = sender.poll_transmit(now, &mut buffer) {
            valid.push(buffer[..size].to_vec());
            if valid.len() > 64 {
                valid.remove(0);
            }
        }
        let packet = match rng.below(3) {
            0 => {
                let size = rng.below(1500) as usize;
                (0..size).map(|_| rng.next_u64() as u8).collect::<Vec<u8>>()
            }
            _ if valid.is_empty() => vec![0xA0],
            kind => {
                let mut mutated = valid[rng.below(valid.len() as u64) as usize].clone();
                for _ in 0..1 + rng.below(8) {
                    let index = rng.below(mutated.len() as u64) as usize;
                    mutated[index] = rng.next_u64() as u8;
                }
                if kind == 1 {
                    let keep = rng.below(mutated.len() as u64 + 1) as usize;
                    mutated.truncate(keep);
                }
                mutated
            }
        };
        let _ = victim.on_packet(now, &packet);
        victim.check_invariants();
        victim.tick(now);
        let mut drain = [0u8; 2048];
        let _ = victim.recv(now, &mut drain);
        while victim.poll_transmit(now, &mut buffer).is_some() {}
        assert!(victim.buffered_bytes() <= bound, "round {round}: {} over {bound}", victim.buffered_bytes());
    }
}

/// 定位慢种子用，默认不跑：`cargo test --release -- --ignored profile --nocapture`。
#[test]
#[ignore]
fn profile_slowest_seeds() {
    let mut rows: Vec<(u128, u64, u64, u64)> = (0..seed_count())
        .map(|seed| {
            let started = std::time::Instant::now();
            let outcome = run_case(&random_case(seed));
            (started.elapsed().as_millis(), seed, outcome.steps, outcome.finish_us)
        })
        .collect();
    rows.sort_unstable();
    for (ms, seed, steps, finish) in rows.iter().rev().take(5) {
        println!("seed {seed}: {ms}ms steps={steps} finish={}s", finish / 1_000_000);
    }
    println!("total {}ms", rows.iter().map(|row| row.0).sum::<u128>());
}

/// 新策略会改变启动窗口、校验和副本的发送顺序；此前随机矩阵只覆盖默认策略。
/// 三种策略都必须通过真实 Connection 入口保持字节完整、有序、可恢复和无空转。
#[test]
fn recovery_policies_keep_streams_intact_and_make_progress() {
    for policy in [RecoveryPolicy::Lean, RecoveryPolicy::Auto, RecoveryPolicy::Fast] {
        for seed in HARD_SEEDS.into_iter().chain(seed_start()..seed_start() + seed_count().min(1000)) {
            let mut case = random_case(seed);
            case.config.recovery_policy = policy;
            case.config.ack_every = Config::for_policy(policy).ack_every;
            let result = run_case(&case);
            assert!(result.finished && result.violation.is_none() && result.spurious_wakes == 0,
                "policy {policy:?} seed {seed}: {result:?}");
        }
    }
}

/// 策略只改变本地发送行为，不得要求对端选择同一策略；验证六种不同策略的双向互通。
#[test]
fn different_recovery_policies_interoperate() {
    for a in [RecoveryPolicy::Lean, RecoveryPolicy::Auto, RecoveryPolicy::Fast] {
        for b in [RecoveryPolicy::Lean, RecoveryPolicy::Auto, RecoveryPolicy::Fast] {
            if a == b { continue; }
            let link = LinkProfile { loss: 0.05, reorder: 0.03, reorder_extra_us: 30_000, ..path(20_000_000, 20_000) };
            let workload = Workload { a_to_b_bytes: 128 << 10, b_to_a_bytes: 96 << 10, ..Workload::default() };
            let result = run(CorePeer::new(Config::for_policy(a)), CorePeer::new(Config::for_policy(b)), link.clone(), link, &workload, 71);
            assert!(result.finished && result.violation.is_none() && result.spurious_wakes == 0,
                "policies {a:?}/{b:?}: {result:?}");
        }
    }
}
