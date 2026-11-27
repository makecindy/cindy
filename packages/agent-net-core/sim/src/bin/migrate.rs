//! 真实 UDP 上换端口：加密连接传数据的途中，客户端换一个本地端口（经过 NAT 时外部端口也跟着换），
//! 看连接断不断、多久恢复、换完以后多快。只用于测试，不进入产品；密钥由测试用的种子派生，不能用于真实通信。
//!
//! 服务器：`migrate server --bind 0.0.0.0:47812 --seconds 600`
//! 客户端：`migrate client --server 服务器:47812 --direction down --bytes 60000000 --rebind-at 4,8 --notice no`
//!
//! 客户端在给定的秒数（从握手完成算起）换一个新端口。`--notice yes` 时告诉连接自己换了网络，知道自己换了网卡的设备是这样；
//! `no` 时连接察觉不到，和 NAT 换端口一样，只能靠服务器验证新地址、自己安静时探测。
//! 接收方每 100 毫秒记一格送达的字节，结束时打印送达中断最长的几段。
//!
//! 真机换网（拔网线切到手机热点）时：`--rate-mbit 10` 让客户端上传时按这个速度往连接里写，传得够久、又不太费蜂窝流量；
//! 不传就是写满。

use std::net::{SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use agent_net_core::{Config, RecoveryPolicy, SecureConnection};
use agent_net_sim::crypto::{AesGcm, TestCrypto};
use agent_net_udp::Endpoint;

type Crypto = TestCrypto<AesGcm>;

const PROLOGUE: &[u8] = b"agent-net-migrate/1";
const SERVER_SEED: u64 = 0x5E7F_E200;
const BUCKET: Duration = Duration::from_millis(100);
const PACKET: usize = 1400;

fn config() -> Config {
    Config { max_packet_size: PACKET, send_window: 1024, recv_window: 1024, send_buffer_bytes: 2 << 20, ..Config::for_policy(RecoveryPolicy::Auto) }
}

fn clock_seed() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(1, |elapsed| elapsed.as_nanos() as u64)
}

fn server_identity() -> [u8; 32] {
    Crypto::from_seed(SERVER_SEED).secret_bytes()
}

fn pattern(index: u64) -> u8 {
    (index.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 56) as u8
}

/// 接收方的记录：每 100 毫秒一格送达的字节数。
struct Timeline {
    started: Instant,
    buckets: Vec<u64>,
    delivered: u64,
}

impl Timeline {
    fn new() -> Self {
        Self { started: Instant::now(), buckets: Vec::new(), delivered: 0 }
    }

    fn add(&mut self, bytes: usize) {
        let index = (self.started.elapsed().as_millis() / BUCKET.as_millis()) as usize;
        if self.buckets.len() <= index {
            self.buckets.resize(index + 1, 0);
        }
        self.buckets[index] += bytes as u64;
        self.delivered += bytes as u64;
    }

    /// 从第一格有数据到最后一格有数据之间，最长的几段空白：（开始的秒数，长度秒数）。
    fn gaps(&self) -> Vec<(f64, f64)> {
        let mut gaps = Vec::new();
        let mut start = None;
        for (index, &bytes) in self.buckets.iter().enumerate() {
            match (bytes, start) {
                (0, None) if index > 0 => start = Some(index),
                (bytes, Some(from)) if bytes > 0 => {
                    gaps.push((from as f64 * 0.1, (index - from) as f64 * 0.1));
                    start = None;
                }
                _ => {}
            }
        }
        gaps.sort_by(|a, b| b.1.total_cmp(&a.1));
        gaps.truncate(5);
        gaps
    }

    /// 每秒的速度，Mbit/s。
    fn rates(&self) -> Vec<f64> {
        self.buckets.chunks(10).map(|second| second.iter().sum::<u64>() as f64 * 8.0 / 1e6).collect()
    }

    fn report(&self) -> String {
        let rates: Vec<String> = self.rates().iter().map(|rate| format!("{rate:.1}")).collect();
        let gaps: Vec<String> = self.gaps().iter().map(|(at, length)| format!("{at:.1}s+{length:.1}s")).collect();
        format!("delivered={} seconds={:.2} mbps_per_second=[{}] longest_gaps=[{}]", self.delivered, self.started.elapsed().as_secs_f64(), rates.join(" "), gaps.join(" "))
    }
}

fn describe(connection: &SecureConnection<Crypto>) -> String {
    let security = connection.security_stats();
    let stats = connection.stats();
    format!(
        "path_challenges={} migrations={} path_failures={} silence_pings={} srtt_us={} bandwidth_mbps={:.1} retransmitted={} timeouts={} packets_sent={} packets_received={}",
        security.path_challenges,
        security.migrations,
        security.path_failures,
        security.silence_pings,
        stats.srtt_us,
        stats.bandwidth as f64 * 8.0 / 1e6,
        stats.retransmitted_segments,
        stats.timeout_losses,
        stats.packets_sent,
        stats.packets_received,
    )
}

/// 一条连接要传的数据：这一端发多少、收多少。
struct Transfer {
    to_send: u64,
    /// 最多写到这么多字节，限速时随时间放开。
    allowed: u64,
    sent: u64,
    to_receive: u64,
    timeline: Timeline,
    error: Option<String>,
}

impl Transfer {
    fn new(to_send: u64, to_receive: u64) -> Self {
        Self { to_send, allowed: u64::MAX, sent: 0, to_receive, timeline: Timeline::new(), error: None }
    }

    fn pump(&mut self, now: u64, connection: &mut SecureConnection<Crypto>) {
        let mut chunk = [0u8; 16 * 1024];
        while self.sent < self.to_send.min(self.allowed) {
            let size = chunk.len().min((self.to_send.min(self.allowed) - self.sent) as usize);
            for (offset, byte) in chunk[..size].iter_mut().enumerate() {
                *byte = pattern(self.sent + offset as u64);
            }
            let accepted = connection.send(now, &chunk[..size]);
            self.sent += accepted as u64;
            if accepted < size {
                break;
            }
        }
        loop {
            let size = connection.recv(now, &mut chunk);
            if size == 0 {
                break;
            }
            let start = self.timeline.delivered;
            if self.error.is_none() && chunk[..size].iter().enumerate().any(|(offset, &byte)| byte != pattern(start + offset as u64)) {
                self.error = Some(format!("corrupted data near byte {start}"));
            }
            self.timeline.add(size);
        }
    }

    fn done(&self, connection: &SecureConnection<Crypto>) -> bool {
        self.sent == self.to_send && self.timeline.delivered >= self.to_receive && !connection.connection().has_unacked_data()
    }
}

fn argument<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments.iter().position(|argument| argument == name).and_then(|index| arguments.get(index + 1)).map(String::as_str)
}

fn serve(arguments: &[String]) {
    let bind: SocketAddr = argument(arguments, "--bind").unwrap_or("0.0.0.0:47812").parse().expect("--bind");
    let seconds: u64 = argument(arguments, "--seconds").unwrap_or("600").parse().expect("--seconds");
    let mut endpoint = Endpoint::<Crypto>::bind(bind, PACKET).expect("bind");
    let identity = server_identity();
    endpoint.listen(PROLOGUE, config(), b"", move || Crypto::from_secret(identity, clock_seed()).unchecked(), |incoming, from| {
        println!("handshake from {from}: {}", String::from_utf8_lossy(incoming.payload()));
        true
    });
    println!("listening on {}", endpoint.local_addr().expect("local address"));
    let started = Instant::now();
    let mut sessions: Vec<(u32, Transfer, Option<SocketAddr>, Option<Instant>)> = Vec::new();
    while started.elapsed().as_secs() < seconds {
        if let Err(error) = endpoint.poll(Duration::from_millis(5)) {
            println!("poll error: {error}");
        }
        while let Some(id) = endpoint.accept() {
            let request = endpoint.connection(id).and_then(SecureConnection::remote_payload).map(|payload| String::from_utf8_lossy(payload).into_owned()).unwrap_or_default();
            let mut words = request.split_whitespace();
            let (direction, bytes) = (words.next().unwrap_or(""), words.next().and_then(|word| word.parse().ok()).unwrap_or(0));
            let transfer = if direction == "down" { Transfer::new(bytes, 0) } else { Transfer::new(0, bytes) };
            println!("accepted {id:08x} from {:?}: {request}", endpoint.peer_addr(id));
            sessions.push((id, transfer, endpoint.peer_addr(id), None));
        }
        let now = endpoint.now_us();
        sessions.retain_mut(|(id, transfer, peer, finished)| {
            let current = endpoint.peer_addr(*id);
            let Some(connection) = endpoint.connection_mut(*id) else { return false };
            transfer.pump(now, connection);
            if current != *peer {
                println!("{id:08x} peer moved {peer:?} -> {current:?} at {:.2}s: {}", transfer.timeline.started.elapsed().as_secs_f64(), describe(connection));
                *peer = current;
            }
            if connection.is_dead() {
                println!("{id:08x} dead: {} {} error={:?}", transfer.timeline.report(), describe(connection), transfer.error);
                endpoint.close(*id);
                return false;
            }
            if finished.is_none() && transfer.done(connection) {
                println!("{id:08x} done: {} {} error={:?}", transfer.timeline.report(), describe(connection), transfer.error);
                *finished = Some(Instant::now());
            }
            // 传完以后再留一会，让最后的确认发出去。
            if finished.is_some_and(|at| at.elapsed() > Duration::from_secs(3)) {
                endpoint.close(*id);
                return false;
            }
            true
        });
    }
    println!("server stats: {:?}", endpoint.stats());
}

fn client(arguments: &[String]) {
    let server: SocketAddr = argument(arguments, "--server").expect("--server").to_socket_addrs().expect("resolve").next().expect("address");
    let direction = argument(arguments, "--direction").unwrap_or("down");
    let bytes: u64 = argument(arguments, "--bytes").unwrap_or("50000000").parse().expect("--bytes");
    let notice = argument(arguments, "--notice").unwrap_or("no") == "yes";
    let limit: u64 = argument(arguments, "--timeout").unwrap_or("180").parse().expect("--timeout");
    let rate_mbit: Option<f64> = argument(arguments, "--rate-mbit").map(|value| value.parse().expect("--rate-mbit"));
    let mut rebinds: Vec<f64> = argument(arguments, "--rebind-at").map(|list| list.split(',').filter_map(|value| value.parse().ok()).collect()).unwrap_or_default();
    rebinds.sort_by(f64::total_cmp);
    let mut endpoint = Endpoint::<Crypto>::bind("0.0.0.0:0".parse().expect("bind address"), PACKET).expect("bind");
    let server_public = Crypto::from_secret(server_identity(), 0).public();
    let request = format!("{direction} {bytes}");
    let id = endpoint.connect(Crypto::from_seed(clock_seed()).unchecked(), config(), PROLOGUE, &server_public, request.as_bytes(), server).expect("connect");
    let mut transfer = if direction == "down" { Transfer::new(0, bytes) } else { Transfer::new(bytes, 0) };
    println!("client {} -> {server}: {request}, notice={notice}, rebind at {rebinds:?}, rate {rate_mbit:?} Mbit/s", endpoint.local_addr().expect("local address"));
    let started = Instant::now();
    let mut established: Option<Instant> = None;
    let mut next_report = 1.0;
    loop {
        if let Err(error) = endpoint.poll(Duration::from_millis(5)) {
            println!("poll error: {error}");
        }
        let now = endpoint.now_us();
        let Some(connection) = endpoint.connection_mut(id) else { break };
        if established.is_none() && connection.is_established() {
            established = Some(Instant::now());
            transfer.timeline = Timeline::new();
            println!("established after {:.3}s", started.elapsed().as_secs_f64());
        }
        let elapsed = established.map_or(0.0, |at| at.elapsed().as_secs_f64());
        if let Some(rate) = rate_mbit {
            transfer.allowed = (elapsed * rate * 1e6 / 8.0) as u64;
        }
        transfer.pump(now, connection);
        if established.is_some() && elapsed >= next_report {
            next_report += 1.0;
            println!("t={elapsed:.1}s sent={} received={} {}", transfer.sent, transfer.timeline.delivered, describe(connection));
        }
        if connection.is_dead() {
            println!("dead: {} {} error={:?}", transfer.timeline.report(), describe(connection), transfer.error);
            break;
        }
        if transfer.done(connection) {
            println!("done: {} {} error={:?}", transfer.timeline.report(), describe(connection), transfer.error);
            break;
        }
        if rebinds.first().is_some_and(|&at| established.is_some() && elapsed >= at) {
            rebinds.remove(0);
            let before = endpoint.local_addr().expect("local address");
            endpoint.rebind("0.0.0.0:0".parse().expect("bind address"), notice).expect("rebind");
            println!("rebound at {elapsed:.2}s: {before} -> {}", endpoint.local_addr().expect("local address"));
        }
        if started.elapsed().as_secs() > limit {
            println!("timeout: {} error={:?}", transfer.timeline.report(), transfer.error);
            break;
        }
    }
    // 留一会让最后的确认发出去。
    let linger = Instant::now();
    while linger.elapsed() < Duration::from_secs(1) {
        let _ = endpoint.poll(Duration::from_millis(5));
    }
    println!("client stats: {:?}", endpoint.stats());
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    match arguments.get(1).map(String::as_str) {
        Some("server") => serve(&arguments),
        Some("client") => client(&arguments),
        _ => eprintln!("usage: migrate server --bind 0.0.0.0:47812 | migrate client --server host:47812 --direction up|down --bytes N --rebind-at 4,8 --notice yes|no --rate-mbit 10"),
    }
}
