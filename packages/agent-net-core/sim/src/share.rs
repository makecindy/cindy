//! 几个发送方共用一个瓶颈，看各自分到多少。只用于测试，不进入产品。
//!
//! 每条流有自己的两端，数据都从同一条 [`Link`] 过，排队和丢包互相影响；确认走另一个方向，不拥塞，只有延迟。
//! TCP 对手是 [`TcpSender`]：按 RFC 8312 写的 CUBIC 和 Reno，带 SACK 判丢、最小 200 毫秒的超时和基于延迟的提前退出慢启动，
//! 和 Linux、macOS 默认行为同类，但不是完整的 TCP 栈。

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use agent_net_core::{Config, Connection};

use crate::{Link, LinkProfile};

/// 线上一个 TCP 段的大小，和 agent-net 的包一样大，比较时不用再折算。
const TCP_WIRE_BYTES: usize = 1400;
const TCP_PAYLOAD_BYTES: u64 = 1360;
const TCP_ACK_BYTES: usize = 40;
/// Linux 延迟确认的下限。
const TCP_DELAYED_ACK_US: u64 = 40_000;
const TCP_INITIAL_WINDOW: f64 = 10.0;
const TCP_MIN_RTO_US: u64 = 200_000;
const DUP_THRESHOLD: u64 = 3;
const CUBIC_C: f64 = 0.4;
const CUBIC_BETA: f64 = 0.7;
/// 没有事发生时也要隔这么久回到循环，应用要写数据。
const TICK_US: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TcpVariant {
    Cubic,
    Reno,
}

#[derive(Clone, Debug)]
pub enum FlowKind {
    AgentNet(Config),
    /// 每段都确认，发得很匀。
    Tcp(TcpVariant),
    /// 和真机一样两段确认一次，发送方一次补两段，成串打到瓶颈上。限速器上成串的包比匀速的丢得多。
    TcpDelayedAck(TcpVariant),
}

#[derive(Clone, Debug)]
pub struct Flow {
    pub kind: FlowKind,
    pub start_us: u64,
    /// 这条流比瓶颈多走的往返时间，一半在去程，一半在回程。
    pub extra_rtt_us: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ShareResult {
    /// 每条流在统计时段内送达的字节。
    pub delivered: Vec<u64>,
    /// 统计时段内每条流的吞吐，bit/s。
    pub rates: Vec<f64>,
    /// 瓶颈排队时间的平均值，微秒。
    pub mean_queue_us: u64,
    /// 瓶颈上丢掉的包占比。
    pub loss: f64,
    /// 瓶颈利用率。
    pub utilization: f64,
    /// 结束时每条 agent-net 流发送端的统计。
    pub stats: Vec<Option<agent_net_core::Stats>>,
    /// 瓶颈收到的线上字节，按流分。
    pub offered_bytes: Vec<u64>,
}

/// 按 RFC 8312 写的 TCP 发送方，单位是段。
pub struct TcpSender {
    variant: TcpVariant,
    cwnd: f64,
    ssthresh: f64,
    /// 已发还没确认的段：序号 → 发送时间。
    outstanding: BTreeMap<u64, u64>,
    lost: BTreeSet<u64>,
    next_seq: u64,
    highest_sacked: Option<u64>,
    /// 确认过的段里最晚发出的时间。比它早发、还没确认的才算丢：重传的段刚发出去，不能再判一次。
    latest_acked_sent_at: u64,
    recovery_end: Option<u64>,
    srtt_us: u64,
    rttvar_us: u64,
    min_rtt_us: u64,
    round_end: u64,
    round_min_rtt_us: u64,
    last_round_min_rtt_us: u64,
    w_max: f64,
    epoch_start: Option<u64>,
    rto_at: Option<u64>,
    backoff: u32,
}

impl TcpSender {
    pub fn new(variant: TcpVariant) -> Self {
        Self {
            variant,
            cwnd: TCP_INITIAL_WINDOW,
            ssthresh: f64::MAX,
            outstanding: BTreeMap::new(),
            lost: BTreeSet::new(),
            next_seq: 0,
            highest_sacked: None,
            latest_acked_sent_at: 0,
            recovery_end: None,
            srtt_us: 0,
            rttvar_us: 0,
            min_rtt_us: u64::MAX,
            round_end: 0,
            round_min_rtt_us: u64::MAX,
            last_round_min_rtt_us: u64::MAX,
            w_max: 0.0,
            epoch_start: None,
            rto_at: None,
            backoff: 0,
        }
    }

    /// 在途段数。判丢了的已经不在路上。
    fn in_flight(&self) -> u64 {
        self.outstanding.len() as u64 - self.lost.len() as u64
    }

    /// 取下一个要发的段。
    pub fn poll_send(&mut self, now_us: u64) -> Option<u64> {
        if (self.in_flight() as f64) >= self.cwnd {
            return None;
        }
        let seq = match self.lost.pop_first() {
            Some(seq) => seq,
            None => {
                self.next_seq += 1;
                self.next_seq - 1
            }
        };
        self.outstanding.insert(seq, now_us);
        self.rto_at.get_or_insert(now_us + self.rto_us());
        Some(seq)
    }

    fn rto_us(&self) -> u64 {
        let rto = if self.srtt_us == 0 { 1_000_000 } else { self.srtt_us + (4 * self.rttvar_us).max(1_000) };
        rto.max(TCP_MIN_RTO_US) << self.backoff.min(6)
    }

    fn observe_rtt(&mut self, rtt_us: u64) {
        if self.srtt_us == 0 {
            self.srtt_us = rtt_us;
            self.rttvar_us = rtt_us / 2;
        } else {
            self.rttvar_us = (3 * self.rttvar_us + self.srtt_us.abs_diff(rtt_us)) / 4;
            self.srtt_us = (7 * self.srtt_us + rtt_us) / 8;
        }
        self.min_rtt_us = self.min_rtt_us.min(rtt_us);
        self.round_min_rtt_us = self.round_min_rtt_us.min(rtt_us);
    }

    fn grow(&mut self, now_us: u64, acked: f64) {
        if self.cwnd < self.ssthresh {
            self.cwnd += acked;
            return;
        }
        match self.variant {
            TcpVariant::Reno => self.cwnd += acked / self.cwnd,
            TcpVariant::Cubic => {
                let epoch = *self.epoch_start.get_or_insert(now_us);
                let elapsed = (now_us - epoch) as f64 / 1e6;
                let k = (self.w_max * (1.0 - CUBIC_BETA) / CUBIC_C).cbrt();
                let rtt = (self.srtt_us.max(1)) as f64 / 1e6;
                let cubic = CUBIC_C * (elapsed + rtt - k).powi(3) + self.w_max;
                // 低带宽延迟积时不比 Reno 慢。
                let friendly = self.w_max * CUBIC_BETA + 3.0 * (1.0 - CUBIC_BETA) / (1.0 + CUBIC_BETA) * elapsed / rtt;
                let target = cubic.max(friendly).max(self.cwnd);
                self.cwnd += acked * ((target - self.cwnd) / self.cwnd).min(1.0);
            }
        }
    }

    fn reduce(&mut self) {
        if self.variant == TcpVariant::Cubic {
            // 快速收敛：比上次的峰值还低时再让一点，给后来的流腾地方。
            self.w_max = if self.cwnd < self.w_max { self.cwnd * (1.0 + CUBIC_BETA) / 2.0 } else { self.cwnd };
            self.ssthresh = (self.cwnd * CUBIC_BETA).max(2.0);
        } else {
            self.ssthresh = (self.cwnd / 2.0).max(2.0);
        }
        self.cwnd = self.ssthresh;
        self.epoch_start = None;
    }

    pub fn on_ack(&mut self, now_us: u64, cumulative: u64, sacked: Option<u64>) {
        let mut newly_acked = 0.0;
        while let Some((&seq, &sent)) = self.outstanding.first_key_value() {
            if seq >= cumulative {
                break;
            }
            self.outstanding.remove(&seq);
            if !self.lost.remove(&seq) {
                self.observe_rtt(now_us.saturating_sub(sent));
                newly_acked += 1.0;
            }
        }
        if let Some(seq) = sacked
            && let Some(sent) = self.outstanding.remove(&seq)
        {
            if !self.lost.remove(&seq) {
                self.observe_rtt(now_us.saturating_sub(sent));
                newly_acked += 1.0;
            }
            self.latest_acked_sent_at = self.latest_acked_sent_at.max(sent);
            self.highest_sacked = Some(self.highest_sacked.map_or(seq, |value| value.max(seq)));
        }
        if cumulative >= self.round_end {
            // 慢启动里一轮的最小 RTT 涨了，说明队列开始排了，提前退出，别等丢包。
            if self.cwnd < self.ssthresh
                && self.cwnd >= 16.0
                && self.round_min_rtt_us != u64::MAX
                && self.last_round_min_rtt_us != u64::MAX
                && self.round_min_rtt_us >= self.last_round_min_rtt_us + (self.last_round_min_rtt_us / 8).clamp(4_000, 16_000)
            {
                self.ssthresh = self.cwnd;
            }
            self.last_round_min_rtt_us = self.round_min_rtt_us;
            self.round_min_rtt_us = u64::MAX;
            self.round_end = self.next_seq;
        }
        if self.recovery_end.is_some_and(|end| cumulative >= end) {
            self.recovery_end = None;
        }
        // 后面已经到了 3 段的，判丢。
        if let Some(highest) = self.highest_sacked {
            let suspects: Vec<u64> = self
                .outstanding
                .range(..highest.saturating_sub(DUP_THRESHOLD - 1))
                .filter(|&(seq, &sent)| sent < self.latest_acked_sent_at && !self.lost.contains(seq))
                .map(|(&seq, _)| seq)
                .collect();
            if !suspects.is_empty() {
                self.lost.extend(suspects);
                if self.recovery_end.is_none() {
                    self.recovery_end = Some(self.next_seq);
                    self.reduce();
                }
            }
        }
        if newly_acked > 0.0 {
            self.backoff = 0;
            self.rto_at = (!self.outstanding.is_empty()).then(|| now_us + self.rto_us());
            if self.recovery_end.is_none() {
                self.grow(now_us, newly_acked);
            }
        }
    }

    pub fn next_timer(&self) -> Option<u64> {
        self.rto_at
    }

    pub fn on_timer(&mut self, now_us: u64) {
        if self.rto_at.is_none_or(|at| at > now_us) {
            return;
        }
        self.lost.extend(self.outstanding.keys().copied());
        self.reduce();
        self.cwnd = 1.0;
        self.recovery_end = Some(self.next_seq);
        self.backoff += 1;
        self.rto_at = Some(now_us + self.rto_us());
    }
}

/// TCP 接收方：记下连续收到了多少，再报最新收到的一段。
#[derive(Default)]
pub struct TcpReceiver {
    cumulative: u64,
    out_of_order: BTreeSet<u64>,
    delayed_ack: bool,
    /// 手里压着一段没确认。
    holding: bool,
}

impl TcpReceiver {
    /// 返回这次累计确认到哪里、新到的是哪一段，和新增了多少连续字节的段数。
    pub fn on_segment(&mut self, seq: u64) -> (u64, u64, u64) {
        let before = self.cumulative;
        if seq >= self.cumulative {
            self.out_of_order.insert(seq);
        }
        while self.out_of_order.remove(&self.cumulative) {
            self.cumulative += 1;
        }
        (self.cumulative, seq, self.cumulative - before)
    }

    /// 按序到达的两段确认一次；乱序或补上空洞要马上确认，不然发送方判不了丢。
    fn ack_now(&mut self, advanced: u64) -> bool {
        let now = !self.delayed_ack || advanced != 1 || self.holding || !self.out_of_order.is_empty();
        self.holding = !now;
        now
    }

    /// 延迟确认的定时器到了。返回要确认到哪里。
    fn ack_timer(&mut self) -> Option<u64> {
        std::mem::take(&mut self.holding).then_some(self.cumulative)
    }
}

enum Endpoint {
    AgentNet { sender: Box<Connection>, receiver: Box<Connection> },
    Tcp { sender: TcpSender, receiver: TcpReceiver },
}

enum Message {
    AgentNetData(Vec<u8>),
    AgentNetBack(Vec<u8>),
    TcpData(u64),
    TcpAck(u64, u64),
    TcpAckTimer,
}

struct Runner {
    flows: Vec<(Flow, Endpoint)>,
    link: Link,
    bottleneck_us: u64,
    /// (到达时间, 顺序, 流, 内容)。内容放在 `messages` 里，堆里只留下标。
    heap: BinaryHeap<Reverse<(u64, u64, usize, usize)>>,
    messages: Vec<Option<Message>>,
    free: Vec<usize>,
    order: u64,
    offered: u64,
    dropped: u64,
    queue_sum_us: u128,
    queue_samples: u64,
    wire_bytes_measured: u64,
    measuring: bool,
    offered_bytes: Vec<u64>,
    last_arrival: Vec<u64>,
    timer_us: u64,
    /// 传给自研连接的时间都加上这个数，模拟时钟不从 0 开始的真实设备。
    clock_offset_us: u64,
}

impl Runner {
    fn push(&mut self, at: u64, flow: usize, message: Message) {
        self.order += 1;
        let slot = match self.free.pop() {
            Some(slot) => {
                self.messages[slot] = Some(message);
                slot
            }
            None => {
                self.messages.push(Some(message));
                self.messages.len() - 1
            }
        };
        self.heap.push(Reverse((at, self.order, flow, slot)));
    }

    /// 过瓶颈。返回到达时间，丢了就是空。
    fn through_bottleneck(&mut self, now_us: u64, index: usize, size: usize) -> Option<u64> {
        self.offered += 1;
        if self.measuring {
            self.offered_bytes[index] += size as u64;
        }
        let (times, count) = self.link.transmit(now_us, size);
        if count == 0 {
            self.dropped += 1;
            return None;
        }
        // 排队时间：到达时间减掉路径延迟和这个包自己的发送时间。
        let serialization = size as u64 * 8_000_000 / self.bottleneck_us.max(1);
        let queue = times[0].saturating_sub(now_us + serialization + self.link_delay_us());
        self.queue_sum_us += queue as u128;
        self.queue_samples += 1;
        if self.measuring {
            self.wire_bytes_measured += size as u64;
        }
        // 瓶颈先进先出：抖动不能让同一条流的包乱序，否则 TCP 模型会把乱序当丢包，自己把自己压垮。
        let arrival = times[0].max(self.last_arrival[index]);
        self.last_arrival[index] = arrival;
        Some(arrival)
    }

    fn link_delay_us(&self) -> u64 {
        self.link.profile_delay_us()
    }

    fn pump(&mut self, now_us: u64, index: usize, delivered: &mut [u64]) {
        if now_us < self.flows[index].0.start_us {
            return;
        }
        let extra = self.flows[index].0.extra_rtt_us / 2;
        let mut buffer = [0u8; 2048];
        let mut sink = [0u8; 8192];
        let chunk = [5u8; 4096];
        match self.flows[index].1 {
            Endpoint::AgentNet { .. } => {
                let mut outgoing = Vec::new();
                let mut back = Vec::new();
                let clock = now_us + self.clock_offset_us;
                if let Endpoint::AgentNet { sender, receiver } = &mut self.flows[index].1 {
                    let now_us = clock;
                    while sender.send(now_us, &chunk) == chunk.len() {}
                    loop {
                        let size = receiver.recv(now_us, &mut sink);
                        if size == 0 {
                            break;
                        }
                        delivered[index] += size as u64;
                    }
                    if sender.next_wake().is_some_and(|at| at <= now_us) {
                        sender.tick(now_us);
                    }
                    if receiver.next_wake().is_some_and(|at| at <= now_us) {
                        receiver.tick(now_us);
                    }
                    while let Some(size) = sender.poll_transmit(now_us, &mut buffer) {
                        outgoing.push(buffer[..size].to_vec());
                    }
                    while let Some(size) = receiver.poll_transmit(now_us, &mut buffer) {
                        back.push(buffer[..size].to_vec());
                    }
                }
                for packet in outgoing {
                    if let Some(at) = self.through_bottleneck(now_us, index, packet.len()) {
                        self.push(at + extra, index, Message::AgentNetData(packet));
                    }
                }
                let delay = self.link_delay_us() + extra;
                for packet in back {
                    self.push(now_us + delay, index, Message::AgentNetBack(packet));
                }
            }
            Endpoint::Tcp { .. } => loop {
                let Endpoint::Tcp { sender, .. } = &mut self.flows[index].1 else { return };
                sender.on_timer(now_us);
                let Some(seq) = sender.poll_send(now_us) else { break };
                if let Some(at) = self.through_bottleneck(now_us, index, TCP_WIRE_BYTES) {
                    self.push(at + extra, index, Message::TcpData(seq));
                }
            },
        }
    }

    fn deliver(&mut self, now_us: u64, index: usize, message: Message, delivered: &mut [u64]) {
        let extra = self.flows[index].0.extra_rtt_us / 2;
        let delay = self.link_delay_us() + extra;
        match (&mut self.flows[index].1, message) {
            (Endpoint::AgentNet { receiver, .. }, Message::AgentNetData(packet)) => {
                let _ = receiver.on_packet(now_us + self.clock_offset_us, &packet);
            }
            (Endpoint::AgentNet { sender, .. }, Message::AgentNetBack(packet)) => {
                let _ = sender.on_packet(now_us + self.clock_offset_us, &packet);
            }
            (Endpoint::Tcp { receiver, .. }, Message::TcpData(seq)) => {
                let (cumulative, seq, advanced) = receiver.on_segment(seq);
                delivered[index] += advanced * TCP_PAYLOAD_BYTES;
                let _ = TCP_ACK_BYTES;
                if receiver.ack_now(advanced) {
                    self.push(now_us + delay, index, Message::TcpAck(cumulative, seq));
                } else {
                    self.push(now_us + TCP_DELAYED_ACK_US, index, Message::TcpAckTimer);
                }
            }
            (Endpoint::Tcp { receiver, .. }, Message::TcpAckTimer) => {
                if let Some(cumulative) = receiver.ack_timer() {
                    self.push(now_us + delay, index, Message::TcpAck(cumulative, cumulative.saturating_sub(1)));
                }
            }
            (Endpoint::Tcp { sender, .. }, Message::TcpAck(cumulative, seq)) => {
                sender.on_ack(now_us, cumulative, Some(seq));
            }
            _ => unreachable!("message of another protocol"),
        }
    }

    fn next_event(&self, now_us: u64) -> u64 {
        let mut next = now_us + TICK_US;
        if let Some(Reverse(entry)) = self.heap.peek() {
            next = next.min(entry.0);
        }
        for (flow, endpoint) in &self.flows {
            if flow.start_us > now_us {
                next = next.min(flow.start_us);
                continue;
            }
            match endpoint {
                Endpoint::AgentNet { sender, receiver } => {
                    for wake in [sender.next_wake(), receiver.next_wake()].into_iter().flatten() {
                        next = next.min(wake.saturating_sub(self.clock_offset_us));
                    }
                }
                Endpoint::Tcp { sender, .. } => {
                    if let Some(at) = sender.next_timer() {
                        next = next.min(at);
                    }
                }
            }
        }
        // 真实的定时器和读 socket 的循环都有粒度，发送方只能在这些时刻动手。
        next.max(now_us + 1).div_ceil(self.timer_us) * self.timer_us
    }
}

/// 跑 `duration_us`，从 `measure_from_us` 起统计。
pub fn run_shared(link: &LinkProfile, flows: &[Flow], duration_us: u64, measure_from_us: u64, seed: u64) -> ShareResult {
    run_shared_with_timer(link, flows, duration_us, measure_from_us, seed, 1)
}

/// `timer_us` 是端点循环的粒度。模拟器默认想什么时候醒就什么时候醒，真机上做不到，低速时包的间隔和粒度差不多。
pub fn run_shared_with_timer(link: &LinkProfile, flows: &[Flow], duration_us: u64, measure_from_us: u64, seed: u64, timer_us: u64) -> ShareResult {
    let endpoints = flows.iter().cloned().map(|flow| {
        let endpoint = match &flow.kind {
            // 后加入的流在它开始的时候才建连接，和真实设备一样。
            FlowKind::AgentNet(config) => {
                let created = flow.start_us + std::env::var("SHARE_CLOCK_OFFSET_US").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
                Endpoint::AgentNet { sender: Box::new(Connection::new(config.clone(), created)), receiver: Box::new(Connection::new(config.clone(), created)) }
            }
            FlowKind::Tcp(variant) => Endpoint::Tcp { sender: TcpSender::new(*variant), receiver: TcpReceiver::default() },
            FlowKind::TcpDelayedAck(variant) => Endpoint::Tcp { sender: TcpSender::new(*variant), receiver: TcpReceiver { delayed_ack: true, ..TcpReceiver::default() } },
        };
        (flow, endpoint)
    });
    let mut runner = Runner {
        flows: endpoints.collect(),
        link: Link::new(link.clone(), seed),
        bottleneck_us: link.bits_per_second,
        heap: BinaryHeap::new(),
        messages: Vec::new(),
        free: Vec::new(),
        order: 0,
        offered: 0,
        dropped: 0,
        queue_sum_us: 0,
        queue_samples: 0,
        wire_bytes_measured: 0,
        measuring: false,
        offered_bytes: vec![0; flows.len()],
        last_arrival: vec![0; flows.len()],
        timer_us: timer_us.max(1),
        clock_offset_us: std::env::var("SHARE_CLOCK_OFFSET_US").ok().and_then(|value| value.parse().ok()).unwrap_or(0),
    };
    let mut delivered = vec![0u64; flows.len()];
    let mut at_start = vec![0u64; flows.len()];
    let mut now = 0;
    // 排查用：`SHARE_TRACE_US=200000` 每隔这么久打印各流的速度和内部统计。
    let trace_every: u64 = std::env::var("SHARE_TRACE_US").ok().and_then(|value| value.parse().ok()).unwrap_or(0);
    let (mut next_trace, mut traced) = (trace_every, vec![0u64; flows.len()]);
    while now < duration_us {
        if trace_every > 0 && now >= next_trace {
            let mut line = format!("{:>6}ms", now / 1000);
            for (index, (_, endpoint)) in runner.flows.iter().enumerate() {
                let rate = (delivered[index] - traced[index]) as f64 * 8.0 / trace_every as f64;
                traced[index] = delivered[index];
                if let Endpoint::AgentNet { sender, .. } = endpoint {
                    let stats = sender.stats();
                    line += &format!(
                        " | {rate:5.1}M 节奏{:5.1} 带宽{:5.1} 最小{:>3} 平滑{:>3} 随机{:>6} 上限{:5.1} 判丢{:>5}",
                        stats.pacing_rate as f64 * 8e-6, stats.bandwidth as f64 * 8e-6, stats.min_rtt_us / 1000, stats.srtt_us / 1000,
                        stats.random_loss_ppm, stats.rate_cap as f64 * 8e-6, stats.fast_losses + stats.timeout_losses
                    );
                } else {
                    line += &format!(" | {rate:5.1}M");
                }
            }
            eprintln!("{line}");
            next_trace += trace_every;
        }
        if !runner.measuring && now >= measure_from_us {
            runner.measuring = true;
            at_start.copy_from_slice(&delivered);
            runner.offered = 0;
            runner.dropped = 0;
            runner.queue_sum_us = 0;
            runner.queue_samples = 0;
        }
        // 定时器有粒度时所有流在同一时刻动手。真机的定时器不会对齐，顺序固定的话排在前面的流永远先占队列。
        let count = runner.flows.len();
        let first = if timer_us > 1 { (now / timer_us) as usize % count } else { 0 };
        for offset in 0..count {
            runner.pump(now, (first + offset) % count, &mut delivered);
        }
        now = runner.next_event(now);
        while runner.heap.peek().is_some_and(|Reverse(entry)| entry.0 <= now) {
            let Some(Reverse((_, _, flow, slot))) = runner.heap.pop() else { break };
            let Some(message) = runner.messages[slot].take() else { continue };
            runner.free.push(slot);
            runner.deliver(now, flow, message, &mut delivered);
        }
    }
    let seconds = (duration_us - measure_from_us) as f64 / 1e6;
    let measured: Vec<u64> = delivered.iter().zip(&at_start).map(|(end, start)| end - start).collect();
    ShareResult {
        rates: measured.iter().map(|&bytes| bytes as f64 * 8.0 / seconds).collect(),
        delivered: measured,
        mean_queue_us: (runner.queue_sum_us / runner.queue_samples.max(1) as u128) as u64,
        loss: runner.dropped as f64 / runner.offered.max(1) as f64,
        stats: runner.flows.iter().map(|(_, endpoint)| if let Endpoint::AgentNet { sender, .. } = endpoint { Some(sender.stats()) } else { None }).collect(),
        offered_bytes: runner.offered_bytes.clone(),
        utilization: runner.wire_bytes_measured as f64 * 8.0 / seconds / link.bits_per_second.max(1) as f64,
    }
}

/// Jain 公平指数：1 是完全平分，1/n 是一条流占了全部。
pub fn jain_index(rates: &[f64]) -> f64 {
    let sum: f64 = rates.iter().sum();
    let squares: f64 = rates.iter().map(|rate| rate * rate).sum();
    if squares == 0.0 { 0.0 } else { sum * sum / (rates.len() as f64 * squares) }
}
