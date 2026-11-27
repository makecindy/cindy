//! 临时实验，不进测试：只换端口时三种链路、两种换端口时机、8 个种子的加总。
//! 放进 `sim/tests/` 后 `cargo test --profile sim -p agent-net-sim --test exp_port -- --nocapture`。
use agent_net_core::Config;
use agent_net_sim::LinkProfile;
use agent_net_sim::migration::{Attack, Move, Scenario, run_moves};

#[test]
fn exp_port_sums() {
    let links = [
        LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 1_000, queue_us: 30_000, ..LinkProfile::default() },
        LinkProfile { bits_per_second: 10_000_000, delay_us: 35_000, jitter_us: 5_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() },
        LinkProfile { bits_per_second: 100_000_000, delay_us: 20_000, jitter_us: 2_000, queue_us: 40_000, ..LinkProfile::default() },
    ];
    let config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..Config::default() };
    for (upload, download) in [(20_000_000u64, 1u64), (0, 20_000_000)] {
        let (mut finish, mut retx, mut timeouts, mut runs) = (0u64, 0u64, 0u64, 0);
        for link in &links {
            for times in [[600_000u64, 1_200_000], [1_500_000, 3_000_000]] {
                for seed in 1..=8u64 {
                    let moves = times.map(|at_us| Move { at_us, outage_us: 0, up: link.clone(), down: link.clone(), noticed: false, same_route: true }).to_vec();
                    let case = Scenario { seed, config: config.clone(), up: link.clone(), down: link.clone(), moves, upload_bytes: upload, download_bytes: download, attack: Attack::None, time_limit_us: 600_000_000 };
                    let report = run_moves(&case);
                    assert!(report.finished);
                    let (_, client) = report.client.expect("client");
                    let (_, server) = report.server.expect("server");
                    finish += report.finish_us;
                    retx += client.retransmitted_segments + server.retransmitted_segments;
                    timeouts += client.timeout_losses;
                    runs += 1;
                }
            }
        }
        println!("RESULT up {upload} down {download}: runs {runs} time {:.1}s retransmitted {retx} client timeout losses {timeouts}", finish as f64 / 1e6);
    }
}
