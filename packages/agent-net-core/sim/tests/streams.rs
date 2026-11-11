//! 测试价值
//! - 生产入口与可观察结果：`agent_net_core::Connection` 的多路流公开接口，断言每条流读到的字节完整、有序、不串流，
//!   一条流卡住不影响别的流，优先级、流量额度和流的生命周期符合约定，坏包不能撑大内存。
//! - Bug／规则依据：`docs/agent-net-plan.md` 第 2 步通过标准。流头写错或额度算错时不会报错，只会把数据交给错的流，
//!   或者让流永远卡住。
//! - 现有覆盖缺口：`reliability.rs` 只用默认流，碰不到流头、调度、额度和流的结束。
//! - 最小失败输入：每条失败都打印种子，用 `AGENT_NET_REPLAY=<种子>` 重放；固定场景的输入写在各用例里。
//! - tier：Rust integration，虚拟时间，无真实网络；独立通过 Cargo 运行，未接入 pnpm unit runner。
//!   用 `--profile sim` 打开溢出检查，默认 200 个种子；`AGENT_NET_SEEDS=10000` 跑扩展矩阵。
//! - 实测耗时：2026-11-02，本机默认 200 个种子 2.2 秒；10000 个种子空闲时约 160 秒，`sim/results/2026-11-02-streams/tests.txt` 里的 527 秒是和注入 bug 同时跑的。
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
        Self {
            a: Connection::new(config.clone(), 0),
            b: Connection::new(config.clone(), 0),
            to_b: Link::new(to_b, seed ^ 0xA5A5),
            to_a: Link::new(to_a, seed ^ 0x5A5A),
            packets: BinaryHeap::new(),
            order: 0,
            now: 0,
            buffer: vec![0; config.max_packet_size],
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
    const DURATION_US: u64 = 6_000_000;
    let mut pair = Pair::new(&wide_config(), link.clone(), link.clone(), seed);
    let chat = pair.a.open_stream(Priority::Interactive).unwrap();
    let file = pair.a.open_stream(Priority::Background).unwrap();
    let (message, chunk) = ([7u8; 200], [9u8; 4096]);
    let mut sent_at = Vec::new();
    let mut delays = Vec::new();
    let (mut chat_read, mut file_read) = (0, 0);
    while pair.now < DURATION_US {
        if pair.now >= sent_at.len() as u64 * 20_000 {
            assert_eq!(pair.a.send_stream(pair.now, chat, &message), message.len());
            sent_at.push(pair.now);
        }
        while pair.a.send_stream(pair.now, file, &chunk) == chunk.len() {}
        chat_read += drain(&mut pair.b, pair.now, chat);
        file_read += drain(&mut pair.b, pair.now, file);
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
