//! 自研核心和真实 KCP 的对比表。

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::kcp::{KcpPeer, KcpVariant};
use agent_net_sim::{CorePeer, LatencyReport, LinkProfile, Peer, Scenario, Workload, run, run_interactive, scenarios};

fn core_config() -> Config {
    let policy = match std::env::var("AGENT_NET_POLICY").as_deref() {
        Ok("lean") => RecoveryPolicy::Lean,
        Ok("fast") => RecoveryPolicy::Fast,
        Ok("auto") | Err(std::env::VarError::NotPresent) => RecoveryPolicy::Auto,
        value => panic!("invalid AGENT_NET_POLICY {value:?}; expected auto, lean or fast"),
    };
    Config { max_packet_size: 1400, send_window: 128, recv_window: 128, ..Config::for_policy(policy) }
}

struct Summary {
    unfinished: usize,
    finish_ms: f64,
    overhead: f64,
    p50: f64,
    p95: f64,
    p99: f64,
    undelivered: usize,
    interactive_bytes: f64,
}

fn average(samples: impl Iterator<Item = f64>) -> f64 {
    let values: Vec<f64> = samples.collect();
    values.iter().sum::<f64>() / values.len() as f64
}

const SEEDS: u64 = 16;

fn measure<P: Peer>(make: impl Fn() -> P, link: &LinkProfile, back: &LinkProfile) -> Summary {
    let payload = 8 * 1024 * 1024u64;
    // 给足 10 分钟：KCP 重传间隔能退避到 60 秒，不能因为判据严就算它失败。
    let workload = Workload { a_to_b_bytes: payload, write_chunk: 4096, stall_limit_us: 600_000_000, ..Workload::default() };
    let runs: Vec<_> = (1..=SEEDS).map(|seed| run(make(), make(), link.clone(), back.clone(), &workload, seed)).collect();
    let unfinished = runs.iter().filter(|outcome| !outcome.finished).count();
    let finished = || runs.iter().filter(|outcome| outcome.finished);
    let finish_ms = if unfinished > 0 { f64::INFINITY } else { average(finished().map(|outcome| outcome.finish_us as f64 / 1000.0)) };
    let overhead = if unfinished > 0 {
        f64::INFINITY
    } else {
        average(finished().map(|outcome| outcome.wire_bytes as f64 / payload as f64 - 1.0)) * 100.0
    };
    let mut latency = LatencyReport::default();
    let mut undelivered = 0;
    for seed in 1..=SEEDS {
        let report = run_interactive(make(), make(), link.clone(), back.clone(), 2_000, 200, 20_000, seed);
        undelivered += report.sent - report.delivered;
        // 最后一条发出 30 秒后还没到的算没送达，延迟按无穷大计入分位数。
        latency.samples_us.extend(std::iter::repeat_n(u64::MAX, report.sent - report.delivered));
        latency.wire_bytes += report.wire_bytes;
        latency.samples_us.extend(report.samples_us);
    }
    Summary {
        unfinished,
        finish_ms,
        overhead,
        p50: latency.percentile_ms(50.0),
        p95: latency.percentile_ms(95.0),
        p99: latency.percentile_ms(99.0),
        undelivered,
        interactive_bytes: latency.wire_bytes as f64 / SEEDS as f64,
    }
}

fn print_row(name: &str, s: &Summary) {
    println!(
        "  {name:<14} 用时{:>8.0}ms 开销{:>6.1}% p50{:>7.1} p95{:>7.1} p99{:>7.1}ms 交互字节{:>8.0}K{}",
        s.finish_ms, s.overhead, s.p50, s.p95, s.p99, s.interactive_bytes / 1024.0,
        if s.unfinished > 0 { format!(" 未完成 {}/{SEEDS}", s.unfinished) } else { String::new() }
            + &if s.undelivered > 0 { format!(" 未送达 {} 条", s.undelivered) } else { String::new() },
    );
}

/// 内存直连、不模拟网络，测单核每秒能处理多少数据：这是实现本身的 CPU 成本。
fn cpu_bench<P: Peer>(mut a: P, mut b: P, megabytes: u64, drop_every: u64) -> f64 {
    let total = megabytes * 1024 * 1024;
    let chunk = vec![7u8; 16 * 1024];
    let mut incoming = vec![0u8; 256 * 1024];
    let (mut written, mut read, mut now, mut packets) = (0u64, 0u64, 0u64, 0u64);
    let mut to_b: Vec<Vec<u8>> = Vec::new();
    let mut to_a: Vec<Vec<u8>> = Vec::new();
    let started = std::time::Instant::now();
    while read < total {
        now += 200;
        while written < total {
            let accepted = a.write(now, &chunk[..chunk.len().min((total - written) as usize)]);
            written += accepted as u64;
            if accepted == 0 {
                break;
            }
        }
        a.pump(now, &mut |packet| {
            packets += 1;
            if drop_every == 0 || packets % drop_every != 0 {
                to_b.push(packet.to_vec());
            }
        });
        for packet in to_b.drain(..) {
            b.input(now, &packet);
        }
        loop {
            let size = b.read(now, &mut incoming);
            if size == 0 {
                break;
            }
            read += size as u64;
        }
        b.pump(now, &mut |packet| to_a.push(packet.to_vec()));
        for packet in to_a.drain(..) {
            a.input(now, &packet);
        }
        if a.wake_at().is_some_and(|at| at <= now) {
            a.on_wake(now);
        }
        if b.wake_at().is_some_and(|at| at <= now) {
            b.on_wake(now);
        }
    }
    megabytes as f64 / started.elapsed().as_secs_f64()
}

fn core_for_cpu() -> CorePeer {
    let mut peer = CorePeer::new(Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 4 << 20, ..core_config() });
    peer.check_invariants = false;
    peer
}

/// 每个场景的各个实现互不相关，按 CPU 核数并行跑。虚拟时钟下结果和串行完全一样。
fn measure_all(rows: &[Scenario], window: u32) -> Vec<Vec<Summary>> {
    let core_config = Config { send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..core_config() };
    // KCP 代码与网络模型都未变时，设 AGENT_NET_KCP=none 只跑自己，再和同模型的完整对照比。
    let variants: &[KcpVariant] = if std::env::var("AGENT_NET_KCP").is_ok_and(|value| value == "none") { &[] } else { &KcpVariant::ALL };
    let implementations = 1 + variants.len();
    let jobs = rows.len() * implementations;
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Summary>>> = Mutex::new((0..jobs).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map_or(4, |count| count.get()).min(jobs);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let job = next.fetch_add(1, Ordering::Relaxed);
                    if job >= jobs {
                        break;
                    }
                    let row = &rows[job / implementations];
                    let summary = match job % implementations {
                        0 => measure(|| CorePeer::new(core_config.clone()), &row.link, &row.back),
                        index => {
                            let variant = variants[index - 1];
                            measure(|| KcpPeer::variant(variant, window as i32), &row.link, &row.back)
                        }
                    };
                    results.lock().unwrap()[job] = Some(summary);
                }
            });
        }
    });
    let mut results = results.into_inner().unwrap().into_iter().map(Option::unwrap);
    (0..rows.len()).map(|_| results.by_ref().take(implementations).collect()).collect()
}

/// 差距在 1% 以内算打平：8 个种子的平均值本身就有这么大的波动。
fn compare_table(title: &str, window: u32) {
    println!("{title}");
    let mut wins = [0u32; 5];
    let mut ties = [0u32; 5];
    let mut losses = Vec::new();
    // 和每种配置单独比时，agent-net 的胜、平、负项数。
    let mut versus = vec![[0u32; 3]; KcpVariant::ALL.len()];
    // 调参期间设 AGENT_NET_TUNING=1，留出场景连跑都不跑，避免看到结果后下意识往那边调。
    // AGENT_NET_FILTER 只跑名字含这些子串的场景，用逗号分开。
    let tuning = std::env::var_os("AGENT_NET_TUNING").is_some();
    let filters: Vec<String> = std::env::var("AGENT_NET_FILTER").map(|value| value.split(',').map(str::to_owned).collect()).unwrap_or_default();
    let rows: Vec<_> = scenarios()
        .into_iter()
        .filter(|row| !(tuning && row.holdout) && (filters.is_empty() || filters.iter().any(|filter| row.label.contains(filter.as_str()))))
        .collect();
    let total = rows.len();
    let summaries = measure_all(&rows, window);
    let has_kcp = summaries.first().is_some_and(|row| row.len() > 1);
    for (row, summaries) in rows.iter().zip(summaries) {
        println!("{}{}", row.label, if row.holdout { "（未参与本轮调参；历史已测）" } else { "" });
        let (core, kcp) = summaries.split_first().unwrap();
        print_row("agent-net", core);
        for ((variant, summary), record) in KcpVariant::ALL.iter().zip(kcp).zip(&mut versus) {
            print_row(variant.label, summary);
            let pairs = [(core.finish_ms, summary.finish_ms), (core.overhead, summary.overhead), (core.p50, summary.p50), (core.p95, summary.p95), (core.p99, summary.p99)];
            for (mine, theirs) in pairs {
                record[if mine < theirs * 0.99 { 0 } else if mine <= theirs * 1.01 { 1 } else { 2 }] += 1;
            }
        }
        if kcp.is_empty() {
            continue;
        }
        let best = |pick: fn(&Summary) -> f64| kcp.iter().map(pick).fold(f64::INFINITY, f64::min);
        let metrics: [(&str, f64, f64); 5] = [
            ("用时", core.finish_ms, best(|s| s.finish_ms)),
            ("开销", core.overhead, best(|s| s.overhead)),
            ("p50", core.p50, best(|s| s.p50)),
            ("p95", core.p95, best(|s| s.p95)),
            ("p99", core.p99, best(|s| s.p99)),
        ];
        for (index, (name, mine, theirs)) in metrics.iter().enumerate() {
            if mine < &(theirs * 0.99) {
                wins[index] += 1;
            } else if mine <= &(theirs * 1.01) {
                ties[index] += 1;
            } else {
                losses.push(format!("{}{} {:.1} 对 {:.1}（差 {:.1}%）", row.label, name, mine, theirs, (mine / theirs - 1.0) * 100.0));
            }
        }
    }
    if !has_kcp {
        println!("\n本次未运行 KCP，不生成胜负统计。\n");
        return;
    }
    println!("\n胜/平（与 KCP 各种配置的最好值比，差距 1% 内算平，共 {total} 个场景）：");
    for (index, name) in ["用时", "开销", "p50", "p95", "p99"].iter().enumerate() {
        println!("  {name} 胜 {} 平 {}", wins[index], ties[index]);
    }
    println!("和每种配置单独比（胜/平/负，共 {} 项）：", total * 5);
    for (variant, record) in KcpVariant::ALL.iter().zip(&versus) {
        println!("  {:<16} {}/{}/{}", variant.label, record[0], record[1], record[2]);
    }
    println!("落后项：");
    for line in &losses {
        println!("  {line}");
    }
    println!();
}

pub fn main() {
    println!("agent-net 策略 {:?}；每场景 {SEEDS} 个种子", core_config().recovery_policy);
    println!("网络模型 {}", agent_net_sim::NETWORK_MODEL);
    // 对比用虚拟时钟，机器忙不影响结果；CPU 测速不行，要单独在空闲时跑。
    // AGENT_NET_WINDOWS=1024 只跑一种窗口；AGENT_NET_NO_CPU=1 跳过 CPU 测速。
    let windows = std::env::var("AGENT_NET_WINDOWS").unwrap_or_else(|_| "128,1024".into());
    if std::env::var_os("AGENT_NET_CPU_ONLY").is_none() {
        if windows.split(',').any(|window| window == "128") {
            compare_table("=== 窗口 128（常用配置，双方都被窗口限住）===", 128);
        }
        if windows.split(',').any(|window| window == "1024") {
            compare_table("=== 窗口 1024（kcptun 快速模式的默认值，窗口够用时比真实带宽利用）===", 1024);
        }
    }
    if std::env::var_os("AGENT_NET_NO_CPU").is_some() {
        return;
    }
    println!("单核 CPU 性能（内存直连，MiB/s，窗口 1024）：");
    for (label, drop_every) in [("无丢包", 0), ("丢 1%", 100)] {
        let mine = cpu_bench(core_for_cpu(), core_for_cpu(), 512, drop_every);
        let kcp = cpu_bench(KcpPeer::with_window(true, 1024), KcpPeer::with_window(true, 1024), 512, drop_every);
        println!("  {label}: agent-net {mine:.0}  KCP {kcp:.0}");
    }
}
