//! 真实 UDP 和真实时钟下，大量数据和交互消息一起走时的延迟，只用于测试，不进入产品。流量是合成数据，也没有加密。
//!
//! 服务器：`muxperf server --bind 0.0.0.0:47812 --peer 客户端公网地址`
//! 客户端：`muxperf client --bind 0.0.0.0:本地端口 --server 服务器地址 --rounds 3 --seconds 15`
//!
//! 比三种情况：只有交互消息、消息和文件走两条连接、消息和文件走一条连接的两条流。三种轮流跑，避免公网波动算到某一方头上。
//! 延迟是消息的往返时间。两条连接共用一个 socket，靠包头第二个字节区分：路径和两个 socket 一样，也不用多打一次洞。

use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use agent_net_core::{BandwidthShare, Config, Connection, Priority, RecoveryPolicy};

const CONTROL: u8 = 0xFF;
const REPLY: u8 = 0xFE;
const BYE: u8 = 0xFD;
const CHAT: u32 = 1;
const FILE: u32 = 2;
const MESSAGE_BYTES: usize = 200;
const MESSAGE_INTERVAL_US: u64 = 20_000;
/// 默认比前三种。`只有文件` 和 TCP 同跑时用，见 `sim/share-public.py`。
const MODES: [(&str, u8); 4] = [("只有交互", 0), ("两条连接", 1), ("多路流", 2), ("只有文件", 3)];
const DIRECTIONS: [(&str, u8); 2] = [("上传", 0), ("下载", 1)];

/// 这一轮的两条连接。只用一条时另一条闲着。
struct Run {
    number: u8,
    mode: u8,
    direction: u8,
    connections: [Connection; 2],
}

impl Run {
    fn new(number: u8, mode: u8, direction: u8) -> Self {
        let config = Config { max_packet_size: 1400, send_window: 1024, recv_window: 1024, send_buffer_bytes: 2 << 20, bandwidth_share: share_mode(), ..Config::for_policy(RecoveryPolicy::Auto) };
        let connections = [Connection::new(config.clone(), 0), Connection::new(config, 0)];
        let mut run = Self { number, mode, direction, connections };
        for connection in &mut run.connections {
            connection.open_stream(Priority::Interactive).expect("chat stream");
            connection.open_stream(Priority::Background).expect("file stream");
        }
        run
    }

    fn file_connection(&self) -> usize {
        (self.mode == 1) as usize
    }

    /// 文件由这一端发时，把发送缓冲写满。
    fn fill_file(&mut self, now: u64, is_client: bool, written: &mut u64) {
        if self.mode == 0 || (self.direction == 0) != is_client {
            return;
        }
        let chunk = [9u8; 4096];
        let index = self.file_connection();
        loop {
            let accepted = self.connections[index].send_stream(now, FILE, &chunk);
            *written += accepted as u64;
            if accepted < chunk.len() {
                return;
            }
        }
    }

    /// 读走一条流，返回字节数。
    fn drain(&mut self, now: u64, index: usize, stream: u32) -> usize {
        let mut buffer = [0u8; 8192];
        let mut total = 0;
        loop {
            let size = self.connections[index].recv_stream(now, stream, &mut buffer);
            if size == 0 {
                return total;
            }
            total += size;
        }
    }

    fn input(&mut self, now: u64, data: &[u8]) {
        if data.len() > 2 && data[0] == self.number && data[1] < 2 {
            let _ = self.connections[data[1] as usize].on_packet(now, &data[2..]);
        }
    }

    fn pump(&mut self, socket: &UdpSocket, remote: SocketAddr, now: u64) {
        let mut buffer = [0u8; 1402];
        for (index, connection) in self.connections.iter_mut().enumerate() {
            if connection.next_wake().is_some_and(|at| at <= now) {
                connection.tick(now);
            }
            buffer[0] = self.number;
            buffer[1] = index as u8;
            while let Some(size) = connection.poll_transmit(now, &mut buffer[2..]) {
                let _ = socket.send_to(&buffer[..size + 2], remote);
            }
            while connection.poll_event().is_some() {}
        }
    }
}

fn open_socket(bind: &str) -> UdpSocket {
    let socket = UdpSocket::bind(bind).expect("bind");
    socket.set_nonblocking(true).expect("nonblocking");
    socket
}

/// 把排队的包都读进来，没有包就睡一小会，这就是循环的节拍。
/// 不用 socket 的读超时：Linux 上它按系统时钟节拍取整，500 微秒会变成好几毫秒，发送节奏被工具自己拖慢。
fn receive(socket: &UdpSocket, mut handle: impl FnMut(&[u8], SocketAddr)) {
    let mut buffer = [0u8; 2048];
    let mut received = false;
    while let Ok((size, from)) = socket.recv_from(&mut buffer) {
        handle(&buffer[..size], from);
        received = true;
    }
    if !received {
        std::thread::sleep(Duration::from_micros(200));
    }
}

fn serve(socket: UdpSocket, peer: SocketAddr, limit_seconds: u64) {
    let started = Instant::now();
    let mut run: Option<Run> = None;
    let mut client = peer;
    let mut last_punch = 0;
    let mut written = 0;
    let mut next_trace = 0;
    while started.elapsed().as_secs() < limit_seconds {
        let now = started.elapsed().as_micros() as u64;
        let mut finished = false;
        receive(&socket, |data, from| {
            client = from;
            match data {
                [CONTROL, number, mode, direction] => {
                    if run.as_ref().is_none_or(|current| current.number != *number) {
                        if let Some(finished_run) = &run {
                            eprintln!("模式 {} 方向 {} 服务端 {:?}", finished_run.mode, finished_run.direction, finished_run.connections[finished_run.file_connection()].stats());
                        }
                        run = Some(Run::new(*number, *mode, *direction));
                    }
                    let _ = socket.send_to(&[REPLY, *number], from);
                }
                [BYE] => finished = true,
                [REPLY, _] => {}
                _ => {
                    if let Some(run) = &mut run {
                        run.input(now, data);
                    }
                }
            }
        });
        if finished {
            return;
        }
        if now >= last_punch + 100_000 && run.is_none() {
            last_punch = now;
            let _ = socket.send_to(&[REPLY, 0], client);
        }
        if let Some(run) = &mut run {
            if argument("--trace").is_some() && now >= next_trace {
                next_trace = now + 500_000;
                let stats = run.connections[run.file_connection()].stats();
                eprintln!("t={:.1} 带宽 {:.2}M 节奏 {:.2}M srtt {} min {} 重传 {} 判丢 {} 上限 {} 发 {}KB", now as f64 / 1e6, stats.bandwidth as f64 * 8e-6, stats.pacing_rate as f64 * 8e-6, stats.srtt_us / 1000, stats.min_rtt_us / 1000, stats.retransmitted_segments, stats.fast_losses + stats.timeout_losses, stats.rate_cap, stats.wire_bytes_sent / 1000);
            }
            for index in 0..2 {
                let echoed = run.drain(now, index, CHAT);
                if echoed > 0 {
                    run.connections[index].send_stream(now, CHAT, &vec![7u8; echoed]);
                }
                run.drain(now, index, FILE);
            }
            run.fill_file(now, false, &mut written);
            run.pump(&socket, client, now);
        }
    }
}

#[derive(Default)]
struct Result {
    delays: Vec<u64>,
    lost: usize,
    bits_per_second: f64,
}

fn run_once(socket: &UdpSocket, server: SocketAddr, number: u8, mode: u8, direction: u8, seconds: u64, result: &mut Result) {
    let hello = [CONTROL, number, mode, direction];
    let mut answered = false;
    for _ in 0..200 {
        let _ = socket.send_to(&hello, server);
        receive(socket, |data, _| answered |= data == [REPLY, number]);
        if answered {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(answered, "服务器没有回应");

    let started = Instant::now();
    let mut run = Run::new(number, mode, direction);
    let mut pending: VecDeque<u64> = VecDeque::new();
    let (mut sent, mut echoed, mut written, mut read) = (0u64, 0usize, 0u64, 0u64);
    let duration = seconds * 1_000_000;
    let mut slow_by_second = [0u32; 30];
    loop {
        let now = started.elapsed().as_micros() as u64;
        if now >= duration {
            break;
        }
        if mode != 3 && now >= sent * MESSAGE_INTERVAL_US {
            sent += 1;
            pending.push_back(now);
            assert_eq!(run.connections[0].send_stream(now, CHAT, &[7u8; MESSAGE_BYTES]), MESSAGE_BYTES);
        }
        run.fill_file(now, true, &mut written);
        receive(socket, |data, _| run.input(started.elapsed().as_micros() as u64, data));
        let now = started.elapsed().as_micros() as u64;
        echoed += run.drain(now, 0, CHAT);
        read += run.drain(now, run.file_connection(), FILE) as u64;
        while echoed >= MESSAGE_BYTES {
            echoed -= MESSAGE_BYTES;
            if let Some(at) = pending.pop_front() {
                result.delays.push(now - at);
                if now - at > 250_000 {
                    slow_by_second[((at / 1_000_000) as usize).min(29)] += 1;
                }
            }
        }
        run.pump(socket, server, now);
    }
    result.lost += pending.len();
    let delivered = if direction == 0 { written.saturating_sub(run.connections[run.file_connection()].buffered_bytes() as u64) } else { read };
    result.bits_per_second += delivered as f64 * 8.0 / seconds as f64;
    if argument("--verbose").is_some() {
        let mut sorted = result.delays.clone();
        sorted.sort_unstable();
        eprintln!("模式 {mode} 方向 {direction} 文件 {:.1} Mbit/s p50 {:.1} 每秒超 250ms 的消息 {:?} 本端 {:?}", delivered as f64 * 8.0 / seconds as f64 / 1e6, percentile(&sorted, 50.0), &slow_by_second[..seconds as usize], run.connections[run.file_connection()].stats());
    }
}

fn percentile(sorted: &[u64], percent: f64) -> f64 {
    sorted.get(((sorted.len() as f64 - 1.0) * percent / 100.0) as usize).map_or(f64::NAN, |&value| value as f64 / 1000.0)
}

/// `--fair` 换成让路模式；两端各管自己发的方向，所以服务器和客户端都要带。
fn share_mode() -> BandwidthShare {
    if std::env::args().any(|value| value == "--fair") { BandwidthShare::Fair } else { BandwidthShare::Full }
}

fn argument(name: &str) -> Option<String> {
    let arguments: Vec<String> = std::env::args().collect();
    arguments.iter().position(|value| value == name).and_then(|index| arguments.get(index + 1)).cloned()
}

fn main() {
    let command = std::env::args().nth(1).unwrap_or_default();
    match command.as_str() {
        "server" => {
            let socket = open_socket(&argument("--bind").expect("--bind"));
            let peer = argument("--peer").expect("--peer").parse().expect("--peer");
            serve(socket, peer, argument("--limit").map_or(3600, |value| value.parse().expect("--limit")));
        }
        "client" => {
            let socket = open_socket(&argument("--bind").unwrap_or("0.0.0.0:0".into()));
            let server: SocketAddr = argument("--server").expect("--server").parse().expect("--server");
            let rounds: u64 = argument("--rounds").map_or(3, |value| value.parse().expect("--rounds"));
            let seconds: u64 = argument("--seconds").map_or(15, |value| value.parse().expect("--seconds"));
            let wanted = |flag: &str, value: u8, default: bool| argument(flag).map_or(default, |list| list.split(',').any(|item| item.parse() == Ok(value)));
            let mut results: Vec<Result> = (0..MODES.len() * DIRECTIONS.len()).map(|_| Result::default()).collect();
            let mut number = 1u8;
            for _ in 0..rounds {
                for (direction_index, &(_, direction)) in DIRECTIONS.iter().enumerate() {
                    for (mode_index, &(_, mode)) in MODES.iter().enumerate() {
                        if !wanted("--directions", direction, true) || !wanted("--modes", mode, mode != 3) {
                            continue;
                        }
                        run_once(&socket, server, number, mode, direction, seconds, &mut results[direction_index * MODES.len() + mode_index]);
                        number = number % 200 + 1;
                    }
                }
            }
            let _ = socket.send_to(&[BYE], server);
            for (direction_index, &(direction, _)) in DIRECTIONS.iter().enumerate() {
                for (mode_index, &(mode, _)) in MODES.iter().enumerate() {
                    let result = &mut results[direction_index * MODES.len() + mode_index];
                    if result.delays.is_empty() && result.bits_per_second == 0.0 {
                        continue;
                    }
                    result.delays.sort_unstable();
                    let rate = result.bits_per_second / rounds as f64 / 1e6;
                    println!(
                        "{direction} {mode:<8} 往返 p50 {:7.1} p95 {:7.1} p99 {:7.1} ms  未回 {:3}  文件 {rate:6.1} Mbit/s",
                        percentile(&result.delays, 50.0),
                        percentile(&result.delays, 95.0),
                        percentile(&result.delays, 99.0),
                        result.lost
                    );
                }
            }
        }
        _ => eprintln!("用法见文件头"),
    }
}
