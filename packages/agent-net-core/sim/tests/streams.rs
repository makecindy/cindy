//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::Connection` 的多路流公开接口，断言每条流读到的字节完整、有序、不串流，
//!   一条流卡住不影响别的流，优先级、流量额度和流的生命周期符合约定，坏包不能撑大内存。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 2 步通过标准。流头写错或额度算错时不会报错，只会把数据交给错的流，
//!   或者让流永远卡住。2026-11-17 起另有一端窗口 8192、一端是窗口 128 的旧版的互通用例（`sim/results/2026-11-17-window-interop`）：
//!   越过旧版窗口的分片被丢掉、旧版发送端等额度，都只会变慢、不会报错。2026-11-19 起另有发送缓冲按优先级让、三档调度的用例
//!   （`sim/results/2026-11-19-priority-buffer`）：Desktop 驱动的配置下大流把交互流挡在发送缓冲外、三档都有数据时交互流被饿住，
//!   都只表现为消息迟迟发不出去，不报错。
//! - 现有覆盖缺口：`reliability.rs` 只用默认流，碰不到流头、调度、额度和流的结束；别的用例两端配置都一样。
//!   2026-11-19 以前的用例发送缓冲固定 1 MiB、最多两档同时有数据，碰不到窗口缩小后超出上限和三档调度。
//! - 最小失败输入：每条失败都打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；固定场景的输入写在各用例里。
//! - tier：Rust integration，虚拟时间，无真实网络；独立通过 Cargo 运行，未接入 pnpm unit runner。
//!   用 `--profile sim` 打开溢出检查，默认 200 个种子；`AGENT_NET_SEEDS=10000` 跑扩展矩阵。
//! - 实测耗时：2026-11-19，本机默认 200 个种子 2.4 秒（2026-11-02 是 2.2 秒）；10000 个种子空闲时约 160 秒，`sim/results/2026-11-02-streams/tests.txt` 里的 527 秒是和注入 bug 同时跑的。
//!   含 300 Mbit/s 路径的吞吐验证和恶意包压力验证，不作为 5 秒内轻量单测。
//! - 测试本身的有效性由 `sim/mutants.py` 验证：注入已知 bug，这里必须变红。

use agent_net_core::{Config, Connection, DEFAULT_STREAM, PacketError, Priority, RecoveryPolicy, StreamEvent};
use agent_net_sim::{Link, LinkProfile, Rng, random_case};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

/// 没有事发生时也要隔这么久回到测试循环，应用要写数据。
const TICK_US: u64 = 1_000;

/// 两端和两个方向的链路，时间是虚拟的。
struct Pair {
    a: Connection,
    b: Connection,
    to_b: Link,
    to_a: Link,
    /// (到达时间, 顺序, 发给 b, 内容)
    packets: BinaryHeap<Reverse<(u64, u64, bool, Vec<u8>)>>,
    order: u64,
    now: u64,
    buffer: Vec<u8>,
    wire_bytes: u64,
    /// a 在同一时刻发出的最多包数。
    largest_burst: usize,
}

impl Pair {
    fn new(config: &Config, to_b: LinkProfile, to_a: LinkProfile, seed: u64) -> Self {
        Self::with_configs(config, config, to_b, to_a, seed)
    }

    /// 两端配置不同：一端升级了、另一端还是旧版。
    fn with_configs(a: &Config, b: &Config, to_b: LinkProfile, to_a: LinkProfile, seed: u64) -> Self {
        Self {
            a: Connection::new(a.clone(), 0),
            b: Connection::new(b.clone(), 0),
            to_b: Link::new(to_b, seed ^ 0xA5A5),
            to_a: Link::new(to_a, seed ^ 0x5A5A),
            packets: BinaryHeap::new(),
            order: 0,
            now: 0,
            buffer: vec![0; a.max_packet_size.max(b.max_packet_size)],
            wire_bytes: 0,
            largest_burst: 0,
        }
    }

    fn pump(&mut self) {
        for from_a in [true, false] {
            let (sender, link) = if from_a { (&mut self.a, &mut self.to_b) } else { (&mut self.b, &mut self.to_a) };
            let mut burst = 0;
            while let Some(size) = sender.poll_transmit(self.now, &mut self.buffer) {
                burst += 1;
                self.wire_bytes += size as u64;
                let (times, count) = link.transmit(self.now, size);
                for &at in &times[..count] {
                    self.order += 1;
                    self.packets.push(Reverse((at, self.order, from_a, self.buffer[..size].to_vec())));
                }
            }
            sender.check_invariants();
            if from_a {
                self.largest_burst = self.largest_burst.max(burst);
            }
        }
    }

    /// 发出两端能发的包，然后走到下一件事发生。
    fn advance(&mut self) {
        self.pump();
        let arrival = self.packets.peek().map(|Reverse(packet)| packet.0);
        let next = [arrival, self.a.next_wake(), self.b.next_wake(), Some(self.now + TICK_US)].into_iter().flatten().min();
        self.now = next.unwrap_or(self.now).max(self.now + 1);
        while self.packets.peek().is_some_and(|Reverse(packet)| packet.0 <= self.now) {
            let Some(Reverse((_, _, to_b, packet))) = self.packets.pop() else { break };
            let receiver = if to_b { &mut self.b } else { &mut self.a };
            let result = receiver.on_packet(self.now, &packet);
            assert!(result.is_ok() || receiver.is_dead(), "valid packet rejected: {result:?}");
        }
        for connection in [&mut self.a, &mut self.b] {
            if connection.next_wake().is_some_and(|at| at <= self.now) {
                connection.tick(self.now);
            }
        }
    }
}

fn path(bits_per_second: u64, delay_us: u64) -> LinkProfile {
    LinkProfile { bits_per_second, delay_us, queue_us: 100_000, ..LinkProfile::default() }
}

fn wide_config() -> Config {
    Config { max_packet_size: 1400, send_window: 1024, recv_window: 1024, send_buffer_bytes: 1 << 20, ..Config::default() }
}

/// 读走一条流现有的数据，返回字节数。
fn drain(connection: &mut Connection, now: u64, stream: u32) -> usize {
    let mut chunk = [0u8; 4096];
    let mut total = 0;
    loop {
        let size = connection.recv_stream(now, stream, &mut chunk);
        if size == 0 {
            return total;
        }
        total += size;
    }
}

/// 两边的内容不同、每条流的内容也不同：只要串了流，比对就会失败。
fn pattern(origin: u8, stream: u32, offset: usize) -> u8 {
    (offset as u64).wrapping_mul(31).wrapping_add(offset as u64 / 257).wrapping_add(stream as u64 * 7).wrapping_add(origin as u64 * 101) as u8
}

struct Transfer {
    id: u32,
    total: usize,
    written: usize,
    read: usize,
    finish_called: bool,
    opened: bool,
    finished: bool,
    paused_until: u64,
}

/// 一端要发的全部内容，和对端的接收进度。
struct Plan {
    origin: u8,
    transfers: Vec<Transfer>,
}

impl Plan {
    fn new(connection: &mut Connection, origin: u8, rng: &mut Rng) -> Self {
        let size = |rng: &mut Rng| rng.pick(&[0usize, 1, 200, 5_000, 60_000]);
        let transfer = |id, total| Transfer { id, total, written: 0, read: 0, finish_called: false, opened: id == DEFAULT_STREAM, finished: false, paused_until: 0 };
        let mut transfers = vec![transfer(DEFAULT_STREAM, size(rng))];
        for _ in 0..rng.below(6) {
            if let Some(id) = connection.open_stream(rng.pick(&[Priority::Interactive, Priority::Normal, Priority::Background])) {
                transfers.push(transfer(id, size(rng)));
            }
        }
        Self { origin, transfers }
    }

    fn write(&mut self, connection: &mut Connection, now: u64, rng: &mut Rng) {
        let mut chunk = [0u8; 4096];
        for transfer in &mut self.transfers {
            if transfer.id != DEFAULT_STREAM && rng.chance(0.01) {
                connection.set_priority(transfer.id, rng.pick(&[Priority::Interactive, Priority::Normal, Priority::Background]));
            }
            while transfer.written < transfer.total {
                let size = (transfer.total - transfer.written).min(chunk.len());
                for (index, byte) in chunk[..size].iter_mut().enumerate() {
                    *byte = pattern(self.origin, transfer.id, transfer.written + index);
                }
                let accepted = connection.send_stream(now, transfer.id, &chunk[..size]);
                transfer.written += accepted;
                if accepted < size {
                    break;
                }
            }
            if transfer.written == transfer.total && transfer.id != DEFAULT_STREAM && !transfer.finish_called {
                assert!(connection.finish_stream(transfer.id));
                transfer.finish_called = true;
            }
        }
    }

    fn read(&mut self, connection: &mut Connection, now: u64, rng: &mut Rng) -> Result<(), String> {
        let origin = self.origin;
        let mut chunk = [0u8; 4096];
        for transfer in &mut self.transfers {
            // 应用偶尔不读：额度要能卡住对端，读了又要能放开。
            if now < transfer.paused_until {
                continue;
            }
            if rng.chance(0.002) {
                transfer.paused_until = now + rng.below(500_000);
                continue;
            }
            loop {
                let size = connection.recv_stream(now, transfer.id, &mut chunk);
                if size == 0 {
                    break;
                }
                if transfer.read + size > transfer.total {
                    return Err(format!("流 {} 读到的比发的多", transfer.id));
                }
                for (index, &byte) in chunk[..size].iter().enumerate() {
                    if byte != pattern(origin, transfer.id, transfer.read + index) {
                        return Err(format!("流 {} 第 {} 字节不对", transfer.id, transfer.read + index));
                    }
                }
                transfer.read += size;
            }
        }
        while let Some(event) = connection.poll_event() {
            let id = match event {
                StreamEvent::Opened(id) | StreamEvent::Finished(id) => id,
            };
            let transfer = self.transfers.iter_mut().find(|transfer| transfer.id == id).ok_or(format!("没开过的流 {id}"))?;
            match event {
                StreamEvent::Opened(_) if transfer.opened => return Err(format!("流 {id} 打开了两次")),
                StreamEvent::Opened(_) => transfer.opened = true,
                StreamEvent::Finished(_) if !transfer.opened || transfer.finished || transfer.read != transfer.total => {
                    return Err(format!("流 {id} 结束得不对：读了 {}/{}", transfer.read, transfer.total));
                }
                StreamEvent::Finished(_) => transfer.finished = true,
            }
        }
        Ok(())
    }

    fn done(&self) -> bool {
        self.transfers.iter().all(|transfer| transfer.read == transfer.total && (transfer.id == DEFAULT_STREAM || transfer.finished))
    }
}

fn exchange(seed: u64) -> Result<(), String> {
    let case = random_case(seed);
    let mut rng = Rng::new(seed ^ 0x57EA);
    let mut pair = Pair::new(&case.config, case.a_link.clone(), case.b_link.clone(), seed);
    let mut from_a = Plan::new(&mut pair.a, 1, &mut rng);
    let mut from_b = Plan::new(&mut pair.b, 2, &mut rng);
    while pair.now < 600_000_000 {
        if pair.a.is_dead() || pair.b.is_dead() {
            return Err("连接断了".into());
        }
        from_a.write(&mut pair.a, pair.now, &mut rng);
        from_b.write(&mut pair.b, pair.now, &mut rng);
        from_a.read(&mut pair.b, pair.now, &mut rng)?;
        from_b.read(&mut pair.a, pair.now, &mut rng)?;
        if from_a.done() && from_b.done() {
            return Ok(());
        }
        pair.advance();
    }
    Err("传不完".into())
}

/// 不管网络多差，两边每条流读到的都必须和写入的完全一致，并且要能传完。
#[test]
fn every_seed_delivers_every_stream_intact() {
    let seeds: Vec<u64> = match std::env::var("AGENT_NET_REPLAY") {
        Ok(value) => vec![value.parse().expect("replay seed")],
        Err(_) => {
            let start = std::env::var("AGENT_NET_SEED_START").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
            let count: u64 = std::env::var("AGENT_NET_SEEDS").ok().and_then(|value| value.parse().ok()).unwrap_or(200);
            (start..start + count).collect()
        }
    };
    let failures: Vec<String> = seeds.into_iter().filter_map(|seed| exchange(seed).err().map(|error| format!("seed {seed}: {error}"))).take(5).collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// 一条流丢了包，别的流不用等它补上，这是一条连接分多条流的意义。
#[test]
fn a_lost_packet_only_holds_up_its_own_stream() {
    let config = Config::for_policy(RecoveryPolicy::Lean);
    let mut sender = Connection::new(config.clone(), 0);
    let mut receiver = Connection::new(config.clone(), 0);
    let mut buffer = vec![0u8; config.max_packet_size];
    let (stuck, moving) = (sender.open_stream(Priority::Normal).unwrap(), sender.open_stream(Priority::Normal).unwrap());

    sender.send_stream(0, stuck, &[1; 100]);
    let lost = sender.poll_transmit(0, &mut buffer).unwrap();
    let lost = buffer[..lost].to_vec();
    sender.send_stream(0, moving, &[2; 100]);
    let size = sender.poll_transmit(0, &mut buffer).unwrap();
    receiver.on_packet(1_000, &buffer[..size]).unwrap();

    assert_eq!(drain(&mut receiver, 1_000, moving), 100);
    assert_eq!(drain(&mut receiver, 1_000, stuck), 0);
    receiver.on_packet(2_000, &lost).unwrap();
    assert_eq!(drain(&mut receiver, 2_000, stuck), 100);
}

/// 应用不读某条流时，只有这条流停下来，读了以后接着走。默认流用窗口，别的流用额度，都要成立。
#[test]
fn an_unread_stream_only_stalls_itself() {
    for default_is_stuck in [true, false] {
        let config = Config { recv_window: 32, ..wide_config() };
        let mut pair = Pair::new(&config, path(40_000_000, 10_000), path(40_000_000, 10_000), 1);
        let moving = pair.a.open_stream(Priority::Normal).unwrap();
        let stuck = if default_is_stuck { DEFAULT_STREAM } else { pair.a.open_stream(Priority::Normal).unwrap() };
        let (total, mut stuck_written, mut moving_written) = (400_000usize, 0, 0);
        let (mut stuck_read, mut moving_read) = (0, 0);
        let chunk = [5u8; 4096];
        while pair.now < 20_000_000 && (stuck_read < total || moving_read < total) {
            if moving_written < total {
                moving_written += pair.a.send_stream(pair.now, moving, &chunk[..chunk.len().min(total - moving_written)]);
            }
            if stuck_written < total {
                stuck_written += pair.a.send_stream(pair.now, stuck, &chunk[..chunk.len().min(total - stuck_written)]);
            }
            moving_read += drain(&mut pair.b, pair.now, moving);
            if moving_read == total {
                stuck_read += drain(&mut pair.b, pair.now, stuck);
            } else {
                let bound = config.recv_window as usize * config.max_packet_size;
                assert!(pair.b.buffered_bytes() <= bound * 2, "没读的流超出了额度：{}", pair.b.buffered_bytes());
            }
            pair.advance();
        }
        assert_eq!((moving_read, stuck_read), (total, total), "default_is_stuck={default_is_stuck} at {}us", pair.now);
    }
}

/// 满载传文件时交互消息的延迟（升序）和文件速度。
fn messages_beside_a_file(link: &LinkProfile, seed: u64) -> (Vec<u64>, u64) {
    messages_beside_files(&wide_config(), link, seed, &[Priority::Background])
}

/// 满载传几条大流（各自的优先级）时交互消息的延迟（升序）和大流的总速度。每条消息都必须一写就整条收下。
fn messages_beside_files(config: &Config, link: &LinkProfile, seed: u64, bulk: &[Priority]) -> (Vec<u64>, u64) {
    const DURATION_US: u64 = 6_000_000;
    let mut pair = Pair::new(config, link.clone(), link.clone(), seed);
    let chat = pair.a.open_stream(Priority::Interactive).unwrap();
    let files: Vec<u32> = bulk.iter().map(|&priority| pair.a.open_stream(priority).unwrap()).collect();
    let (message, chunk) = ([7u8; 200], [9u8; 4096]);
    let mut sent_at = Vec::new();
    let mut delays = Vec::new();
    let (mut chat_read, mut file_read) = (0, 0);
    while pair.now < DURATION_US {
        if pair.now >= sent_at.len() as u64 * 20_000 {
            assert_eq!(pair.a.send_stream(pair.now, chat, &message), message.len(), "消息写不进发送缓冲，at {}us", pair.now);
            sent_at.push(pair.now);
        }
        for &file in &files {
            while pair.a.send_stream(pair.now, file, &chunk) == chunk.len() {}
        }
        chat_read += drain(&mut pair.b, pair.now, chat);
        for &file in &files {
            file_read += drain(&mut pair.b, pair.now, file);
        }
        while (delays.len() + 1) * message.len() <= chat_read {
            delays.push(pair.now - sent_at[delays.len()]);
        }
        pair.advance();
    }
    delays.sort_unstable();
    (delays, file_read as u64 * 8 * 1_000_000 / DURATION_US)
}

/// 这是多路流的过关标准：满载传文件时，交互延迟接近空闲水平，文件也不能明显变慢。
/// 上限取空闲水平加很小的余量；放松压低队列的任何一项，这里都会超。
#[test]
fn interactive_messages_stay_fast_beside_a_full_file() {
    let lossy = |bits_per_second, delay_us, jitter_us, loss, queue_us| LinkProfile { bits_per_second, delay_us, jitter_us, loss, queue_us, ..LinkProfile::default() };
    let rows = [
        ("校园", lossy(40_000_000, 15_000, 3_000, 0.008, 40_000), 19_500, 26_000, 29_000, 36_000_000),
        ("手机", lossy(10_000_000, 50_000, 30_000, 0.03, 150_000), 82_000, 165_000, 235_000, 8_000_000),
        // 公网实测：往返时间常年在高位，偶尔才碰到一次低值。拿低值当基准的话文件只剩四分之一。
        ("漂移", LinkProfile { wander_us: 30_000, wander_period_us: 4_000_000, ..lossy(20_000_000, 30_000, 4_000, 0.02, 80_000) }, 70_000, 140_000, 150_000, 15_000_000),
        // 往返时间摆动得比观察窗口还快：排空几轮不见效，就要认定不是自己排的队。
        ("摆动", LinkProfile { wander_us: 40_000, wander_period_us: 1_000_000, ..lossy(20_000_000, 50_000, 4_000, 0.002, 80_000) }, 120_000, 170_000, 215_000, 10_000_000),
        // 令牌桶限速：文件成片丢包时重传队列很长，消息还要照常走。
        ("限速", LinkProfile { bits_per_second: 1_000_000_000, delay_us: 70_000, jitter_us: 5_000, queue_us: 20_000, bucket_bytes_per_second: 708_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() }, 75_000, 80_000, 90_000, 4_800_000),
    ];
    for (name, link, p50_limit, p95_limit, p99_limit, rate_floor) in rows {
        let (mut delays, mut rate) = (Vec::new(), 0);
        for seed in 1..=3 {
            let (run, run_rate) = messages_beside_a_file(&link, seed);
            delays.extend(run);
            rate += run_rate / 3;
        }
        delays.sort_unstable();
        let at = |percent: usize| delays[delays.len() * percent / 100];
        let (p50, p95, p99) = (at(50), at(95), at(99));
        assert!(p50 <= p50_limit && p95 <= p95_limit && p99 <= p99_limit, "{name}: p50 {p50} p95 {p95} p99 {p99}");
        assert!(rate >= rate_floor, "{name}: 文件只有 {rate} bit/s");
    }
}

/// 普通和后台各一条大流一起写满时（会话层的普通通道传大结果、后台通道传文件），交互消息照样一写就收下，延迟和大流速度都接近
/// 只有一条文件时。配置同 Desktop 的驱动。2026-11-19 修之前两处会坏：两条大流写满共用的发送缓冲，交互消息一个字节都写不进去；
/// 写得进以后，三档都有数据时调度器一直让给普通档，慢线一行的 p95 从 0.19 秒涨到 2.6 秒。
#[test]
fn interactive_messages_stay_fast_beside_two_full_streams() {
    let config = upgraded(Config::for_policy(RecoveryPolicy::Auto));
    let lossy = |bits_per_second, delay_us, jitter_us, loss, queue_us| LinkProfile { bits_per_second, delay_us, jitter_us, loss, queue_us, ..LinkProfile::default() };
    let rows = [
        ("手机", lossy(10_000_000, 50_000, 30_000, 0.03, 150_000)),
        ("跨境", lossy(4_000_000, 35_000, 5_000, 0.05, 200_000)),
        ("慢线", lossy(1_000_000, 60_000, 4_000, 0.01, 300_000)),
    ];
    for (name, link) in rows {
        let (mut one, mut two, mut one_rate, mut two_rate) = (Vec::new(), Vec::new(), 0, 0);
        for seed in 1..=3 {
            let (delays, rate) = messages_beside_files(&config, &link, seed, &[Priority::Background]);
            one.extend(delays);
            one_rate += rate / 3;
            let (delays, rate) = messages_beside_files(&config, &link, seed, &[Priority::Normal, Priority::Background]);
            two.extend(delays);
            two_rate += rate / 3;
        }
        one.sort_unstable();
        two.sort_unstable();
        let at = |delays: &Vec<u64>, percent: usize| delays[delays.len() * percent / 100];
        let (one_p, two_p) = ([50, 95, 99].map(|percent| at(&one, percent)), [50, 95, 99].map(|percent| at(&two, percent)));
        let close = one_p.iter().zip(two_p).all(|(&one, two)| two <= one + one / 5 + 10_000);
        assert!(close && two_rate >= one_rate - one_rate / 20,
            "{name}：一条文件 p50/p95/p99 {one_p:?} {one_rate} bit/s，两条大流 {two_p:?} {two_rate} bit/s");
    }
}

/// 三档都一直写满时每一档都在前进，最高档占大头（2026-11-19：防饿死只记一个数时，让给中间档清不了零，之后一直让给中间档；
/// 高档的流一直写满共用发送缓冲时，最低档连一个分片都写不进去，调度器给它留的那一份没东西可发）。
#[test]
fn every_priority_makes_progress_when_all_are_busy() {
    let config = wide_config();
    let mut pair = Pair::new(&config, path(20_000_000, 10_000), path(20_000_000, 10_000), 1);
    let streams = [Priority::Interactive, Priority::Normal, Priority::Background].map(|priority| pair.a.open_stream(priority).unwrap());
    let chunk = [3u8; 4096];
    let mut read = [0usize; 3];
    while pair.now < 3_000_000 {
        for &stream in &streams {
            while pair.a.send_stream(pair.now, stream, &chunk) == chunk.len() {}
        }
        for (index, &stream) in streams.iter().enumerate() {
            read[index] += drain(&mut pair.b, pair.now, stream);
        }
        pair.advance();
    }
    let total: usize = read.iter().sum();
    assert!(read[1] > 0 && read[2] > 0 && read[0] * 5 >= total * 4, "交互 / 普通 / 后台：{read:?}");
}

/// 不打乱先后的抖动线路（Wi-Fi 聚合、经 TCP 中转、VPN）上交互消息和文件一起发时，低排队模式的窗口只按最小往返算，
/// 确认晚回来，窗口先卡住速度，带宽估计一轮轮往下掉（2026-11-15 真实网络对比：会话层回传每秒 3–7 MB，线路能跑 14 MB）。
/// 窗口要另加确认一直成批到达多出来的量，加速探测连着成功时要一次比一次加得多（VPN 一行：改之前文件 26 Mbit/s）；排起来的队连着两轮发得比送到的快很多时要认作自己的、
/// 把带宽估计降下来，不能当成路径变慢去抬高基准，否则窗口越撑越大，消息排到队尾（抖动 30 毫秒一行：改之前 p99 1.23 秒）。
/// 上一个用例守着另一头：令牌桶开头放行的那一阵、浅队列上的随机抖动不能拿来放大窗口。
#[test]
fn files_keep_their_speed_beside_messages_on_ordered_jitter() {
    let ordered = |bits_per_second, delay_us, jitter_us, loss, queue_us| LinkProfile { bits_per_second, delay_us, jitter_us, jitter_fifo: true, loss, queue_us, ..LinkProfile::default() };
    let rows = [
        // 2026-11-16：改之前 p99 18 毫秒、文件 26.2 Mbit/s；窗口补上确认一直成批到达的量以后 41.6 Mbit/s，
        // 加速探测连着成功时一次比一次加得多以后 48.7 Mbit/s，p99 都是 18 毫秒。
        ("VPN", ordered(120_000_000, 8_500, 10_000, 0.0, 50_000), 25_000, 45_000_000),
        // 改之前 p99 1232 毫秒、6.7 Mbit/s，之后 669 毫秒、7.4 Mbit/s。
        ("每秒 1 MB 抖动 30 毫秒", ordered(8_000_000, 40_000, 30_000, 0.0, 262_000), 900_000, 7_000_000),
        // 改之前 p99 110 毫秒、16.0 Mbit/s，之后 111 毫秒、16.3 Mbit/s：这里只守着不变差。
        ("4G", ordered(20_000_000, 35_000, 20_000, 0.015, 200_000), 150_000, 15_000_000),
    ];
    for (name, link, p99_limit, rate_floor) in rows {
        let (mut delays, mut rate) = (Vec::new(), 0);
        for seed in 1..=4 {
            let (run, run_rate) = messages_beside_a_file(&link, seed);
            delays.extend(run);
            rate += run_rate / 4;
        }
        delays.sort_unstable();
        let p99 = delays[delays.len() * 99 / 100];
        assert!(p99 <= p99_limit, "{name}: p99 {p99}");
        assert!(rate >= rate_floor, "{name}: 文件只有 {rate} bit/s");
    }
}

/// 额度跟不上时，流会被自己的窗口卡住：高带宽路径上新开的流不能比默认流慢。
#[test]
fn credit_keeps_up_with_fast_paths() {
    let config = wide_config();
    let link = LinkProfile { loss: 0.003, ..path(300_000_000, 12_500) };
    let rate = |opened: bool| {
        let mut pair = Pair::new(&config, link.clone(), link.clone(), 1);
        let stream = if opened { pair.a.open_stream(Priority::Background).unwrap() } else { DEFAULT_STREAM };
        let chunk = [8u8; 4096];
        let mut read = 0;
        while pair.now < 3_000_000 {
            while pair.a.send_stream(pair.now, stream, &chunk) == chunk.len() {}
            read += drain(&mut pair.b, pair.now, stream);
            pair.advance();
        }
        read
    };
    let (default_stream, opened) = (rate(false), rate(true));
    assert!(opened * 10 >= default_stream * 9, "默认流 {default_stream}，新开的流 {opened}");
}

/// 旧版：窗口和每条流的初始额度都是 `Config::default()` 的 128 个分片。
fn legacy_config() -> Config {
    Config::default()
}

/// 新版 Node 驱动的配置（`wasm/src/lib.rs` 的 `init`）：窗口放大到 8192 个分片，发包短一些。
fn upgraded_config() -> Config {
    upgraded(Config::default())
}

fn upgraded(base: Config) -> Config {
    Config { send_window: 8192, recv_window: 8192, send_buffer_bytes: 24 << 20, send_packet_size: 1317, ..base }
}

/// a 在 `streams` 条新开的流上各发 `total` 字节给 b，b 一到就读。返回 (b 读完的时刻, a 重传的分片数)。
fn one_way(a: &Config, b: &Config, link: &LinkProfile, streams: usize, total: usize, seed: u64) -> (u64, u64) {
    let mut pair = Pair::with_configs(a, b, link.clone(), link.clone(), seed);
    let ids: Vec<u32> = (0..streams).map(|_| pair.a.open_stream(Priority::Normal).unwrap()).collect();
    let chunk = [8u8; 65_536];
    let (mut written, mut read) = (vec![0; streams], 0);
    while read < total * streams && pair.now < 60_000_000 {
        for (index, &id) in ids.iter().enumerate() {
            while written[index] < total {
                let accepted = pair.a.send_stream(pair.now, id, &chunk[..chunk.len().min(total - written[index])]);
                if accepted == 0 {
                    break;
                }
                written[index] += accepted;
            }
            read += drain(&mut pair.b, pair.now, id);
        }
        while pair.b.poll_event().is_some() {}
        pair.advance();
    }
    assert_eq!(read, total * streams, "seed {seed}: stalled at {}us", pair.now);
    (pair.now, pair.a.stats().retransmitted_segments)
}

/// 新版发给旧版：旧版接收端只收 `rcv_next` 之后 128 个分片以内的，越过的丢掉、也不确认，只能等重传。
/// 新版发送端要和两端都是旧版时一样守着这个窗口，互通不能比两端都是旧版差（新版发包短 6%，窗口卡住时按字节算就慢这么多）。
/// 2026-11-17 复核发现：只有默认流按对端确认里的窗口限着，别的流的额度从自己的 8192 起算，在途分片和拥塞窗口的上限也按自己的 8192；
/// 8 MiB、100 Mbit/s、往返 20 毫秒、1% 丢包，重传从 2 个涨到 8312 个，慢 61%。
#[test]
fn upgraded_senders_stay_inside_a_legacy_window() {
    let total = 8 << 20;
    let lossy = LinkProfile { loss: 0.01, queue_us: 50_000, ..path(100_000_000, 10_000) };
    for seed in 1..=2 {
        let (legacy_us, legacy_resent) = one_way(&legacy_config(), &legacy_config(), &lossy, 1, total, seed);
        let (mixed_us, mixed_resent) = one_way(&upgraded_config(), &legacy_config(), &lossy, 1, total, seed);
        assert!(mixed_resent <= legacy_resent * 4 + 32, "seed {seed}: 旧版两端重传 {legacy_resent} 个，新版发给旧版 {mixed_resent} 个");
        // 拥塞控制按自己的大窗口判断（不看对端只有 128）时，校验包和启动都按错的窗口走，慢 52%。
        assert!(mixed_us * 10 <= legacy_us * 12, "seed {seed}: 旧版两端 {legacy_us}us，新版发给旧版 {mixed_us}us");
    }
    // 两条流一起发、不发校验包：每条流的额度各自都在旧版的窗口里，合起来却会越过它，要按连接的序号守住。
    // 只按流的额度和在途分片数限的话，重传是旧版两端的 4–7 倍。
    let lean = Config::for_policy(RecoveryPolicy::Lean);
    for seed in 1..=2 {
        let (_, legacy_resent) = one_way(&lean, &lean, &lossy, 2, total / 2, seed);
        let (_, mixed_resent) = one_way(&upgraded(lean.clone()), &lean, &lossy, 2, total / 2, seed);
        assert!(mixed_resent <= legacy_resent * 2 + 32, "seed {seed}: 旧版两端重传 {legacy_resent} 个，新版发给旧版 {mixed_resent} 个");
    }
    // 没读的流只卡住自己：旧版接收端给每条流 128 个分片的额度，新版发送端开流时也按 128 记，不按自己的 8192。
    // 按 8192 记的话，没读的流把旧版的未读上限（4 个窗口）占满，读着的流也收不到了。
    let (legacy, upgraded) = (legacy_config(), upgraded_config());
    let mut pair = Pair::with_configs(&upgraded, &legacy, path(40_000_000, 10_000), path(40_000_000, 10_000), 1);
    let (moving, stuck) = (pair.a.open_stream(Priority::Normal).unwrap(), pair.a.open_stream(Priority::Normal).unwrap());
    let (total, mut stuck_written, mut moving_written, mut moving_read) = (2_000_000usize, 0, 0, 0);
    let chunk = [5u8; 4096];
    while pair.now < 20_000_000 && moving_read < total {
        moving_written += pair.a.send_stream(pair.now, moving, &chunk[..chunk.len().min(total - moving_written)]);
        stuck_written += pair.a.send_stream(pair.now, stuck, &chunk[..chunk.len().min(total - stuck_written)]);
        moving_read += drain(&mut pair.b, pair.now, moving);
        let bound = legacy.recv_window as usize * legacy.max_packet_size;
        assert!(pair.b.buffered_bytes() <= bound * 2, "没读的流超出了旧版给的额度：{}", pair.b.buffered_bytes());
        pair.advance();
    }
    assert_eq!(moving_read, total, "读着的流被没读的流卡住，at {}us", pair.now);
}

/// 旧版发给新版：旧版发送端开流时按 128 个分片的额度记，用完就等新的额度。新版接收端收到新流就把额度放到自己的窗口，
/// 不能等应用读走八分之一个窗口（1024 个分片）才给：那样旧版发送端要等 250 毫秒的探测，千兆局域网上 8 MiB 慢一倍多。
#[test]
fn legacy_senders_get_credit_from_upgraded_receivers_at_once() {
    let lan = LinkProfile { queue_us: 5_000, ..path(1_000_000_000, 1_000) };
    let total = 8 << 20;
    let (legacy_us, _) = one_way(&legacy_config(), &legacy_config(), &lan, 1, total, 1);
    let (mixed_us, _) = one_way(&legacy_config(), &upgraded_config(), &lan, 1, total, 1);
    assert!(mixed_us * 10 <= legacy_us * 11, "旧版两端 {legacy_us}us，旧版发给新版 {mixed_us}us");
}

/// 两端都升级：开头按 128 个分片发，对端在确认里说出大窗口后放开，长往返上不再卡在 128 个分片；
/// 新流一开就有整个窗口的额度，应用晚一点读，发送端也不停在 128 个分片上等它。
#[test]
fn upgraded_peers_use_their_large_windows() {
    let far = path(50_000_000, 40_000);
    let total = 8 << 20;
    let (legacy_us, _) = one_way(&legacy_config(), &legacy_config(), &far, 1, total, 1);
    let (upgraded_us, _) = one_way(&upgraded_config(), &upgraded_config(), &far, 1, total, 1);
    assert!(upgraded_us * 2 <= legacy_us, "旧版两端 {legacy_us}us，新版两端 {upgraded_us}us");

    let config = upgraded_config();
    let mut pair = Pair::new(&config, path(100_000_000, 10_000), path(100_000_000, 10_000), 1);
    let stream = pair.a.open_stream(Priority::Normal).unwrap();
    let chunk = [3u8; 65_536];
    while pair.now < 200_000 {
        while pair.a.send_stream(pair.now, stream, &chunk) == chunk.len() {}
        pair.advance();
    }
    let segment = config.send_limit();
    assert!(pair.b.buffered_bytes() > 512 * segment, "应用还没读时只收到了 {} 字节", pair.b.buffered_bytes());
}

/// 只有交互流在发时没有谁要让路，不能压低队列：把终端输出这样的突发放在交互流上，不能因此变慢。
#[test]
fn a_lone_interactive_stream_runs_at_full_speed() {
    let config = wide_config();
    let total = 4_000_000;
    let finish_time = |priority| {
        let mut pair = Pair::new(&config, path(100_000_000, 25_000), path(100_000_000, 25_000), 1);
        let stream = pair.a.open_stream(priority).unwrap();
        let (mut written, mut read) = (0, 0);
        let chunk = [8u8; 4096];
        while read < total {
            if written < total {
                written += pair.a.send_stream(pair.now, stream, &chunk[..chunk.len().min(total - written)]);
            }
            read += drain(&mut pair.b, pair.now, stream);
            pair.advance();
        }
        pair.now
    };
    let (normal, interactive) = (finish_time(Priority::Normal), finish_time(Priority::Interactive));
    assert!(interactive <= normal, "普通流 {normal}us，交互流 {interactive}us");
}

/// 同级的流平分线路；高优先级占大头，但低优先级不能被饿死。
#[test]
fn priorities_share_the_link() {
    for (first, second, lowest_ratio, highest_ratio) in [(Priority::Normal, Priority::Normal, 0.8, 1.25), (Priority::Interactive, Priority::Background, 10.0, 20.0)] {
        let config = wide_config();
        let mut pair = Pair::new(&config, path(20_000_000, 10_000), path(20_000_000, 10_000), 1);
        let (one, two) = (pair.a.open_stream(Priority::Normal).unwrap(), pair.a.open_stream(Priority::Normal).unwrap());
        assert!(pair.a.set_priority(one, first) && pair.a.set_priority(two, second));
        let chunk = [3u8; 4096];
        let (mut one_read, mut two_read) = (0, 0);
        while pair.now < 3_000_000 {
            for stream in [one, two] {
                while pair.a.send_stream(pair.now, stream, &chunk) == chunk.len() {}
            }
            one_read += drain(&mut pair.b, pair.now, one);
            two_read += drain(&mut pair.b, pair.now, two);
            pair.advance();
        }
        let ratio = one_read as f64 / two_read.max(1) as f64;
        assert!(two_read > 0 && (lowest_ratio..=highest_ratio).contains(&ratio), "{first:?}/{second:?}: {one_read} : {two_read}");
    }
}

/// 大量数据要排节奏，交互流的小消息不用等，写下去这一刻就能发。
#[test]
fn small_interactive_messages_skip_the_pacing_queue() {
    let config = wide_config();
    let mut pair = Pair::new(&config, path(2_000_000, 25_000), path(2_000_000, 25_000), 1);
    let (chat, file) = (pair.a.open_stream(Priority::Interactive).unwrap(), pair.a.open_stream(Priority::Background).unwrap());
    let chunk = [3u8; 4096];
    let (mut skipped, mut sent, mut next_message) = (0, 0, 500_000);
    let mut buffer = vec![0u8; config.max_packet_size];
    while pair.now < 3_000_000 {
        while pair.a.send_stream(pair.now, file, &chunk) == chunk.len() {}
        drain(&mut pair.b, pair.now, chat);
        drain(&mut pair.b, pair.now, file);
        pair.pump();
        // 这时节奏不让发了；写一条消息，要能马上发出去。
        if pair.now >= next_message && pair.a.poll_transmit(pair.now, &mut buffer).is_none() {
            assert_eq!(pair.a.send_stream(pair.now, chat, &[7; 200]), 200);
            skipped += pair.a.poll_transmit(pair.now, &mut buffer).is_some() as u32;
            sent += 1;
            next_message = pair.now + 20_000;
            pair.pump();
        }
        pair.advance();
    }
    assert!(skipped * 5 >= sent * 4, "{sent} 条消息里只有 {skipped} 条直接发出");
}

/// 不用等节奏的放行有总量：把大量小消息写进交互流，也不能冲过瓶颈。
#[test]
fn a_flood_of_tiny_messages_cannot_overrun_the_path() {
    let config = wide_config();
    let mut pair = Pair::new(&config, path(2_000_000, 25_000), path(2_000_000, 25_000), 1);
    let chat = pair.a.open_stream(Priority::Interactive).unwrap();
    while pair.now < 3_000_000 {
        pair.a.send_stream(pair.now, chat, &[7; 300]);
        drain(&mut pair.b, pair.now, chat);
        pair.pump();
        pair.advance();
    }
    let stats = pair.a.stats();
    assert!(stats.fast_losses + stats.timeout_losses <= 120, "{stats:?}");
}

/// 大量数据占满发送窗口时，要给交互流留一点位置，否则新消息要等窗口空出来。
#[test]
fn a_full_window_keeps_room_for_interactive_messages() {
    let config = Config { send_window: 8, recv_window: 64, ..Config::default() };
    let mut sender = Connection::new(config.clone(), 0);
    let mut buffer = vec![0u8; config.max_packet_size];
    let (chat, file) = (sender.open_stream(Priority::Interactive).unwrap(), sender.open_stream(Priority::Background).unwrap());
    sender.send_stream(0, chat, &[7; 100]);
    sender.send_stream(0, file, &vec![3u8; config.max_packet_size * 32]);
    while sender.poll_transmit(0, &mut buffer).is_some() {}
    sender.send_stream(0, chat, &[7; 100]);
    assert!(sender.poll_transmit(0, &mut buffer).is_some());
}

/// 两条大流写满所有流共用的发送缓冲时，更急的流照样写得进去（2026-11-19：普通和后台各一条大流就能把交互流挡在缓冲外，
/// 交互消息要等大流被确认才写得进，慢线路上是好几秒）。低档和同档的流不能借高档的份额，只能写进一个分片好让它也在前进；
/// 多占的内存有上限。
#[test]
fn full_bulk_streams_leave_room_for_more_urgent_ones() {
    let config = Config::default();
    let per_stream = config.send_buffer_bytes;
    let big = vec![3u8; per_stream];
    // 共用缓冲满了以后，这条流只写得进一个分片。
    let one_segment_only = |sender: &mut Connection, stream: u32| {
        let first = sender.send_stream(0, stream, &big);
        first > 0 && first <= config.max_packet_size && sender.send_stream(0, stream, &[1; 100]) == 0
    };
    // 后台加普通写满共用缓冲：交互流还能写，另一条后台流不能。
    let mut sender = Connection::new(config.clone(), 0);
    let (background, normal) = (sender.open_stream(Priority::Background).unwrap(), sender.open_stream(Priority::Normal).unwrap());
    let (late_background, chat) = (sender.open_stream(Priority::Background).unwrap(), sender.open_stream(Priority::Interactive).unwrap());
    assert_eq!(sender.send_stream(0, background, &big), per_stream);
    assert_eq!(sender.send_stream(0, normal, &big), per_stream);
    assert!(one_segment_only(&mut sender, late_background), "后台流借了高档的份额");
    assert_eq!(sender.send_stream(0, chat, &[7; 200]), 200, "交互流被大流挡在缓冲外");
    sender.check_invariants();
    // 两条后台流写满：普通流还能写，普通流写满它的份额以后交互流仍能写。
    let mut sender = Connection::new(config.clone(), 0);
    let (one, two) = (sender.open_stream(Priority::Background).unwrap(), sender.open_stream(Priority::Background).unwrap());
    let (normal, late_normal, chat) = (sender.open_stream(Priority::Normal).unwrap(), sender.open_stream(Priority::Normal).unwrap(),
        sender.open_stream(Priority::Interactive).unwrap());
    assert_eq!(sender.send_stream(0, one, &big) + sender.send_stream(0, two, &big), 2 * per_stream);
    let normal_room = sender.send_stream(0, normal, &big);
    assert!(normal_room > config.max_packet_size, "普通流被后台流挡在缓冲外");
    assert!(one_segment_only(&mut sender, late_normal), "同档的流多占了份额");
    assert_eq!(sender.send_stream(0, chat, &[7; 200]), 200, "交互流被大流挡在缓冲外");
    while sender.send_stream(0, chat, &[7; 4096]) > 0 {}
    sender.check_invariants();
    let bound = 3 * per_stream + 5 * config.max_packet_size;
    assert!(sender.buffered_bytes() <= bound, "多占的超出一条流的上限：{}", sender.buffered_bytes());
    // 只有同一档的流时不多给份额：两条写满就满，第三条只写得进一个分片。
    let mut sender = Connection::new(config.clone(), 0);
    let streams: Vec<u32> = (0..3).map(|_| sender.open_stream(Priority::Normal).unwrap()).collect();
    assert_eq!(sender.send_stream(0, streams[0], &big) + sender.send_stream(0, streams[1], &big), 2 * per_stream);
    assert!(one_segment_only(&mut sender, streams[2]));
}

/// 交互消息要排在待重传的大量数据前面：丢掉的先补，新写的也不等。成片丢包时重传队列很长，排在后面要等很久。
#[test]
fn interactive_messages_go_ahead_of_retransmissions() {
    for message_was_lost in [true, false] {
        let config = Config { reorder_threshold: 2, ..Config::for_policy(RecoveryPolicy::Lean) };
        let mut sender = Connection::new(config.clone(), 0);
        let mut receiver = Connection::new(config.clone(), 0);
        let mut buffer = vec![0u8; config.max_packet_size];
        let (chat, file) = (sender.open_stream(Priority::Interactive).unwrap(), sender.open_stream(Priority::Background).unwrap());
        sender.send_stream(0, file, &vec![3u8; config.max_packet_size * 6]);
        assert!(sender.poll_transmit(0, &mut buffer).is_some(), "大量数据的第一片丢了");
        if message_was_lost {
            sender.send_stream(0, chat, &[7; 100]);
            assert!(sender.poll_transmit(0, &mut buffer).is_some(), "交互消息也丢了");
        }
        let arrived: Vec<Vec<u8>> = std::iter::from_fn(|| sender.poll_transmit(0, &mut buffer).map(|size| buffer[..size].to_vec())).collect();
        assert!(arrived.len() >= 3);
        for packet in &arrived {
            receiver.on_packet(10_000, packet).unwrap();
        }
        let size = receiver.poll_transmit(10_000, &mut buffer).unwrap();
        sender.on_packet(20_000, &buffer[..size]).unwrap();
        if !message_was_lost {
            sender.send_stream(20_000, chat, &[7; 100]);
        }
        let size = sender.poll_transmit(20_000, &mut buffer).expect("下一个包");
        receiver.on_packet(30_000, &buffer[..size]).unwrap();
        assert_eq!(drain(&mut receiver, 30_000, chat), 100, "message_was_lost={message_was_lost}");
    }
}

/// 交互流只放行小消息。大量数据标成交互流也得照常排节奏，否则一个窗口的包同时冲出去，瓶颈直接被顶爆。
#[test]
fn bulk_data_marked_interactive_is_still_paced() {
    let config = wide_config();
    let mut pair = Pair::new(&config, path(100_000_000, 50_000), path(100_000_000, 50_000), 1);
    let (marked, other) = (pair.a.open_stream(Priority::Interactive).unwrap(), pair.a.open_stream(Priority::Background).unwrap());
    let chunk = [3u8; 4096];
    while pair.now < 2_000_000 {
        for stream in [marked, other] {
            while pair.a.send_stream(pair.now, stream, &chunk) == chunk.len() {}
        }
        drain(&mut pair.b, pair.now, marked);
        drain(&mut pair.b, pair.now, other);
        pair.advance();
    }
    // 排空以后再写一大块：这时拥塞窗口全空着，不排节奏的话整个窗口会同一时刻发出去。
    while pair.a.has_unacked_data() || pair.a.buffered_bytes() > 0 {
        drain(&mut pair.b, pair.now, marked);
        drain(&mut pair.b, pair.now, other);
        pair.advance();
    }
    let idle_until = pair.now + 100_000;
    while pair.now < idle_until {
        pair.advance();
    }
    pair.largest_burst = 0;
    while pair.a.send_stream(pair.now, marked, &chunk) == chunk.len() {}
    let until = pair.now + 500_000;
    while pair.now < until {
        drain(&mut pair.b, pair.now, marked);
        pair.advance();
    }
    assert!(pair.largest_burst <= 32, "同一时刻发了 {} 个包", pair.largest_burst);
}

/// 额度帧也会丢。对端不知道有新额度时会一直等，全靠重复发和探测补回来。
#[test]
fn lost_credit_is_sent_again() {
    let config = Config { recv_window: 16, send_window: 32, ..wide_config() };
    let reverse = LinkProfile { loss: 0.7, ..path(40_000_000, 10_000) };
    let mut pair = Pair::new(&config, path(40_000_000, 10_000), reverse, 3);
    let stream = pair.a.open_stream(Priority::Normal).unwrap();
    let total = 200_000;
    let (mut written, mut read) = (0, 0);
    let chunk = [8u8; 4096];
    while read < total && pair.now < 120_000_000 && !pair.a.is_dead() {
        if written < total {
            written += pair.a.send_stream(pair.now, stream, &chunk[..chunk.len().min(total - written)]);
        }
        read += drain(&mut pair.b, pair.now, stream);
        pair.advance();
    }
    assert_eq!(read, total, "at {}us dead={}", pair.now, pair.a.is_dead());
}

/// 一条流不管发多少，只在开头带一次流头。单流场景的线上开销不能因为多路流变大。
#[test]
fn a_lone_stream_does_not_repeat_its_header() {
    let config = wide_config();
    let total = 1_000_000;
    let cost = |opened: bool| {
        let mut pair = Pair::new(&config, path(40_000_000, 10_000), path(40_000_000, 10_000), 1);
        let stream = if opened { pair.a.open_stream(Priority::Normal).unwrap() } else { DEFAULT_STREAM };
        let (mut written, mut read) = (0, 0);
        let chunk = [8u8; 4096];
        while read < total {
            if written < total {
                written += pair.a.send_stream(pair.now, stream, &chunk[..chunk.len().min(total - written)]);
            }
            read += drain(&mut pair.b, pair.now, stream);
            pair.advance();
        }
        pair.wire_bytes
    };
    let (default_stream, opened) = (cost(false), cost(true));
    assert!(opened <= default_stream + 1_000 && opened <= total as u64 * 1_016 / 1_000, "默认流 {default_stream}，新开的流 {opened}");
}

/// 把几条流传完，返回对端看到的事件。
fn finish_all(pair: &mut Pair, streams: &[u32]) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for &stream in streams {
        assert!(pair.a.finish_stream(stream));
    }
    while (pair.a.has_unacked_data() || events.iter().filter(|event| matches!(event, StreamEvent::Finished(_))).count() < streams.len()) && pair.now < 60_000_000 {
        for &stream in streams {
            drain(&mut pair.b, pair.now, stream);
        }
        events.extend(std::iter::from_fn(|| pair.b.poll_event()));
        pair.advance();
    }
    events
}

/// 流用完要把名额还回来：长期运行的连接会开关几千条流。
#[test]
fn finished_streams_release_their_slots() {
    let config = Config { max_streams: 4, ..wide_config() };
    let mut pair = Pair::new(&config, path(40_000_000, 1_000), path(40_000_000, 1_000), 1);

    let (written, empty, spare) = (pair.a.open_stream(Priority::Normal).unwrap(), pair.a.open_stream(Priority::Normal).unwrap(), pair.a.open_stream(Priority::Normal).unwrap());
    assert_eq!(pair.a.open_stream(Priority::Normal), None, "名额用完了");
    assert!(!pair.a.finish_stream(DEFAULT_STREAM), "默认流不能结束");
    assert!(!pair.a.finish_stream(999), "不存在的流");

    // 没写过数据的流也要能打开和结束。
    assert_eq!(pair.a.send_stream(pair.now, written, &[1; 100]), 100);
    let events = finish_all(&mut pair, &[written, empty]);
    for stream in [written, empty] {
        let order: Vec<&StreamEvent> = events.iter().filter(|event| matches!(event, StreamEvent::Opened(id) | StreamEvent::Finished(id) if *id == stream)).collect();
        assert_eq!(order, [&StreamEvent::Opened(stream), &StreamEvent::Finished(stream)]);
    }
    assert_eq!(pair.a.send_stream(pair.now, written, &[1; 100]), 0, "结束的流不能再写");

    for round in 0..200 {
        let stream = pair.a.open_stream(Priority::Background).unwrap_or_else(|| panic!("第 {round} 轮开不了新流"));
        assert_eq!(pair.a.send_stream(pair.now, stream, &[2; 300]), 300);
        finish_all(&mut pair, &[stream]);
    }
    assert_eq!(pair.a.send_stream(pair.now, spare, &[3; 300]), 300, "没结束的流不受影响");
    assert_eq!(pair.a.buffered_bytes(), 300, "发送端不留用完的流");
    assert!(pair.b.buffered_bytes() <= (config.recv_window as usize) * config.max_packet_size);
}

/// 第 2 步还没有加密，网络上任何人都能发包。流头是对端说了算的字段，伪造的流号和序号不能撑大内存，
/// 也不能开出超过上限的流。
#[test]
fn forged_stream_headers_stay_within_bounds() {
    let config = Config { recv_window: 16, send_window: 16, max_streams: 8, ..Config::default() };
    let bound = 8 * (config.recv_window as usize) * config.max_packet_size;
    let mut victim = Connection::new(config.clone(), 0);
    let mut buffer = vec![0u8; config.max_packet_size];
    let payload = [4u8; 1000];

    let mut rng = Rng::new(0x5EED);
    let mut opened = 0;
    for number in 0..50_000u32 {
        // 分片序号连着写，内容才会真的被收下。先用合法的流头开三条流，后面的流内序号全是额度之外的。
        let stream = if number < 30_000 { number % 3 + 1 } else { rng.below(1 << 20) as u32 + 1 };
        let seq = if number < 3 { 0 } else { (1 << 20) + rng.below(1 << 24) as u32 };
        let packet = crafted_stream_packet(number, number, stream, seq, number >= 30_000 && rng.chance(0.1), &payload);
        let _ = victim.on_packet(number as u64, &packet);
        for stream in 0..4 {
            drain(&mut victim, number as u64, stream);
        }
        victim.check_invariants();
        assert!(victim.buffered_bytes() <= bound, "{} over {bound}", victim.buffered_bytes());
        opened += std::iter::from_fn(|| victim.poll_event()).filter(|event| matches!(event, StreamEvent::Opened(_))).count();
    }
    assert!(opened <= config.max_streams as usize, "开了 {opened} 条流");

    // 不读的话，对端不守额度也撑不大内存：接收方有未读上限。
    let mut victim = Connection::new(config.clone(), 0);
    for number in 0..50_000u32 {
        let packet = crafted_stream_packet(number, number, 1, number, false, &payload);
        let _ = victim.on_packet(number as u64, &packet);
        assert!(victim.buffered_bytes() <= bound, "{} over {bound}", victim.buffered_bytes());
    }

    // 真实的多路流包被改坏以后，同样不能让进程崩溃或内存失控。
    let mut sender = Connection::new(config.clone(), 0);
    let streams: Vec<u32> = (0..4).map(|_| sender.open_stream(Priority::Normal).unwrap()).collect();
    let mut victim = Connection::new(config.clone(), 0);
    let mut valid: VecDeque<Vec<u8>> = VecDeque::new();
    let mut now = 0u64;
    for round in 0..20_000u64 {
        now += 100;
        if round % 8 == 0 {
            sender.send_stream(now, streams[rng.below(4) as usize], &[round as u8; 300]);
        }
        sender.tick(now);
        while let Some(size) = sender.poll_transmit(now, &mut buffer) {
            valid.push_back(buffer[..size].to_vec());
            if valid.len() > 64 {
                valid.pop_front();
            }
        }
        let Some(original) = valid.get(rng.below(valid.len().max(1) as u64) as usize) else { continue };
        let mut mutated = original.clone();
        for _ in 0..rng.below(6) {
            let index = rng.below(mutated.len() as u64) as usize;
            mutated[index] = rng.next_u64() as u8;
        }
        let _ = victim.on_packet(now, &mutated);
        victim.check_invariants();
        victim.tick(now);
        for &stream in &streams {
            drain(&mut victim, now, stream);
        }
        while victim.poll_event().is_some() {}
        while victim.poll_transmit(now, &mut buffer).is_some() {}
        assert!(victim.buffered_bytes() <= bound, "round {round}: {} over {bound}", victim.buffered_bytes());
    }
}

/// 不带流头的分片紧跟上一个分片的流。第一片没到时后面的不能猜着交出去，也不能用流头的长度标记骗过长度检查。
#[test]
fn headerless_segments_wait_for_their_header() {
    let config = Config::for_policy(RecoveryPolicy::Lean);
    let mut sender = Connection::new(config.clone(), 0);
    let mut receiver = Connection::new(config.clone(), 0);
    let mut buffer = vec![0u8; config.max_packet_size];
    let stream = sender.open_stream(Priority::Normal).unwrap();
    assert_eq!(sender.send_stream(0, stream, &vec![6u8; config.max_packet_size * 2]), config.max_packet_size * 2);
    let packets: Vec<Vec<u8>> = std::iter::from_fn(|| sender.poll_transmit(0, &mut buffer).map(|size| buffer[..size].to_vec())).collect();
    assert!(packets.len() >= 2);

    for packet in &packets[1..] {
        receiver.on_packet(1_000, packet).unwrap();
    }
    assert_eq!(receiver.poll_event(), None, "还不知道是哪条流");
    assert_eq!(drain(&mut receiver, 1_000, DEFAULT_STREAM), 0, "不能交给默认流");
    assert_eq!(drain(&mut receiver, 1_000, stream), 0);

    receiver.on_packet(2_000, &packets[0]).unwrap();
    assert_eq!(receiver.poll_event(), Some(StreamEvent::Opened(stream)));
    assert_eq!(drain(&mut receiver, 2_000, stream), config.max_packet_size * 2);

    assert_eq!(receiver.on_packet(3_000, &crafted_stream_packet(9, 100, 1, 0, false, &[])[..12]), Err(PacketError::Malformed), "流头被截断");
}

fn crafted_stream_packet(packet_number: u32, sn: u32, stream: u32, seq: u32, fin: bool, payload: &[u8]) -> Vec<u8> {
    let [_, high, middle, low] = packet_number.to_be_bytes();
    let mut packet = vec![0xA0 | (high & 0x0F), middle, low, 1];
    packet.extend_from_slice(&sn.to_be_bytes());
    packet.extend_from_slice(&((payload.len() + 9) as u16 | 0x8000).to_be_bytes());
    packet.extend_from_slice(&stream.to_be_bytes());
    packet.extend_from_slice(&seq.to_be_bytes());
    packet.push(fin as u8);
    packet.extend_from_slice(payload);
    packet
}
