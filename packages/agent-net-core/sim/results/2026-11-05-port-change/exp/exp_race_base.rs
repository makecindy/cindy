//! 临时实验：每 8 个包抢先复制一个、领先 50 毫秒时上传慢多少；和没人复制比，换网和不换网各一遍。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Scenario, run_moves};

#[test]
fn exp_race_base() {
    let wifi = LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() };
    let cell = LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() };
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() };
    for (name, start, moves) in [
        ("Wi-Fi 切蜂窝", wifi.clone(), vec![Move { at_us: 500_000, outage_us: 0, up: cell.clone(), down: cell.clone(), noticed: false, same_route: false }]),
        ("只在蜂窝", cell.clone(), Vec::new()),
        ("只在 Wi-Fi", wifi.clone(), Vec::new()),
    ] {
        for attack in [Attack::None, Attack::Race { every: 8, lead_us: 50_000 }, Attack::Race { every: 8, lead_us: 5_000 }] {
            let case = Scenario { seed: 1, config: config.clone(), up: start.clone(), down: start.clone(), moves: moves.clone(), upload_bytes: 20_000_000, download_bytes: 1, attack: attack.clone(), time_limit_us: 300_000_000 };
            let report = run_moves(&case);
            let retx = report.client.map_or(0, |(_, s)| s.retransmitted_segments);
            println!("RESULT {name} {attack:?}: finished {} at {:.2}s client retransmitted {retx}", report.finished, report.finish_us as f64 / 1e6);
        }
    }
}
