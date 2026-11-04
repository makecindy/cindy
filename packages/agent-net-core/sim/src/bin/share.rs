//! 多个发送方抢一个瓶颈：公平性、和 TCP 共存。只用于测试，不进入产品。
//! 用法：`share [过滤词]`，环境变量 `SHARE_SEEDS` 指定种子数，默认 3。

use agent_net_core::{BandwidthShare, Config, RecoveryPolicy};
use agent_net_sim::LinkProfile;
use agent_net_sim::share::{Flow, FlowKind, TcpVariant, jain_index, run_shared_with_timer};

fn agent(window: u32) -> FlowKind {
    // `SHARE_MODE=fair` 看让路模式。
    let bandwidth_share = if std::env::var("SHARE_MODE").is_ok_and(|mode| mode == "fair") { BandwidthShare::Fair } else { BandwidthShare::Full };
    FlowKind::AgentNet(Config { bandwidth_share, max_packet_size: 1400, send_window: window, recv_window: window, send_buffer_bytes: window as usize * 2800, ..Config::for_policy(RecoveryPolicy::Auto) })
}

fn flow(kind: FlowKind, start_us: u64, extra_rtt_us: u64) -> Flow {
    Flow { kind, start_us, extra_rtt_us }
}

/// 瓶颈：`bdps` 是队列能排几个带宽延迟积。
fn bottleneck(bits_per_second: u64, rtt_us: u64, bdps: f64) -> LinkProfile {
    LinkProfile { bits_per_second, delay_us: rtt_us / 2, jitter_us: 500, queue_us: (rtt_us as f64 * bdps) as u64, ..LinkProfile::default() }
}

fn main() {
    let filter = std::env::args().nth(1).unwrap_or_default();
    let seeds: u64 = std::env::var("SHARE_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(3);
    // 端点循环的粒度，微秒。真机上是定时器精度，云主机上可能有好几毫秒。
    let timer: u64 = std::env::var("SHARE_TIMER_US").ok().and_then(|value| value.parse().ok()).unwrap_or(1);
    let window = 8192;
    let mut rows: Vec<(String, LinkProfile, Vec<Flow>, u64, u64)> = Vec::new();
    for (name, bits, rtt) in [("20M 40ms", 20_000_000u64, 40_000u64), ("100M 12ms", 100_000_000, 12_000), ("100M 40ms", 100_000_000, 40_000), ("100M 100ms", 100_000_000, 100_000)] {
        for bdps in [0.25, 1.0, 4.0] {
            let link = bottleneck(bits, rtt, bdps);
            let label = format!("{name} 队列{bdps}倍");
            rows.push((format!("公平 两条 {label}"), link.clone(), vec![flow(agent(window), 0, 0), flow(agent(window), 0, 0)], 20_000_000, 5_000_000));
            rows.push((format!("公平 后来者 {label}"), link.clone(), vec![flow(agent(window), 0, 0), flow(agent(window), 5_000_000, 0)], 25_000_000, 10_000_000));
            rows.push((format!("公平 四条 {label}"), link.clone(), (0..4).map(|index| flow(agent(window), index * 200_000, 0)).collect(), 20_000_000, 5_000_000));
            rows.push((format!("往返不同 40/160ms {label}"), link.clone(), vec![flow(agent(window), 0, 0), flow(agent(window), 0, 120_000)], 25_000_000, 10_000_000));
            rows.push((format!("对 CUBIC {label}"), link.clone(), vec![flow(agent(window), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000));
            rows.push((format!("对 Reno {label}"), link.clone(), vec![flow(agent(window), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Reno), 0, 0)], 30_000_000, 10_000_000));
            rows.push((format!("基准 两条 CUBIC {label}"), link.clone(), vec![flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000));
        }
    }
    // 令牌桶：没有队列，超速就丢。云主机的带宽上限常常是这样。
    for (name, bytes, depth, delay_us) in [
        ("限速 5.6M", 708_000u64, 600_000u64, 45_000u64),
        ("限速 40M", 5_000_000, 600_000, 45_000),
        ("短往返限速 5.6M", 708_000, 30_000, 6_000),
        ("短往返限速 5.6M 深桶", 708_000, 600_000, 6_000),
        ("短往返限速 40M", 5_000_000, 100_000, 6_000),
    ] {
        let link = LinkProfile { bits_per_second: 1_000_000_000, delay_us, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: bytes, bucket_depth_bytes: depth, ..LinkProfile::default() };
        rows.push((format!("单独 {name}"), link.clone(), vec![flow(agent(window), 0, 0)], 30_000_000, 10_000_000));
        rows.push((format!("基准 单独 CUBIC {name}"), link.clone(), vec![flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000));
        rows.push((format!("公平 两条 {name}"), link.clone(), vec![flow(agent(window), 0, 0), flow(agent(window), 0, 0)], 30_000_000, 10_000_000));
        rows.push((format!("对 CUBIC {name}"), link.clone(), vec![flow(agent(window), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000));
        rows.push((format!("后来的 CUBIC {name}"), link.clone(), vec![flow(agent(window), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 5_000_000, 0)], 30_000_000, 10_000_000));
        rows.push((format!("基准 两条 CUBIC {name}"), link.clone(), vec![flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0), flow(FlowKind::TcpDelayedAck(TcpVariant::Cubic), 0, 0)], 30_000_000, 10_000_000));
    }
    for (name, link, flows, duration, measure_from) in rows {
        if !name.contains(&filter) {
            continue;
        }
        let mut rates = vec![0.0; flows.len()];
        let (mut queue, mut loss, mut utilization) = (0.0, 0.0, 0.0);
        for seed in 1..=seeds {
            let result = run_shared_with_timer(&link, &flows, duration, measure_from, seed, timer);
            for (total, rate) in rates.iter_mut().zip(&result.rates) {
                *total += rate / seeds as f64;
            }
            queue += result.mean_queue_us as f64 / 1000.0 / seeds as f64;
            loss += result.loss / seeds as f64;
            utilization += result.utilization / seeds as f64;
        }
        if std::env::var("SHARE_DEBUG").is_ok() {
            let result = run_shared_with_timer(&link, &flows, duration, measure_from, 1, timer);
            for (index, stats) in result.stats.iter().enumerate() {
                println!("  流{index} 送达 {:.1}M 发出 {:.1}M {stats:?}", result.rates[index] / 1e6, result.offered_bytes[index] as f64 * 8.0 / ((duration - measure_from) as f64));
            }
        }
        let shown: Vec<String> = rates.iter().map(|rate| format!("{:.1}", rate / 1e6)).collect();
        println!("{name:<34} 各流 {:<28} Mbit/s  公平 {:.2}  利用率 {:3.0}%  排队 {queue:6.1}ms  丢包 {:.2}%", shown.join(" / "), jain_index(&rates), utilization * 100.0, loss * 100.0);
    }
}
