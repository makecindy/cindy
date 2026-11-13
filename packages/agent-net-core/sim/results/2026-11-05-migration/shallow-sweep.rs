//! 浅队列扫描用的一次性测试，结果见 `shallow-sweep.txt`。不在测试集里：复制到 `sim/tests/` 后运行
//! `cargo test --profile sim -p agent-net-sim --test shallow-sweep -- --nocapture`，本机约 24 秒（不含编译）。
//! 放宽上限那一列是把 `src/congestion.rs` 的 `SATURATED_MAX_RANDOM_LOSS_PPM` 改成 500_000 后跑的。

use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::LinkProfile;
use agent_net_sim::share::{Flow, FlowKind, jain_index, run_shared_with_timer};

const WINDOW: u32 = 8192;

fn agent() -> FlowKind {
    FlowKind::AgentNet(Config { max_packet_size: 1400, send_window: WINDOW, recv_window: WINDOW, send_buffer_bytes: WINDOW as usize * 2800, ..Config::for_policy(RecoveryPolicy::Auto) })
}

#[test]
fn explore() {
    let mut cases = Vec::new();
    for n in [2u64, 4, 8] {
        for bits in [20_000_000u64, 100_000_000] {
            for rtt in [12_000u64, 40_000, 100_000] {
                for bdps in [0.1f64, 0.25] {
                    for timer in [1u64, 1000] {
                        for stagger in [0u64, 200_000] {
                            cases.push((n, bits, rtt, bdps, timer, stagger));
                        }
                    }
                }
            }
        }
    }
    let results: Vec<String> = std::thread::scope(|scope| {
        let chunks: Vec<_> = cases.chunks(cases.len().div_ceil(8)).map(|chunk| scope.spawn(move || {
            chunk.iter().map(|&(n, bits, rtt, bdps, timer, stagger)| {
                let link = LinkProfile { bits_per_second: bits, delay_us: rtt / 2, jitter_us: 500, queue_us: (rtt as f64 * bdps) as u64, ..LinkProfile::default() };
                let flows: Vec<Flow> = (0..n).map(|i| Flow { kind: agent(), start_us: i * stagger, extra_rtt_us: 0 }).collect();
                let r = run_shared_with_timer(&link, &flows, 20_000_000, 5_000_000, 1, timer);
                format!("n={n} bits={}M rtt={}ms bdps={bdps} timer={timer} stagger={stagger} loss={:.2}% jain={:.2} util={:.2}", bits / 1_000_000, rtt / 1000, r.loss * 100.0, jain_index(&r.rates), r.utilization)
            }).collect::<Vec<_>>()
        })).collect();
        chunks.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    for line in results { println!("{line}"); }
}
