//! 加密的代价：同一批模拟网络里明文和加密各跑一遍，比用时和线上流量；再用直连的内存循环比 CPU。
//! 用法：cargo run --release -p agent-net-sim --example secure_cost [种子数] [MiB]
//! 加密算法是测试用的 ring（AES-256-GCM、ChaCha20-Poly1305）和 x25519-dalek，产品里换成各平台的系统实现，
//! CPU 数字只代表同等级的实现，测的时候机器上不要有别的负载。
use std::collections::VecDeque;
use std::time::Instant;

use agent_net_core::{Config, Connection, Crypto, Incoming, SecureConnection};
use agent_net_sim::crypto::{AesGcm, ChaChaPoly, PROLOGUE, SecurePeer, Suite, TestCrypto};
use agent_net_sim::{CorePeer, LinkProfile, Outcome, Workload, run, scenarios};

fn plain(config: &Config, link: &LinkProfile, back: &LinkProfile, workload: &Workload, seed: u64) -> Outcome {
    run(CorePeer::new(config.clone()), CorePeer::new(config.clone()), link.clone(), back.clone(), workload, seed)
}

fn secure(config: &Config, link: &LinkProfile, back: &LinkProfile, workload: &Workload, seed: u64) -> Outcome {
    let (a, b) = SecurePeer::<AesGcm>::pair(config.clone(), seed);
    run(a, b, link.clone(), back.clone(), workload, seed)
}

/// 直连循环里两种连接共用的操作。
trait Endpoint {
    fn send(&mut self, now: u64, data: &[u8]) -> usize;
    fn recv(&mut self, now: u64, out: &mut [u8]) -> usize;
    fn input(&mut self, now: u64, packet: &[u8]);
    fn output(&mut self, now: u64, out: &mut [u8]) -> Option<usize>;
    fn wake(&self) -> Option<u64>;
    fn tick(&mut self, now: u64);
}

impl Endpoint for Connection {
    fn send(&mut self, now: u64, data: &[u8]) -> usize {
        Connection::send(self, now, data)
    }
    fn recv(&mut self, now: u64, out: &mut [u8]) -> usize {
        Connection::recv(self, now, out)
    }
    fn input(&mut self, now: u64, packet: &[u8]) {
        self.on_packet(now, packet).expect("packet");
    }
    fn output(&mut self, now: u64, out: &mut [u8]) -> Option<usize> {
        self.poll_transmit(now, out)
    }
    fn wake(&self) -> Option<u64> {
        self.next_wake()
    }
    fn tick(&mut self, now: u64) {
        Connection::tick(self, now)
    }
}

impl<C: Crypto> Endpoint for SecureConnection<C> {
    fn send(&mut self, now: u64, data: &[u8]) -> usize {
        SecureConnection::send(self, now, data)
    }
    fn recv(&mut self, now: u64, out: &mut [u8]) -> usize {
        SecureConnection::recv(self, now, out)
    }
    fn input(&mut self, now: u64, packet: &[u8]) {
        let _ = self.on_packet(now, packet);
    }
    fn output(&mut self, now: u64, out: &mut [u8]) -> Option<usize> {
        self.poll_transmit(now, out)
    }
    fn wake(&self) -> Option<u64> {
        self.next_wake()
    }
    fn tick(&mut self, now: u64) {
        SecureConnection::tick(self, now)
    }
}

/// 两个端点直接互相喂包，虚拟时间每轮走 1 微秒、空闲时跳到下一次唤醒；返回传完 `total` 字节的真实耗时。
fn pump<A: Endpoint, B: Endpoint>(a: &mut A, b: &mut B, total: usize) -> f64 {
    let started = Instant::now();
    let chunk = vec![0x5Au8; 65536];
    let (mut out, mut sink) = (vec![0u8; 2048], vec![0u8; 1 << 20]);
    let (mut written, mut read, mut now) = (0usize, 0usize, 0u64);
    let (mut to_b, mut to_a): (VecDeque<Vec<u8>>, VecDeque<Vec<u8>>) = (VecDeque::new(), VecDeque::new());
    while read < total {
        while written < total {
            let size = a.send(now, &chunk[..chunk.len().min(total - written)]);
            written += size;
            if size == 0 {
                break;
            }
        }
        while let Some(size) = a.output(now, &mut out) {
            to_b.push_back(out[..size].to_vec());
        }
        while let Some(size) = b.output(now, &mut out) {
            to_a.push_back(out[..size].to_vec());
        }
        let moved = !to_b.is_empty() || !to_a.is_empty();
        now += 1;
        while let Some(packet) = to_b.pop_front() {
            b.input(now, &packet);
        }
        while let Some(packet) = to_a.pop_front() {
            a.input(now, &packet);
        }
        loop {
            let size = b.recv(now, &mut sink);
            if size == 0 {
                break;
            }
            read += size;
        }
        if !moved {
            let next = [a.wake(), b.wake()].into_iter().flatten().min().unwrap_or(now + 1);
            now = now.max(next);
        }
        for endpoint in [&mut *a as &mut dyn Endpoint, &mut *b as &mut dyn Endpoint] {
            if endpoint.wake().is_some_and(|at| at <= now) {
                endpoint.tick(now);
            }
        }
        assert!(now < 3_600_000_000, "direct pump stalled");
    }
    started.elapsed().as_secs_f64()
}

fn cpu_secure<S: Suite>(config: &Config, total: usize) -> f64 {
    let responder = TestCrypto::<S>::from_seed(2).unchecked();
    let mut initiator = SecureConnection::connect(TestCrypto::<S>::from_seed(1).unchecked(), config.clone(), PROLOGUE, &responder.public(), &[], 0).expect("connect");
    let mut out = vec![0u8; 2048];
    let size = initiator.poll_transmit(0, &mut out).expect("initiation");
    let incoming = Incoming::read(&responder, PROLOGUE, &out[..size]).expect("read");
    let mut accepted = incoming.accept(responder, config.clone(), &[], 0).expect("accept");
    pump(&mut initiator, &mut accepted, total)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let seeds: u64 = args.get(1).map_or(8, |value| value.parse().expect("seeds"));
    let mib: u64 = args.get(2).map_or(2, |value| value.parse().expect("MiB"));
    let config = Config { send_window: 512, recv_window: 512, send_buffer_bytes: 4 << 20, ..Config::default() };

    println!("每场景 {seeds} 个种子。批量 = 单向 {mib} MiB 用时；加密的“握手后”从发起方收到回复算起；小消息 = 单向 1 KiB 从建连到送达；流量 = 线上字节 / 数据字节 - 1");
    println!("{:<36} {:>9} {:>9} {:>7} {:>9} {:>7}   {:>7} {:>7}   {:>7} {:>7}", "场景", "明文批量", "加密批量", "差", "握手后", "差", "明文小", "加密小", "明文流量", "加密流量");
    let (mut bulk_ratios, mut data_ratios, mut overheads) = (Vec::new(), Vec::new(), Vec::new());
    for scenario in scenarios() {
        let bulk = Workload { a_to_b_bytes: mib << 20, ..Workload::default() };
        let small = Workload { a_to_b_bytes: 1024, ..Workload::default() };
        let (mut plain_bulk, mut secure_bulk, mut plain_small, mut secure_small) = (0f64, 0f64, 0f64, 0f64);
        let (mut plain_wire, mut secure_wire, mut secure_data) = (0f64, 0f64, 0f64);
        for seed in 1..=seeds {
            let (p, s) = (plain(&config, &scenario.link, &scenario.back, &bulk, seed), secure(&config, &scenario.link, &scenario.back, &bulk, seed));
            assert!(p.finished && s.finished && p.violation.is_none() && s.violation.is_none(), "{} seed {seed}: {:?} / {:?}", scenario.label, p.violation, s.violation);
            plain_bulk += p.finish_us as f64 / 1000.0;
            secure_bulk += s.finish_us as f64 / 1000.0;
            secure_data += (s.finish_us - s.established_at[0].expect("handshake time")) as f64 / 1000.0;
            plain_wire += p.wire_bytes as f64 / (mib << 20) as f64;
            secure_wire += s.wire_bytes as f64 / (mib << 20) as f64;
            let (p, s) = (plain(&config, &scenario.link, &scenario.back, &small, seed), secure(&config, &scenario.link, &scenario.back, &small, seed));
            assert!(p.finished && s.finished, "{} seed {seed}: small message", scenario.label);
            plain_small += p.finish_us as f64 / 1000.0;
            secure_small += s.finish_us as f64 / 1000.0;
        }
        let n = seeds as f64;
        let ratio = secure_bulk / plain_bulk;
        bulk_ratios.push(ratio);
        data_ratios.push(secure_data / plain_bulk);
        overheads.push(secure_wire / plain_wire);
        println!(
            "{:<36} {:>7.0}ms {:>7.0}ms {:>+6.1}% {:>7.0}ms {:>+6.1}%   {:>5.0}ms {:>5.0}ms   {:>6.1}% {:>6.1}%",
            scenario.label,
            plain_bulk / n,
            secure_bulk / n,
            (ratio - 1.0) * 100.0,
            secure_data / n,
            (secure_data / plain_bulk - 1.0) * 100.0,
            plain_small / n,
            secure_small / n,
            (plain_wire / n - 1.0) * 100.0,
            (secure_wire / n - 1.0) * 100.0
        );
    }
    let mean = |values: &[f64]| values.iter().sum::<f64>() / values.len() as f64;
    let worst = |values: &[f64]| values.iter().cloned().fold(f64::MIN, f64::max);
    let best = |values: &[f64]| values.iter().cloned().fold(f64::MAX, f64::min);
    println!("批量用时 加密/明文：平均 {:+.2}%，最差 {:+.2}%", (mean(&bulk_ratios) - 1.0) * 100.0, (worst(&bulk_ratios) - 1.0) * 100.0);
    println!("握手后用时 加密/明文：平均 {:+.2}%，最好 {:+.2}%，最差 {:+.2}%", (mean(&data_ratios) - 1.0) * 100.0, (best(&data_ratios) - 1.0) * 100.0, (worst(&data_ratios) - 1.0) * 100.0);
    println!("线上流量 加密/明文：平均 {:+.2}%，最差 {:+.2}%", (mean(&overheads) - 1.0) * 100.0, (worst(&overheads) - 1.0) * 100.0);

    // CPU：两个端点直接互相喂包，没有模拟器、链路模型和逐字节校验，测的是协议栈自己的开销。
    let total = 512usize << 20;
    let cpu_config = Config { send_window: 1024, recv_window: 1024, send_buffer_bytes: 8 << 20, ..Config::default() };
    let best = |label: &str, f: &dyn Fn() -> f64| {
        let seconds = (0..5).map(|_| f()).fold(f64::MAX, f64::min);
        println!("CPU {label:<24} 512 MiB 用 {seconds:.3} 秒，{:.0} MiB/s（两端在同一线程，取 5 次最快）", 512.0 / seconds);
        seconds
    };
    let plain_cpu = best("明文", &|| pump(&mut Connection::new(cpu_config.clone(), 0), &mut Connection::new(cpu_config.clone(), 0), total));
    let aes_cpu = best("加密 AES-256-GCM", &|| cpu_secure::<AesGcm>(&cpu_config, total));
    let chacha_cpu = best("加密 ChaCha20-Poly1305", &|| cpu_secure::<ChaChaPoly>(&cpu_config, total));
    println!("CPU 加密/明文：AES-256-GCM {:+.1}%，ChaCha20-Poly1305 {:+.1}%", (aes_cpu / plain_cpu - 1.0) * 100.0, (chacha_cpu / plain_cpu - 1.0) * 100.0);
}
