//! 打印一条连接的时间线。用法：trace <场景名子串> [窗口] [种子] [MiB]
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use agent_net_core::{Config, Connection};
use agent_net_sim::{Link, scenarios};
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenario = scenarios().into_iter().find(|s| s.label.contains(&args[1])).unwrap();
    let window: u32 = args.get(2).map_or(1024, |v| v.parse().unwrap());
    let seed: u64 = args.get(3).map_or(1, |v| v.parse().unwrap());
    let total: u64 = args.get(4).map_or(8, |v| v.parse().unwrap()) << 20;
    let config = Config { send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..Config::default() };
    let mut a = Connection::new(config.clone(), 0);
    let mut b = Connection::new(config, 0);
    let (mut up, mut down) = (Link::new(scenario.link, seed), Link::new(scenario.back, seed + 1));
    let mut heap: BinaryHeap<Reverse<(u64, u64, bool, Vec<u8>)>> = BinaryHeap::new();
    let (mut now, mut order, mut written, mut read, mut next_print) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut out = [0u8; 2048];
    let mut sink = vec![0u8; 1 << 20];
    let chunk = [7u8; 4096];
    let (mut last_wire, mut last_read) = (0u64, 0u64);
    while read < total && now < 120_000_000 {
        while written < total {
            let n = a.send(now, &chunk[..4096.min((total - written) as usize)]);
            written += n as u64;
            if n == 0 { break; }
        }
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
            println!("{:5} ms  送达 {:6.2} MB/s  线上 {:6.2} MB/s  bw {:6.2} cap {:5.2} pace {:6.2}  rto {:5} fast {:5} spur {:4} srtt {:3} loss% {:4.1}",
                now / 1000, (read - last_read) as f64 / 250_000.0, (s.wire_bytes_sent - last_wire) as f64 / 250_000.0, s.bandwidth as f64 / 1e6, s.rate_cap as f64 / 1e6, s.pacing_rate as f64 / 1e6,
                s.timeout_losses, s.fast_losses, s.spurious_losses, s.srtt_us / 1000, s.random_loss_ppm as f64 / 1e4);
            last_wire = s.wire_bytes_sent; last_read = read;
            next_print = now + 250_000;
        }
        let mut next = heap.peek().map(|Reverse(i)| i.0);
        for peer in [&a, &b] { if let Some(w) = peer.next_wake() { next = Some(next.map_or(w, |v: u64| v.min(w))); } }
        now = next.unwrap_or(now + 1000).max(now + 1);
    }
    println!("完成 {} ms 线上 {} MB 开销 {:.1}%", now / 1000, a.stats().wire_bytes_sent / 1_000_000, (a.stats().wire_bytes_sent as f64 / total as f64 - 1.0) * 100.0);
}
