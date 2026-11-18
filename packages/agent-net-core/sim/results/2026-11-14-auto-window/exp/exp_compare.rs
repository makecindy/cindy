//! `compare` 的核心部分，不带 KCP（本机没有 C 编译器时用）：同样的场景、16 个种子、8 MiB 传输和交互延迟测量，
//! 输出格式和 `AGENT_NET_KCP=none` 时的 compare 相同，用来对比两版核心。
//! 运行：`AGENT_NET_POLICY=auto cargo test --profile sim -p agent-net-sim --test exp_compare -- --nocapture`
//! 和上一轮相比多了 `AGENT_NET_SEND_BUFFER_MIB`（每条流发送缓冲上限，默认 4）；`AGENT_NET_WINDOWS=8192` 选窗口，默认 128,1024。
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::{CorePeer, LatencyReport, LinkProfile, Workload, run, run_interactive, scenarios};

const SEEDS: u64 = 16;

fn core_config() -> Config {
    let policy = match std::env::var("AGENT_NET_POLICY").as_deref() {
        Ok("lean") => RecoveryPolicy::Lean,
        Ok("fast") => RecoveryPolicy::Fast,
        _ => RecoveryPolicy::Auto,
    };
    Config { max_packet_size: 1400, send_window: 128, recv_window: 128, ..Config::for_policy(policy) }
}

fn measure(config: &Config, link: &LinkProfile, back: &LinkProfile) -> String {
    let payload = 8 * 1024 * 1024u64;
    let workload = Workload { a_to_b_bytes: payload, write_chunk: 4096, stall_limit_us: 600_000_000, ..Workload::default() };
    let make = || CorePeer::new(config.clone());
    let runs: Vec<_> = (1..=SEEDS).map(|seed| run(make(), make(), link.clone(), back.clone(), &workload, seed)).collect();
    let unfinished = runs.iter().filter(|outcome| !outcome.finished).count();
    let count = (runs.len() - unfinished).max(1) as f64;
    let finish_ms = if unfinished > 0 { f64::INFINITY } else { runs.iter().map(|o| o.finish_us as f64 / 1000.0).sum::<f64>() / count };
    let overhead = if unfinished > 0 { f64::INFINITY } else { runs.iter().map(|o| o.wire_bytes as f64 / payload as f64 - 1.0).sum::<f64>() / count * 100.0 };
    let mut latency = LatencyReport::default();
    let mut undelivered = 0;
    for seed in 1..=SEEDS {
        let report = run_interactive(make(), make(), link.clone(), back.clone(), 2_000, 200, 20_000, seed);
        undelivered += report.sent - report.delivered;
        latency.samples_us.extend(std::iter::repeat_n(u64::MAX, report.sent - report.delivered));
        latency.wire_bytes += report.wire_bytes;
        latency.samples_us.extend(report.samples_us);
    }
    format!(
        "  agent-net      用时{:>8.0}ms 开销{:>6.1}% p50{:>7.1} p95{:>7.1} p99{:>7.1}ms 交互字节{:>8.0}K{}{}",
        finish_ms,
        overhead,
        latency.percentile_ms(50.0),
        latency.percentile_ms(95.0),
        latency.percentile_ms(99.0),
        latency.wire_bytes as f64 / SEEDS as f64 / 1024.0,
        if unfinished > 0 { format!(" 未完成 {unfinished}/{SEEDS}") } else { String::new() },
        if undelivered > 0 { format!(" 未送达 {undelivered} 条") } else { String::new() },
    )
}

#[test]
fn compare_core_only() {
    println!("agent-net 策略 {:?}；每场景 {SEEDS} 个种子", core_config().recovery_policy);
    // AGENT_NET_FILTER 只跑名字含这些子串的场景（逗号分开）；AGENT_NET_WINDOWS 选窗口。
    let filters: Vec<String> = std::env::var("AGENT_NET_FILTER").map(|value| value.split(',').map(str::to_owned).collect()).unwrap_or_default();
    let windows: Vec<u32> = std::env::var("AGENT_NET_WINDOWS").map(|value| value.split(',').map(|w| w.parse().unwrap()).collect()).unwrap_or(vec![128, 1024]);
    for window in windows {
        println!("=== 窗口 {window} ===");
        // AGENT_NET_SEND_BUFFER_MIB 设每条流的发送缓冲上限，默认 4 MiB（和 compare 一样）。
        let buffer = std::env::var("AGENT_NET_SEND_BUFFER_MIB").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(4) << 20;
        let config = Config { send_window: window, recv_window: window, send_buffer_bytes: buffer, ..core_config() };
        let rows: Vec<_> = scenarios().into_iter().filter(|row| filters.is_empty() || filters.iter().any(|f| row.label.contains(f.as_str()))).collect();
        let next = AtomicUsize::new(0);
        let results: Mutex<Vec<Option<String>>> = Mutex::new(vec![None; rows.len()]);
        let workers = std::thread::available_parallelism().map_or(4, |count| count.get()).min(rows.len());
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    loop {
                        let job = next.fetch_add(1, Ordering::Relaxed);
                        if job >= rows.len() {
                            break;
                        }
                        let line = measure(&config, &rows[job].link, &rows[job].back);
                        results.lock().unwrap()[job] = Some(line);
                    }
                });
            }
        });
        for (row, line) in rows.iter().zip(results.into_inner().unwrap()) {
            println!("{}", row.label);
            println!("{}", line.unwrap());
        }
    }
}
