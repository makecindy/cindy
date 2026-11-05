//! 临时实验：客户端真换了网络、路上的人把每个包（或每 8 个一个）都抢先复制时，服务端能不能跟到真的新地址。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Scenario, run_moves};

#[test]
fn exp_race_after_move() {
    let wifi = LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() };
    let cell = LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() };
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() };
    for every in [1u64] {
        for lead_us in [5_000u64] {
            for noticed in [true, false] {
                for (upload, download) in [(8_000_000u64, 1u64), (0, 8_000_000), (4_000_000, 4_000_000)] {
                    let step = Move { at_us: 500_000, outage_us: 0, up: cell.clone(), down: cell.clone(), noticed, same_route: false };
                    let case = Scenario { seed: 1, config: config.clone(), up: wifi.clone(), down: wifi.clone(), moves: vec![step], upload_bytes: upload, download_bytes: download, attack: Attack::Race { every, lead_us }, time_limit_us: 120_000_000 };
                    let report = run_moves(&case);
                    let server = report.server.map(|(s, _)| s);
                    println!("RESULT every {every} lead {lead_us} noticed {noticed} up {upload} down {download}: finished {} at {:.2}s path {} recovery {:?} attacker {}/{} migrations {:?} failures {:?}",
                        report.finished, report.finish_us as f64 / 1e6, report.server_path, report.recoveries_us, report.attacker_sent, report.attacker_received, server.map(|s| s.migrations), server.map(|s| s.path_failures));
                }
            }
        }
    }
}
