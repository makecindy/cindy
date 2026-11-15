//! 只跑自研核心，打印内部统计，用来定位某个场景为什么慢。
//! 运行：`cargo run --release -p agent-net-sim --bin diagnose -- 丢包`，参数是场景名的子串。

use agent_net_core::Config;
use agent_net_sim::{CorePeer, LatencyReport, Workload, run, run_interactive, scenarios};

fn main() {
    let filter = std::env::args().nth(1).unwrap_or_default();
    let window = std::env::var("AGENT_NET_WINDOW").ok().and_then(|value| value.parse().ok()).unwrap_or(128);
    let config = Config { max_packet_size: 1400, send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..Config::default() };
    let payload = 8 * 1024 * 1024u64;
    let workload = Workload { a_to_b_bytes: payload, write_chunk: 4096, stall_limit_us: 600_000_000, ..Workload::default() };
    for scenario in scenarios().into_iter().filter(|scenario| !scenario.holdout && scenario.label.contains(&filter)) {
        let (link, back) = (scenario.link, scenario.back);
        let mut total_ms = 0.0;
        let mut overhead = 0.0;
        for seed in 1..=8 {
            let outcome = run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), back.clone(), &workload, seed);
            total_ms += outcome.finish_us as f64 / 1000.0 / 8.0;
            overhead += (outcome.wire_bytes as f64 / payload as f64 - 1.0) * 100.0 / 8.0;
            if seed == 1 {
                println!("{}\n  发送端 {}\n  接收端 {}", scenario.label, outcome.final_states[0], outcome.final_states[1]);
            }
        }
        let mut latency = LatencyReport::default();
        for seed in 1..=8 {
            let report = run_interactive(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), back.clone(), 2_000, 200, 20_000, seed);
            latency.samples_us.extend(report.samples_us);
        }
        println!("  平均用时 {total_ms:.0}ms 开销 {overhead:.1}% p95 {:.0} p99 {:.0}", latency.percentile_ms(95.0), latency.percentile_ms(99.0));
    }
}
