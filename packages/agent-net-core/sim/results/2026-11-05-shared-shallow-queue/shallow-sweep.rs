//! 浅队列扫描，结果见 `shallow-sweep.txt`。不在测试集里：放进一个依赖 `agent-net-core`、`agent-net-sim` 的临时 crate 当作二进制，
//! `--release` 运行。`THREADS` 指定线程数（默认 8），`ALL=1` 逐行输出，`TCP=cubic` 把每条连接换成 TCP CUBIC，
//! `one 条数 Mbit/s 往返毫秒 队列倍数 定时器微秒 启动间隔微秒` 只跑一种组合并打印各条连接的统计，配合 `SHARE_TRACE_US` 看时间线。
//! 本机 8 个线程约 15–25 秒，随机器负载变。

use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::LinkProfile;
use agent_net_sim::share::{Flow, FlowKind, jain_index, run_shared_with_timer};

const WINDOW: u32 = 8192;

fn agent() -> FlowKind {
    match std::env::var("TCP").as_deref() {
        Ok("cubic") => return FlowKind::TcpDelayedAck(agent_net_sim::share::TcpVariant::Cubic),
        Ok("reno") => return FlowKind::TcpDelayedAck(agent_net_sim::share::TcpVariant::Reno),
        _ => {}
    }
    FlowKind::AgentNet(Config { max_packet_size: 1400, send_window: WINDOW, recv_window: WINDOW, send_buffer_bytes: WINDOW as usize * 2800, ..Config::for_policy(RecoveryPolicy::Auto) })
}

type Case = (u64, u64, u64, f64, u64, u64);

fn run(case: Case, seed: u64) -> (f64, f64, f64, Vec<f64>, Vec<Option<agent_net_core::Stats>>) {
    let (n, bits, rtt, bdps, timer, stagger) = case;
    let link = LinkProfile { bits_per_second: bits, delay_us: rtt / 2, jitter_us: 500, queue_us: (rtt as f64 * bdps) as u64, ..LinkProfile::default() };
    let flows: Vec<Flow> = (0..n).map(|i| Flow { kind: agent(), start_us: i * stagger, extra_rtt_us: 0 }).collect();
    let r = run_shared_with_timer(&link, &flows, 20_000_000, 5_000_000, seed, timer);
    (r.loss * 100.0, jain_index(&r.rates), r.utilization, r.rates, r.stats)
}

fn label(c: Case) -> String {
    format!("n={} bits={}M rtt={}ms bdps={} timer={} stagger={}", c.0, c.1 / 1_000_000, c.2 / 1000, c.3, c.4, c.5)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("one") {
        let p: Vec<f64> = args[1..7].iter().map(|v| v.parse().unwrap()).collect();
        let case = (p[0] as u64, (p[1] * 1e6) as u64, (p[2] * 1000.0) as u64, p[3], p[4] as u64, p[5] as u64);
        let seed = args.get(7).map(|v| v.parse().unwrap()).unwrap_or(1);
        let (loss, jain, util, rates, stats) = run(case, seed);
        println!("{} loss={loss:.2}% jain={jain:.2} util={util:.2}", label(case));
        for (rate, s) in rates.iter().zip(stats) {
            let Some(s) = s else { println!("  {:.1}M", rate / 1e6); continue };
            println!("  {:.1}M bw={:.1}M pacing={:.1}M rand={} cap={:.1}M minrtt={} srtt={} lost={}", rate / 1e6, s.bandwidth as f64 * 8e-6, s.pacing_rate as f64 * 8e-6, s.random_loss_ppm, s.rate_cap as f64 * 8e-6, s.min_rtt_us, s.srtt_us, s.fast_losses + s.timeout_losses);
        }
        return;
    }
    let seeds: u64 = std::env::var("SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
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
    let jobs: Vec<(Case, u64)> = cases.iter().flat_map(|&c| (1..=seeds).map(move |s| (c, s))).collect();
    let threads: usize = std::env::var("THREADS").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
    let results: Vec<(Case, u64, f64, f64, f64)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads).map(|t| {
            let jobs = &jobs;
            scope.spawn(move || jobs.iter().skip(t).step_by(threads).map(|&(c, s)| { let (l, j, u, _, _) = run(c, s); (c, s, l, j, u) }).collect::<Vec<_>>())
        }).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let mut rows: Vec<(String, f64, f64, f64)> = cases.iter().map(|&c| {
        let mine: Vec<_> = results.iter().filter(|r| r.0 == c).collect();
        let k = mine.len() as f64;
        (label(c), mine.iter().map(|r| r.2).sum::<f64>() / k, mine.iter().map(|r| r.3).sum::<f64>() / k, mine.iter().map(|r| r.4).sum::<f64>() / k)
    }).collect();
    if std::env::var("ALL").is_ok() {
        for (l, loss, jain, util) in &rows { println!("{l:60} loss={loss:6.2}% jain={jain:.2} util={util:.2}"); }
    }
    rows.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mean = rows.iter().map(|r| r.1).sum::<f64>() / rows.len() as f64;
    let jain = rows.iter().map(|r| r.2).sum::<f64>() / rows.len() as f64;
    let util = rows.iter().map(|r| r.3).sum::<f64>() / rows.len() as f64;
    let over = rows.iter().filter(|r| r.1 > 10.0).count();
    println!("mean loss {mean:.2}% over10 {over}/{} mean jain {jain:.3} mean util {util:.3} worst {:.2}%", rows.len(), rows[0].1);
    for (l, loss, jain, util) in rows.iter().take(12) { println!("  {l:60} loss={loss:6.2}% jain={jain:.2} util={util:.2}"); }
}
