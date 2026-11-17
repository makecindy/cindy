//! 确定性网络模拟器。时间是虚拟的，随机数来自种子：同一个种子每次跑出完全相同的结果，
//! 任何失败都能用种子复现。

#[cfg(feature = "kcp")]
pub mod fec;
#[cfg(feature = "kcp")]
pub mod kcp;
pub mod crypto;
pub mod migration;
pub mod share;
pub mod traversal;

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use agent_net_core::{BandwidthShare, Config, Connection};

/// 对比数据必须记录网络模型版本；v2 的突发日程不受发包数量影响。
pub const NETWORK_MODEL: &str = "independent-burst-calendar-v2";

/// SplitMix64：简单、快、可复现，这里不需要密码学强度。
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    pub fn below(&mut self, bound: u64) -> u64 {
        if bound == 0 { 0 } else { self.next_u64() % bound }
    }

    pub fn chance(&mut self, probability: f64) -> bool {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 <= probability
    }

    pub fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

/// 单向链路。
#[derive(Clone, Debug, Default)]
pub struct LinkProfile {
    /// 0 表示不限速。
    pub bits_per_second: u64,
    pub delay_us: u64,
    pub jitter_us: u64,
    pub loss: f64,
    /// 突发丢包：平均每隔 `burst_every_us` 出现一次，平均持续 `burst_len_us`，期间每个包有 `burst_loss` 的概率丢失。
    /// 按时间而不是按包数计算：真实网络的突发是一段时间，和这段时间里发了多少包无关。
    pub burst_every_us: u64,
    pub burst_len_us: u64,
    pub burst_loss: f64,
    pub duplicate: f64,
    pub reorder: f64,
    pub reorder_extra_us: u64,
    /// 瓶颈队列能排多久，超过就丢包。
    pub queue_us: u64,
    /// 断网时段 `[开始, 结束)`。
    pub outages: Vec<(u64, u64)>,
    /// 配额限速：每个时间窗最多放行这么多字节，用完后整段丢弃，下个窗口再恢复。没有队列，RTT 也不变。
    pub quota_bytes: u64,
    pub quota_window_us: u64,
    /// 路径延迟整体漂移：大部分时间多 `wander_us`，每个周期只有开头十六分之一的时间回到 `delay_us`。
    /// 真实公网的往返时间常年停在高位，10 秒窗口里的最低值只是偶尔碰到一次，不代表现在的路径。
    pub wander_us: u64,
    pub wander_period_us: u64,
    /// 令牌桶限速：按这个速率攒令牌，超出的包直接丢弃。云主机的带宽上限常常是这样，
    /// 实测 aotu-dev 持续约 708 KB/s，另有约 600 KB 的初始突发。
    pub bucket_bytes_per_second: u64,
    pub bucket_depth_bytes: u64,
    /// 线路卡一下：每隔 `stall_every_us` 卡 `stall_us`，这段时间到的包压到结束时一起送到，一个不丢。
    /// Wi-Fi 重传和换信道时就是这样，发送方会以为全丢了。
    pub stall_every_us: u64,
    pub stall_us: u64,
}

pub struct Link {
    profile: LinkProfile,
    rng: Rng,
    burst_rng: Rng,
    next_free: u64,
    burst_start: u64,
    burst_end: u64,
    quota_window: u64,
    quota_used: u64,
    bucket_tokens: u64,
    bucket_updated: u64,
}

impl Link {
    pub fn new(profile: LinkProfile, seed: u64) -> Self {
        let bucket_tokens = profile.bucket_depth_bytes;
        // 保留首段逐包损伤的旧随机序列，突发日程使用独立流，避免发包量改变时段。
        let mut packet_rng = Rng::new(seed);
        if profile.burst_every_us > 0 {
            packet_rng.below(2 * profile.burst_every_us);
            packet_rng.below(2 * profile.burst_len_us);
        }
        let mut link = Self { profile, rng: packet_rng, burst_rng: Rng::new(seed), next_free: 0, burst_start: u64::MAX, burst_end: 0, quota_window: 0, quota_used: 0, bucket_tokens, bucket_updated: 0 };
        link.schedule_burst(0);
        link
    }

    fn schedule_burst(&mut self, after_us: u64) {
        if self.profile.burst_every_us == 0 {
            return;
        }
        let gap = 1 + self.burst_rng.below(2 * self.profile.burst_every_us);
        let length = 1 + self.burst_rng.below(2 * self.profile.burst_len_us);
        self.burst_start = after_us + gap;
        self.burst_end = self.burst_start + length;
    }

    pub fn profile_delay_us(&self) -> u64 {
        self.profile.delay_us
    }

    /// 返回这个包的到达时间，丢包时为空。
    pub fn transmit(&mut self, now_us: u64, size: usize) -> ([u64; 2], usize) {
        while self.burst_end != 0 && self.burst_end <= now_us {
            self.schedule_burst(self.burst_end);
        }
        let in_burst = self.burst_start <= now_us && now_us < self.burst_end;
        let profile = &self.profile;
        if profile.outages.iter().any(|&(start, end)| start <= now_us && now_us < end) {
            return ([0; 2], 0);
        }
        let loss = if in_burst { profile.burst_loss } else { profile.loss };
        if loss > 0.0 && self.rng.chance(loss) {
            return ([0; 2], 0);
        }
        if profile.quota_bytes > 0 {
            let window = now_us / profile.quota_window_us;
            if window != self.quota_window {
                self.quota_window = window;
                self.quota_used = 0;
            }
            if self.quota_used + size as u64 > profile.quota_bytes {
                return ([0; 2], 0);
            }
            self.quota_used += size as u64;
        }
        if profile.bucket_bytes_per_second > 0 {
            let refill = (now_us - self.bucket_updated) * profile.bucket_bytes_per_second / 1_000_000;
            if refill > 0 {
                self.bucket_tokens = (self.bucket_tokens + refill).min(profile.bucket_depth_bytes);
                self.bucket_updated = now_us;
            }
            if self.bucket_tokens < size as u64 {
                return ([0; 2], 0);
            }
            self.bucket_tokens -= size as u64;
        }
        let mut departure = now_us;
        if profile.bits_per_second > 0 {
            let start = self.next_free.max(now_us);
            if start - now_us > profile.queue_us {
                return ([0; 2], 0);
            }
            departure = start + (size as u64 * 8_000_000) / profile.bits_per_second;
            self.next_free = departure;
        }
        let jitter = self.rng.below(profile.jitter_us + 1);
        let wander = if profile.wander_us > 0 && departure % profile.wander_period_us >= profile.wander_period_us / 16 { profile.wander_us } else { 0 };
        let mut arrival = departure + profile.delay_us + wander + jitter;
        if profile.reorder > 0.0 && self.rng.chance(profile.reorder) {
            arrival += self.rng.below(profile.reorder_extra_us + 1);
        }
        if profile.duplicate > 0.0 && self.rng.chance(profile.duplicate) {
            return ([arrival, arrival + self.rng.below(profile.delay_us + 1)], 2);
        }
        if profile.stall_every_us > 0 {
            let phase = arrival % profile.stall_every_us;
            if phase < profile.stall_us {
                arrival += profile.stall_us - phase;
            }
        }
        ([arrival, 0], 1)
    }
}

/// 让模拟器能驱动不同的实现，KCP 对比也走这个接口。
pub trait Peer {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize;
    fn read(&mut self, now_us: u64, out: &mut [u8]) -> usize;
    fn input(&mut self, now_us: u64, packet: &[u8]);
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8]));
    fn wake_at(&self) -> Option<u64>;
    fn on_wake(&mut self, now_us: u64);
    fn buffered(&self) -> usize;
    fn is_dead(&self) -> bool;
    fn describe(&self) -> String {
        String::new()
    }
    fn stats(&self) -> Option<agent_net_core::Stats> {
        None
    }
    /// 加密连接握手完成、开始传数据的时刻。没有握手的实现是 `None`。
    fn established_at(&self) -> Option<u64> {
        None
    }
}

pub struct CorePeer {
    pub connection: Connection,
    buffer: Vec<u8>,
    /// 每一步校验内部账目。测 CPU 性能时关掉，否则测到的是校验本身。
    pub check_invariants: bool,
}

impl CorePeer {
    pub fn new(config: Config) -> Self {
        Self::new_at(config, 0)
    }

    /// 在 `created_us` 时刻建好的连接，配合 [`Shifted`] 模拟时钟不从 0 开始的真实设备。
    pub fn new_at(config: Config, created_us: u64) -> Self {
        let size = config.max_packet_size;
        Self { connection: Connection::new(config, created_us), buffer: vec![0; size], check_invariants: true }
    }
}

/// 把传给端点的时间整体平移 `offset_us`。真实设备用系统时钟，连接建好时时钟早已不是 0；
/// 核心的行为只能依赖时间差，平移以后每一步都应该和从 0 开始完全一样。
pub struct Shifted<P> {
    pub peer: P,
    pub offset_us: u64,
}

impl<P: Peer> Peer for Shifted<P> {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize {
        self.peer.write(now_us + self.offset_us, data)
    }
    fn read(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        self.peer.read(now_us + self.offset_us, out)
    }
    fn input(&mut self, now_us: u64, packet: &[u8]) {
        self.peer.input(now_us + self.offset_us, packet)
    }
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8])) {
        self.peer.pump(now_us + self.offset_us, sink)
    }
    fn wake_at(&self) -> Option<u64> {
        self.peer.wake_at().map(|at| at.saturating_sub(self.offset_us))
    }
    fn on_wake(&mut self, now_us: u64) {
        self.peer.on_wake(now_us + self.offset_us)
    }
    fn buffered(&self) -> usize {
        self.peer.buffered()
    }
    fn is_dead(&self) -> bool {
        self.peer.is_dead()
    }
    fn describe(&self) -> String {
        self.peer.describe()
    }
    fn stats(&self) -> Option<agent_net_core::Stats> {
        self.peer.stats()
    }
    fn established_at(&self) -> Option<u64> {
        self.peer.established_at().map(|at| at.saturating_sub(self.offset_us))
    }
}

impl Peer for CorePeer {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize {
        self.connection.send(now_us, data)
    }
    fn read(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        self.connection.recv(now_us, out)
    }
    fn input(&mut self, now_us: u64, packet: &[u8]) {
        // 模拟器里的包都是真实对端发的，被拒绝说明实现自己有问题。
        if let Err(error) = self.connection.on_packet(now_us, packet) {
            let head = &packet[..packet.len().min(48)];
            assert!(self.connection.is_dead(), "valid packet rejected: {error:?}, {} bytes: {head:02x?}", packet.len());
        }
    }
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8])) {
        while let Some(size) = self.connection.poll_transmit(now_us, &mut self.buffer) {
            sink(&self.buffer[..size]);
        }
        if self.check_invariants {
            self.connection.check_invariants();
        }
    }
    fn wake_at(&self) -> Option<u64> {
        self.connection.next_wake()
    }
    fn on_wake(&mut self, now_us: u64) {
        self.connection.tick(now_us);
    }
    fn buffered(&self) -> usize {
        self.connection.buffered_bytes()
    }
    fn is_dead(&self) -> bool {
        self.connection.is_dead()
    }
    fn describe(&self) -> String {
        format!("dead={} unacked={} {:?}", self.connection.is_dead(), self.connection.has_unacked_data(), self.connection.stats())
    }
    fn stats(&self) -> Option<agent_net_core::Stats> {
        Some(self.connection.stats())
    }
}

#[derive(Clone, Debug)]
pub struct Workload {
    pub a_to_b_bytes: u64,
    pub b_to_a_bytes: u64,
    pub write_chunk: usize,
    /// 接收方的读取节奏：每隔这么久最多读 `read_bytes`。0 表示有数据就读。
    pub read_interval_us: u64,
    pub read_bytes: usize,
    /// 这段时间内接收方完全不读。
    pub read_pause: Option<(u64, u64)>,
    /// 传输途中这么久没有任何新数据送达，就判定卡死。判据是“有没有进展”，不是“多久传完”：
    /// 慢不等于卡死，用总时限衡量只会掩盖问题或误报。吞吐好坏由 compare 对比。
    pub stall_limit_us: u64,
    pub time_limit_us: u64,
}

impl Default for Workload {
    fn default() -> Self {
        Self {
            a_to_b_bytes: 0,
            b_to_a_bytes: 0,
            write_chunk: 4096,
            read_interval_us: 0,
            read_bytes: 0,
            read_pause: None,
            stall_limit_us: 120_000_000,
            time_limit_us: 86_400_000_000,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub finished: bool,
    pub finish_us: u64,
    /// 第一处违反不变量的描述。
    pub violation: Option<String>,
    pub wire_bytes: u64,
    pub packets: u64,
    pub peak_buffered: usize,
    /// 全过程的哈希，用来确认同一种子的结果完全一致。
    pub trace: u64,
    pub steps: u64,
    /// 处理完当前时刻后，下次唤醒仍不晚于当前时刻的次数。大于 0 表示端点在空转，真机上就是 CPU 打满。
    pub spurious_wakes: u64,
    /// 结束时两端的状态，排查失败种子用。
    pub final_states: [String; 2],
    pub final_stats: [Option<agent_net_core::Stats>; 2],
    /// 两端握手完成的时刻，见 `Peer::established_at`。
    pub established_at: [Option<u64>; 2],
}

pub(crate) fn stream_byte(stream: u64, index: u64) -> u8 {
    let mixed = (index ^ stream).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    (mixed >> 56) as u8
}

struct Side<P> {
    peer: P,
    out: Link,
    stream: u64,
    to_write: u64,
    written: u64,
    expect: u64,
    delivered: u64,
    incoming_stream: u64,
    /// 已生成、还没被写入的数据。发送缓冲满时不能每一步都重新生成，否则模拟器自己就成了最慢的部分。
    pending: Vec<u8>,
    pending_offset: usize,
}

fn mix(trace: &mut u64, value: u64) {
    *trace = (*trace ^ value).wrapping_mul(0x0000_0100_0000_01B3);
}

/// 驱动两个端点传完工作量。每个到达的字节都和发送内容逐一核对。
pub fn run<P: Peer>(a: P, b: P, a_link: LinkProfile, b_link: LinkProfile, workload: &Workload, seed: u64) -> Outcome {
    let mut sides = [
        Side {
            peer: a,
            out: Link::new(a_link, seed ^ 0xA5A5),
            stream: seed,
            to_write: workload.a_to_b_bytes,
            written: 0,
            expect: workload.b_to_a_bytes,
            delivered: 0,
            incoming_stream: seed.rotate_left(17),
            pending: Vec::new(),
            pending_offset: 0,
        },
        Side {
            peer: b,
            out: Link::new(b_link, seed ^ 0x5A5A),
            stream: seed.rotate_left(17),
            to_write: workload.b_to_a_bytes,
            written: 0,
            expect: workload.a_to_b_bytes,
            delivered: 0,
            incoming_stream: seed,
            pending: Vec::new(),
            pending_offset: 0,
        },
    ];
    let mut outcome = Outcome { trace: 0xCBF2_9CE4_8422_2325, ..Outcome::default() };
    let mut arrivals: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>> = BinaryHeap::new();
    let mut order = 0u64;
    let mut now = 0u64;
    let mut next_read = 0u64;
    let mut progressed_total = 0u64;
    let mut progressed_at = 0u64;
    let mut incoming = vec![0u8; 64 * 1024];

    loop {
        outcome.steps += 1;
        if outcome.steps > 200_000_000 {
            outcome.violation = Some("simulation step limit reached".into());
            return outcome;
        }

        for side in &mut sides {
            loop {
                if side.pending_offset == side.pending.len() {
                    if side.written == side.to_write {
                        break;
                    }
                    let size = workload.write_chunk.min((side.to_write - side.written) as usize);
                    let start = side.written;
                    side.pending.clear();
                    side.pending.extend((0..size as u64).map(|offset| stream_byte(side.stream, start + offset)));
                    side.pending_offset = 0;
                    side.written += size as u64;
                }
                let accepted = side.peer.write(now, &side.pending[side.pending_offset..]);
                side.pending_offset += accepted;
                if accepted == 0 {
                    break;
                }
            }
        }

        let paused = workload.read_pause.is_some_and(|(start, end)| start <= now && now < end);
        if !paused && now >= next_read {
            for side in &mut sides {
                let limit = if workload.read_interval_us == 0 { usize::MAX } else { workload.read_bytes };
                let mut budget = limit;
                while budget > 0 {
                    let want = budget.min(incoming.len());
                    let size = side.peer.read(now, &mut incoming[..want]);
                    if size == 0 {
                        break;
                    }
                    budget -= size;
                    for (offset, &byte) in incoming[..size].iter().enumerate() {
                        let index = side.delivered + offset as u64;
                        if byte != stream_byte(side.incoming_stream, index) && outcome.violation.is_none() {
                            outcome.violation = Some(format!("byte {index} differs from what was sent"));
                        }
                    }
                    side.delivered += size as u64;
                    if side.delivered > side.expect && outcome.violation.is_none() {
                        outcome.violation = Some(format!("{} bytes delivered, only {} sent", side.delivered, side.expect));
                    }
                    mix(&mut outcome.trace, side.delivered ^ now);
                }
            }
            if workload.read_interval_us > 0 {
                next_read = now + workload.read_interval_us;
            }
        }
        if outcome.violation.is_some() {
            outcome.finish_us = now;
            return outcome;
        }

        for (index, side) in sides.iter_mut().enumerate() {
            let target = 1 - index;
            let Side { peer, out, .. } = side;
            let wire = &mut outcome.wire_bytes;
            let packets = &mut outcome.packets;
            let trace = &mut outcome.trace;
            peer.pump(now, &mut |packet| {
                *wire += packet.len() as u64;
                *packets += 1;
                mix(trace, packet.len() as u64 ^ (now << 8));
                let (times, count) = out.transmit(now, packet.len());
                for &at in &times[..count] {
                    order += 1;
                    arrivals.push(Reverse((at, order, target, packet.to_vec())));
                }
            });
            outcome.peak_buffered = outcome.peak_buffered.max(peer.buffered());
            if peer.wake_at().is_some_and(|at| at <= now) {
                outcome.spurious_wakes += 1;
            }
        }

        if sides.iter().all(|side| side.delivered >= side.expect) {
            outcome.finished = true;
            outcome.finish_us = now;
            outcome.final_states = [sides[0].peer.describe(), sides[1].peer.describe()];
            outcome.final_stats = [sides[0].peer.stats(), sides[1].peer.stats()];
            outcome.established_at = [sides[0].peer.established_at(), sides[1].peer.established_at()];
            return outcome;
        }
        let delivered_total = sides[0].delivered + sides[1].delivered;
        if delivered_total != progressed_total {
            progressed_total = delivered_total;
            progressed_at = now;
        } else if now - progressed_at > workload.stall_limit_us {
            outcome.finish_us = now;
            outcome.violation = Some(format!("no progress for {}us", now - progressed_at));
            outcome.final_states = [sides[0].peer.describe(), sides[1].peer.describe()];
            return outcome;
        }
        if sides.iter().any(|side| side.peer.is_dead()) {
            outcome.finish_us = now;
            outcome.final_states = [sides[0].peer.describe(), sides[1].peer.describe()];
            return outcome;
        }

        let mut next = arrivals.peek().map(|Reverse(item)| item.0);
        for side in &sides {
            if let Some(at) = side.peer.wake_at() {
                next = Some(next.map_or(at, |value| value.min(at)));
            }
        }
        if workload.read_interval_us > 0 {
            next = Some(next.map_or(next_read, |value| value.min(next_read)));
        }
        if let Some((_, end)) = workload.read_pause {
            if now < end {
                next = Some(next.map_or(end, |value| value.min(end)));
            }
        }
        let Some(next) = next else {
            outcome.violation = Some("both sides went idle before the transfer finished".into());
            return outcome;
        };
        now = next.max(now + 1);
        if now > workload.time_limit_us {
            outcome.finish_us = now;
            outcome.violation = Some("time limit reached".into());
            outcome.final_states = [sides[0].peer.describe(), sides[1].peer.describe()];
            return outcome;
        }

        while arrivals.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Some(Reverse((_, _, target, packet))) = arrivals.pop() else { break };
            sides[target].peer.input(now, &packet);
        }
        for side in &mut sides {
            if side.peer.wake_at().is_some_and(|at| at <= now) {
                side.peer.on_wake(now);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LatencyReport {
    pub delivered: usize,
    pub sent: usize,
    pub wire_bytes: u64,
    pub samples_us: Vec<u64>,
}

impl LatencyReport {
    pub fn percentile_ms(&self, percentile: f64) -> f64 {
        if self.samples_us.is_empty() {
            return f64::NAN;
        }
        let mut sorted = self.samples_us.clone();
        sorted.sort_unstable();
        let index = ((percentile / 100.0) * sorted.len() as f64).ceil() as usize;
        sorted[index.clamp(1, sorted.len()) - 1] as f64 / 1000.0
    }
}

/// 交互负载：A 每隔固定时间发一条短消息，统计每条到达 B 的单向延迟。
pub fn run_interactive<P: Peer>(
    mut a: P,
    mut b: P,
    a_link: LinkProfile,
    b_link: LinkProfile,
    messages: usize,
    message_bytes: usize,
    interval_us: u64,
    seed: u64,
) -> LatencyReport {
    let mut out_a = Link::new(a_link, seed ^ 0xA5A5);
    let mut out_b = Link::new(b_link, seed ^ 0x5A5A);
    let mut arrivals: BinaryHeap<Reverse<(u64, u64, usize, Vec<u8>)>> = BinaryHeap::new();
    let mut order = 0u64;
    let mut now = 0u64;
    let mut sent = 0usize;
    let mut delivered_bytes = 0usize;
    let mut sample_index = 0usize;
    let mut report = LatencyReport { sent: messages, ..LatencyReport::default() };
    let payload = vec![7u8; message_bytes];
    let mut incoming = vec![0u8; 64 * 1024];
    let end = messages as u64 * interval_us + 30_000_000;

    while now <= end {
        if sent < messages && now >= sent as u64 * interval_us {
            let accepted = a.write(now, &payload);
            debug_assert_eq!(accepted, message_bytes);
            sent += 1;
        }
        loop {
            let size = b.read(now, &mut incoming);
            if size == 0 {
                break;
            }
            delivered_bytes += size;
            while (sample_index + 1) * message_bytes <= delivered_bytes {
                report.samples_us.push(now - sample_index as u64 * interval_us);
                sample_index += 1;
            }
        }
        let (wire, ordering, heap) = (&mut report.wire_bytes, &mut order, &mut arrivals);
        a.pump(now, &mut |packet| {
            *wire += packet.len() as u64;
            let (times, count) = out_a.transmit(now, packet.len());
            for &at in &times[..count] {
                *ordering += 1;
                heap.push(Reverse((at, *ordering, 1, packet.to_vec())));
            }
        });
        b.pump(now, &mut |packet| {
            *wire += packet.len() as u64;
            let (times, count) = out_b.transmit(now, packet.len());
            for &at in &times[..count] {
                *ordering += 1;
                heap.push(Reverse((at, *ordering, 0, packet.to_vec())));
            }
        });
        if sample_index == messages {
            break;
        }

        let mut next = (sent < messages).then_some(sent as u64 * interval_us);
        for candidate in [arrivals.peek().map(|Reverse(item)| item.0), a.wake_at(), b.wake_at()].into_iter().flatten() {
            next = Some(next.map_or(candidate, |value| value.min(candidate)));
        }
        let Some(next) = next else { break };
        now = next.max(now + 1);
        while arrivals.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Some(Reverse((_, _, target, packet))) = arrivals.pop() else { break };
            if target == 0 { a.input(now, &packet) } else { b.input(now, &packet) }
        }
        if a.wake_at().is_some_and(|at| at <= now) {
            a.on_wake(now);
        }
        if b.wake_at().is_some_and(|at| at <= now) {
            b.on_wake(now);
        }
    }
    report.delivered = sample_index;
    report
}

/// 一个随机测试场景：网络条件、连接配置和工作量都由种子决定。
#[derive(Clone, Debug)]
pub struct Case {
    pub seed: u64,
    pub config: Config,
    pub a_link: LinkProfile,
    pub b_link: LinkProfile,
    pub workload: Workload,
}

pub(crate) fn random_link(rng: &mut Rng, outages: &[(u64, u64)]) -> LinkProfile {
    let delay_us = rng.pick(&[100, 1_000, 5_000, 20_000, 50_000, 150_000, 300_000]);
    let bursty = rng.chance(0.25);
    let quota = rng.chance(0.2);
    let bucket = rng.chance(0.2);
    LinkProfile {
        bits_per_second: rng.pick(&[0, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000]),
        delay_us,
        jitter_us: rng.pick(&[0, 1_000, 10_000, delay_us / 2]),
        loss: rng.pick(&[0.0, 0.005, 0.01, 0.05, 0.1, 0.2, 0.3]),
        burst_every_us: if bursty { 2_000_000 } else { 0 },
        burst_len_us: 300_000,
        burst_loss: 0.9,
        duplicate: rng.pick(&[0.0, 0.0, 0.01, 0.05]),
        reorder: rng.pick(&[0.0, 0.0, 0.01, 0.05, 0.2]),
        reorder_extra_us: rng.pick(&[1_000, 10_000, 50_000]),
        queue_us: rng.pick(&[5_000, 50_000, 200_000]),
        outages: outages.to_vec(),
        quota_bytes: if quota { rng.pick(&[50_000, 250_000, 1_000_000]) } else { 0 },
        quota_window_us: rng.pick(&[100_000, 1_000_000]),
        wander_us: 0,
        wander_period_us: 0,
        bucket_bytes_per_second: if bucket { rng.pick(&[100_000, 700_000, 5_000_000]) } else { 0 },
        bucket_depth_bytes: rng.pick(&[20_000, 200_000, 600_000]),
        stall_every_us: 0,
        stall_us: 0,
    }
}

pub fn random_case(seed: u64) -> Case {
    let mut rng = Rng::new(seed);
    let window = rng.pick(&[8u32, 32, 128, 512]);
    let config = Config {
        // 四分之一的种子走让路模式。不从 `rng` 取，其它种子的场景不变。
        bandwidth_share: if seed % 4 == 0 { BandwidthShare::Fair } else { BandwidthShare::Full },
        max_packet_size: rng.pick(&[64, 600, 1200, 1400]),
        send_window: window,
        recv_window: window.max(rng.pick(&[8u32, 64, 256])),
        send_buffer_bytes: rng.pick(&[8 * 1024, 64 * 1024, 1024 * 1024]),
        reorder_threshold: rng.pick(&[2, 3, 5]),
        initial_sequence: if rng.chance(0.2) { u32::MAX as u64 - rng.below(64) } else { 0 },
        initial_packet_number: if rng.chance(0.2) { u32::MAX as u64 - rng.below(64) } else { 0 },
        ..Config::default()
    };
    let mut outages = Vec::new();
    if rng.chance(0.3) {
        let start = rng.below(2_000_000);
        outages.push((start, start + 100_000 + rng.below(2_900_000)));
    }
    let a_link = random_link(&mut rng, &outages);
    let b_link = random_link(&mut rng, &outages);
    let size = rng.pick(&[1u64, 1024, 16 * 1024, 64 * 1024, 256 * 1024]);
    let workload = Workload {
        a_to_b_bytes: size + rng.below(size),
        b_to_a_bytes: if rng.chance(0.5) { size / 2 + rng.below(size) } else { 0 },
        write_chunk: rng.pick(&[100, 1500, 4096, 65536]),
        ..Workload::default()
    };
    Case { seed, config, a_link, b_link, workload }
}

pub fn run_case(case: &Case) -> Outcome {
    run(
        CorePeer::new(case.config.clone()),
        CorePeer::new(case.config.clone()),
        case.a_link.clone(),
        case.b_link.clone(),
        &case.workload,
        case.seed,
    )
}

/// 和 KCP 对比用的网络条件。
pub struct Scenario {
    pub label: &'static str,
    /// 留出场景：不拿来调参，只用来确认优化没有过拟合。看过结果后要改成普通场景，换一批新的。
    pub holdout: bool,
    /// 批量数据的方向。
    pub link: LinkProfile,
    /// 确认的方向。
    pub back: LinkProfile,
}

pub fn scenarios() -> Vec<Scenario> {
    let base = LinkProfile { bits_per_second: 100_000_000, delay_us: 20_000, jitter_us: 1_000, queue_us: 50_000, ..LinkProfile::default() };
    let tuned = |label, link: LinkProfile| Scenario { label, holdout: false, back: link.clone(), link };
    let holdout = |label, link: LinkProfile| Scenario { label, holdout: true, back: link.clone(), link };
    let asymmetric = |label, link, back| Scenario { label, holdout: false, link, back };
    // 按 2026-10-30 实测的 Mac 到 aotu-dev 路径建模，两个方向完全不同。
    let china_to_overseas = LinkProfile { bits_per_second: 1_000_000_000, delay_us: 45_000, jitter_us: 5_000, queue_us: 20_000, bucket_bytes_per_second: 708_000, bucket_depth_bytes: 600_000, ..LinkProfile::default() };
    let overseas_to_china = LinkProfile { bits_per_second: 100_000_000, delay_us: 45_000, jitter_us: 8_000, loss: 0.17, queue_us: 50_000, ..LinkProfile::default() };
    vec![
        tuned("无丢包 40ms", base.clone()),
        tuned("丢包 1%", LinkProfile { loss: 0.01, ..base.clone() }),
        tuned("丢包 5%", LinkProfile { loss: 0.05, ..base.clone() }),
        tuned("丢包 15%", LinkProfile { loss: 0.15, ..base.clone() }),
        tuned("丢包 30%", LinkProfile { loss: 0.30, ..base.clone() }),
        tuned("突发丢包", LinkProfile { burst_every_us: 2_000_000, burst_len_us: 300_000, burst_loss: 0.9, ..base.clone() }),
        tuned("乱序 10%", LinkProfile { reorder: 0.1, reorder_extra_us: 30_000, ..base.clone() }),
        tuned("高延迟 300ms 丢包 5%", LinkProfile { delay_us: 150_000, loss: 0.05, ..base.clone() }),
        tuned("弱网 2Mbit 80ms 丢包 5%", LinkProfile { bits_per_second: 2_000_000, delay_us: 40_000, jitter_us: 10_000, loss: 0.05, queue_us: 200_000, ..base.clone() }),
        tuned("千兆 2ms 丢包 0.1%", LinkProfile { bits_per_second: 1_000_000_000, delay_us: 1_000, jitter_us: 200, loss: 0.001, queue_us: 20_000, ..LinkProfile::default() }),
        tuned("50Mbit 20ms 丢包 2%", LinkProfile { bits_per_second: 50_000_000, delay_us: 10_000, jitter_us: 3_000, loss: 0.02, queue_us: 30_000, ..LinkProfile::default() }),
        tuned("手机 10Mbit 100ms 抖动 30ms 丢包 3%", LinkProfile { bits_per_second: 10_000_000, delay_us: 50_000, jitter_us: 30_000, loss: 0.03, queue_us: 150_000, ..LinkProfile::default() }),
        tuned("小队列 5Mbit 60ms 丢包 1%", LinkProfile { bits_per_second: 5_000_000, delay_us: 30_000, jitter_us: 2_000, loss: 0.01, queue_us: 10_000, ..LinkProfile::default() }),
        tuned("重复 5% 乱序 5% 丢包 3%", LinkProfile { bits_per_second: 20_000_000, delay_us: 25_000, jitter_us: 5_000, loss: 0.03, duplicate: 0.05, reorder: 0.05, reorder_extra_us: 20_000, queue_us: 50_000, ..LinkProfile::default() }),
        tuned("低速 1Mbit 200ms 丢包 2%", LinkProfile { bits_per_second: 1_000_000, delay_us: 100_000, jitter_us: 5_000, loss: 0.02, queue_us: 50_000, ..LinkProfile::default() }),
        tuned("卫星 20Mbit 600ms 丢包 1%", LinkProfile { bits_per_second: 20_000_000, delay_us: 300_000, jitter_us: 10_000, loss: 0.01, queue_us: 300_000, ..LinkProfile::default() }),
        tuned("Wi-Fi 200Mbit 8ms 抖动 4ms 短突发", LinkProfile { bits_per_second: 200_000_000, delay_us: 4_000, jitter_us: 4_000, loss: 0.005, burst_every_us: 1_000_000, burst_len_us: 50_000, burst_loss: 0.5, queue_us: 20_000, ..LinkProfile::default() }),
        tuned("地铁 30Mbit 60ms 每 5 秒断 1 秒", LinkProfile { bits_per_second: 30_000_000, delay_us: 30_000, jitter_us: 10_000, loss: 0.02, burst_every_us: 5_000_000, burst_len_us: 1_000_000, burst_loss: 1.0, queue_us: 100_000, ..LinkProfile::default() }),
        tuned("跨境 50Mbit 180ms 丢包 8% 乱序 3%", LinkProfile { bits_per_second: 50_000_000, delay_us: 90_000, jitter_us: 15_000, loss: 0.08, reorder: 0.03, reorder_extra_us: 40_000, queue_us: 100_000, ..LinkProfile::default() }),
        asymmetric("实测路径 下载 令牌桶 5.7Mbit", china_to_overseas.clone(), overseas_to_china.clone()),
        asymmetric("实测路径 上传 随机丢包 17%", overseas_to_china, china_to_overseas),
        tuned("配额 20Mbit 40ms 短窗口", LinkProfile { bits_per_second: 1_000_000_000, delay_us: 20_000, jitter_us: 1_000, queue_us: 20_000, quota_bytes: 250_000, quota_window_us: 100_000, ..LinkProfile::default() }),
        tuned("家宽 300Mbit 25ms 丢包 0.3%", LinkProfile { bits_per_second: 300_000_000, delay_us: 12_500, jitter_us: 2_000, loss: 0.003, queue_us: 40_000, ..LinkProfile::default() }),
        tuned("4G 20Mbit 70ms 抖动 20ms 丢包 1.5%", LinkProfile { bits_per_second: 20_000_000, delay_us: 35_000, jitter_us: 20_000, loss: 0.015, queue_us: 200_000, ..LinkProfile::default() }),
        tuned("跨洋 100Mbit 250ms 丢包 0.5%", LinkProfile { bits_per_second: 100_000_000, delay_us: 125_000, jitter_us: 5_000, loss: 0.005, queue_us: 120_000, ..LinkProfile::default() }),
        tuned("拥挤 Wi-Fi 30Mbit 15ms 抖动 10ms 丢包 6%", LinkProfile { bits_per_second: 30_000_000, delay_us: 7_500, jitter_us: 10_000, loss: 0.06, reorder: 0.02, reorder_extra_us: 10_000, queue_us: 60_000, ..LinkProfile::default() }),
        tuned("山区 3Mbit 150ms 丢包 10% 突发", LinkProfile { bits_per_second: 3_000_000, delay_us: 75_000, jitter_us: 15_000, loss: 0.10, burst_every_us: 3_000_000, burst_len_us: 200_000, burst_loss: 0.8, queue_us: 300_000, ..LinkProfile::default() }),
        holdout("留出 校园网 40Mbit 30ms 丢包 0.8%", LinkProfile { bits_per_second: 40_000_000, delay_us: 15_000, jitter_us: 3_000, loss: 0.008, queue_us: 40_000, ..LinkProfile::default() }),
        holdout("留出 5G 100Mbit 35ms 抖动 15ms 丢包 0.5%", LinkProfile { bits_per_second: 100_000_000, delay_us: 17_500, jitter_us: 15_000, loss: 0.005, queue_us: 80_000, ..LinkProfile::default() }),
        holdout("留出 欧美 30Mbit 200ms 丢包 2%", LinkProfile { bits_per_second: 30_000_000, delay_us: 100_000, jitter_us: 6_000, loss: 0.02, queue_us: 100_000, ..LinkProfile::default() }),
        holdout("留出 令牌桶 10Mbit 60ms 突发 300KB", LinkProfile { bits_per_second: 1_000_000_000, delay_us: 30_000, jitter_us: 3_000, queue_us: 20_000, bucket_bytes_per_second: 1_250_000, bucket_depth_bytes: 300_000, ..LinkProfile::default() }),
        holdout("留出 高铁 15Mbit 80ms 丢包 4% 短断网", LinkProfile { bits_per_second: 15_000_000, delay_us: 40_000, jitter_us: 12_000, loss: 0.04, burst_every_us: 4_000_000, burst_len_us: 400_000, burst_loss: 1.0, queue_us: 120_000, ..LinkProfile::default() }),
    ]
}

#[cfg(test)]
mod link_tests {
    use super::{Link, LinkProfile};

    // 性能对照的时序合同：相同种子的突发时段不受算法发包量影响。
    // Link::transmit 是 compare 和真实 UDP 损伤代理使用的入口；额外流量不应移动断网时段。
    #[test]
    fn burst_calendar_is_independent_of_packet_count() {
        let profile = LinkProfile { burst_every_us: 100_000, burst_len_us: 50_000, burst_loss: 1.0, ..LinkProfile::default() };
        let mut sparse = Link::new(profile.clone(), 71);
        let mut busy = Link::new(profile, 71);
        for now in (0..2_000_000).step_by(1_000) {
            assert_eq!(sparse.transmit(now, 32).1, busy.transmit(now, 32).1, "burst calendar shifted at {now}us");
            busy.transmit(now + 100, 32);
            busy.transmit(now + 500, 32);
        }
    }
}
