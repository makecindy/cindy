//! 新旧窗口互通：一端是窗口 8192、发包 1317 字节的新版（`wasm/src/lib.rs` 的配置），另一端是 `Config::default()` 的旧版（窗口 128）。
//! 四种组合（旧→旧、新→旧、旧→新、新→新）在新开的流和默认流上各传 8 MiB（4 个种子平均），再在不丢包的线路上传 20 MiB（种子 1）。
//! 发送端一直写满，接收端一到就读（`slowread` 一行按每秒 2 MB 读）。打印用时、发送端重传的分片数和发出的包数。
//! 2026-11-17 复核的实验（复核者的原版在仓库外，这里改成用 `agent_net_sim` 的链路，数字相同）。
//!
//! 运行：`cp sim/results/2026-11-17-window-interop/exp/exp_window_mix.rs sim/tests/`，
//! `cargo test --release -p agent-net-sim --test exp_window_mix -- --nocapture`，跑完删掉。
use agent_net_sim::{Link, LinkProfile};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use agent_net_core::{Config, Connection, Priority, StreamEvent};

fn new_cfg() -> Config { Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, send_packet_size: 1317, ..Config::default() } }
fn old_cfg() -> Config { Config::default() }

/// sender writes `bytes` on a non-default stream (or the default one); returns (us, retransmitted, packets_sent, receiver rejected, done)
fn transfer(a: Config, b: Config, profile: &LinkProfile, bytes: u64, seed: u64, read_bps: u64, default_stream: bool) -> (u64, u64, u64, u64, bool) {
    let mut peers = [Connection::new(a, 0), Connection::new(b, 0)];
    let mut links = [Link::new(profile.clone(), seed), Link::new(profile.clone(), seed ^ 0x5A5A)];
    let mut heap: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>> = BinaryHeap::new();
    let mut order = 0u64;
    let mut now = 0u64;
    let stream = if default_stream { 0 } else { peers[0].open_stream(Priority::Normal).unwrap() };
    let mut written = 0u64;
    let mut read = 0u64;
    let mut streams: Vec<u32> = if default_stream { vec![0] } else { Vec::new() };
    let chunk = vec![7u8; 65536];
    let mut sink = vec![0u8; 65536];
    let mut out = [0u8; 2048];
    while read < bytes && now < 120_000_000 {
        while written < bytes {
            let n = peers[0].send_stream(now, stream, &chunk[..(bytes - written).min(65536) as usize]) as u64;
            if n == 0 { break; }
            written += n;
        }
        while heap.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Reverse((_, _, to, packet)) = heap.pop().unwrap();
            let _ = peers[to].on_packet(now, &packet);
        }
        while let Some(ev) = peers[1].poll_event() { if let StreamEvent::Opened(id) = ev { streams.push(id); } }
        let allowed = if read_bps == 0 { u64::MAX } else { now * read_bps / 1_000_000 };
        for &id in &streams { loop { if read >= allowed { break; } let cap = ((allowed - read).min(65536)) as usize; let n = peers[1].recv_stream(now, id, &mut sink[..cap]); if n == 0 { break; } read += n as u64; } }
        for side in 0..2 {
            if peers[side].next_wake().is_some_and(|w| w <= now) { peers[side].tick(now); }
            while let Some(n) = peers[side].poll_transmit(now, &mut out) {
                let (arrivals, count) = links[side].transmit(now, n);
                for &at in &arrivals[..count] { order += 1; heap.push(Reverse((at, order, 1 - side, out[..n].to_vec()))); }
            }
        }
        let mut next = u64::MAX;
        if let Some(Reverse(item)) = heap.peek() { next = next.min(item.0); }
        for p in &peers { if let Some(w) = p.next_wake() { next = next.min(w); } }
        if read_bps > 0 { next = next.min(now + 1000); }
        now = next.max(now + 1);
    }
    let s = peers[0].stats();
    let r = peers[1].stats();
    (now, s.retransmitted_segments, s.packets_sent, r.rejected_packets, read >= bytes)
}

#[test]
fn window_mix() {
    let mk = |bps: u64, d: u64, q: u64, loss: f64| LinkProfile { bits_per_second: bps, delay_us: d, queue_us: q, loss, ..LinkProfile::default() };
    let pairs = [("old->old", old_cfg(), old_cfg()), ("new->old", new_cfg(), old_cfg()), ("old->new", old_cfg(), new_cfg()), ("new->new", new_cfg(), new_cfg())];
    let lossy = [("wan 100M/20ms 1%", mk(100_000_000, 10_000, 50_000, 0.01), 0u64), ("far 50M/80ms 1%", mk(50_000_000, 40_000, 100_000, 0.01), 0),
                 ("4g 20M/60ms 2%", mk(20_000_000, 30_000, 100_000, 0.02), 0), ("wan 100M/20ms slowread 2MB/s", mk(100_000_000, 10_000, 50_000, 0.0), 2_000_000)];
    for default_stream in [false, true] {
        println!("== 8 MiB, 4 seeds, {} stream", if default_stream { "default" } else { "non-default" });
        for (name, link, rd) in lossy.iter() {
            for (pair, a, b) in pairs.iter() {
                let mut tot = (0u64, 0u64, 0u64, 0u64);
                for seed in 1..=4u64 {
                    let (us, rtx, sent, rej, done) = transfer(a.clone(), b.clone(), link, 8 << 20, seed, *rd, default_stream);
                    if !done { println!("NOT DONE {name} {pair} seed {seed}"); }
                    tot = (tot.0 + us, tot.1 + rtx, tot.2 + sent, tot.3 + rej);
                }
                println!("{name:30} {pair:9} avg {:>7.3}s  retransmitted={:>7} packets_sent={:>7} rx_rejected={:>6}", tot.0 as f64 / 4e6, tot.1 / 4, tot.2 / 4, tot.3 / 4);
            }
        }
    }
    let lan = mk(1_000_000_000, 1_000, 5_000, 0.0);
    let wan = mk(100_000_000, 10_000, 50_000, 0.0);
    let far = mk(50_000_000, 40_000, 100_000, 0.0);
    let fast = mk(1_000_000_000, 10_000, 20_000, 0.0);
    println!("== 20 MiB, seed 1, non-default stream, no loss");
    for (name, link) in [("lan 1G/2ms", &lan), ("wan 100M/20ms", &wan), ("far 50M/80ms", &far), ("fast 1G/20ms", &fast)] {
        for (pair, a, b) in pairs.iter() {
            let (us, rtx, sent, rej, done) = transfer(a.clone(), b.clone(), link, 20 << 20, 1, 0, false);
            println!("{name:14} {pair:9} done={done} {:>8.3}s  retransmitted={rtx:>7} packets_sent={sent:>7} rx_rejected={rej}", us as f64 / 1e6);
        }
    }
}
