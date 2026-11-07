//! 打洞和中继的模拟：两端各在一个 NAT 后面，先经中继连上，再交换各自的公网地址、同时去验证对方，
//! 打通了就换到直连，打不通就一直走中继；直连中途断了退回中继，恢复后再换回来。
//!
//! 两端都用核心的 [`Endpoint`]，地址类型是 [`SimAddr`]：中继通道代价 1，UDP 地址代价 0。
//! 中继模拟 443 上的 WebSocket：不丢包、按顺序到，只有延迟和带宽。
//! 交换候选地址这一步在真实产品里走已经建好的加密连接，这里直接在中继单程延迟之后交给对方，不经过连接。

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap};

use agent_net_core::{Config, Endpoint, PathAddress, SecurityStats, Stats, destination_id};

use crate::crypto::{AesGcm, PROLOGUE, TestCrypto};
use crate::{Link, LinkProfile, Rng, stream_byte};

/// 模拟里的地址。UDP 的 IP 用编号表示。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum SimAddr {
    /// 经中继转发到对端。
    Relay,
    Udp { ip: u32, port: u16 },
}

impl PathAddress for SimAddr {
    fn same_host(&self, other: &Self) -> bool {
        matches!((self, other), (SimAddr::Udp { ip: a, .. }, SimAddr::Udp { ip: b, .. }) if a == b)
    }

    fn cost(&self) -> u8 {
        match self {
            SimAddr::Relay => 1,
            SimAddr::Udp { .. } => 0,
        }
    }
}

/// 公网地址查询服务（STUN）的地址。只用来看这一端的 NAT 给了哪个外部端口，不转发数据。
const STUN: SimAddr = SimAddr::Udp { ip: 9_000, port: 3478 };
/// 这么久没有任何新数据送达就判定卡死，和别的矩阵一样只看进展。
const STALL_LIMIT_US: u64 = 120_000_000;

/// NAT 的类型，按 RFC 4787 的映射和过滤行为分。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nat {
    /// 有公网地址，没有 NAT。
    Open,
    /// 映射和过滤都与目的地址无关（全锥形）。
    FullCone,
    /// 映射与目的地址无关，只放行这一端发过包的 IP（受限锥形）。
    Restricted,
    /// 映射与目的地址无关，只放行这一端发过包的 IP 和端口（端口受限锥形，家用路由器最常见）。
    PortRestricted,
    /// 每个目的地址一个新的外部端口，只放行那个目的地址（对称型，运营商级 NAT 常见）。
    Symmetric,
    /// UDP 全被挡：出不去也进不来，只剩中继。
    UdpBlocked,
}

struct NatBox {
    kind: Nat,
    public_ip: u32,
    local_port: u16,
    /// 目的地址 → （外部端口，最后一次往外发的时间）。对称型按目的地址分，别的类型只有一个，键是 `None`。
    mappings: BTreeMap<Option<SimAddr>, (u16, u64)>,
    /// 往外发过包的目的地址和时间，过滤用。
    sent_to: BTreeMap<SimAddr, u64>,
    next_port: u16,
    timeout_us: u64,
}

impl NatBox {
    fn new(kind: Nat, public_ip: u32, timeout_us: u64) -> Self {
        Self { kind, public_ip, local_port: 40_000, mappings: BTreeMap::new(), sent_to: BTreeMap::new(), next_port: 50_000, timeout_us }
    }

    /// 往 `to` 发一个包，返回外面看到的来源地址；UDP 被挡时返回 `None`。
    fn outbound(&mut self, now_us: u64, to: SimAddr) -> Option<SimAddr> {
        match self.kind {
            Nat::UdpBlocked => return None,
            Nat::Open => return Some(SimAddr::Udp { ip: self.public_ip, port: self.local_port }),
            _ => {}
        }
        let key = (self.kind == Nat::Symmetric).then_some(to);
        let timeout = self.timeout_us;
        let next_port = &mut self.next_port;
        let entry = self.mappings.entry(key).or_insert_with(|| {
            *next_port += 1;
            (*next_port, now_us)
        });
        if now_us.saturating_sub(entry.1) >= timeout {
            // 映射过期了，NAT 给一个新端口。
            *next_port += 1;
            entry.0 = *next_port;
        }
        entry.1 = now_us;
        self.sent_to.insert(to, now_us);
        Some(SimAddr::Udp { ip: self.public_ip, port: entry.0 })
    }

    /// 从 `from` 发往外部端口 `port` 的包放不放进来。
    fn inbound(&self, now_us: u64, from: SimAddr, port: u16) -> bool {
        let live = |at: u64| now_us.saturating_sub(at) < self.timeout_us;
        let SimAddr::Udp { ip: from_ip, .. } = from else { return false };
        match self.kind {
            Nat::UdpBlocked => false,
            Nat::Open => port == self.local_port,
            Nat::FullCone => self.mappings.values().any(|&(mapped, at)| mapped == port && live(at)),
            Nat::Restricted => {
                self.mappings.values().any(|&(mapped, at)| mapped == port && live(at))
                    && self.sent_to.iter().any(|(to, &at)| matches!(to, SimAddr::Udp { ip, .. } if *ip == from_ip) && live(at))
            }
            Nat::PortRestricted => self.mappings.values().any(|&(mapped, at)| mapped == port && live(at)) && self.sent_to.get(&from).is_some_and(|&at| live(at)),
            Nat::Symmetric => self.mappings.get(&Some(from)).is_some_and(|&(mapped, at)| mapped == port && live(at)),
        }
    }
}

/// 网络在某一刻的变化。
#[derive(Clone, Debug)]
pub struct Change {
    pub at_us: u64,
    /// 哪一端（0 是发起方 A，1 是 B）的 NAT 换成什么类型。换成 `UdpBlocked` 就是直连断了。
    pub side: usize,
    pub nat: Nat,
}

#[derive(Clone, Debug)]
pub struct Scenario {
    pub seed: u64,
    pub config: Config,
    pub nats: [Nat; 2],
    /// 两端在同一个局域网里：本机地址互相直达，候选地址里也有它。
    pub same_lan: bool,
    /// NAT 映射多久没有往外发的包就过期。
    pub mapping_timeout_us: u64,
    /// 直连两个方向：A 到 B、B 到 A。
    pub direct: [LinkProfile; 2],
    /// 经中继两个方向。不丢包。
    pub relay: [LinkProfile; 2],
    /// A 写给 B、B 写给 A 的字节数。
    pub bytes: [u64; 2],
    /// 第一次交换候选地址之后，还没走直连的一端每隔这么久再验证一轮（上层的重试），0 表示不重试。
    pub reprobe_us: u64,
    pub changes: Vec<Change>,
    pub time_limit_us: u64,
}

#[derive(Debug, Default)]
pub struct Side {
    pub security: SecurityStats,
    pub stats: Stats,
    /// 最后的数据路径是不是直连。
    pub direct_at_end: bool,
    /// 数据路径在中继和直连之间换了几次，和每次换的时刻。
    pub switches: u32,
    pub switch_times: Vec<u64>,
    /// 经中继和直连发出的字节。
    pub relay_bytes: u64,
    pub direct_bytes: u64,
    /// 发往当时还没有包到达过对端的 UDP 地址的字节：打洞时被对端 NAT 挡掉的、打洞失败时白发的验证包。
    pub unanswered_bytes: u64,
    /// 每条直连候选／中继路径在线上出现的目的号。
    pub connection_ids: BTreeMap<SimAddr, BTreeSet<u32>>,
}

#[derive(Debug, Default)]
pub struct Report {
    pub finished: bool,
    pub finish_us: u64,
    pub violation: Option<String>,
    /// 两端的数据路径第一次都是直连的时刻，从握手完成算起。
    pub direct_after_us: Option<u64>,
    /// 每次网络变化以后，过了多久两个方向都重新有数据送达。
    pub recoveries_us: Vec<Option<u64>>,
    pub sides: [Side; 2],
    pub spurious_wakes: u64,
}

struct Flow {
    stream: u64,
    total: u64,
    written: u64,
    delivered: u64,
    pending: Vec<u8>,
    offset: usize,
}

impl Flow {
    fn new(stream: u64, total: u64) -> Self {
        Self { stream, total, written: 0, delivered: 0, pending: Vec::new(), offset: 0 }
    }
}

struct Peer {
    endpoint: Endpoint<TestCrypto, SimAddr>,
    nat: NatBox,
    /// 这一端的那条连接。
    id: Option<u32>,
    /// 发过去的包到得了对端的 UDP 地址（这一端看到的写法）。
    reached: Vec<SimAddr>,
    last_direct: bool,
}

/// 到达：（时间，顺序，收包方，来源地址，发往的外部端口，是不是局域网里直达，内容）。
/// NAT 的过滤在到达时判断：那时对端的 NAT 可能已经为这里开了映射。
type Arrival = Reverse<(u64, u64, usize, SimAddr, u16, bool, Vec<u8>)>;

fn local_addr(side: usize) -> SimAddr {
    SimAddr::Udp { ip: 100 + side as u32, port: 40_000 }
}

fn public_ip(side: usize) -> u32 {
    200 + side as u32
}

pub fn run(scenario: &Scenario) -> Report {
    let seed = scenario.seed;
    let crypto = [0, 1].map(|side| TestCrypto::<AesGcm>::from_seed(seed.wrapping_mul(2).wrapping_add(side + 1)));
    let a_public = crypto[0].public();
    let b_secret = crypto[1].secret_bytes();
    let mut ids = Rng::new(seed ^ 0x1D5);
    let mut peers: Vec<Peer> = (0..2)
        .map(|side| Peer {
            endpoint: Endpoint::new({
                let mut rng = Rng::new(ids.next_u64());
                move || rng.next_u64() as u32
            }),
            nat: NatBox::new(scenario.nats[side], public_ip(side), scenario.mapping_timeout_us),
            id: None,
            reached: Vec::new(),
            last_direct: false,
        })
        .collect();
    let mut accepted = 0u64;
    peers[1].endpoint.listen(
        PROLOGUE,
        scenario.config.clone(),
        b"",
        move || {
            accepted += 1;
            TestCrypto::<AesGcm>::from_secret(b_secret, seed ^ accepted)
        },
        move |incoming, _| incoming.remote_static() == &a_public,
    );
    let b_public = crypto[1].public();
    let [a_crypto, _] = crypto;
    peers[0].id = Some(peers[0].endpoint.connect(0, a_crypto, scenario.config.clone(), PROLOGUE, &b_public, b"", SimAddr::Relay).expect("connect"));

    let mut direct_links = [Link::new(scenario.direct[0].clone(), seed ^ 0xD1), Link::new(scenario.direct[1].clone(), seed ^ 0xD2)];
    let mut relay_links = [Link::new(scenario.relay[0].clone(), seed ^ 0xE1), Link::new(scenario.relay[1].clone(), seed ^ 0xE2)];
    let mut flows = [Flow::new(seed, scenario.bytes[0]), Flow::new(seed.rotate_left(19), scenario.bytes[1])];
    let mut report = Report::default();
    let mut arrivals: BinaryHeap<Arrival> = BinaryHeap::new();
    let mut order = 0u64;
    let mut now = 0u64;
    let mut buffer = vec![0u8; scenario.config.max_packet_size];
    let mut chunk = vec![0u8; 64 * 1024];
    let mut established_at: Option<u64> = None;
    // 下一次（重新）交换候选地址的时间。
    let mut exchange_at: Option<u64> = None;
    let mut applied = 0usize;
    let mut recovery: Vec<(u64, [Option<u64>; 2])> = Vec::new();
    let mut progress = (0u64, 0u64);

    loop {
        while applied < scenario.changes.len() && scenario.changes[applied].at_us <= now {
            let change = &scenario.changes[applied];
            applied += 1;
            peers[change.side].nat.kind = change.nat;
            let pending = [0, 1].map(|index| (flows[index].delivered < flows[index].total).then_some(flows[index].delivered));
            recovery.push((now, pending));
        }

        if peers[1].id.is_none() {
            peers[1].id = peers[1].endpoint.accept();
        }
        let both_established = (0..2).all(|side| peers[side].id.and_then(|id| peers[side].endpoint.connection(id)).is_some_and(|connection| connection.is_established()));
        if both_established && established_at.is_none() {
            established_at = Some(now);
            // 一端开始交换：它的候选地址经中继单程到达对端，对端回自己的，再单程回来。两端大约同时开始验证。
            exchange_at = Some(now + scenario.relay[0].delay_us);
        }
        if exchange_at.is_some_and(|at| at <= now) {
            for side in 0..2 {
                let Some(id) = peers[side].id else { continue };
                if peers[side].endpoint.peer_addr(id).is_some_and(|address| address != SimAddr::Relay) {
                    continue;
                }
                let other = 1 - side;
                let mut candidates = Vec::new();
                if scenario.same_lan {
                    candidates.push(local_addr(other));
                }
                // 对端经公网地址查询服务看到的自己的外部地址。
                if let Some(reflexive) = peers[other].nat.outbound(now, STUN) {
                    candidates.push(reflexive);
                }
                for candidate in candidates {
                    peers[side].endpoint.probe(now, id, candidate);
                }
            }
            exchange_at = (scenario.reprobe_us > 0).then(|| now + scenario.reprobe_us);
        }

        for side in 0..2 {
            let Some(id) = peers[side].id else { continue };
            let Some(connection) = peers[side].endpoint.connection_mut(id) else { continue };
            let flow = &mut flows[side];
            loop {
                if flow.offset == flow.pending.len() {
                    if flow.written == flow.total {
                        break;
                    }
                    let size = (16 * 1024u64).min(flow.total - flow.written);
                    flow.pending = (flow.written..flow.written + size).map(|index| stream_byte(flow.stream, index)).collect();
                    flow.offset = 0;
                    flow.written += size;
                }
                let accepted = connection.send(now, &flow.pending[flow.offset..]);
                flow.offset += accepted;
                if accepted == 0 {
                    break;
                }
            }
            let incoming = &mut flows[1 - side];
            loop {
                let size = connection.recv(now, &mut chunk);
                if size == 0 {
                    break;
                }
                for (offset, &byte) in chunk[..size].iter().enumerate() {
                    if byte != stream_byte(incoming.stream, incoming.delivered + offset as u64) {
                        report.violation = Some(format!("byte {} to side {side} differs", incoming.delivered + offset as u64));
                    }
                }
                incoming.delivered += size as u64;
            }
        }
        for (at, pending) in &mut recovery {
            for (index, base) in pending.iter_mut().enumerate() {
                if base.is_some_and(|base| flows[index].delivered > base) {
                    *base = None;
                }
            }
            if pending.iter().all(Option::is_none) && *at != u64::MAX {
                report.recoveries_us.push(Some(now - *at));
                *at = u64::MAX;
            }
        }

        for side in 0..2 {
            while let Some((size, to)) = peers[side].endpoint.poll_transmit(now, &mut buffer) {
                let packet = buffer[..size].to_vec();
                if packet[0] & 0xE0 == 0xA0 && let Some(id) = destination_id(&packet) {
                    report.sides[side].connection_ids.entry(to).or_default().insert(id);
                }
                let other = 1 - side;
                match to {
                    SimAddr::Relay => {
                        report.sides[side].relay_bytes += size as u64;
                        let (times, count) = relay_links[side].transmit(now, size);
                        for &at in &times[..count] {
                            order += 1;
                            arrivals.push(Reverse((at, order, other, SimAddr::Relay, 0, false, packet.clone())));
                        }
                    }
                    SimAddr::Udp { .. } => {
                        report.sides[side].direct_bytes += size as u64;
                        if !peers[side].reached.contains(&to) {
                            report.sides[side].unanswered_bytes += size as u64;
                        }
                        let lan = scenario.same_lan && to == local_addr(other);
                        let Some(from) = (if lan { Some(local_addr(side)) } else { peers[side].nat.outbound(now, to) }) else { continue };
                        let reaches_other = lan || matches!(to, SimAddr::Udp { ip, .. } if ip == public_ip(other));
                        if !reaches_other {
                            continue;
                        }
                        let SimAddr::Udp { port, .. } = to else { continue };
                        let (times, count) = direct_links[side].transmit(now, size);
                        for &at in &times[..count] {
                            order += 1;
                            arrivals.push(Reverse((at, order, other, from, port, lan, packet.clone())));
                        }
                    }
                }
            }
            let Some(id) = peers[side].id else { continue };
            if let Some(connection) = peers[side].endpoint.connection(id) {
                connection.connection().check_invariants();
                let is_direct = peers[side].endpoint.peer_addr(id).is_some_and(|address| address != SimAddr::Relay);
                if is_direct != peers[side].last_direct {
                    peers[side].last_direct = is_direct;
                    report.sides[side].switches += 1;
                    report.sides[side].switch_times.push(now);
                }
            }
            if peers[side].endpoint.next_wake().is_some_and(|at| at <= now) {
                report.spurious_wakes += 1;
            }
        }
        if report.direct_after_us.is_none()
            && let Some(start) = established_at
            && peers.iter().all(|peer| peer.last_direct)
        {
            report.direct_after_us = Some(now - start);
        }

        let finished = flows.iter().all(|flow| flow.delivered == flow.total);
        let dead = peers.iter().any(|peer| peer.id.and_then(|id| peer.endpoint.connection(id)).is_some_and(|connection| connection.is_dead()));
        let delivered = flows[0].delivered + flows[1].delivered;
        if delivered != progress.0 {
            progress = (delivered, now);
        } else if now - progress.1 > STALL_LIMIT_US && report.violation.is_none() {
            report.violation = Some(format!("no progress for {}us", now - progress.1));
        }
        if finished || dead || report.violation.is_some() || now > scenario.time_limit_us {
            report.finished = finished && report.violation.is_none();
            report.finish_us = now;
            if !finished && report.violation.is_none() {
                report.violation = Some(if dead { "a side gave up".into() } else { "time limit reached".into() });
            }
            for (at, _) in &recovery {
                if *at != u64::MAX {
                    report.recoveries_us.push(None);
                }
            }
            for (side, peer) in peers.iter().enumerate() {
                if let Some(connection) = peer.id.and_then(|id| peer.endpoint.connection(id)) {
                    report.sides[side].security = connection.security_stats();
                    report.sides[side].stats = connection.stats();
                }
                report.sides[side].direct_at_end = peer.last_direct;
            }
            return report;
        }

        let mut next = arrivals.peek().map(|Reverse(item)| item.0);
        let mut consider = |at: u64| next = Some(next.map_or(at, |value: u64| value.min(at)));
        for wake in [peers[0].endpoint.next_wake(), peers[1].endpoint.next_wake(), exchange_at, scenario.changes.get(applied).map(|change| change.at_us)].into_iter().flatten() {
            consider(wake);
        }
        let Some(next) = next else {
            report.violation = Some("both sides went idle before the transfer finished".into());
            continue;
        };
        now = next.max(now + 1);

        while arrivals.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Some(Reverse((_, _, to, from, port, lan, packet))) = arrivals.pop() else { break };
            if from != SimAddr::Relay {
                if !lan && !peers[to].nat.inbound(now, from, port) {
                    continue;
                }
                // 发包的一端发往的那个地址到得了：发往那里的包不算白发。
                let sender = 1 - to;
                let sent_to = if lan { local_addr(to) } else { SimAddr::Udp { ip: public_ip(to), port } };
                if !peers[sender].reached.contains(&sent_to) {
                    peers[sender].reached.push(sent_to);
                }
            }
            peers[to].endpoint.on_datagram(now, from, &packet);
        }
        for peer in &mut peers {
            peer.endpoint.tick(now);
        }
    }
}

/// 常用的两端网络：直连单程 `delay_us`、不限速；中继单程多 `relay_extra_us`。
pub fn scenario(seed: u64, nats: [Nat; 2], delay_us: u64, relay_extra_us: u64, bytes: [u64; 2]) -> Scenario {
    let direct = LinkProfile { bits_per_second: 50_000_000, delay_us, queue_us: 100_000, ..LinkProfile::default() };
    let relay = LinkProfile { bits_per_second: 20_000_000, delay_us: delay_us + relay_extra_us, queue_us: 2_000_000, ..LinkProfile::default() };
    Scenario {
        seed,
        config: Config::default(),
        nats,
        same_lan: false,
        mapping_timeout_us: 30_000_000,
        direct: [direct.clone(), direct],
        relay: [relay.clone(), relay],
        bytes,
        reprobe_us: 10_000_000,
        changes: Vec::new(),
        time_limit_us: 300_000_000,
    }
}
