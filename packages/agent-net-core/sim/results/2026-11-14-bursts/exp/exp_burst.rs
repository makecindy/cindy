//! 一阵一阵的业务数据能不能跑满线路（docs/agent-net-session-plan.md 第 7 节第 7 条，2026-11-14）。
//!
//! 和 Cindy 的实际用法一样：两端一直有零星小消息（每 500 毫秒各发 200 字节），大数据一阵一阵地来。
//! 先由 B 向 A 传 1 MiB（A 只回确认），停 2 秒；再由 A 向 B 传三次 1 MiB，中间分别停 2 秒、5 秒。
//! 每一阵从写入到对端读完算用时，利用率 = 1 MiB ÷ 用时 ÷ 线路速率。
//!
//! 运行：`cargo test --profile sim -p agent-net-sim --test exp_burst -- --nocapture`
//! `AGENT_NET_TRACE=线路名` 时打印该线路第一个种子上 A 每 100 毫秒的带宽估计、节奏、往返。
use std::cmp::Reverse;
use std::collections::BinaryHeap;

use agent_net_core::{Config, Connection};
use agent_net_sim::{Link, LinkProfile};

const BULK: u64 = 1 << 20;
const TAP: u64 = 200;
const TAP_EVERY_US: u64 = 500_000;
const LIMIT_US: u64 = 600_000_000;

struct Net {
    peers: [Connection; 2],
    links: [Link; 2],
    heap: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>>,
    order: u64,
    now: u64,
    /// 每一端还没写进连接的字节数，和已经交给连接的总字节数。
    pending: [u64; 2],
    written: [u64; 2],
    /// 每一端读到的总字节数（对端写的）。
    read: [u64; 2],
    next_tap: u64,
    trace: bool,
    next_trace: u64,
}

impl Net {
    fn new(profile: &LinkProfile, seed: u64, trace: bool) -> Self {
        // AGENT_NET_WINDOW=1024：发送、接收窗口都改成这么多个包，发送缓冲 4 MiB。
        let config = match std::env::var("AGENT_NET_WINDOW").ok().and_then(|v| v.parse::<u32>().ok()) {
            Some(window) => Config { send_window: window, recv_window: window, send_buffer_bytes: 4 << 20, ..Config::default() },
            None => Config::default(),
        };
        Self {
            peers: [Connection::new(config.clone(), 0), Connection::new(config, 0)],
            links: [Link::new(profile.clone(), seed), Link::new(profile.clone(), seed ^ 0x5A5A)],
            heap: BinaryHeap::new(),
            order: 0,
            now: 0,
            pending: [0; 2],
            written: [0; 2],
            read: [0; 2],
            next_tap: 0,
            trace,
            next_trace: 0,
        }
    }

    fn step(&mut self) {
        let now = self.now;
        if now >= self.next_tap {
            self.pending[0] += TAP;
            self.pending[1] += TAP;
            self.next_tap += TAP_EVERY_US;
        }
        let chunk = [7u8; 4096];
        for side in 0..2 {
            while self.pending[side] > 0 {
                let n = self.peers[side].send(now, &chunk[..4096.min(self.pending[side] as usize)]) as u64;
                if n == 0 {
                    break;
                }
                self.pending[side] -= n;
                self.written[side] += n;
            }
        }
        while self.heap.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Reverse((_, _, to, packet)) = self.heap.pop().unwrap();
            let _ = self.peers[to].on_packet(now, &packet);
        }
        let mut sink = [0u8; 65536];
        for side in 0..2 {
            loop {
                let n = self.peers[side].recv(now, &mut sink);
                if n == 0 {
                    break;
                }
                self.read[side] += n as u64;
            }
        }
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
        if self.trace && now >= self.next_trace {
            let s = self.peers[0].stats();
            println!(
                "    {:6} ms  bw {:7.0} KB/s  pace {:7.0} KB/s  srtt {:4} ms  min {:4} ms  读到 {:8}",
                now / 1000,
                s.bandwidth as f64 / 1000.0,
                s.pacing_rate as f64 / 1000.0,
                s.srtt_us / 1000,
                s.min_rtt_us / 1000,
                self.read[1]
            );
            self.next_trace = if std::env::var("AGENT_NET_FINE").is_ok_and(|v| { let r: Vec<u64> = v.split('-').map(|x| x.parse().unwrap()).collect(); now / 1000 >= r[0] && now / 1000 < r[1] }) { now } else { now + 50_000 };
        }
        let mut next = self.next_tap;
        if let Some(Reverse(item)) = self.heap.peek() {
            next = next.min(item.0);
        }
        for peer in &self.peers {
            if let Some(wake) = peer.next_wake() {
                next = next.min(wake);
            }
        }
        self.now = next.max(now + 1);
    }

    /// `side` 写 `bytes`，返回对端读完它用了多少微秒。
    fn burst(&mut self, side: usize, bytes: u64) -> u64 {
        let start = self.now;
        // 已写进连接的和还在排队的都在这一阵前面。
        let target = self.written[side] + self.pending[side] + bytes;
        self.pending[side] += bytes;
        while self.read[1 - side] < target && self.now < LIMIT_US {
            self.step();
        }
        self.now - start
    }

    fn idle(&mut self, us: u64) {
        let until = self.now + us;
        while self.now < until {
            self.step();
        }
    }
}

struct Run {
    name: &'static str,
    profile: LinkProfile,
}

fn runs() -> Vec<Run> {
    let fast = LinkProfile { bits_per_second: 8_000_000, delay_us: 20_000, queue_us: 262_000, ..LinkProfile::default() };
    vec![
        Run { name: "fast 8M 40ms", profile: fast.clone() },
        Run { name: "fast 抖动30ms 不乱序", profile: LinkProfile { jitter_us: 30_000, jitter_fifo: true, ..fast.clone() } },
        Run { name: "fast 抖动30ms 乱序", profile: LinkProfile { jitter_us: 30_000, ..fast.clone() } },
        Run { name: "slow 2M 100ms", profile: LinkProfile { bits_per_second: 2_000_000, delay_us: 50_000, queue_us: 524_000, ..LinkProfile::default() } },
        Run { name: "very-slow 512k 200ms", profile: LinkProfile { bits_per_second: 512_000, delay_us: 100_000, queue_us: 1_000_000, ..LinkProfile::default() } },
        Run {
            name: "4G 20M 70ms 抖动20 丢1.5%",
            profile: LinkProfile { bits_per_second: 20_000_000, delay_us: 35_000, jitter_us: 20_000, jitter_fifo: true, loss: 0.015, queue_us: 200_000, ..LinkProfile::default() },
        },
        Run {
            name: "Wi-Fi 50M 20ms 抖动4 丢0.5%",
            profile: LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 4_000, jitter_fifo: true, loss: 0.005, queue_us: 20_000, ..LinkProfile::default() },
        },
        Run { name: "家宽 100M 30ms", profile: LinkProfile { bits_per_second: 100_000_000, delay_us: 15_000, jitter_us: 2_000, queue_us: 40_000, ..LinkProfile::default() } },
    ]
}

#[test]
fn bursty_transfers() {
    let seeds = [1u64, 2, 3, 4];
    let trace = std::env::var("AGENT_NET_TRACE").ok();
    let mut grand = [0f64; 4];
    println!("线路 | 反向 | 第一阵 | 停 2 秒后 | 停 5 秒后（利用率，{} 个种子平均）", seeds.len());
    for run in runs() {
        let rate = run.profile.bits_per_second as f64 / 8.0;
        let mut sums = [0f64; 4];
        for &seed in &seeds {
            let trace_seed: u64 = std::env::var("AGENT_NET_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(seeds[0]);
            let traced = seed == trace_seed && trace.as_deref().is_some_and(|t| run.name.contains(t));
            let mut net = Net::new(&run.profile, seed, traced);
            net.idle(1_000_000);
            if traced {
                println!("  {} 反向", run.name);
            }
            let times = [
                net.burst(1, BULK),
                { net.idle(2_000_000); if traced { println!("  第一阵"); } net.burst(0, BULK) },
                { net.idle(2_000_000); if traced { println!("  停 2 秒后"); } net.burst(0, BULK) },
                { net.idle(5_000_000); if traced { println!("  停 5 秒后"); } net.burst(0, BULK) },
            ];
            if trace.is_some() {
                println!("  {} 种子 {}：{:?} ms", run.name, seed, times.map(|t| t / 1000));
            }
            for (sum, time) in sums.iter_mut().zip(times) {
                *sum += BULK as f64 / (time as f64 / 1e6) / rate;
            }
        }
        let mean = sums.map(|sum| sum / seeds.len() as f64);
        for (total, value) in grand.iter_mut().zip(mean) {
            *total += value;
        }
        println!("{} | {:.0}% | {:.0}% | {:.0}% | {:.0}%", run.name, mean[0] * 100.0, mean[1] * 100.0, mean[2] * 100.0, mean[3] * 100.0);
    }
    let count = runs().len() as f64;
    println!("平均 | {:.0}% | {:.0}% | {:.0}% | {:.0}%", grand[0] / count * 100.0, grand[1] / count * 100.0, grand[2] / count * 100.0, grand[3] / count * 100.0);
}
