//! 一个本地端口上的多条加密连接。和连接一样不碰套接字和时钟：调用方把收到的数据报、来源地址和当前时间喂进来，
//! 再取出要发的数据报和目的地址。真机 UDP 驱动、Node 驱动和以后的手机驱动共用这一份分发逻辑。
//!
//! - 数据包和握手回复按连接号（[`destination_id`]）找连接，不按来源地址：NAT 换了端口、手机换了网络，地址都会变。
//!   握手请求按 [`Endpoint::listen`] 设的规则决定接不接受。
//! - 每条连接自己给来源地址编路径号：0 是建连时的地址，之后每见到一个新地址编一个新号，核心据此验证新路径、换过去。
//!   新地址和数据路径是同一台主机、只差端口时告诉连接（`on_packet_via_route`），换过去时不重量往返和带宽。
//! - 地址的类型由驱动定（[`PathAddress`]）：UDP 地址，或者驱动自己编的中继通道。每种地址自带代价，
//!   编路径号时交给连接（`SecureConnection::set_path_cost`），直连和中继同时可用时优先直连。
//! - 陌生的握手请求先过准入（[`Admission`]）：mac1 不对的直接丢，不回任何东西；处理得太快时先回 cookie、按地址限流，
//!   最后才交给 `admit` 做 DH。cookie 回复按 mac1 交给正在发起的那条连接。

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, VecDeque};
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::{Debug, Write};
use core::net::{IpAddr, SocketAddr};

use crate::admission::{Admission, Admitter, Gate, Verdict};

use crate::connection::{Config, PacketError};
use crate::crypto::{Crypto, PUBLIC_KEY_LEN};
use crate::ids::MAX_IDS;
use crate::noise::HandshakeError;
use crate::secure::{CLOSE_PACKET_LEN, Incoming, SecureConnection, destination_id, is_cookie_reply, is_initiation};

/// 一条连接最多记住这么多个来源地址，再多就忘掉最久没见到的（正在用的和正在验证的除外）。
/// 伪造来源的包每个都会占一个号，不能无限增长。
const MAX_PATHS: usize = 16;
/// 还没确认的连接最多这么多条。重放的握手请求会各开一条，确认不了，`dead_after_us` 后自己放弃。
const MAX_UNCONFIRMED: usize = 1024;
/// 排队等发的 cookie 回复最多这么多个，调用方来不及取时多出来的丢掉。
const MAX_OUTGOING: usize = 256;

/// 驱动用的地址。核心只比较是否相同、是不是同一台主机，以及取它的代价。
pub trait PathAddress: Copy + Eq + Debug {
    /// 和 `other` 是同一台主机、只是端口可能不同：两个地址只差端口时，多半是 NAT 换了外部端口，走的还是同一条路。
    fn same_host(&self, other: &Self) -> bool;
    /// 走这个地址的代价，越小越优先，见 `SecureConnection::set_path_cost`。
    fn cost(&self) -> u8 {
        0
    }
    /// 算 cookie 用的地址字节：同一个地址每次都一样，不同的地址不一样。只在本机用，不上线。默认用 `Debug` 的写法。
    fn write_identity(&self, out: &mut Vec<u8>) {
        let mut text = String::new();
        let _ = write!(text, "{self:?}");
        out.extend_from_slice(text.as_bytes());
    }
}

impl PathAddress for SocketAddr {
    fn same_host(&self, other: &Self) -> bool {
        self.ip() == other.ip()
    }

    fn write_identity(&self, out: &mut Vec<u8>) {
        match self.ip() {
            IpAddr::V4(ip) => out.extend_from_slice(&ip.octets()),
            IpAddr::V6(ip) => out.extend_from_slice(&ip.octets()),
        }
        out.extend_from_slice(&self.port().to_be_bytes());
    }
}

/// 分发层的计数。
#[derive(Clone, Copy, Debug, Default)]
pub struct EndpointStats {
    pub datagrams_received: u64,
    pub bytes_received: u64,
    /// 交给调用方去发的数据报。
    pub datagrams_sent: u64,
    pub bytes_sent: u64,
    /// 连接号对不上任何连接的包，以及对不上正在发起的连接的 cookie 回复。
    pub unknown_destination: u64,
    /// 读不开、或者被接受规则拒绝的握手请求。
    pub rejected_initiations: u64,
    /// mac1 不对、没做 DH 就丢掉的握手请求：发的人不知道这一端的公钥。
    pub bad_mac1: u64,
    /// 忙的时候回出去的 cookie。
    pub cookie_replies: u64,
    /// 忙的时候超过限额、没做 DH 就丢掉的握手请求。
    pub throttled_initiations: u64,
}

struct Slot<C: Crypto, A: PathAddress> {
    connection: SecureConnection<C>,
    routing_ids: Vec<u32>,
    /// 路径号 → （地址，最后一次从那里收到包的时间）。
    paths: BTreeMap<u64, (A, u64)>,
    next_path: u64,
}

impl<C: Crypto, A: PathAddress> Slot<C, A> {
    fn new(mut connection: SecureConnection<C>, peer: A, now_us: u64) -> Self {
        if peer.cost() != 0 {
            connection.set_path_cost(0, peer.cost());
        }
        let routing_ids = connection.local_connection_ids().collect();
        Self { connection, routing_ids, paths: BTreeMap::from([(0, (peer, now_us))]), next_path: 1 }
    }

    fn knows(&self, address: A) -> bool {
        self.paths.values().any(|(known, _)| *known == address)
    }

    /// `from` 和数据路径只差端口：多半是 NAT 换了外部端口，走的还是同一条路。
    fn same_route(&self, from: A) -> bool {
        self.paths.get(&self.connection.path()).is_some_and(|(active, _)| active.same_host(&from) && *active != from)
    }

    /// 来源地址对应的路径号，没见过就编一个新的。
    fn path_of(&mut self, from: A, now_us: u64) -> u64 {
        if let Some((&path, entry)) = self.paths.iter_mut().find(|(_, (address, _))| *address == from) {
            entry.1 = now_us;
            return path;
        }
        if self.paths.len() >= MAX_PATHS {
            let keep: Vec<u64> = core::iter::once(self.connection.path()).chain(self.connection.validating()).chain(self.connection.alternates()).collect();
            let oldest = self.paths.iter().filter(|(path, _)| !keep.contains(path)).min_by_key(|(_, (_, seen))| *seen).map(|(&path, _)| path);
            if let Some(path) = oldest {
                self.paths.remove(&path);
            }
        }
        let path = self.next_path;
        self.next_path += 1;
        self.paths.insert(path, (from, now_us));
        if from.cost() != 0 {
            self.connection.set_path_cost(path, from.cost());
        }
        path
    }
}

/// 接受规则：看过对方身份、附带数据和来源地址以后决定接不接受。
type Admit<C, A> = Box<dyn FnMut(&Incoming<C>, A) -> bool>;

/// 收到陌生的握手请求时怎么办。
struct Listener<C: Crypto, A> {
    prologue: Vec<u8>,
    config: Config,
    payload: Vec<u8>,
    /// 给每条新连接一个加密实现，读请求也用它。
    crypto: Box<dyn FnMut() -> C>,
    admit: Admit<C, A>,
    /// 查 mac1、mac2，写 cookie 回复。
    gate: Gate<C>,
}

/// 一个本地端口和上面的所有连接。`A` 是驱动的地址类型，默认是 UDP 地址。
pub struct Endpoint<C: Crypto, A: PathAddress = SocketAddr> {
    connections: BTreeMap<u32, Slot<C, A>>,
    /// 线上收包号 → 稳定句柄。一个句柄可以同时有多个收包号。
    destinations: BTreeMap<u32, u32>,
    listener: Option<Listener<C, A>>,
    accepted: VecDeque<u32>,
    /// 新连接号、cookie 密钥和盐的来源。
    random: Box<dyn FnMut() -> u32>,
    admitter: Admitter,
    /// 不属于任何连接、等着发的包：cookie 回复，关掉的连接最后的关闭包。
    outgoing: VecDeque<(Vec<u8>, A)>,
    stats: EndpointStats,
}

impl<C: Crypto, A: PathAddress> Endpoint<C, A> {
    /// `random` 给新连接选连接号，也用来生成算 cookie 的密钥，必须是不可预测的随机数：
    /// 同一台机器先后的连接号连着的话，路上的人能据此把它们对上；cookie 密钥猜得到，伪造来源地址就挡不住了。
    pub fn new(random: impl FnMut() -> u32 + 'static) -> Self {
        Self {
            connections: BTreeMap::new(),
            destinations: BTreeMap::new(),
            listener: None,
            accepted: VecDeque::new(),
            random: Box::new(random),
            admitter: Admitter::new(),
            outgoing: VecDeque::new(),
            stats: EndpointStats::default(),
        }
    }

    /// 改握手准入的限额，见 [`Admission`]。
    pub fn set_admission(&mut self, admission: Admission) {
        self.admitter.config = admission;
    }

    pub fn stats(&self) -> EndpointStats {
        self.stats
    }

    /// 连接号不取 0，调用方可以拿 0 表示“没有连接”。
    fn allocate_id(&mut self) -> u32 {
        loop {
            let id = (self.random)();
            if id != 0 && !self.connections.contains_key(&id) && !self.destinations.contains_key(&id) {
                return id;
            }
        }
    }

    /// 作废号先从分发表删掉，再补备用号。稳定句柄仍占位，不能被另一条新连接拿走。
    fn maintain_ids(&mut self, handle: u32) {
        let Some(slot) = self.connections.get_mut(&handle) else { return };
        slot.routing_ids.retain(|id| {
            if slot.connection.local_connection_ids().any(|local| local == *id) {
                true
            } else {
                self.destinations.remove(id);
                false
            }
        });
        if !slot.connection.is_established() {
            return;
        }
        while self.connections.get(&handle).is_some_and(|slot| slot.routing_ids.len() < MAX_IDS) {
            let id = self.allocate_id();
            let slot = self.connections.get_mut(&handle).expect("live handle");
            if !slot.connection.add_connection_id(id) {
                break;
            }
            slot.routing_ids.push(id);
            self.destinations.insert(id, handle);
        }
    }

    /// 向 `peer` 发起加密连接，返回稳定句柄，初值等于握手里的连接号。线上号码轮换、作废后句柄仍有效；
    /// 不要把后续包的 `destination_id` 当成句柄。`config.connection_id` 会被替换。
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        &mut self,
        now_us: u64,
        crypto: C,
        config: Config,
        prologue: &[u8],
        remote_static: &[u8; PUBLIC_KEY_LEN],
        payload: &[u8],
        peer: A,
    ) -> Result<u32, HandshakeError> {
        let id = self.allocate_id();
        let connection = SecureConnection::connect(crypto, Config { connection_id: id, ..config }, prologue, remote_static, payload, now_us)?;
        self.connections.insert(id, Slot::new(connection, peer, now_us));
        self.destinations.insert(id, id);
        Ok(id)
    }

    /// 接受别人发起的连接。`crypto` 给每条新连接一个加密实现；`admit` 看过对方的长期公钥、附带数据和来源地址后决定接不接受；
    /// 接受的连接用 `config`（连接号会被替换），回复里附带 `payload`。新连接用 [`accept`](Self::accept) 取。
    pub fn listen(
        &mut self,
        prologue: &[u8],
        config: Config,
        payload: &[u8],
        mut crypto: impl FnMut() -> C + 'static,
        admit: impl FnMut(&Incoming<C>, A) -> bool + 'static,
    ) {
        let gate = Gate::new(crypto());
        self.listener = Some(Listener { prologue: prologue.to_vec(), config, payload: payload.to_vec(), crypto: Box::new(crypto), admit: Box::new(admit), gate });
    }

    /// 新接受的连接，取一个少一个。
    pub fn accept(&mut self) -> Option<u32> {
        self.accepted.pop_front()
    }

    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.connections.keys().copied()
    }

    pub fn connection(&self, id: u32) -> Option<&SecureConnection<C>> {
        self.connections.get(&id).map(|slot| &slot.connection)
    }

    pub fn connection_mut(&mut self, id: u32) -> Option<&mut SecureConnection<C>> {
        self.connections.get_mut(&id).map(|slot| &mut slot.connection)
    }

    /// 这条连接的数据现在发往哪个地址。
    pub fn peer_addr(&self, id: u32) -> Option<A> {
        let slot = self.connections.get(&id)?;
        slot.paths.get(&slot.connection.path()).map(|(address, _)| *address)
    }

    /// 关掉一条连接，不再收发。连接已经建立时先把关闭包排进 [`poll_transmit`](Self::poll_transmit)，
    /// 对端收到就停，不用等判死，见 `SecureConnection::close`。
    pub fn close(&mut self, id: u32) -> Option<SecureConnection<C>> {
        let mut slot = self.connections.remove(&id)?;
        for routing_id in &slot.routing_ids {
            self.destinations.remove(routing_id);
        }
        slot.connection.close();
        let mut packet = [0; CLOSE_PACKET_LEN];
        while let Some((size, path)) = slot.connection.poll_close(&mut packet) {
            if let Some(&(address, _)) = slot.paths.get(&path)
                && self.outgoing.len() < MAX_OUTGOING
            {
                self.outgoing.push_back((packet[..size].to_vec(), address));
            }
        }
        Some(slot.connection)
    }

    /// 主动验证这条连接到 `address` 的路径（打洞时验证对端的候选地址、手动退回中继等），
    /// 见 `SecureConnection::probe_path`。地址要来自已认证的对端或这一端自己。开始了新一轮验证时返回 `true`。
    pub fn probe(&mut self, now_us: u64, id: u32, address: A) -> bool {
        let Some(slot) = self.connections.get_mut(&id) else { return false };
        let path = slot.path_of(address, now_us);
        slot.connection.probe_path(now_us, path)
    }

    /// 这一端换了网络（换了网卡、重新绑定了端口）：告诉每条连接，它们会马上发包让对端跟过来。
    /// 见 `SecureConnection::on_local_address_change`。
    pub fn on_local_address_change(&mut self, now_us: u64) {
        for slot in self.connections.values_mut() {
            slot.connection.on_local_address_change(now_us);
        }
    }

    /// 下一次需要调用 [`tick`](Self::tick) 的时间。有包等着发时是 0。
    pub fn next_wake(&self) -> Option<u64> {
        if !self.outgoing.is_empty() {
            return Some(0);
        }
        self.connections.values().filter_map(|slot| slot.connection.next_wake()).min()
    }

    /// 处理到期的计时器。
    pub fn tick(&mut self, now_us: u64) {
        for slot in self.connections.values_mut() {
            if slot.connection.next_wake().is_some_and(|at| at <= now_us) {
                slot.connection.tick(now_us);
            }
        }
    }

    /// 收到一个数据报。
    pub fn on_datagram(&mut self, now_us: u64, from: A, packet: &[u8]) {
        self.stats.datagrams_received += 1;
        self.stats.bytes_received += packet.len() as u64;
        if is_cookie_reply(packet) {
            match self.connections.values_mut().find(|slot| slot.connection.awaits_cookie(packet)) {
                Some(slot) => {
                    let path = slot.connection.path();
                    let _ = slot.connection.on_packet_via(now_us, path, packet);
                }
                None => self.stats.unknown_destination += 1,
            }
            return;
        }
        if is_initiation(packet) {
            // 先查 mac1：不知道这一端公钥的人发来的，什么都不做，也不回。
            if self.listener.as_ref().is_some_and(|listener| !listener.gate.mac1_ok(packet)) {
                self.stats.bad_mac1 += 1;
                return;
            }
            // 重发的请求交给同一条连接：还没确认的会再回一次，确认过的当重复丢掉。对方重新发起的新连接才另开一条。
            if let Some(slot) = self.connections.values_mut().find(|slot| slot.knows(from)) {
                let path = slot.path_of(from, now_us);
                if slot.connection.on_packet_via(now_us, path, packet) != Err(PacketError::Handshake) {
                    return;
                }
            }
            let Some(listener) = self.listener.as_ref() else {
                self.stats.rejected_initiations += 1;
                return;
            };
            let mut address = Vec::new();
            from.write_identity(&mut address);
            match self.admitter.check(&listener.gate, now_us, &address, packet, &mut self.random) {
                Verdict::Process => self.admit(now_us, from, packet),
                Verdict::Cookie(reply) => {
                    self.stats.cookie_replies += 1;
                    if self.outgoing.len() < MAX_OUTGOING {
                        self.outgoing.push_back((reply, from));
                    }
                }
                Verdict::Throttled => self.stats.throttled_initiations += 1,
            }
            return;
        }
        let Some(handle) = destination_id(packet).and_then(|id| self.destinations.get(&id)).copied() else {
            self.stats.unknown_destination += 1;
            return;
        };
        let Some(slot) = self.connections.get_mut(&handle) else { return };
        let path = slot.path_of(from, now_us);
        let same_route = slot.same_route(from);
        let _ = slot.connection.on_packet_via_route(now_us, path, same_route, packet);
        self.maintain_ids(handle);
    }

    fn admit(&mut self, now_us: u64, from: A, packet: &[u8]) {
        let unconfirmed = self.connections.values().filter(|slot| !slot.connection.is_established()).count();
        let id = self.allocate_id();
        let Some(listener) = self.listener.as_mut().filter(|_| unconfirmed < MAX_UNCONFIRMED) else {
            self.stats.rejected_initiations += 1;
            return;
        };
        let crypto = (listener.crypto)();
        let accepted = Incoming::read(&crypto, &listener.prologue, packet)
            .ok()
            .filter(|incoming| (listener.admit)(incoming, from))
            .and_then(|incoming| incoming.accept(crypto, Config { connection_id: id, ..listener.config.clone() }, &listener.payload, now_us).ok());
        match accepted {
            Some(connection) => {
                self.connections.insert(id, Slot::new(connection, from, now_us));
                self.destinations.insert(id, id);
                self.accepted.push_back(id);
            }
            None => self.stats.rejected_initiations += 1,
        }
    }

    /// 取下一个要发的数据报，写进 `out`，返回长度和目的地址。`out` 不能小于各连接配置的 `max_packet_size`。
    /// 一条连接的包取完了才轮到下一条。
    pub fn poll_transmit(&mut self, now_us: u64, out: &mut [u8]) -> Option<(usize, A)> {
        if let Some((packet, address)) = self.outgoing.pop_front() {
            out[..packet.len()].copy_from_slice(&packet);
            self.stats.datagrams_sent += 1;
            self.stats.bytes_sent += packet.len() as u64;
            return Some((packet.len(), address));
        }
        for slot in self.connections.values_mut() {
            while let Some((size, path)) = slot.connection.poll_transmit_via(now_us, out) {
                // 路径号被忘掉了（来源地址太多），这个包只能丢掉，可靠层会重传。
                let Some(&(address, _)) = slot.paths.get(&path) else { continue };
                self.stats.datagrams_sent += 1;
                self.stats.bytes_sent += size as u64;
                return Some((size, address));
            }
        }
        None
    }
}
