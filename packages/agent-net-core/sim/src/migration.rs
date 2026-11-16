//! 换地址的模拟：发起方（客户端）中途换网络，响应方（服务端）不动。
//!
//! 路径号和真实驱动一样由调用方编：服务端看到的客户端地址从 0 开始，每换一次网络加一；客户端看到的服务端地址一直是 0。
//! 每个客户端地址有自己的一对单向链路，往返、带宽、丢包都可以和旧网络不同。服务端发往客户端已经离开的地址的包，
//! 到达时直接丢掉：那里已经没有人了。攻击者从 [`ATTACKER`] 这个地址注入包，发往那里的包也丢掉，只记字节数。

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, VecDeque};

use agent_net_core::{Config, Incoming, PacketError, SecureConnection, SecurityStats, Stats, destination_id, is_initiation};

use crate::crypto::{AesGcm, PROLOGUE, TestCrypto};
use crate::{Link, LinkProfile, Rng, random_link, stream_byte};

/// 攻击者用的地址：伪造的来源，或者被拿来当放大目标的受害者。
pub const ATTACKER: u64 = 1 << 40;
/// 这么久没有任何新数据送达就判定卡死，和明文矩阵相同。
const STALL_LIMIT_US: u64 = 120_000_000;

/// 客户端换一次网络。
#[derive(Clone, Debug)]
pub struct Move {
    pub at_us: u64,
    /// 换之前这么久客户端收不到也发不出：旧网络已经断了，新网络还没连上。切 Wi-Fi 和蜂窝时常见一两秒。
    pub outage_us: u64,
    /// 新网络上客户端到服务端、服务端到客户端两个方向。
    pub up: LinkProfile,
    pub down: LinkProfile,
    /// 客户端自己知道换了网络（驱动收到系统通知），换的那一刻调用 `on_local_address_change`。
    /// `false` 是 NAT 换了端口、系统没有通知一类：客户端照旧发，只是服务端看到的来源变了。
    pub noticed: bool,
    /// 只是 NAT 换了外部端口：服务端看到的 IP 不变，驱动会告诉服务端只换了端口。
    /// 新地址和旧地址共用同一条链路（同一个队列），`up`、`down` 不用。
    pub same_route: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attack {
    None,
    /// 路上的人把客户端每 `every` 个数据包复制一份，从攻击者地址抢先 `lead_us` 送到服务端。
    Race { every: u64, lead_us: u64 },
    /// 每 `every` 个数据包，从攻击者地址送一个录下的旧包、一个改了一位的包、一个随机内容的包。
    Inject { every: u64 },
}

#[derive(Clone, Debug)]
pub struct Scenario {
    pub seed: u64,
    pub config: Config,
    pub up: LinkProfile,
    pub down: LinkProfile,
    pub moves: Vec<Move>,
    pub upload_bytes: u64,
    pub download_bytes: u64,
    pub attack: Attack,
    pub time_limit_us: u64,
}

#[derive(Debug, Default)]
pub struct Report {
    pub finished: bool,
    pub finish_us: u64,
    pub violation: Option<String>,
    /// 每次换网以后，过了多久还没传完的方向全都重新有数据送达。到结束都没恢复是 `None`。
    pub recoveries_us: Vec<Option<u64>>,
    /// 每次换网的那一刻，上传和下载各自已经送达了多少字节。
    pub delivered_at_moves: Vec<[u64; 2]>,
    /// 服务端发往攻击者地址的字节，和攻击者从那里送来的字节。
    pub attacker_sent: u64,
    pub attacker_received: u64,
    /// 客户端每个地址还不是服务端的数据路径时，服务端往那里发的字节、从那里收到的字节。
    pub unvalidated: BTreeMap<u64, (u64, u64)>,
    pub spurious_wakes: u64,
    pub client: Option<(SecurityStats, Stats)>,
    pub server: Option<(SecurityStats, Stats)>,
    pub server_path: u64,
    /// 上传／下载，每个客户端地址在线上出现过哪些目的连接号（不含握手）。
    pub connection_ids: [BTreeMap<u64, BTreeSet<u32>>; 2],
    /// 作废以后才到的旧号包，由分发层直接丢弃。
    pub retired_packets: u64,
}

/// 两个方向：0 是上传（客户端写、服务端读），1 是下载。
struct Flow {
    stream: u64,
    total: u64,
    written: u64,
    delivered: u64,
    pending: Vec<u8>,
    offset: usize,
}

impl Flow {
    fn write(&mut self, now_us: u64, connection: &mut SecureConnection<TestCrypto>) {
        loop {
            if self.offset == self.pending.len() {
                if self.written == self.total {
                    return;
                }
                let size = (16 * 1024u64).min(self.total - self.written);
                self.pending = (self.written..self.written + size).map(|index| stream_byte(self.stream, index)).collect();
                self.offset = 0;
                self.written += size;
            }
            let accepted = connection.send(now_us, &self.pending[self.offset..]);
            self.offset += accepted;
            if accepted == 0 {
                return;
            }
        }
    }

    fn read(&mut self, now_us: u64, connection: &mut SecureConnection<TestCrypto>, chunk: &mut [u8]) -> Result<(), String> {
        loop {
            let size = connection.recv(now_us, chunk);
            if size == 0 {
                return Ok(());
            }
            for (offset, &byte) in chunk[..size].iter().enumerate() {
                let index = self.delivered + offset as u64;
                if byte != stream_byte(self.stream, index) {
                    return Err(format!("byte {index} of stream {} differs from what was sent", self.stream));
                }
            }
            self.delivered += size as u64;
            if self.delivered > self.total {
                return Err(format!("{} bytes delivered, only {} sent", self.delivered, self.total));
            }
        }
    }
}

type Arrival = Reverse<(u64, u64, bool, u64, Vec<u8>)>;

/// 跑完一个场景。每个到达的字节都和发送内容逐一核对。
pub fn run_moves(scenario: &Scenario) -> Report {
    run_with_ids(scenario, false)
}

/// 同一个网络场景，双方补满 8 个连接号并统计换地址时的号是否重叠。
pub fn run_rotating_moves(scenario: &Scenario) -> Report {
    run_with_ids(scenario, true)
}

fn replenish(connection: &mut SecureConnection<TestCrypto>, rng: &mut Rng) {
    while connection.is_established() && connection.local_connection_ids().count() < 8 {
        connection.add_connection_id(rng.next_u64() as u32);
    }
}

fn run_with_ids(scenario: &Scenario, rotate_ids: bool) -> Report {
    let seed = scenario.seed;
    let listener_crypto = TestCrypto::<AesGcm>::from_seed(seed.wrapping_mul(2).wrapping_add(2));
    let client_config = Config { connection_id: seed as u32 ^ 0xC11E_0001, ..scenario.config.clone() };
    let server_config = Config { connection_id: seed as u32 ^ 0x5E7F_0002, ..scenario.config.clone() };
    let mut client =
        SecureConnection::connect(TestCrypto::<AesGcm>::from_seed(seed.wrapping_mul(2).wrapping_add(1)), client_config.clone(), PROLOGUE, &listener_crypto.public(), &[], 0)
            .expect("connect");
    let mut listener = Some(listener_crypto);
    let mut server: Option<SecureConnection<TestCrypto>> = None;

    let mut links = vec![(Link::new(scenario.up.clone(), seed ^ 0xA5A5), Link::new(scenario.down.clone(), seed ^ 0x5A5A))];
    // 每个地址走哪条链路：只换端口时和上一个地址共用。
    let mut link_of = vec![0usize];
    let mut flows = [
        Flow { stream: seed, total: scenario.upload_bytes, written: 0, delivered: 0, pending: Vec::new(), offset: 0 },
        Flow { stream: seed.rotate_left(17), total: scenario.download_bytes, written: 0, delivered: 0, pending: Vec::new(), offset: 0 },
    ];
    let mut report = Report::default();
    let mut arrivals: BinaryHeap<Arrival> = BinaryHeap::new();
    let mut order = 0u64;
    let mut now = 0u64;
    let mut buffer = vec![0u8; scenario.config.max_packet_size];
    let mut chunk = vec![0u8; 64 * 1024];
    let mut rng = Rng::new(seed ^ 0xBAD5_EED);
    let mut ids_rng = Rng::new(seed ^ 0x1D5_2026);
    // 客户端现在在第几个地址，已经换了几次。每个地址的 IP 是第几个：只换端口时 IP 不变。
    let mut address = 0u64;
    let mut ips = vec![0u64];
    let mut moved = 0usize;
    // 每次换网时还没传完的方向和那一刻已送达的量。
    let mut recovery: Vec<(u64, [Option<u64>; 2])> = Vec::new();
    let mut recorded: VecDeque<Vec<u8>> = VecDeque::new();
    let mut client_packets = 0u64;
    // （已送达的总量，那时的时间）：判断有没有进展，和明文矩阵一样只看进展，不看总时长。
    let mut progress = (0u64, 0u64);
    let outage = |now: u64| scenario.moves.iter().any(|step| step.at_us.saturating_sub(step.outage_us) <= now && now < step.at_us);

    loop {
        while moved < scenario.moves.len() && scenario.moves[moved].at_us <= now {
            let step = &scenario.moves[moved];
            moved += 1;
            address += 1;
            ips.push(if step.same_route { ips[ips.len() - 1] } else { address });
            if step.same_route {
                link_of.push(link_of[link_of.len() - 1]);
            } else {
                links.push((Link::new(step.up.clone(), seed ^ address.wrapping_mul(0x9E37)), Link::new(step.down.clone(), seed ^ address.wrapping_mul(0x7F4A))));
                link_of.push(links.len() - 1);
            }
            if step.noticed {
                client.on_local_address_change(now);
            }
            let pending = [0, 1].map(|index| (flows[index].delivered < flows[index].total).then_some(flows[index].delivered));
            recovery.push((now, pending));
            report.delivered_at_moves.push([flows[0].delivered, flows[1].delivered]);
        }

        flows[0].write(now, &mut client);
        if let Some(server) = &mut server {
            flows[1].write(now, server);
        }
        if let Err(error) = flows[1].read(now, &mut client, &mut chunk) {
            report.violation = Some(error);
        }
        if let Some(server) = &mut server
            && let Err(error) = flows[0].read(now, server, &mut chunk)
        {
            report.violation = Some(error);
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

        if rotate_ids {
            replenish(&mut client, &mut ids_rng);
            if let Some(server) = &mut server {
                replenish(server, &mut ids_rng);
            }
        }

        while let Some((size, path)) = client.poll_transmit_via(now, &mut buffer) {
            let packet = buffer[..size].to_vec();
            if packet[0] & 0xE0 == 0xA0 && let Some(id) = destination_id(&packet) {
                report.connection_ids[0].entry(address).or_default().insert(id);
            }
            if path != 0 {
                report.violation = Some(format!("the client sent to path {path}, the server never moves"));
            }
            if outage(now) {
                continue;
            }
            let (times, count) = links[link_of[address as usize]].0.transmit(now, size);
            for &at in &times[..count] {
                order += 1;
                arrivals.push(Reverse((at, order, true, address, packet.clone())));
            }
            if packet[0] & 0xE0 != 0xA0 {
                continue;
            }
            client_packets += 1;
            let arrival = if count > 0 { times[0] } else { now + links[link_of[address as usize]].0.profile_delay_us() };
            match scenario.attack {
                Attack::None => {}
                Attack::Race { every, lead_us } => {
                    if client_packets.is_multiple_of(every) {
                        order += 1;
                        report.attacker_received += size as u64;
                        arrivals.push(Reverse((arrival.saturating_sub(lead_us).max(now), order, true, ATTACKER, packet.clone())));
                    }
                }
                Attack::Inject { every } => {
                    if client_packets.is_multiple_of(every) {
                        let mut tampered = packet.clone();
                        let position = rng.below(size as u64) as usize;
                        tampered[position] ^= 1 << rng.below(8);
                        let mut garbage: Vec<u8> = (0..size).map(|_| rng.below(256) as u8).collect();
                        garbage[0] = 0xA0 | (garbage[0] & 0x1F);
                        let old = recorded.front().cloned();
                        for forged in [old, Some(tampered), Some(garbage)].into_iter().flatten() {
                            order += 1;
                            report.attacker_received += forged.len() as u64;
                            arrivals.push(Reverse((arrival, order, true, ATTACKER, forged)));
                        }
                    }
                    recorded.push_back(packet.clone());
                    if recorded.len() > 256 {
                        recorded.pop_front();
                    }
                }
            }
        }
        if let Some(server) = &mut server {
            while let Some((size, path)) = server.poll_transmit_via(now, &mut buffer) {
                if buffer[0] & 0xE0 == 0xA0 && path != ATTACKER && let Some(id) = destination_id(&buffer[..size]) {
                    report.connection_ids[1].entry(path).or_default().insert(id);
                }
                if path != server.path() && path != ATTACKER {
                    report.unvalidated.entry(path).or_default().0 += size as u64;
                }
                if path == ATTACKER {
                    report.attacker_sent += size as u64;
                    continue;
                }
                let Some((_, down)) = link_of.get(path as usize).and_then(|&index| links.get_mut(index)) else {
                    report.violation = Some(format!("the server sent to unknown path {path}"));
                    break;
                };
                let (times, count) = down.transmit(now, size);
                for &at in &times[..count] {
                    order += 1;
                    arrivals.push(Reverse((at, order, false, path, buffer[..size].to_vec())));
                }
            }
            server.connection().check_invariants();
            if server.next_wake().is_some_and(|at| at <= now) {
                report.spurious_wakes += 1;
            }
        }
        client.connection().check_invariants();
        if client.next_wake().is_some_and(|at| at <= now) {
            report.spurious_wakes += 1;
        }

        let finished = flows.iter().all(|flow| flow.delivered == flow.total);
        let dead = client.is_dead() || server.as_ref().is_some_and(SecureConnection::is_dead);
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
            report.client = Some((client.security_stats(), client.stats()));
            report.server = server.as_ref().map(|server| (server.security_stats(), server.stats()));
            report.server_path = server.as_ref().map_or(0, SecureConnection::path);
            return report;
        }

        let mut next = arrivals.peek().map(|Reverse(item)| item.0);
        let mut consider = |at: u64| next = Some(next.map_or(at, |value: u64| value.min(at)));
        for wake in [client.next_wake(), server.as_ref().and_then(SecureConnection::next_wake), scenario.moves.get(moved).map(|step| step.at_us)].into_iter().flatten() {
            consider(wake);
        }
        let Some(next) = next else {
            report.violation = Some("both sides went idle before the transfer finished".into());
            continue;
        };
        now = next.max(now + 1);

        while arrivals.peek().is_some_and(|Reverse(item)| item.0 <= now) {
            let Some(Reverse((_, _, to_server, path, packet))) = arrivals.pop() else { break };
            if !to_server {
                // 客户端已经离开了那个地址，或者正在断网。
                if path != address || outage(now) {
                    continue;
                }
                if packet[0] & 0xE0 == 0xA0 && destination_id(&packet).is_some_and(|id| !client.local_connection_ids().any(|live| live == id)) {
                    report.retired_packets += 1;
                    continue;
                }
                match client.on_packet_via(now, 0, &packet) {
                    Ok(()) | Err(PacketError::Replayed) => {}
                    Err(error) if !client.is_dead() => report.violation = Some(format!("the client rejected a genuine packet: {error:?}")),
                    Err(_) => {}
                }
                continue;
            }
            let Some(connection) = &mut server else {
                if !is_initiation(&packet) {
                    continue;
                }
                let crypto = listener.take().expect("listener");
                let incoming = match Incoming::read(&crypto, PROLOGUE, &packet) {
                    Ok(incoming) => incoming,
                    Err(error) => {
                        report.violation = Some(format!("initiation rejected: {error:?}"));
                        listener = Some(crypto);
                        continue;
                    }
                };
                let mut accepted = incoming.accept(crypto, server_config.clone(), &[], now).expect("accept");
                // 接受时的路径是 0；请求是从别的地址来的，就让回复跟过去，和驱动收到重发的请求时一样。
                let _ = accepted.on_packet_via(now, path, &packet);
                server = Some(accepted);
                continue;
            };
            // 驱动看到的：来源和数据路径 IP 相同、只差端口。攻击者的地址不算。
            let active = connection.path();
            if packet[0] & 0xE0 == 0xA0 && destination_id(&packet).is_some_and(|id| !connection.local_connection_ids().any(|live| live == id)) {
                report.retired_packets += 1;
                continue;
            }
            let same_route = path != ATTACKER && path != active && ips.get(path as usize).is_some_and(|ip| ips.get(active as usize) == Some(ip));
            let result = connection.on_packet_via_route(now, path, same_route, &packet);
            match result {
                Ok(()) | Err(PacketError::Replayed) => {}
                Err(_) if path == ATTACKER || connection.is_dead() => {}
                Err(PacketError::Handshake) if is_initiation(&packet) => {}
                Err(error) => report.violation = Some(format!("the server rejected a genuine packet from path {path}: {error:?}")),
            }
            if path != ATTACKER && connection.path() != path {
                report.unvalidated.entry(path).or_default().1 += packet.len() as u64;
            }
        }
        if client.next_wake().is_some_and(|at| at <= now) {
            client.tick(now);
        }
        if let Some(server) = &mut server
            && server.next_wake().is_some_and(|at| at <= now)
        {
            server.tick(now);
        }
    }
}

/// 随机的换网场景：旧网络和新网络各自从明文矩阵的链路里抽，换一到两次，可能有空档，客户端不一定知道，
/// 四分之一的种子有路上的人时不时抢先送复制包，四分之一有人从别的地址注入重放、篡改和随机的包。
/// 每个包都抢先复制的攻击者单独测（`tests/migration.rs`）：它带不走数据；客户端真换了网络时新地址来的包全成了
/// 复制包之后到的重复包，2026-11-05 起服务端靠最新那个包的重复照样找到新地址。这里不抽它，抽了会改掉所有种子的场景。
pub fn random_scenario(seed: u64) -> Scenario {
    let mut rng = Rng::new(seed ^ 0x3A1F_0C4E);
    let mut config = crate::random_case(seed).config;
    // 握手请求至少 135 字节（2026-11-06 加了 mac1、mac2 以前是 103）。
    config.max_packet_size = config.max_packet_size.max(160);
    // 握手、启动都完成以后再换，也有一开始就换的。
    let first = rng.pick(&[200_000, 1_000_000, 3_000_000]);
    let moves = (0..1 + rng.below(2))
        .map(|index| Move {
            at_us: first + index * rng.pick(&[500_000, 2_000_000, 5_000_000]),
            outage_us: rng.pick(&[0, 0, 300_000, 1_000_000, 3_000_000]),
            up: random_link(&mut rng, &[]),
            down: random_link(&mut rng, &[]),
            noticed: rng.chance(0.5),
            same_route: false,
        })
        .collect();
    let size = rng.pick(&[64 * 1024u64, 256 * 1024, 1024 * 1024]);
    let attack = match rng.below(4) {
        0 => Attack::Race { every: rng.pick(&[8, 64, 512]), lead_us: rng.pick(&[100, 5_000, 50_000]) },
        1 => Attack::Inject { every: rng.pick(&[1, 16]) },
        _ => Attack::None,
    };
    Scenario {
        seed,
        config,
        up: random_link(&mut rng, &[]),
        down: random_link(&mut rng, &[]),
        moves,
        upload_bytes: if rng.chance(0.6) { size + rng.below(size) } else { 0 },
        download_bytes: if rng.chance(0.7) { size + rng.below(size) } else { 1 },
        attack,
        // 和明文矩阵一样只按有没有进展判卡死：让路模式在丢包三成的路径上本来就极慢，那不是换地址的问题。
        time_limit_us: 86_400_000_000,
    }
}
