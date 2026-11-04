//! 真实 UDP 和真实时钟下的性能测试，只用于测试，不进入产品。流量是合成数据，也没有加密。
//!
//! 本机：`netperf local --filter 丢包 --seconds 20`，回环 UDP 中间过一个按模拟器参数加损伤的代理。
//! 公网：服务器 `netperf server --bind 0.0.0.0:47811 --peer 客户端公网地址`，
//! 客户端 `netperf client --bind 0.0.0.0:本地端口 --server 服务器地址`。
//! 云安全组通常挡入站 UDP，所以服务器先往客户端的公网映射发包打洞。

use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::net::{SocketAddr, UdpSocket};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use agent_net_core::{Config, RecoveryPolicy};
use agent_net_sim::kcp::{KcpPeer, KcpVariant};
use agent_net_sim::{CorePeer, Link, LinkProfile, Peer, scenarios};

const MAX_DATAGRAM: usize = 2048;
const BUFFER_BYTES: i32 = 8 << 20;
const CONTROL_RUN: u32 = 0;
const KIND_START: u8 = 1;
const KIND_STARTED: u8 = 2;
const KIND_DONE: u8 = 3;
const KIND_PUNCH: u8 = 4;
const KIND_BYE: u8 = 5;
const KIND_FINISH: u8 = 6;
const MODE_UPLOAD: u8 = 0;
const MODE_DOWNLOAD: u8 = 1;
const MODE_ECHO: u8 = 2;
const ECHO_BYTES: usize = 200;
const ECHO_INTERVAL_US: u64 = 20_000;

/// 仅测试宿主读取环境变量；传输核心不依赖进程环境。
fn recovery_policy() -> RecoveryPolicy {
    match std::env::var("AGENT_NET_POLICY").as_deref() {
        Ok("lean") => RecoveryPolicy::Lean,
        Ok("fast") => RecoveryPolicy::Fast,
        Ok("auto") | Err(std::env::VarError::NotPresent) => RecoveryPolicy::Auto,
        value => panic!("invalid AGENT_NET_POLICY {value:?}; expected auto, lean or fast"),
    }
}

mod sys {
    use std::ffi::{c_int, c_short, c_void};

    #[repr(C)]
    pub struct PollFd {
        pub fd: c_int,
        pub events: c_short,
        pub revents: c_short,
    }

    #[cfg(target_os = "linux")]
    pub type PollCount = u64;
    #[cfg(not(target_os = "linux"))]
    pub type PollCount = u32;

    unsafe extern "C" {
        pub fn poll(fds: *mut PollFd, count: PollCount, timeout_ms: c_int) -> c_int;
        pub fn setsockopt(fd: c_int, level: c_int, name: c_int, value: *const c_void, size: u32) -> c_int;
    }

    pub const POLLIN: c_short = 1;

    #[cfg(target_os = "linux")]
    pub const SOCKET_LEVEL: c_int = 1;
    #[cfg(target_os = "linux")]
    // SO_SNDBUFFORCE、SO_RCVBUFFORCE：只影响这个 socket，不用改系统的 rmem_max。
    pub const BUFFER_OPTIONS: [c_int; 2] = [32, 33];
    #[cfg(not(target_os = "linux"))]
    pub const SOCKET_LEVEL: c_int = 0xffff;
    #[cfg(not(target_os = "linux"))]
    pub const BUFFER_OPTIONS: [c_int; 2] = [0x1001, 0x1002];
}

fn clock() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

fn open_socket(bind: &str) -> UdpSocket {
    let socket = UdpSocket::bind(bind).expect("bind");
    socket.set_nonblocking(true).expect("nonblocking");
    for option in sys::BUFFER_OPTIONS {
        // SAFETY: fd 有效，value 在调用期间存活，长度与类型一致。
        let result = unsafe {
            sys::setsockopt(socket.as_raw_fd(), sys::SOCKET_LEVEL, option, (&BUFFER_BYTES as *const i32).cast(), 4)
        };
        if result != 0 {
            eprintln!("setsockopt {option} failed: {}", std::io::Error::last_os_error());
        }
    }
    socket
}

/// 等到 socket 可读或超时。系统定时器只有毫秒精度，这正是产品里会遇到的情况。
fn wait_readable(socket: &UdpSocket, timeout_us: u64) {
    let mut poll_fd = sys::PollFd { fd: socket.as_raw_fd(), events: sys::POLLIN, revents: 0 };
    let timeout_ms = timeout_us.div_ceil(1000).min(1000) as i32;
    // SAFETY: poll_fd 在调用期间存活，数量为 1。
    unsafe { sys::poll(&mut poll_fd, 1, timeout_ms) };
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Protocol {
    AgentNet,
    KcpFast,
    KcpFlush,
    KcpTunedFec,
    KcpHeavyFec,
}

impl Protocol {
    fn code(self) -> u8 {
        self as u8
    }

    fn from_code(code: u8) -> Self {
        [Self::AgentNet, Self::KcpFast, Self::KcpFlush, Self::KcpTunedFec, Self::KcpHeavyFec][code as usize]
    }

    fn name(self) -> &'static str {
        ["agent-net", "KCP 快速", "KCP 冲刷", "调优+FEC", "极速+FEC5/5"][self as usize]
    }

    fn make(self, window: u32) -> Box<dyn Peer> {
        match self {
            Self::AgentNet => {
                let config = Config { send_window: window, recv_window: window, send_buffer_bytes: 8 << 20, ..Config::for_policy(recovery_policy()) };
                let mut peer = CorePeer::new(config);
                peer.check_invariants = false;
                Box::new(peer)
            }
            Self::KcpFast => Box::new(KcpPeer::with_window(false, window as i32)),
            Self::KcpFlush => Box::new(KcpPeer::with_window(true, window as i32)),
            Self::KcpTunedFec => Box::new(KcpPeer::variant(KcpVariant::TUNED_FEC, window as i32)),
            Self::KcpHeavyFec => Box::new(KcpPeer::variant(KcpVariant::TURBO_HEAVY_FEC, window as i32)),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Plan {
    run: u32,
    protocol: Protocol,
    window: u32,
    bytes: u64,
    mode: u8,
}

impl Plan {
    fn encode(&self) -> [u8; 19] {
        let mut out = [0u8; 19];
        out[..4].copy_from_slice(&self.run.to_be_bytes());
        out[4] = self.protocol.code();
        out[5..9].copy_from_slice(&self.window.to_be_bytes());
        out[9..17].copy_from_slice(&self.bytes.to_be_bytes());
        out[17] = self.mode;
        out
    }

    fn decode(data: &[u8]) -> Self {
        Self {
            run: u32::from_be_bytes(data[..4].try_into().unwrap()),
            protocol: Protocol::from_code(data[4]),
            window: u32::from_be_bytes(data[5..9].try_into().unwrap()),
            bytes: u64::from_be_bytes(data[9..17].try_into().unwrap()),
            mode: data[17],
        }
    }
}

fn send_control(socket: &UdpSocket, peer: SocketAddr, kind: u8, body: &[u8]) {
    let mut out = Vec::with_capacity(5 + body.len());
    out.extend_from_slice(&CONTROL_RUN.to_be_bytes());
    out.push(kind);
    out.extend_from_slice(body);
    let _ = socket.send_to(&out, peer);
}

/// 一次测试里一端的状态。外层只负责把包喂进来，节奏全由核心决定。
struct Session {
    run: u32,
    peer: Box<dyn Peer>,
    remote: SocketAddr,
    wire_bytes: u64,
    packets: u64,
    send_failures: u64,
    outgoing: Vec<u8>,
}

impl Session {
    fn new(plan: &Plan, remote: SocketAddr) -> Self {
        Self { run: plan.run, peer: plan.protocol.make(plan.window), remote, wire_bytes: 0, packets: 0, send_failures: 0, outgoing: Vec::with_capacity(MAX_DATAGRAM) }
    }

    fn input(&mut self, now: u64, data: &[u8]) {
        self.peer.input(now, data);
    }

    fn flush(&mut self, socket: &UdpSocket, now: u64) {
        if self.peer.wake_at().is_some_and(|at| at <= now) {
            self.peer.on_wake(now);
        }
        let (run, remote) = (self.run, self.remote);
        let (outgoing, wire, packets, failures) = (&mut self.outgoing, &mut self.wire_bytes, &mut self.packets, &mut self.send_failures);
        self.peer.pump(now, &mut |packet| {
            outgoing.clear();
            outgoing.extend_from_slice(&run.to_be_bytes());
            outgoing.extend_from_slice(packet);
            *wire += packet.len() as u64;
            *packets += 1;
            if socket.send_to(outgoing, remote).is_err() {
                *failures += 1;
            }
        });
    }

    fn wait_us(&self, now: u64) -> u64 {
        self.peer.wake_at().map_or(5_000, |at| at.saturating_sub(now).min(5_000))
    }
}

/// 把批量数据源源不断写进连接，写满就下次再来。
fn fill(peer: &mut dyn Peer, now: u64, written: &mut u64, total: u64) {
    static CHUNK: [u8; 16 * 1024] = [0x5A; 16 * 1024];
    while *written < total {
        let size = CHUNK.len().min((total - *written) as usize);
        let accepted = peer.write(now, &CHUNK[..size]);
        *written += accepted as u64;
        if accepted == 0 {
            break;
        }
    }
}

fn serve(socket: UdpSocket, first_peer: Option<SocketAddr>, stop: Arc<AtomicBool>) {
    let mut remote = first_peer;
    let mut buffer = [0u8; MAX_DATAGRAM];
    let mut sink = vec![0u8; 256 * 1024];
    let mut session: Option<(Session, Plan, u64, u64)> = None;
    let mut done: Option<([u8; 28], u64)> = None;
    let mut last_punch = 0u64;
    let mut seen_client = false;
    let mut finish_requested = false;
    while !stop.load(Ordering::Relaxed) {
        let now = clock();
        if !seen_client
            && now >= last_punch + 50_000
            && let Some(target) = remote
        {
            last_punch = now;
            send_control(&socket, target, KIND_PUNCH, &[]);
        }
        loop {
            let Ok((size, from)) = socket.recv_from(&mut buffer) else { break };
            seen_client = true;
            if size < 4 {
                continue;
            }
            let run = u32::from_be_bytes(buffer[..4].try_into().unwrap());
            if run == CONTROL_RUN {
                match buffer[4] {
                    KIND_START => {
                        let plan = Plan::decode(&buffer[5..size]);
                        remote = Some(from);
                        if session.as_ref().is_none_or(|(_, current, ..)| current.run != plan.run) && done.is_none_or(|(body, _)| u32::from_be_bytes(body[..4].try_into().unwrap()) != plan.run) {
                            session = Some((Session::new(&plan, from), plan, 0, 0));
                            done = None;
                        }
                        send_control(&socket, from, KIND_STARTED, &plan.run.to_be_bytes());
                    }
                    KIND_BYE => return,
                    KIND_FINISH => finish_requested = true,
                    _ => {}
                }
            } else if let Some((current, ..)) = session.as_mut()
                && current.run == run
            {
                current.input(clock(), &buffer[4..size]);
            }
        }

        let now = clock();
        let mut finished = core::mem::take(&mut finish_requested);
        if let Some((current, plan, written, received)) = session.as_mut() {
            match plan.mode {
                MODE_DOWNLOAD => fill(current.peer.as_mut(), now, written, plan.bytes),
                MODE_UPLOAD => loop {
                    let size = current.peer.read(now, &mut sink);
                    if size == 0 {
                        break;
                    }
                    *received += size as u64;
                },
                _ => loop {
                    let size = current.peer.read(now, &mut sink);
                    if size == 0 {
                        break;
                    }
                    let mut offset = 0;
                    while offset < size {
                        let accepted = current.peer.write(now, &sink[offset..size]);
                        offset += accepted;
                        if accepted == 0 {
                            break;
                        }
                    }
                },
            }
            current.flush(&socket, now);
            if plan.mode == MODE_UPLOAD && *received >= plan.bytes {
                finished = true;
            }
        }
        if finished && let Some((current, plan, ..)) = session.take() {
            println!("服务器 run={} {:?} 窗口{} 模式{} 发出 {} 包 {} 字节 {}", plan.run, plan.protocol, plan.window, plan.mode, current.packets, current.wire_bytes, current.peer.describe());
            let mut body = [0u8; 28];
            body[..4].copy_from_slice(&plan.run.to_be_bytes());
            body[4..12].copy_from_slice(&current.wire_bytes.to_be_bytes());
            body[12..20].copy_from_slice(&current.packets.to_be_bytes());
            body[20..28].copy_from_slice(&current.send_failures.to_be_bytes());
            done = Some((body, 0));
        }
        if let Some((body, last)) = done.as_mut()
            && clock() >= *last + 20_000
            && let Some(target) = remote
        {
            *last = clock();
            send_control(&socket, target, KIND_DONE, &body[..]);
        }
        let wait = session.as_ref().map_or(2_000, |(current, ..)| current.wait_us(clock()));
        if wait > 0 {
            wait_readable(&socket, wait);
        }
    }
}

struct Report {
    seconds: f64,
    wire_bytes: u64,
    send_failures: u64,
    latencies_us: Vec<u64>,
    finished: bool,
    detail: String,
}

fn run_client(socket: &UdpSocket, server: SocketAddr, plan: Plan, limit_us: u64) -> Report {
    let mut buffer = [0u8; MAX_DATAGRAM];
    let mut sink = vec![0u8; 256 * 1024];
    let mut started_at = None;
    let mut session = Session::new(&plan, server);
    let mut last_start = 0u64;
    let begin = clock();
    let (mut written, mut received) = (0u64, 0u64);
    let mut server_stats = None;
    let messages = (plan.bytes / ECHO_BYTES as u64) as usize;
    let mut sent_at = Vec::with_capacity(messages);
    let mut latencies = Vec::with_capacity(messages);
    let message = [0x33u8; ECHO_BYTES];
    loop {
        let now = clock();
        if now - begin > limit_us {
            return Report { seconds: (now - begin) as f64 / 1e6, wire_bytes: session.wire_bytes, send_failures: session.send_failures, latencies_us: latencies, finished: false, detail: session.peer.describe() };
        }
        if started_at.is_none() && now >= last_start + 100_000 {
            last_start = now;
            let mut body = [0u8; 19];
            body.copy_from_slice(&plan.encode());
            send_control(socket, server, KIND_START, &body[..18]);
        }
        loop {
            let Ok((size, _)) = socket.recv_from(&mut buffer) else { break };
            if size < 4 {
                continue;
            }
            let run = u32::from_be_bytes(buffer[..4].try_into().unwrap());
            if run == CONTROL_RUN {
                if buffer[4] == KIND_STARTED && size >= 9 && u32::from_be_bytes(buffer[5..9].try_into().unwrap()) == plan.run {
                    started_at.get_or_insert(clock());
                }
                if buffer[4] == KIND_DONE && size >= 33 && u32::from_be_bytes(buffer[5..9].try_into().unwrap()) == plan.run {
                    let wire = u64::from_be_bytes(buffer[9..17].try_into().unwrap());
                    let failures = u64::from_be_bytes(buffer[25..33].try_into().unwrap());
                    server_stats = Some((wire, failures));
                }
            } else if run == plan.run {
                session.input(clock(), &buffer[4..size]);
            }
        }
        let now = clock();
        if let Some(start) = started_at {
            match plan.mode {
                MODE_UPLOAD => fill(session.peer.as_mut(), now, &mut written, plan.bytes),
                MODE_DOWNLOAD => loop {
                    let size = session.peer.read(now, &mut sink);
                    if size == 0 {
                        break;
                    }
                    received += size as u64;
                },
                _ => {
                    while sent_at.len() < messages && now >= start + sent_at.len() as u64 * ECHO_INTERVAL_US {
                        session.peer.write(now, &message);
                        sent_at.push(now);
                    }
                    loop {
                        let size = session.peer.read(now, &mut sink);
                        if size == 0 {
                            break;
                        }
                        received += size as u64;
                        while (latencies.len() + 1) * ECHO_BYTES <= received as usize {
                            let index = latencies.len();
                            latencies.push(clock() - sent_at[index]);
                        }
                    }
                }
            }
            session.flush(socket, now);
            let done = match plan.mode {
                MODE_UPLOAD => server_stats.is_some(),
                MODE_DOWNLOAD => received >= plan.bytes,
                _ => latencies.len() == messages,
            };
            if done {
                let seconds = (clock() - start) as f64 / 1e6;
                // 下载和交互由客户端先结束，要问服务器发了多少字节才算得出开销。
                let asked_at = clock();
                let mut last_ask = 0;
                while server_stats.is_none() && clock() - asked_at < 2_000_000 {
                    if clock() >= last_ask + 50_000 {
                        last_ask = clock();
                        send_control(socket, server, KIND_FINISH, &[]);
                    }
                    wait_readable(socket, 10_000);
                    while let Ok((size, _)) = socket.recv_from(&mut buffer) {
                        if size >= 33 && buffer[..4] == CONTROL_RUN.to_be_bytes() && buffer[4] == KIND_DONE && u32::from_be_bytes(buffer[5..9].try_into().unwrap()) == plan.run {
                            let wire = u64::from_be_bytes(buffer[9..17].try_into().unwrap());
                            let failures = u64::from_be_bytes(buffer[25..33].try_into().unwrap());
                            server_stats = Some((wire, failures));
                        }
                    }
                }
                return Report { seconds, wire_bytes: session.wire_bytes + server_stats.map_or(0, |(wire, _)| wire), send_failures: session.send_failures + server_stats.map_or(0, |(_, failures)| failures), latencies_us: latencies, finished: true, detail: session.peer.describe() };
            }
        }
        let wait = session.wait_us(clock()).min(if started_at.is_some() && plan.mode == MODE_ECHO { 1_000 } else { 5_000 });
        if wait > 0 {
            wait_readable(socket, wait);
        }
    }
}

fn percentile(values: &[u64], percentile: f64) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let index = ((percentile / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[index.clamp(1, sorted.len()) - 1] as f64 / 1000.0
}

/// 模拟器的链路模型放到真实时钟上：两个 socket 之间按 `Link` 算出的时间转发。
fn impair(front: UdpSocket, back: UdpSocket, client: Arc<OnceLock<SocketAddr>>, server: SocketAddr, link: (LinkProfile, LinkProfile), stop: Arc<AtomicBool>) {
    let mut up = Link::new(link.0, 1);
    let mut down = Link::new(link.1, 2);
    let mut pending: BinaryHeap<Reverse<(u64, u64, bool, Vec<u8>)>> = BinaryHeap::new();
    let mut buffer = [0u8; MAX_DATAGRAM];
    let mut order = 0u64;
    while !stop.load(Ordering::Relaxed) {
        let now = clock();
        while let Ok((size, from)) = front.recv_from(&mut buffer) {
            let _ = client.set(from);
            let (arrivals, count) = up.transmit(now, size);
            for &arrival in &arrivals[..count] {
                order += 1;
                pending.push(Reverse((arrival, order, true, buffer[..size].to_vec())));
            }
        }
        while let Ok((size, _)) = back.recv_from(&mut buffer) {
            let (arrivals, count) = down.transmit(now, size);
            for &arrival in &arrivals[..count] {
                order += 1;
                pending.push(Reverse((arrival, order, false, buffer[..size].to_vec())));
            }
        }
        while pending.peek().is_some_and(|Reverse(item)| item.0 <= clock()) {
            let Some(Reverse((_, _, to_server, data))) = pending.pop() else { break };
            if to_server {
                let _ = back.send_to(&data, server);
            } else if let Some(&target) = client.get() {
                let _ = front.send_to(&data, target);
            }
        }
        std::hint::spin_loop();
    }
}

struct Args(Vec<String>);

impl Args {
    fn value(&self, name: &str) -> Option<String> {
        self.0.iter().position(|arg| arg == name).and_then(|index| self.0.get(index + 1)).cloned()
    }
    fn number(&self, name: &str, default: u64) -> u64 {
        self.value(name).and_then(|value| value.parse().ok()).unwrap_or(default)
    }
}

#[derive(Default)]
struct Tally {
    seconds: Vec<f64>,
    wire: u64,
    failures: u64,
    latencies: Vec<u64>,
    unfinished: u32,
    detail: String,
}

/// 每一轮里各协议轮流跑一次：公网状况几分钟内就会变，依次测完一种再测下一种，会把波动算到某一方头上。
fn run_matrix(socket: &UdpSocket, server: SocketAddr, label: &str, args: &Args, next_run: &mut u32) {
    let mib = args.number("--mib", 8);
    let rounds = args.number("--rounds", 3);
    let limit_us = args.number("--limit", 60) * 1_000_000;
    let windows: Vec<u32> = args.value("--windows").unwrap_or("128,1024".into()).split(',').map(|value| value.parse().unwrap()).collect();
    let protocols = [Protocol::AgentNet, Protocol::KcpFast, Protocol::KcpFlush, Protocol::KcpTunedFec, Protocol::KcpHeavyFec];
    let modes: Vec<u8> = args.value("--modes").unwrap_or("0,1,2".into()).split(',').map(|value| value.parse().unwrap()).collect();
    for &window in &windows {
        for &mode in &modes {
            let name = ["上传", "下载", "交互"][mode as usize];
            let mut tallies: [Tally; 5] = Default::default();
            for round in 0..rounds as usize {
                for offset in 0..protocols.len() {
                    // 每轮换一个起点，谁都不会总排在前面。
                    let index = (round + offset) % protocols.len();
                    *next_run += 1;
                    let bytes = if mode == MODE_ECHO { 500 * ECHO_BYTES as u64 } else { mib << 20 };
                    let plan = Plan { run: *next_run, protocol: protocols[index], window, bytes, mode };
                    let report = run_client(socket, server, plan, limit_us);
                    let tally = &mut tallies[index];
                    if report.finished {
                        tally.seconds.push(report.seconds);
                        tally.wire += report.wire_bytes;
                    } else {
                        tally.unfinished += 1;
                    }
                    tally.failures += report.send_failures;
                    tally.latencies.extend(report.latencies_us);
                    tally.detail = report.detail;
                    // 让上一轮残留的队列排空，不影响下一轮。
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
            }
            for (protocol, tally) in protocols.iter().zip(&tallies) {
                let average = tally.seconds.iter().sum::<f64>() / tally.seconds.len().max(1) as f64;
                let payload = mib << 20;
                let overhead = if mode == MODE_ECHO || tally.seconds.is_empty() { f64::NAN } else { (tally.wire as f64 / tally.seconds.len() as f64 / payload as f64 - 1.0) * 100.0 };
                let spread = tally.seconds.iter().fold((f64::MAX, 0f64), |(low, high), &value| (low.min(value), high.max(value)));
                println!(
                    "{label} 窗口{window} {name} {:<10} 用时 {average:7.2}s [{:.2}-{:.2}] 开销 {overhead:6.1}% p50 {:7.1} p95 {:7.1} p99 {:7.1}ms 未完成 {} 发送失败 {}",
                    protocol.name(), spread.0, spread.1, percentile(&tally.latencies, 50.0), percentile(&tally.latencies, 95.0), percentile(&tally.latencies, 99.0), tally.unfinished, tally.failures,
                );
                if std::env::var_os("NETPERF_DETAIL").is_some() {
                    println!("    {}", tally.detail);
                }
            }
        }
    }
}

fn main() {
    println!("agent-net 策略 {:?}", recovery_policy());
    let args = Args(std::env::args().collect());
    clock();
    let command = args.0.get(1).cloned().unwrap_or_default();
    match command.as_str() {
        "server" => {
            let socket = open_socket(&args.value("--bind").expect("--bind"));
            let peer = args.value("--peer").map(|value| value.parse().expect("--peer"));
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let limit = args.number("--limit", 3600);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(limit));
                flag.store(true, Ordering::Relaxed);
            });
            serve(socket, peer, stop);
        }
        "client" => {
            let socket = open_socket(&args.value("--bind").unwrap_or("0.0.0.0:0".into()));
            let server: SocketAddr = args.value("--server").expect("--server").parse().expect("--server");
            let begin = clock();
            let mut buffer = [0u8; MAX_DATAGRAM];
            // 服务器的打洞包到了才算路径通。
            loop {
                let _ = socket.send_to(&[0u8; 5], server);
                if socket.recv_from(&mut buffer).is_ok() {
                    break;
                }
                assert!(clock() - begin < 30_000_000, "path never opened");
                wait_readable(&socket, 100_000);
            }
            println!("路径已打通，用时 {} ms", (clock() - begin) / 1000);
            let mut next_run = 1;
            run_matrix(&socket, server, &args.value("--label").unwrap_or("公网".into()), &args, &mut next_run);
            for _ in 0..5 {
                send_control(&socket, server, KIND_BYE, &[]);
            }
        }
        "local" => {
            let filter = args.value("--filter").unwrap_or_default();
            let mut next_run = 1;
            for scenario in scenarios().into_iter().filter(|scenario| !scenario.holdout && scenario.label.contains(&filter)) {
                let server_socket = open_socket("127.0.0.1:0");
                let server_addr = server_socket.local_addr().expect("addr");
                let front = open_socket("127.0.0.1:0");
                let back = open_socket("127.0.0.1:0");
                let front_addr = front.local_addr().expect("addr");
                let client = open_socket("127.0.0.1:0");
                let stop = Arc::new(AtomicBool::new(false));
                let peer = Arc::new(OnceLock::new());
                let (serve_stop, proxy_stop) = (stop.clone(), stop.clone());
                let link = (scenario.link.clone(), scenario.back.clone());
                let proxy = std::thread::spawn(move || impair(front, back, peer, server_addr, link, proxy_stop));
                let server = std::thread::spawn(move || serve(server_socket, None, serve_stop));
                run_matrix(&client, front_addr, scenario.label, &args, &mut next_run);
                stop.store(true, Ordering::Relaxed);
                let _ = server.join();
                let _ = proxy.join();
            }
        }
        _ => eprintln!("用法见文件头"),
    }
}
