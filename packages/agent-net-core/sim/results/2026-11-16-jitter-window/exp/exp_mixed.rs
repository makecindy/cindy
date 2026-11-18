//! 大数据在传时夹着小请求，核心慢多少、小请求等多久（2026-11-14 起；2026-11-16 加了真实网络对比那条 VPN 线路）。
//!
//! 和会话层的用法一样：两端一直有零星小消息（每 500 毫秒各发 200 字节，走默认流）。B 回 A 一条大消息（普通流），
//! 传的期间 A 每 100 毫秒发一个 64 字节的小请求，B 读到就回 64 字节。三种情况：
//! - 单独：没有小请求；
//! - 普通：小请求和回复走另开的普通优先级流（核心不进低排队模式）；
//! - 交互：走交互优先级流（会话层的控制与交互通道，核心进低排队模式）。
//! 大消息用时从 B 写入到 A 读完，小请求往返从 A 写入到 A 读完回复。
//!
//! 运行：`AGENT_NET_BULK_MIB=1 cargo test --profile sim -p agent-net-sim --test exp_mixed -- --nocapture`；
//! `AGENT_NET_SEEDS=12` 跑种子 1–12（默认 4 个）。p99 是所有种子的小请求往返合在一起排的。
//! Windows 的计时器：`AGENT_NET_TIMER_US=16000` 让核心自己的唤醒按 15.6 毫秒的节拍取整，`AGENT_NET_WAKE=core|always|never` 选驱动的规则（见 `advance`）。
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

use agent_net_core::{Config, Connection, Priority};
use agent_net_sim::{Link, LinkProfile};

fn bulk() -> u64 { std::env::var("AGENT_NET_BULK_MIB").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1) << 20 }
const TAP: u64 = 200;
const TAP_EVERY_US: u64 = 500_000;
const REQUEST: u64 = 64;
const REQUEST_EVERY_US: u64 = 100_000;
const LIMIT_US: u64 = 600_000_000;

#[derive(Clone, Copy, PartialEq)]
enum Mode { Alone, Normal, Interactive }

struct Net {
    peers: [Connection; 2],
    links: [Link; 2],
    heap: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>>,
    order: u64,
    now: u64,
    next_tap: u64,
    /// 每一端每条流还没写进连接的字节数：默认流、大消息流、小请求流。
    pending: [[u64; 3]; 2],
    streams: [[u32; 3]; 2],
    /// 每一端从对端每条流读到的字节数。
    read: [[u64; 3]; 2],
    /// 上一步有没有读到数据（应用读到就会回，见 `advance`）。
    reacted: bool,
}

impl Net {
    fn new(profile: &LinkProfile, seed: u64, mode: Mode) -> Self {
        let config = Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, ..Config::default() };
        let mut peers = [Connection::new(config.clone(), 0), Connection::new(config, 0)];
        let small = if mode == Mode::Interactive { Priority::Interactive } else { Priority::Normal };
        let streams = [0, 1].map(|side| {
            let bulk = peers[side].open_stream(Priority::Normal).unwrap();
            let request = peers[side].open_stream(small).unwrap();
            [agent_net_core::DEFAULT_STREAM, bulk, request]
        });
        Self {
            peers,
            links: [Link::new(profile.clone(), seed), Link::new(profile.clone(), seed ^ 0x5A5A)],
            heap: BinaryHeap::new(),
            order: 0,
            now: 0,
            next_tap: 0,
            pending: [[0; 3]; 2],
            streams,
            read: [[0; 3]; 2],
            reacted: false,
        }
    }

    fn step(&mut self) {
        let now = self.now;
        if now >= self.next_tap {
            self.pending[0][0] += TAP;
            self.pending[1][0] += TAP;
            self.next_tap += TAP_EVERY_US;
        }
        let chunk = [7u8; 4096];
        for side in 0..2 {
            // 小请求先写：会话层也是先写控制通道。
            for lane in [2, 0, 1] {
                while self.pending[side][lane] > 0 {
                    let n = self.peers[side].send_stream(now, self.streams[side][lane], &chunk[..4096.min(self.pending[side][lane] as usize)]) as u64;
                    if n == 0 {
                        break;
                    }
                    self.pending[side][lane] -= n;
                }
            }
        }
        while self.heap.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Reverse((_, _, to, packet)) = self.heap.pop().unwrap();
            let _ = self.peers[to].on_packet(now, &packet);
        }
        let read_before = self.read;
        let mut sink = [0u8; 65536];
        for side in 0..2 {
            for lane in 0..3 {
                loop {
                    let n = self.peers[side].recv_stream(now, self.streams[1 - side][lane], &mut sink);
                    if n == 0 {
                        break;
                    }
                    self.read[side][lane] += n as u64;
                }
            }
        }
        self.reacted = self.read != read_before;
        let mut out = [0u8; 2048];
        for side in 0..2 {
            if self.peers[side].next_wake().is_some_and(|wake| wake <= now) {
                self.peers[side].tick(now);
            }
            while let Some(n) = self.peers[side].poll_transmit(now, &mut out) {
                let (arrivals, count) = self.links[side].transmit(now, n);
                for &at in &arrivals[..count] {
                    self.order += 1;
                    self.heap.push(Reverse((at, self.order, 1 - side, out[..n].to_vec())));
                }
            }
        }
    }

    fn advance(&mut self, deadline: u64) {
        let mut next = self.next_tap.min(deadline);
        if let Some(Reverse(item)) = self.heap.peek() {
            next = next.min(item.0);
        }
        // AGENT_NET_TIMER_US：核心自己的唤醒按这个粒度往后取整（Windows 上 setTimeout 约 15.6 毫秒），收到包照旧马上处理。
        let timer = std::env::var("AGENT_NET_TIMER_US").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1).max(1);
        // AGENT_NET_WAKE：粒度粗时驱动怎么醒。core（默认）和 `wasm/node.mts` 一样，核心说这条连接等不起（`needs_fine_timer`）时每轮看时间；
        // always 一直看时间（2026-11-16 之前的驱动）；never 一直交给计时器。
        let rule = std::env::var("AGENT_NET_WAKE").unwrap_or_default();
        // 计时器粗时，读到数据的这一刻应用就回（Node 里应用写数据，驱动当轮就处理），不等下一次醒来；准时的时候下一个事件只差几微秒，
        // 不改，之前的记录照样能复现。
        if timer > 1 && self.reacted {
            next = next.min(self.now + 1);
        }
        for peer in &self.peers {
            if let Some(wake) = peer.next_wake() {
                let fine = match rule.as_str() {
                    "always" => true,
                    "never" => false,
                    _ => peer.needs_fine_timer(timer),
                };
                let quantum = if fine { 1 } else { timer };
                next = next.min(wake.max(self.now + 1).div_ceil(quantum) * quantum);
            }
        }
        self.now = next.max(self.now + 1);
    }

    fn idle(&mut self, us: u64) {
        let until = self.now + us;
        while self.now < until {
            self.step();
            self.advance(until);
        }
    }

    /// B 回 A 一条 `bytes` 的大消息，期间 A 按 `mode` 发小请求。返回大消息用时和小请求往返（微秒）。
    fn transfer(&mut self, bytes: u64, mode: Mode) -> (u64, Vec<u64>) {
        let start = self.now;
        let target = self.read[0][1] + bytes;
        self.pending[1][1] += bytes;
        let mut next_request = start;
        let mut sent: VecDeque<u64> = VecDeque::new();
        let (mut requests_seen, mut replies_seen) = (self.read[1][2] / REQUEST, self.read[0][2] / REQUEST);
        let mut rtts = Vec::new();
        let mut done = 0;
        while (done == 0 || !sent.is_empty()) && self.now < LIMIT_US {
            if mode != Mode::Alone && done == 0 && self.now >= next_request {
                self.pending[0][2] += REQUEST;
                sent.push_back(self.now);
                next_request += REQUEST_EVERY_US;
            }
            self.step();
            if done == 0 && self.read[0][1] >= target {
                done = self.now - start;
            }
            // B 读到一个请求就回一个。
            let requests = self.read[1][2] / REQUEST;
            self.pending[1][2] += (requests - requests_seen) * REQUEST;
            requests_seen = requests;
            let replies = self.read[0][2] / REQUEST;
            for _ in replies_seen..replies {
                rtts.push(self.now - sent.pop_front().unwrap());
            }
            replies_seen = replies;
            let deadline = if mode != Mode::Alone && done == 0 { next_request } else { u64::MAX };
            self.advance(deadline);
        }
        (done, rtts)
    }
}

fn lines() -> Vec<(&'static str, LinkProfile)> {
    vec![
        ("bench far 50M 200ms", LinkProfile { bits_per_second: 50_000_000, delay_us: 100_000, queue_us: 100_000, ..LinkProfile::default() }),
        ("跨地区 50M 200ms 丢0.5%", LinkProfile { bits_per_second: 50_000_000, delay_us: 100_000, jitter_us: 5_000, loss: 0.005, queue_us: 100_000, ..LinkProfile::default() }),
        ("bench wide 100M 32ms", LinkProfile { bits_per_second: 100_000_000, delay_us: 16_000, queue_us: 40_000, ..LinkProfile::default() }),
        ("每秒 1 MB 80ms", LinkProfile { bits_per_second: 8_000_000, delay_us: 40_000, queue_us: 262_000, ..LinkProfile::default() }),
        ("每秒 1 MB 80ms 抖动30 不乱序", LinkProfile { bits_per_second: 8_000_000, delay_us: 40_000, jitter_us: 30_000, jitter_fifo: true, queue_us: 262_000, ..LinkProfile::default() }),
        ("每秒 1 MB 80ms 抖动60 不乱序", LinkProfile { bits_per_second: 8_000_000, delay_us: 40_000, jitter_us: 60_000, jitter_fifo: true, queue_us: 262_000, ..LinkProfile::default() }),
        // 2026-11-15 真实网络对比的线路：家里经公司 VPN，往返最小 16–20 毫秒、平常 20–27 毫秒，几乎不丢包；原来的 Device Link 回传每秒 14–15 MB。
        ("VPN 120M 17ms 抖动10 不乱序", LinkProfile { bits_per_second: 120_000_000, delay_us: 8_500, jitter_us: 10_000, jitter_fifo: true, queue_us: 50_000, ..LinkProfile::default() }),
        ("VPN 120M 17ms 抖动5 不乱序", LinkProfile { bits_per_second: 120_000_000, delay_us: 8_500, jitter_us: 5_000, jitter_fifo: true, queue_us: 50_000, ..LinkProfile::default() }),
        ("4G 20M 70ms 抖动20 丢1.5%", LinkProfile { bits_per_second: 20_000_000, delay_us: 35_000, jitter_us: 20_000, jitter_fifo: true, loss: 0.015, queue_us: 200_000, ..LinkProfile::default() }),
    ]
}

#[test]
fn bulk_with_small_requests() {
    let seeds: Vec<u64> = (1..=std::env::var("AGENT_NET_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(4)).collect();
    println!("线路 | 单独 | 普通流小请求：用时 / 往返平均 / p99 / 最长 | 交互流小请求：用时 / 往返平均 / p99 / 最长（毫秒，{} 个种子平均，最长取最大）", seeds.len());
    for (name, profile) in lines() {
        let mut cells = Vec::new();
        for mode in [Mode::Alone, Mode::Normal, Mode::Interactive] {
            let (mut time, mut rtt_sum, mut rtt_count, mut rtt_max) = (0u64, 0u64, 0u64, 0u64);
            let mut all: Vec<u64> = Vec::new();
            for &seed in seeds.iter() {
                let mut net = Net::new(&profile, seed, mode);
                net.idle(1_000_000);
                let (took, rtts) = net.transfer(bulk(), mode);
                time += took;
                rtt_sum += rtts.iter().sum::<u64>();
                rtt_count += rtts.len() as u64;
                rtt_max = rtt_max.max(rtts.iter().copied().max().unwrap_or(0));
                all.extend(&rtts);
            }
            let time = time / seeds.len() as u64 / 1000;
            cells.push(if mode == Mode::Alone {
                format!("{time}")
            } else {
                { all.sort(); let p99 = all.get(all.len() * 99 / 100).copied().unwrap_or(0); format!("{time} / {} / {} / {}", rtt_sum / rtt_count.max(1) / 1000, p99 / 1000, rtt_max / 1000) }
            });
        }
        println!("{name} | {}", cells.join(" | "));
    }
}
