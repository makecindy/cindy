//! 限速器上的超发：令牌桶 0.7 MB/s，往返 10 / 40 / 90 毫秒，令牌 64 / 256 / 600 KB，传 1 MiB 和 8 MiB，按 Desktop 的配置（2026-11-19）。
//! 复制到 sim/tests/ 后运行，跑完删掉：
//!   cargo test --release -p agent-net-sim --test exp_policer probe -- --ignored --nocapture
//!   DELAY=5000 DEPTH=600000 MIB=1 STEP=10000 cargo test --release -p agent-net-sim --test exp_policer trace -- --ignored --nocapture
use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::{CorePeer, LinkProfile, Workload, run};

fn desktop() -> Config {
    Config { max_packet_size: 1400, send_packet_size: 1310, send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::for_policy(RecoveryPolicy::Auto) }
}

#[test]
#[ignore]
fn probe() {
    let rate: u64 = std::env::var("RATE").ok().and_then(|v| v.parse().ok()).unwrap_or(700_000);
    for delay in [5_000u64, 20_000, 45_000] {
        for depth in [64_000u64, 256_000, 600_000] {
            for mib in [1u64, 8] {
                let bytes = mib << 20;
                let mut over = Vec::new(); let mut fin = Vec::new(); let mut found = Vec::new();
                for seed in 1..=4u64 {
                    let data = LinkProfile { bits_per_second: 1_000_000_000, delay_us: delay, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: rate, bucket_depth_bytes: depth, ..LinkProfile::default() };
                    let ack = LinkProfile { bits_per_second: 1_000_000_000, delay_us: delay, jitter_us: 500, queue_us: 20_000, ..LinkProfile::default() };
                    let workload = Workload { a_to_b_bytes: bytes, write_chunk: 65536, ..Workload::default() };
                    let o = run(CorePeer::new(desktop()), CorePeer::new(desktop()), data, ack, &workload, seed);
                    assert!(o.finished, "{o:?}");
                    over.push(o.wire_bytes as f64 / bytes as f64);
                    fin.push(o.finish_us as f64 / 1e6);
                    found.push(o.final_stats[0].map(|s| s.rate_limits_found).unwrap_or(0));
                }
                let avg = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
                let ideal = depth.min(bytes) as f64 / 1e9 * 8.0 + bytes.saturating_sub(depth) as f64 / rate as f64;
                println!("rtt={:>3}ms depth={:>4}KB size={}MiB wire x{:.2} (max {:.2}) finish {:.2}s (ideal {:.2}s) found {:?}",
                    delay * 2 / 1000, depth / 1000, mib, avg(&over), over.iter().cloned().fold(0.0, f64::max), avg(&fin), ideal, found);
            }
        }
    }
}

#[test]
#[ignore]
fn trace() {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use agent_net_core::Connection;
    use agent_net_sim::Link;
    let env = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
    let (delay, depth, total, step) = (env("DELAY", 5_000), env("DEPTH", 600_000), env("MIB", 8) << 20, env("STEP", 50_000));
    let data = LinkProfile { bits_per_second: 1_000_000_000, delay_us: delay, jitter_us: 500, queue_us: 20_000, bucket_bytes_per_second: env("RATE", 700_000), bucket_depth_bytes: depth, ..LinkProfile::default() };
    let back = LinkProfile { bits_per_second: 1_000_000_000, delay_us: delay, jitter_us: 500, queue_us: 20_000, ..LinkProfile::default() };
    let mut a = Connection::new(desktop(), 0);
    let mut b = Connection::new(desktop(), 0);
    let (mut up, mut down) = (Link::new(data, 1), Link::new(back, 2));
    let mut heap: BinaryHeap<Reverse<(u64, u64, bool, Vec<u8>)>> = BinaryHeap::new();
    let (mut now, mut order, mut written, mut read, mut next_print) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut out = [0u8; 2048];
    let mut sink = vec![0u8; 1 << 20];
    let chunk = [7u8; 4096];
    let (mut last_wire, mut last_read) = (0u64, 0u64);
    while read < total && now < 60_000_000 {
        while written < total { let n = a.send(now, &chunk[..4096.min((total - written) as usize)]); written += n as u64; if n == 0 { break; } }
        while heap.peek().is_some_and(|Reverse(i)| i.0 <= now) {
            let Reverse((_, _, to_b, p)) = heap.pop().unwrap();
            if to_b { let _ = b.on_packet(now, &p); } else { let _ = a.on_packet(now, &p); }
        }
        loop { let n = b.recv(now, &mut sink); if n == 0 { break; } read += n as u64; }
        for (peer, link, to_b) in [(&mut a, &mut up, true), (&mut b, &mut down, false)] {
            if peer.next_wake().is_some_and(|w| w <= now) { peer.tick(now); }
            while let Some(n) = peer.poll_transmit(now, &mut out) {
                let (arrivals, count) = link.transmit(now, n);
                for &at in &arrivals[..count] { order += 1; heap.push(Reverse((at, order, to_b, out[..n].to_vec()))); }
            }
        }
        if now >= next_print {
            let s = a.stats();
            let per = step as f64 / 1e6;
            println!("{:5}ms got {:6.2}MB/s wire {:6.2}MB/s bw {:6.2} cap {:5.2} pace {:6.2} rto {:5} fast {:5} spur {:4} srtt {:3} rnd% {:4.1} found {}",
                now / 1000, (read - last_read) as f64 / 1e6 / per, (s.wire_bytes_sent - last_wire) as f64 / 1e6 / per, s.bandwidth as f64 / 1e6, s.rate_cap as f64 / 1e6, s.pacing_rate as f64 / 1e6,
                s.timeout_losses, s.fast_losses, s.spurious_losses, s.srtt_us / 1000, s.random_loss_ppm as f64 / 1e4, s.rate_limits_found);
            last_wire = s.wire_bytes_sent; last_read = read; next_print = now + step;
        }
        let mut next = heap.peek().map(|Reverse(i)| i.0);
        for peer in [&a, &b] { if let Some(w) = peer.next_wake() { next = Some(next.map_or(w, |v: u64| v.min(w))); } }
        now = next.unwrap_or(now + 1000).max(now + 1);
    }
    println!("done {}ms wire x{:.2}", now / 1000, a.stats().wire_bytes_sent as f64 / total as f64);
}

