//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::Connection`，几条连接和 TCP 共用一个瓶颈时，断言各自分到的速率、丢包率和瓶颈利用率。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 3 步。2026-11-02 实测四条连接同抢 20 Mbit/s 时丢包 71%、两条被饿死：
//!   算法把别的流挤掉的包当成随机丢包，按丢包率多发，发得越多丢得越多。`BandwidthShare::Fair` 的用例依据用户 2026-11-02 的决定：
//!   默认全速，另有让路配置。第一版让路在模拟里过关，公网下载却是 5.6 / 0.1，所以用例里有往返 12 毫秒的窄线路和两段确认一次的 TCP；
//!   公网 Wi-Fi 上还掉到过 15 Mbit/s，所以有短暂断网的用例。分线路门槛按同一条线路上两条 TCP 互相抢的结果定。
//!   2026-11-03 发现后加入的连接会一直超发，见 `late_joiners_do_not_keep_overshooting`；共享模拟器从这时起在流开始时才建连接，和真实设备一样。
//!   2026-11-04 四条连接挤 3 毫秒的队列丢 27%：队列比排队判断的余量还浅，被挤掉的包都算成了随机丢包，见 `hidden_queue_is_not_read_as_random_loss`。
//! - 现有覆盖缺口：`reliability.rs` 和 `streams.rs` 都只有一对端点，碰不到多个发送方抢瓶颈。
//! - 最小失败输入：固定场景写在各用例里，瓶颈带 0.5 毫秒抖动，用固定种子。
//! - tier：Rust integration，虚拟时间，无真实网络；TCP 对手是 `sim/src/share.rs` 里的 CUBIC 和 Reno 模型，不是真实 TCP 栈。
//!   上传方向公网上 TCP 占优、这里略偏向我们，模型还没覆盖真实上传线路，分线路的最终判断看 `sim/share-public.py`。
//! - 实测耗时：2026-11-05，Windows 本机 2.6–3.9 秒（不含编译，随机器负载变）。场景固定，不随 `AGENT_NET_SEEDS` 变。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use agent_net_core::{BandwidthShare, Config, RecoveryPolicy};
use agent_net_sim::LinkProfile;
use agent_net_sim::share::{Flow, FlowKind, ShareResult, TcpVariant, jain_index, run_shared, run_shared_with_timer};

const WINDOW: u32 = 8192;

fn agent() -> FlowKind {
    FlowKind::AgentNet(Config { max_packet_size: 1400, send_window: WINDOW, recv_window: WINDOW, send_buffer_bytes: WINDOW as usize * 2800, ..Config::for_policy(RecoveryPolicy::Auto) })
}

fn agent_with(bandwidth_share: BandwidthShare) -> FlowKind {
    let FlowKind::AgentNet(config) = agent() else { unreachable!() };
    FlowKind::AgentNet(Config { bandwidth_share, ..config })
}

fn flow(kind: FlowKind, start_us: u64, extra_rtt_us: u64) -> Flow {
    Flow { kind, start_us, extra_rtt_us }
}

fn bottleneck(bits_per_second: u64, rtt_us: u64, bdps: f64) -> LinkProfile {
    LinkProfile { bits_per_second, delay_us: rtt_us / 2, jitter_us: 500, queue_us: (rtt_us as f64 * bdps) as u64, ..LinkProfile::default() }
}

fn share(link: &LinkProfile, flows: &[Flow], seconds: u64, measure_from: u64) -> ShareResult {
    run_shared(link, flows, seconds * 1_000_000, measure_from * 1_000_000, 1)
}

/// 自家的连接抢一个瓶颈时不能崩溃：丢包要低、线路要用满、每条都要有进展。
#[test]
fn several_connections_do_not_collapse_the_bottleneck() {
    for (bits, bdps) in [(20_000_000, 0.25), (20_000_000, 1.0), (100_000_000, 0.25)] {
        let flows: Vec<Flow> = (0..4).map(|index| flow(agent(), index * 200_000, 0)).collect();
        let result = share(&bottleneck(bits, 40_000, bdps), &flows, 20, 5);
        assert!(result.loss <= 0.15, "{bits} {bdps}: 丢包 {:.1}%", result.loss * 100.0);
        assert!(result.utilization >= 0.95, "{bits} {bdps}: 利用率 {:.2}", result.utilization);
        assert!(result.rates.iter().all(|&rate| rate >= bits as f64 / 400.0), "{bits} {bdps}: {:?}", result.rates);
    }
}

/// 后加入的连接不能一直按别人造成的丢包多发。2026-11-03 查到两个自我维持的循环，以前被统计段起点的问题掩盖：
/// 每一轮都丢得比送达多时带宽样本一直不老化，几条流各自以为整条线归自己；开头几条流一起启动时估高的随机丢包率，
/// 队列一直满着时没有样本能修正，大家按它多发。修之前 5 秒后加入的那条让这条线路丢 16.8%，四条依次加入时丢 12%。
#[test]
fn late_joiners_do_not_keep_overshooting() {
    let link = bottleneck(100_000_000, 100_000, 0.25);
    let result = share(&link, &[flow(agent(), 0, 0), flow(agent(), 5_000_000, 0)], 25, 10);
    assert!(result.loss <= 0.03, "后来者：丢包 {:.1}%", result.loss * 100.0);
    assert!(jain_index(&result.rates) >= 0.9, "后来者：{:?}", result.rates);
    let flows: Vec<Flow> = (0..4).map(|index| flow(agent(), index * 200_000, 0)).collect();
    let result = share(&link, &flows, 20, 5);
    assert!(result.loss <= 0.05, "四条：丢包 {:.1}%", result.loss * 100.0);
}

/// 浅队列比抖动还小时看不出排队，别的流挤掉的包会被当成随机丢包。持续满发时补偿得收住，判错的损失才有上限：
/// 放大两倍的话，第一个场景丢掉一半。2026-11-03 起别人的队列里送到的包也算进随机丢包率，第一个场景的估计不再冲到上限；
/// 两条连接同时挤 3 毫秒的队列还会冲到，上限放宽到 50% 时丢包从 2% 变成 46%。2026-11-04 认出看不出的排队以后这两个也冲不到了。
/// 四条连接依次挤 20 Mbit/s 上 4 毫秒的队列：持续满发时按 20% 补偿（2026-11-05 以前）丢 19%，放宽到 50% 时 43%；
/// 现在满发时只补探测补不回来的部分，丢 3.6%。四条依次挤 20 Mbit/s、往返 12 毫秒的 3 毫秒队列：现在 5.4%，
/// 满发时按 20% 封顶补偿（其余照现在）14.7%。见 `sim/results/2026-11-05-shared-shallow-queue`。
#[test]
fn misread_loss_stays_bounded_on_shallow_queues() {
    let flows = [flow(agent(), 0, 0), flow(agent(), 0, 120_000)];
    let result = share(&bottleneck(100_000_000, 100_000, 0.25), &flows, 25, 10);
    assert!(result.loss <= 0.2, "丢包 {:.1}%", result.loss * 100.0);
    let result = share(&bottleneck(100_000_000, 12_000, 0.25), &[flow(agent(), 0, 0), flow(agent(), 0, 0)], 20, 5);
    assert!(result.loss <= 0.1, "往返 12ms：丢包 {:.1}%", result.loss * 100.0);
    let flows: Vec<Flow> = (0..4).map(|index| flow(agent(), index * 200_000, 0)).collect();
    let result = share(&bottleneck(20_000_000, 40_000, 0.1), &flows, 20, 5);
    assert!(result.loss <= 0.1, "四条挤 4 毫秒队列：丢包 {:.1}%", result.loss * 100.0);
    let result = share(&bottleneck(20_000_000, 12_000, 0.25), &flows, 20, 5);
    assert!(result.loss <= 0.1, "四条挤 20M 3 毫秒队列：丢包 {:.1}%", result.loss * 100.0);
}

/// 队列浅到排满了往返时间也涨不过排队判断的余量（3 毫秒对 4 毫秒）时，靠往返时间认不出排队。几条连接挤在一起，
/// 被挤掉的包被当成随机丢包，各自按估高的丢包率多发，多发的又被挤掉，估多少就丢多少，能一直维持下去。
/// 现在比同一个探测周期里巡航和降速的丢包率：随机丢包和速率无关，被挤掉的包跟着速率涨。
/// 认出来以后收回随机丢包的补偿，降速时丢的包也不再算进随机丢包率，送到的照样算，估高的值才降得下来。
/// 最后一行守着另一头：线路真有随机丢包时清理不能清过头，否则限速判断把随机丢包当成撞上限速，一路压低速率。
#[test]
fn hidden_queue_is_not_read_as_random_loss() {
    let flows: Vec<Flow> = (0..4).map(|index| flow(agent(), index * 200_000, 0)).collect();
    let shallow = bottleneck(100_000_000, 12_000, 0.25);
    let rows = [
        // 2026-11-04：修之前丢 24.5%、公平指数 0.75，之后 5.9%、0.98；2026-11-05 满发时不再按 20% 补偿，2.7%、0.99。
        ("100M 12ms 3 毫秒队列", shallow.clone(), 1, 0.10, 0.9, 0.0),
        // 1 毫秒定时器：修之前丢 13.6%，之后 5.9%；降速时丢的包照样算进随机丢包率的话是 12.8%。
        // 2026-11-05 起 4.4%、公平 0.80。认别人的队列时仍按排队判断的 4 毫秒余量是 7.6%；丢包跟着速率涨时降速丢包照常算，
        // 公平 0.52；限速判断的门槛按清理后的估计算，0.42：都是一条连接被当成撞上限速、压了下去。
        ("100M 12ms 3 毫秒队列 1 毫秒定时器", shallow, 1_000, 0.06, 0.6, 0.0),
        // 修之前利用率 0.94、公平指数 0.75，之后 0.92、0.80。补偿收回后一直不放开时利用率 0.84；
        // 限速判断的门槛按清理后的估计算时公平指数 0.55，有一条被压到 0.9 Mbit/s。
        // 2026-11-05 起满发时随机丢 16% 以内不补偿，利用率 0.865、公平 0.81：这是用户选的取舍，浅队列上几条连接少丢包优先。
        ("20M 40ms 一倍队列 随机丢 10%", LinkProfile { loss: 0.10, ..bottleneck(20_000_000, 40_000, 1.0) }, 1, 1.0, 0.7, 0.85),
    ];
    for (name, link, timer_us, max_loss, min_fairness, min_utilization) in rows {
        let result = run_shared_with_timer(&link, &flows, 20_000_000, 5_000_000, 1, timer_us);
        assert!(result.loss <= max_loss, "{name}: 丢包 {:.1}%", result.loss * 100.0);
        assert!(jain_index(&result.rates) >= min_fairness, "{name}: {:?}", result.rates);
        assert!(result.utilization >= min_utilization, "{name}: 利用率 {:.2}", result.utilization);
    }
}

/// 令牌桶攒满令牌时一下放行一串，周期和周期之间的丢包率差得很远。比巡航和降速的丢包率时，标准误要按周期之间实际差多少放大，
/// 只按每个包独立算的话会把这种起伏当成看不出的排队：1 毫秒定时器下单条连接的丢包从 2.35% 涨到 4.0%（修之前也是 2.35%）。
#[test]
fn bursty_limiter_is_not_read_as_a_hidden_queue() {
    let result = run_shared_with_timer(&limiter(708_000, 45_000, 600_000), &[flow(agent(), 0, 0)], 30_000_000, 10_000_000, 1, 1_000);
    assert!(result.loss <= 0.03, "丢包 {:.2}%", result.loss * 100.0);
}

/// 真机的定时器有粒度：迟到的时间作废的话，每次醒来只能发一个包，速度锁死在“一个包除以定时器精度”，
/// 4 毫秒的定时器上只有 2.8 Mbit/s，Windows 默认的 15.6 毫秒上只有 0.7。公网下载实测出现过 0.6。
#[test]
fn coarse_timers_do_not_cap_the_rate() {
    let bucket = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 45_000, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: 5_000_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() };
    for (name, link, floor) in [("令牌桶 40M", bucket, 36_000_000.0), ("普通 100M", bottleneck(100_000_000, 40_000, 1.0), 90_000_000.0)] {
        for timer_us in [4_000, 16_000] {
            let rate = run_shared_with_timer(&link, &[flow(agent(), 0, 0)], 15_000_000, 5_000_000, 1, timer_us).rates[0];
            assert!(rate >= floor, "{name} 定时器 {timer_us}us: {:.1} Mbit/s", rate / 1e6);
        }
    }
}

/// 限速器把多发的包都丢了，在途量永远到不了探测的目标。一直等下去就一直多发 25%、一直丢 20%。
/// 精确时钟下碰不到，定时器有粒度时才会卡住，所以要在这种条件下看。
#[test]
fn probing_does_not_get_stuck_on_a_rate_limiter() {
    let link = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 45_000, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: 5_000_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() };
    let result = run_shared_with_timer(&link, &[flow(agent(), 0, 0)], 20_000_000, 8_000_000, 1, 1_000);
    assert!(result.loss <= 0.08, "丢包 {:.1}%", result.loss * 100.0);
    assert!(result.rates[0] >= 36_000_000.0, "{:.1} Mbit/s", result.rates[0] / 1e6);
}

/// 两条连接要分得平均：一起开始、后来加入、往返时间不同都一样。
#[test]
fn two_connections_share_evenly() {
    let link = bottleneck(100_000_000, 40_000, 1.0);
    let rows = [
        ("一起开始", vec![flow(agent(), 0, 0), flow(agent(), 0, 0)]),
        ("后来加入", vec![flow(agent(), 0, 0), flow(agent(), 5_000_000, 0)]),
        ("往返时间不同", vec![flow(agent(), 0, 0), flow(agent(), 0, 120_000)]),
    ];
    for (name, flows) in rows {
        let result = share(&link, &flows, 25, 10);
        assert!(jain_index(&result.rates) >= 0.9, "{name}: {:?}", result.rates);
        assert!(result.loss <= 0.03, "{name}: 丢包 {:.1}%", result.loss * 100.0);
    }
}

/// 和 TCP 共用线路时双方都要有份额。队列一个带宽延迟积时应该接近平分；高带宽的极浅队列和低带宽的极深队列是已知短板，
/// 这里守住的是谁也不能被挤到没有。令牌桶限速时 TCP 基本拿不到份额，这是已知的取舍，见结果记录，这里不断言。
#[test]
fn tcp_and_agent_net_both_get_a_share() {
    for (variant, bits, rtt, bdps, agent_floor, tcp_floor) in [
        (TcpVariant::Cubic, 100_000_000, 40_000, 1.0, 0.3, 0.3),
        (TcpVariant::Reno, 100_000_000, 40_000, 1.0, 0.3, 0.3),
        (TcpVariant::Cubic, 20_000_000, 40_000, 1.0, 0.3, 0.3),
        (TcpVariant::Reno, 20_000_000, 40_000, 0.25, 0.3, 0.3),
        (TcpVariant::Cubic, 100_000_000, 100_000, 0.25, 0.3, 0.05),
        (TcpVariant::Reno, 100_000_000, 100_000, 0.25, 0.3, 0.05),
        (TcpVariant::Cubic, 20_000_000, 40_000, 4.0, 0.05, 0.3),
    ] {
        let flows = [flow(agent(), 0, 0), flow(FlowKind::Tcp(variant), 0, 0)];
        let result = share(&bottleneck(bits, rtt, bdps), &flows, 30, 10);
        let total: f64 = result.rates.iter().sum();
        let (ours, theirs) = (result.rates[0] / total, result.rates[1] / total);
        assert!(ours >= agent_floor && theirs >= tcp_floor, "{variant:?} {bits} {rtt} {bdps}: {:.1} / {:.1} Mbit/s", result.rates[0] / 1e6, result.rates[1] / 1e6);
        assert!(result.utilization >= 0.9, "{variant:?} {bits} {rtt} {bdps}: 利用率 {:.2}", result.utilization);
    }
}

fn limiter(bytes_per_second: u64, delay_us: u64, bucket_depth_bytes: u64) -> LinkProfile {
    LinkProfile { bits_per_second: 1_000_000_000, delay_us, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: bytes_per_second, bucket_depth_bytes, ..LinkProfile::default() }
}

/// 让路模式要真的和 CUBIC 分线路：浅队列、深队列、限速器上全速模式都分不平，这里都要分得开。
/// 1 毫秒定时器更接近真机。
#[test]
fn fair_share_splits_the_line_with_tcp() {
    let rows = [
        ("20M 浅队列", bottleneck(20_000_000, 40_000, 0.25), 0.3),
        ("100M 浅队列", bottleneck(100_000_000, 40_000, 0.25), 0.3),
        // 这条线路上两条 TCP 互相抢也只是 65 / 31。
        ("100M 长往返浅队列", bottleneck(100_000_000, 100_000, 0.25), 0.3),
        ("100M 中等队列", bottleneck(100_000_000, 40_000, 1.0), 0.35),
        ("20M 深队列", bottleneck(20_000_000, 40_000, 4.0), 0.25),
        ("限速 5.6M", limiter(708_000, 45_000, 600_000), 0.3),
        // 这条线路上两条 TCP 互相抢也只是 25 / 11。
        ("限速 40M", limiter(5_000_000, 45_000, 600_000), 0.2),
        // 公网下载就是这种线路：一个往返只装得下几个包，比全速模式的窗口下限还小。
        ("限速 5.6M 短往返", limiter(708_000, 6_000, 30_000), 0.45),
        ("限速 5.6M 短往返深桶", limiter(708_000, 6_000, 600_000), 0.45),
    ];
    for (name, link, least) in rows {
        let flows = [flow(agent_with(BandwidthShare::Fair), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)];
        let result = run_shared_with_timer(&link, &flows, 30_000_000, 10_000_000, 1, 1_000);
        let total: f64 = result.rates.iter().sum();
        let (ours, theirs) = (result.rates[0] / total, result.rates[1] / total);
        assert!(ours >= 0.15 && theirs >= least, "{name}: {:.1} / {:.1} Mbit/s", result.rates[0] / 1e6, result.rates[1] / 1e6);
    }
}

/// 让路只在有人抢的时候让：线路空着时不比一条 TCP 慢多少。默认必须是全速，抢得过让路模式。
#[test]
fn fair_share_fills_an_empty_line_and_full_is_the_default() {
    let alone = |link: &LinkProfile, kind: FlowKind| run_shared_with_timer(link, &[flow(kind, 0, 0)], 20_000_000, 8_000_000, 1, 1_000).rates[0];
    for (name, link) in [("100M", bottleneck(100_000_000, 40_000, 1.0)), ("限速 40M", limiter(5_000_000, 45_000, 600_000)), ("限速 5.6M 短往返", limiter(708_000, 6_000, 30_000))] {
        let (fair, tcp) = (alone(&link, agent_with(BandwidthShare::Fair)), alone(&link, FlowKind::TcpDelayedAck(TcpVariant::Cubic)));
        assert!(fair >= tcp * 0.85, "{name}: {:.1} / {:.1} Mbit/s", fair / 1e6, tcp / 1e6);
    }

    let link = limiter(5_000_000, 45_000, 600_000);
    let against_tcp = |kind: FlowKind| run_shared_with_timer(&link, &[flow(kind, 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000, 1, 1_000).rates[0];
    assert!(against_tcp(agent()) > against_tcp(agent_with(BandwidthShare::Fair)) * 1.3, "默认配置要是全速");
}

/// 线路空着时开局就要快。启动冲过头丢的包连着查出来好几轮，逐轮减的话窗口只剩容量的三分之一，要爬十几秒。
#[test]
fn fair_share_takes_an_empty_line_right_away() {
    for (name, link) in [("100M 40ms", bottleneck(100_000_000, 40_000, 1.0)), ("100M 100ms", bottleneck(100_000_000, 100_000, 1.0))] {
        let rate = run_shared_with_timer(&link, &[flow(agent_with(BandwidthShare::Fair), 0, 0)], 3_000_000, 1_000_000, 1, 1_000).rates[0];
        assert!(rate >= 90_000_000.0, "{name}: 第 2、3 秒 {:.1} Mbit/s", rate / 1e6);
    }
}

/// 超时判的丢包不算拥塞。我们的超时只有十几毫秒，公网 Wi-Fi 上卡一下就响，速度一低确认变稀，响得更多，
/// 算成拥塞会一路掉到 15 Mbit/s 出不来，TCP 最短 200 毫秒的超时碰不到这个问题。这里用短暂断网造出超时。
#[test]
fn fair_share_does_not_take_timeouts_for_congestion() {
    let outages = (1..60).map(|index| (index * 300_000, index * 300_000 + 40_000)).collect();
    let link = LinkProfile { outages, ..bottleneck(100_000_000, 12_000, 1.0) };
    let rate = |kind| run_shared_with_timer(&link, &[flow(kind, 0, 0)], 15_000_000, 5_000_000, 1, 1_000);
    let (fair, full) = (rate(agent_with(BandwidthShare::Fair)), rate(agent()));
    assert!(fair.stats[0].as_ref().expect("agent-net").timeout_losses > 0, "没有制造出超时，测的不是这件事");
    assert!(fair.rates[0] >= full.rates[0] * 0.8, "{:.1} / {:.1} Mbit/s", fair.rates[0] / 1e6, full.rates[0] / 1e6);
}

/// 窗口下限按字节算。按包算时 64 字节的包下限只有 128 字节，丢包多、往返长的线路上一个来回传不了多少，
/// 随机测试里有种子 600 秒传不完。
#[test]
fn fair_share_window_floor_does_not_shrink_with_the_packet() {
    let link = LinkProfile { loss: 0.2, ..bottleneck(10_000_000, 600_000, 0.33) };
    let FlowKind::AgentNet(config) = agent_with(BandwidthShare::Fair) else { unreachable!() };
    let kind = FlowKind::AgentNet(Config { max_packet_size: 64, ..config });
    let rate = run_shared_with_timer(&link, &[flow(kind, 0, 0)], 60_000_000, 10_000_000, 1, 1_000).rates[0];
    assert!(rate >= 15_000.0, "{:.1} kbit/s", rate / 1e3);
}

/// 让路的连接和全速的连接同跑时，全速的占大头，让路的也不能被饿死。
#[test]
fn fair_share_survives_beside_a_full_speed_connection() {
    let flows = [flow(agent_with(BandwidthShare::Fair), 0, 0), flow(agent(), 0, 0)];
    let result = share(&bottleneck(100_000_000, 40_000, 1.0), &flows, 25, 10);
    assert!(result.rates[0] >= 5_000_000.0 && result.utilization >= 0.95, "{:?}", result.rates);
}
