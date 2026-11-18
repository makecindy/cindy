//! 分块请求-回复：A 同时发 4 个小请求，B 每收到一个就回 512 KiB，A 收完一块就再发一个请求，共 16 块（8 MiB）。
//! 和端到端压测 bulk-transfer.ts 的 down 方向同样的用法，看核心在这种「一直有数据、但按块来」的传输里能跑多快。
//! 运行：`cargo test --profile sim -p agent-net-sim --test exp_chunked -- --nocapture`，`AGENT_NET_TRACE=1` 打印 B 每 50 毫秒的统计。
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use agent_net_core::{Config, Connection};
use agent_net_sim::{Link, LinkProfile};

const CHUNK: u64 = 512 * 1024;
const REQUEST: u64 = 64;

fn run(name: &str, profile: LinkProfile, concurrency: u64, chunks: u64, trace: bool) {
    let config = Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::default() };
    let mut peers = [Connection::new(config.clone(), 0), Connection::new(config, 0)];
    let mut links = [Link::new(profile.clone(), 1), Link::new(profile.clone(), 1 ^ 0x5A5A)];
    let mut heap: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>> = BinaryHeap::new();
    let (mut order, mut now) = (0u64, 0u64);
    // pending[side]：还没写进连接的字节；B 读到的请求字节、A 读到的回复字节。
    let mut pending = [0u64; 2];
    let (mut requests_read, mut responses_read) = (0u64, 0u64);
    let (mut requested, mut responded) = (0u64, 0u64);
    let mut next_tap = 0u64;
    let mut next_trace = 0u64;
    let mut start = None;
    // 先空闲 1 秒，两端每 500 毫秒一条 200 字节的小消息（和压测一样先建好连接）。
    let mut taps = [0u64; 2];
    loop {
        if now >= 1_000_000 && start.is_none() {
            start = Some(now);
            pending[0] += REQUEST * concurrency;
            requested = concurrency;
        }
        if now >= next_tap { taps[0] += 200; taps[1] += 200; next_tap += 500_000; }
        let chunk = [7u8; 4096];
        for side in 0..2 {
            let total = pending[side] + taps[side];
            let mut left = total;
            while left > 0 {
                let n = peers[side].send(now, &chunk[..4096.min(left as usize)]) as u64;
                if n == 0 { break; }
                left -= n;
            }
            let written = total - left;
            let from_taps = written.min(taps[side]);
            taps[side] -= from_taps;
            pending[side] -= written - from_taps;
        }
        while heap.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Reverse((_, _, to, packet)) = heap.pop().unwrap();
            let _ = peers[to].on_packet(now, &packet);
        }
        let mut sink = [0u8; 65536];
        loop { let n = peers[1].recv(now, &mut sink) as u64; if n == 0 { break; } requests_read += n; }
        loop { let n = peers[0].recv(now, &mut sink) as u64; if n == 0 { break; } responses_read += n; }
        // 小消息也算在读到的字节里，按请求大小折算只是近似：请求 64 字节、小消息 200 字节，按 B 读到的总量减去小消息算。
        if start.is_some() {
            let taps_seen = (now / 500_000 + 1) * 200;
            let request_bytes = requests_read.saturating_sub(taps_seen.min(requests_read));
            while responded < requested.min(request_bytes / REQUEST) && responded < chunks { pending[1] += CHUNK; responded += 1; }
            let done = responses_read.saturating_sub(taps_seen.min(responses_read)) / CHUNK;
            while requested < chunks && requested < done + concurrency { pending[0] += REQUEST; requested += 1; }
            if done >= chunks {
                let took = now - start.unwrap();
                println!("{name} 并发 {concurrency}: {} ms，{:.1} MB/s，线路的 {:.0}%", took / 1000,
                    (chunks * CHUNK) as f64 / took as f64, (chunks * CHUNK) as f64 / (took as f64 / 1e6) / (profile.bits_per_second as f64 / 8.0) * 100.0);
                return;
            }
        }
        if trace && now >= next_trace {
            let s = peers[1].stats();
            println!("    {:6} ms bw {:6} KB/s pace {:6} KB/s srtt {:3} min {:3} 回了 {} 块 读到 {} KB", now / 1000, s.bandwidth / 1000, s.pacing_rate / 1000,
                s.srtt_us / 1000, s.min_rtt_us / 1000, responded, responses_read / 1024);
            next_trace = now + 50_000;
        }
        let mut out = [0u8; 2048];
        for side in 0..2 {
            if peers[side].next_wake().is_some_and(|wake| wake <= now) { peers[side].tick(now); }
            while let Some(n) = peers[side].poll_transmit(now, &mut out) {
                let (arrivals, count) = links[side].transmit(now, n);
                for &at in &arrivals[..count] { order += 1; heap.push(Reverse((at, order, 1 - side, out[..n].to_vec()))); }
            }
        }
        let mut next = next_tap;
        if let Some(Reverse(item)) = heap.peek() { next = next.min(item.0); }
        for peer in &peers { if let Some(wake) = peer.next_wake() { next = next.min(wake); } }
        if start.is_none() { next = next.min(1_000_000); }
        now = next.max(now + 1);
        if now > 120_000_000 { println!("{name}: 超时"); return; }
    }
}

#[test]
fn chunked_transfers() {
    let trace = std::env::var("AGENT_NET_TRACE").is_ok();
    let wide = LinkProfile { bits_per_second: 100_000_000, delay_us: 16_000, queue_us: 40_000, ..LinkProfile::default() };
    let far = LinkProfile { bits_per_second: 50_000_000, delay_us: 100_000, queue_us: 100_000, ..LinkProfile::default() };
    let fast = LinkProfile { bits_per_second: 8_000_000, delay_us: 20_000, queue_us: 262_000, ..LinkProfile::default() };
    for c in [1, 4, 8] { run("家宽 100M 32ms", wide.clone(), c, 16, trace && c == 4); }
    for c in [1, 4] { run("跨地区 50M 200ms", far.clone(), c, 16, false); }
    for c in [1, 4] { run("每秒 1 MB 40ms", fast.clone(), c, 8, false); }
}
