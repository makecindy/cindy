//! 临时实验：每 8 个包复制一个、领先 50 毫秒、客户端真换了网络时，16 个种子加总的用时，比较新旧规则。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Scenario, run_moves};

#[test]
fn exp_race_seeds() {
    let wifi = LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() };
    let cell = LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() };
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() };
    for lead_us in [50_000u64, 5_000] {
        for noticed in [true, false] {
            for (upload, download) in [(20_000_000u64, 1u64), (0, 20_000_000), (10_000_000, 10_000_000)] {
                let (mut total, mut failed, mut slowest) = (0f64, 0, 0f64);
                for seed in 1..=16u64 {
                    let step = Move { at_us: 500_000, outage_us: 0, up: cell.clone(), down: cell.clone(), noticed, same_route: false };
                    let case = Scenario { seed, config: config.clone(), up: wifi.clone(), down: wifi.clone(), moves: vec![step], upload_bytes: upload, download_bytes: download, attack: Attack::Race { every: 8, lead_us }, time_limit_us: 300_000_000 };
                    let report = run_moves(&case);
                    let t = report.finish_us as f64 / 1e6;
                    total += t; slowest = slowest.max(t);
                    if !report.finished { failed += 1; }
                }
                println!("RESULT lead {lead_us} noticed {noticed} up {upload} down {download}: 16 seeds total {total:.1}s slowest {slowest:.1}s unfinished {failed}");
            }
        }
    }
}
