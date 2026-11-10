//! 临时实验，不进测试：安静探测的间隔对“不知道换了网络、只在下载”的客户端恢复时间的影响。
//! 放进 `sim/tests/` 后 `cargo test --profile sim -p agent-net-sim --test exp_ping -- --nocapture`。
//! Wi-Fi 下载 30 MB，第 1.5 秒断网 0–10 秒（每 0.25 秒一档）后换到蜂窝，新网络两个方向丢包 0 / 10% / 30%，每档 10 个种子。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Scenario, run_moves};

#[test]
fn exp_ping_recovery() {
    let wifi = LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() };
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() };
    for loss in [0.0, 0.1, 0.3] {
        let mut all = Vec::new();
        let mut dead = 0;
        for outage_ms in (0..=10_000u64).step_by(250) {
            for seed in 0..10u64 {
                let cell = LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss, queue_us: 80_000, ..LinkProfile::default() };
                let outage_us = outage_ms * 1000;
                let step = Move { at_us: 1_500_000 + outage_us, outage_us, up: cell.clone(), down: cell.clone(), noticed: false, same_route: false };
                let case = Scenario { seed: seed * 7919 + outage_ms, config: config.clone(), up: wifi.clone(), down: wifi.clone(), moves: vec![step], upload_bytes: 0, download_bytes: 30_000_000, attack: Attack::None, time_limit_us: 200_000_000 };
                let report = run_moves(&case);
                match report.recoveries_us.first().copied().flatten() {
                    Some(r) if report.finished => all.push(r),
                    _ => dead += 1,
                }
            }
        }
        all.sort();
        let n = all.len();
        let mean = all.iter().sum::<u64>() as f64 / n as f64 / 1e6;
        let p = |q: f64| all[((n as f64 * q) as usize).min(n - 1)] as f64 / 1e6;
        println!("RESULT loss {loss}: runs {} dead {dead} mean {mean:.2}s p50 {:.2}s p90 {:.2}s p99 {:.2}s max {:.2}s", n + dead, p(0.5), p(0.9), p(0.99), p(1.0));
    }
}
