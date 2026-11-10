//! INSTRUMENT: 大文件和交互消息共用一条线路：单条流 / 两条独立连接 / 只有交互（基线）。
use agent_net_core::{Config, Priority, RecoveryPolicy};
use agent_net_sim::{CorePeer, LatencyReport, Link, LinkProfile, Peer};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

#[derive(Clone, Copy, PartialEq)]
enum Mode { Idle, OneStream, TwoConn, Mux }

fn run(mode: Mode, link: &LinkProfile, seed: u64, messages: usize) -> (LatencyReport, f64) {
    let window: u32 = std::env::var("WINDOW").ok().and_then(|v| v.parse().ok()).unwrap_or(1024);
    let config = Config { max_packet_size: 1400, send_window: window, recv_window: window, send_buffer_bytes: (window as usize * 2800).max(1 << 20), ..Config::for_policy(RecoveryPolicy::Auto) };
    let mut a: Vec<CorePeer> = (0..2).map(|_| CorePeer::new(config.clone())).collect();
    let mut b: Vec<CorePeer> = (0..2).map(|_| CorePeer::new(config.clone())).collect();
    let mut out_a = Link::new(link.clone(), seed ^ 0xA5A5);
    let mut out_b = Link::new(link.clone(), seed ^ 0x5A5A);
    let mut heap: BinaryHeap<Reverse<(u64, u64, usize, bool, Vec<u8>)>> = BinaryHeap::new();
    let (interval, msg, chunk) = (20_000u64, vec![7u8; 200], vec![9u8; 4096]);
    let (bulk_pair, chat_pair) = (0usize, if mode == Mode::OneStream || mode == Mode::Mux { 0 } else { 1 });
    let (mut chat_id, mut bulk_id) = (0u32, 0u32);
    if mode == Mode::Mux {
        chat_id = a[0].connection.open_stream(Priority::Interactive).unwrap();
        bulk_id = a[0].connection.open_stream(Priority::Background).unwrap();
    }
    let (mut now, mut order, mut sent) = (0u64, 0u64, 0usize);
    let mut report = LatencyReport::default();
    let mut pending: VecDeque<(usize, u64)> = VecDeque::new(); // 等写入的消息
    let mut waiting: VecDeque<(u64, u64)> = VecDeque::new(); // (流内结束位置, 产生时间)
    let (mut written, mut read_chat, mut read_bulk) = (0u64, 0u64, 0u64);
    let mut incoming = vec![0u8; 256 * 1024];
    let end = messages as u64 * interval + 30_000_000;
    while now <= end && report.samples_us.len() < messages {
        if sent < messages && now >= sent as u64 * interval { pending.push_back((sent, now)); sent += 1; }
        while let Some(&(_, at)) = pending.front() {
            let n = if mode == Mode::Mux { a[0].connection.send_stream(now, chat_id, &msg) } else { a[chat_pair].write(now, &msg) };
            if n == 0 { break; }
            pending.pop_front();
            written += 200;
            waiting.push_back((written, at));
        }
        if mode != Mode::Idle && pending.is_empty() {
            loop {
                let n = if mode == Mode::Mux { a[0].connection.send_stream(now, bulk_id, &chunk) } else { a[bulk_pair].write(now, &chunk) };
                if chat_pair == bulk_pair && mode != Mode::Mux { written += n as u64; }
                if n < chunk.len() { break; }
            }
        }
        if mode == Mode::Mux {
            while let Some(_) = b[0].connection.poll_event() {}
            loop { let n = b[0].connection.recv_stream(now, chat_id, &mut incoming); if n == 0 { break; } read_chat += n as u64; }
            loop { let n = b[0].connection.recv_stream(now, bulk_id, &mut incoming); if n == 0 { break; } read_bulk += n as u64; }
        }
        for i in 0..2 {
            if mode == Mode::Mux { break; }
            loop {
                let n = b[i].read(now, &mut incoming);
                if n == 0 { break; }
                if i == chat_pair { read_chat += n as u64; }
                if i == bulk_pair && mode == Mode::TwoConn { read_bulk += n as u64; }
            }
        }
        while let Some(&(position, at)) = waiting.front() {
            if read_chat < position { break; }
            report.samples_us.push(now - at);
            waiting.pop_front();
        }
        for i in 0..2 {
            let (heap_ref, ordering, wire) = (&mut heap, &mut order, &mut report.wire_bytes);
            a[i].pump(now, &mut |p| { *wire += p.len() as u64; let (t, c) = out_a.transmit(now, p.len()); for &at in &t[..c] { *ordering += 1; heap_ref.push(Reverse((at, *ordering, i, true, p.to_vec()))); } });
            b[i].pump(now, &mut |p| { *wire += p.len() as u64; let (t, c) = out_b.transmit(now, p.len()); for &at in &t[..c] { *ordering += 1; heap_ref.push(Reverse((at, *ordering, i, false, p.to_vec()))); } });
        }
        let mut next = (sent < messages).then_some(sent as u64 * interval);
        let mut cands: Vec<u64> = heap.peek().map(|Reverse(x)| x.0).into_iter().collect();
        for i in 0..2 { cands.extend(a[i].wake_at()); cands.extend(b[i].wake_at()); }
        for c in cands { next = Some(next.map_or(c, |v: u64| v.min(c))); }
        let Some(next) = next else { break };
        now = next.max(now + 1);
        while heap.peek().is_some_and(|Reverse(x)| x.0 <= now) {
            let Some(Reverse((_, _, i, to_b, p))) = heap.pop() else { break };
            if to_b { b[i].input(now, &p) } else { a[i].input(now, &p) }
        }
        for i in 0..2 {
            if a[i].wake_at().is_some_and(|at| at <= now) { a[i].on_wake(now); }
            if b[i].wake_at().is_some_and(|at| at <= now) { b[i].on_wake(now); }
        }
    }
    if mode == Mode::OneStream { read_bulk = read_chat.saturating_sub(report.samples_us.len() as u64 * 200); }
    report.samples_us.extend(std::iter::repeat_n(u64::MAX, messages - report.samples_us.len()));
    (report, read_bulk as f64 * 8.0 / (messages as u64 * interval) as f64)
}

fn main() {
    let lan = |bits: u64, delay: u64, jitter: u64, loss: f64, queue: u64| LinkProfile { bits_per_second: bits, delay_us: delay, jitter_us: jitter, loss, queue_us: queue, ..LinkProfile::default() };
    let rows = [("家宽 300M 25ms", lan(300_000_000, 12_500, 2_000, 0.003, 40_000)), ("校园 40M 30ms", lan(40_000_000, 15_000, 3_000, 0.008, 40_000)), ("4G 20M 70ms", lan(20_000_000, 35_000, 20_000, 0.015, 200_000)), ("手机 10M 100ms", lan(10_000_000, 50_000, 30_000, 0.03, 150_000)), ("窄带 5M 大队列", lan(5_000_000, 30_000, 2_000, 0.01, 300_000))];
    let wander = |bits: u64, delay: u64, wander: u64, loss: f64| LinkProfile { bits_per_second: bits, delay_us: delay, jitter_us: 4_000, loss, queue_us: 80_000, wander_us: wander, wander_period_us: 4_000_000, ..LinkProfile::default() };
    let drift = [("漂移 60M 104-150ms", wander(60_000_000, 52_000, 23_000, 0.01)), ("漂移 20M 60-120ms", wander(20_000_000, 30_000, 30_000, 0.02))];
    let limited = |bytes: u64, depth: u64| LinkProfile { bits_per_second: 1_000_000_000, delay_us: 70_000, jitter_us: 5_000, queue_us: 20_000, bucket_bytes_per_second: bytes, bucket_depth_bytes: depth, ..LinkProfile::default() };
    let limits = [("限速 5.6M", limited(708_000, 600_000)), ("限速 40M", limited(5_000_000, 600_000))];
    let swing = |period: u64, wander: u64| LinkProfile { bits_per_second: 20_000_000, delay_us: 50_000, jitter_us: 4_000, loss: 0.002, queue_us: 80_000, wander_us: wander, wander_period_us: period, ..LinkProfile::default() };
    let swings = [("摆动 0.4s 30ms", swing(400_000, 30_000)), ("摆动 1s 40ms", swing(1_000_000, 40_000)), ("摆动 2s 20ms", swing(2_000_000, 20_000))];
    let step = |bits: u64, period: u64| LinkProfile { bits_per_second: bits, delay_us: 30_000, jitter_us: 2_000, queue_us: 60_000, wander_us: 40_000, wander_period_us: period, ..LinkProfile::default() };
    let steps = [("台阶 100M 0.25s", step(100_000_000, 4_000_000)), ("台阶 100M 0.5s", step(100_000_000, 8_000_000)), ("台阶 40M 0.5s", step(40_000_000, 8_000_000))];
    let long = [("千兆 100ms", lan(1_000_000_000, 50_000, 1_000, 0.0005, 30_000)), ("跨洋 100M 200ms", lan(100_000_000, 100_000, 3_000, 0.002, 60_000))];
    let rows: Vec<_> = if std::env::var("STEP").is_ok() { steps.to_vec() } else if std::env::var("SWING").is_ok() { swings.to_vec() } else if std::env::var("LIMIT").is_ok() { limits.to_vec() } else if std::env::var("DRIFT").is_ok() { drift.to_vec() } else if std::env::var("LONG").is_ok() { long.to_vec() } else { rows.to_vec() };
    for (name, link) in &rows {
        for (label, mode) in [("只有交互", Mode::Idle), ("两条连接", Mode::TwoConn), ("多路流", Mode::Mux)] {
            let mut all = LatencyReport::default();
            let mut rate = 0.0;
            for seed in 1..=std::env::var("SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(4u64) {
                let (r, x) = run(mode, link, seed, std::env::var("MSGS").ok().and_then(|v| v.parse().ok()).unwrap_or(750));
                if std::env::var("EACH").is_ok() { print!(" {x:.1}"); }
                all.samples_us.extend(r.samples_us);
                rate += x / std::env::var("SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(4.0);
            }
            println!("{name:<16} {label:<8} 消息延迟 p50 {:8.1} p95 {:8.1} p99 {:8.1} ms  文件 {:7.1} Mbit/s", all.percentile_ms(50.0), all.percentile_ms(95.0), all.percentile_ms(99.0), rate);
        }
    }
}
