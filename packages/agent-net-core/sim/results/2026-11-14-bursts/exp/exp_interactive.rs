//! 断网线路上零星消息的延迟分位数，种子多一些看真实差别（2026-11-14，对比两版核心用）。
//! 运行：`cargo test --profile sim -p agent-net-sim --test exp_interactive -- --nocapture`
use agent_net_core::Config;
use agent_net_sim::{CorePeer, LatencyReport, LinkProfile, run_interactive};

#[test]
fn interactive_tail_over_many_seeds() {
    let rows = [
        ("高铁 15M 80ms 丢 4% 短断网", LinkProfile { bits_per_second: 15_000_000, delay_us: 40_000, jitter_us: 12_000, loss: 0.04, burst_every_us: 4_000_000, burst_len_us: 400_000, burst_loss: 1.0, queue_us: 120_000, ..LinkProfile::default() }),
        ("地铁 30M 60ms 每 5 秒断 1 秒", LinkProfile { bits_per_second: 30_000_000, delay_us: 30_000, jitter_us: 10_000, loss: 0.02, burst_every_us: 5_000_000, burst_len_us: 1_000_000, burst_loss: 1.0, queue_us: 100_000, ..LinkProfile::default() }),
    ];
    let config = Config::default();
    for (name, link) in rows {
        for (from, to) in [(1u64, 16u64), (1, 128)] {
            let mut merged = LatencyReport::default();
            for seed in from..=to {
                let report = run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), link.clone(), 2_000, 200, 20_000, seed);
                merged.samples_us.extend(report.samples_us);
            }
            println!("{name} 种子 {from}-{to}: p50 {:.1} p95 {:.1} p99 {:.1} ms", merged.percentile_ms(50.0), merged.percentile_ms(95.0), merged.percentile_ms(99.0));
        }
    }
}
