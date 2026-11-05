//! 一个本地端口上的多条加密连接。和连接一样不碰套接字和时钟：调用方把收到的数据报、来源地址和当前时间喂进来，
//! 再取出要发的数据报和目的地址。真机 UDP 驱动、Node 驱动和以后的手机驱动共用这一份分发逻辑。
//!
//! - 数据包和握手回复按连接号（[`destination_id`]）找连接，不按来源地址：NAT 换了端口、手机换了网络，地址都会变。
//!   握手请求按 [`Endpoint::listen`] 设的规则决定接不接受。
//! - 每条连接自己给来源地址编路径号：0 是建连时的地址，之后每见到一个新地址编一个新号，核心据此验证新路径、换过去。
//!   新地址和数据路径 IP 相同、只差端口时告诉连接（`on_packet_via_route`），换过去时不重量往返和带宽。

use alloc::boxed::Box;
use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::net::SocketAddr;

use crate::connection::{Config, PacketError};
use crate::crypto::{Crypto, PUBLIC_KEY_LEN};
use crate::noise::HandshakeError;
use crate::secure::{Incoming, SecureConnection, destination_id, is_initiation};

/// 一条连接最多记住这么多个来源地址，再多就忘掉最久没见到的（正在用的和正在验证的除外）。
/// 伪造来源的包每个都会占一个号，不能无限增长。
const MAX_PATHS: usize = 16;
/// 还没确认的连接最多这么多条。重放的握手请求会各开一条，确认不了，`dead_after_us` 后自己放弃。
const MAX_UNCONFIRMED: usize = 1024;

/// 分发层的计数。
#[derive(Clone, Copy, Debug, Default)]
pub struct EndpointStats {
    pub datagrams_received: u64,
    pub bytes_received: u64,
    /// 交给调用方去发的数据报。
    pub datagrams_sent: u64,
    pub bytes_sent: u64,
    /// 连接号对不上任何连接的包。
    pub unknown_destination: u64,
    /// 读不开、或者被接受规则拒绝的握手请求。
    pub rejected_initiations: u64,
}

struct Slot<C: Crypto> {
    connection: SecureConnection<C>,
    /// 路径号 → （地址，最后一次从那里收到包的时间）。
    paths: BTreeMap<u64, (SocketAddr, u64)>,
    next_path: u64,
}

impl<C: Crypto> Slot<C> {
    fn new(connection: SecureConnection<C>, peer: SocketAddr, now_us: u64) -> Self {
        Self { connection, paths: BTreeMap::from([(0, (peer, now_us))]), next_path: 1 }
    }

    fn knows(&self, address: SocketAddr) -> bool {
        self.paths.values().any(|(known, _)| *known == address)
    }

    /// `from` 和数据路径只差端口：多半是 NAT 换了外部端口，走的还是同一条路。
    fn same_route(&self, from: SocketAddr) -> bool {
        self.paths.get(&self.connection.path()).is_some_and(|(active, _)| active.ip() == from.ip() && active.port() != from.port())
    }

    /// 来源地址对应的路径号，没见过就编一个新的。
    fn path_of(&mut self, from: SocketAddr, now_us: u64) -> u64 {
        if let Some((&path, entry)) = self.paths.iter_mut().find(|(_, (address, _))| *address == from) {
            entry.1 = now_us;
            return path;
        }
        if self.paths.len() >= MAX_PATHS {
            let keep: Vec<u64> = core::iter::once(self.connection.path()).chain(self.connection.validating()).collect();
            let oldest = self.paths.iter().filter(|(path, _)| !keep.contains(path)).min_by_key(|(_, (_, seen))| *seen).map(|(&path, _)| path);
            if let Some(path) = oldest {
                self.paths.remove(&path);
            }
        }
        let path = self.next_path;
        self.next_path += 1;
        self.paths.insert(path, (from, now_us));
        path
    }
}

/// 接受规则：看过对方身份、附带数据和来源地址以后决定接不接受。
type Admit<C> = Box<dyn FnMut(&Incoming<C>, SocketAddr) -> bool>;

/// 收到陌生的握手请求时怎么办。
struct Listener<C: Crypto> {
    prologue: Vec<u8>,
    config: Config,
    payload: Vec<u8>,
    /// 给每条新连接一个加密实现，读请求也用它。
    crypto: Box<dyn FnMut() -> C>,
    admit: Admit<C>,
}

/// 一个本地端口和上面的所有连接。
pub struct Endpoint<C: Crypto> {
    connections: BTreeMap<u32, Slot<C>>,
    listener: Option<Listener<C>>,
    accepted: VecDeque<u32>,
    /// 新连接号的来源。
    random: Box<dyn FnMut() -> u32>,
    stats: EndpointStats,
}

impl<C: Crypto> Endpoint<C> {
    /// `random` 给新连接选连接号，必须是不可预测的随机数：同一台机器先后的连接号连着的话，路上的人能据此把它们对上。
    pub fn new(random: impl FnMut() -> u32 + 'static) -> Self {
        Self {
            connections: BTreeMap::new(),
            listener: None,
            accepted: VecDeque::new(),
            random: Box::new(random),
            stats: EndpointStats::default(),
        }
    }

    pub fn stats(&self) -> EndpointStats {
        self.stats
    }

    /// 连接号不取 0，调用方可以拿 0 表示“没有连接”。
    fn allocate_id(&mut self) -> u32 {
        loop {
            let id = (self.random)();
            if id != 0 && !self.connections.contains_key(&id) {
                return id;
            }
        }
    }

    /// 向 `peer` 发起加密连接，返回这条连接在本端点的编号（也就是它的连接号）。`config.connection_id` 会被替换。
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        &mut self,
        now_us: u64,
        crypto: C,
        config: Config,
        prologue: &[u8],
        remote_static: &[u8; PUBLIC_KEY_LEN],
        payload: &[u8],
        peer: SocketAddr,
    ) -> Result<u32, HandshakeError> {
        let id = self.allocate_id();
        let connection = SecureConnection::connect(crypto, Config { connection_id: id, ..config }, prologue, remote_static, payload, now_us)?;
        self.connections.insert(id, Slot::new(connection, peer, now_us));
        Ok(id)
    }

    /// 接受别人发起的连接。`crypto` 给每条新连接一个加密实现；`admit` 看过对方的长期公钥、附带数据和来源地址后决定接不接受；
    /// 接受的连接用 `config`（连接号会被替换），回复里附带 `payload`。新连接用 [`accept`](Self::accept) 取。
    pub fn listen(
        &mut self,
        prologue: &[u8],
        config: Config,
        payload: &[u8],
        crypto: impl FnMut() -> C + 'static,
        admit: impl FnMut(&Incoming<C>, SocketAddr) -> bool + 'static,
    ) {
        self.listener = Some(Listener { prologue: prologue.to_vec(), config, payload: payload.to_vec(), crypto: Box::new(crypto), admit: Box::new(admit) });
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
    pub fn peer_addr(&self, id: u32) -> Option<SocketAddr> {
        let slot = self.connections.get(&id)?;
        slot.paths.get(&slot.connection.path()).map(|(address, _)| *address)
    }

    /// 关掉一条连接，不再收发。
    pub fn close(&mut self, id: u32) -> Option<SecureConnection<C>> {
        self.connections.remove(&id).map(|slot| slot.connection)
    }

    /// 这一端换了网络（换了网卡、重新绑定了端口）：告诉每条连接，它们会马上发包让对端跟过来。
    /// 见 `SecureConnection::on_local_address_change`。
    pub fn on_local_address_change(&mut self, now_us: u64) {
        for slot in self.connections.values_mut() {
            slot.connection.on_local_address_change(now_us);
        }
    }

    /// 下一次需要调用 [`tick`](Self::tick) 的时间。
    pub fn next_wake(&self) -> Option<u64> {
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
    pub fn on_datagram(&mut self, now_us: u64, from: SocketAddr, packet: &[u8]) {
        self.stats.datagrams_received += 1;
        self.stats.bytes_received += packet.len() as u64;
        if is_initiation(packet) {
            // 重发的请求交给同一条连接：还没确认的会再回一次，确认过的当重复丢掉。对方重新发起的新连接才另开一条。
            if let Some(slot) = self.connections.values_mut().find(|slot| slot.knows(from)) {
                let path = slot.path_of(from, now_us);
                if slot.connection.on_packet_via(now_us, path, packet) != Err(PacketError::Handshake) {
                    return;
                }
            }
            self.admit(now_us, from, packet);
            return;
        }
        let Some(slot) = destination_id(packet).and_then(|id| self.connections.get_mut(&id)) else {
            self.stats.unknown_destination += 1;
            return;
        };
        let path = slot.path_of(from, now_us);
        let same_route = slot.same_route(from);
        let _ = slot.connection.on_packet_via_route(now_us, path, same_route, packet);
    }

    fn admit(&mut self, now_us: u64, from: SocketAddr, packet: &[u8]) {
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
                self.accepted.push_back(id);
            }
            None => self.stats.rejected_initiations += 1,
        }
    }

    /// 取下一个要发的数据报，写进 `out`，返回长度和目的地址。`out` 不能小于各连接配置的 `max_packet_size`。
    /// 一条连接的包取完了才轮到下一条。
    pub fn poll_transmit(&mut self, now_us: u64, out: &mut [u8]) -> Option<(usize, SocketAddr)> {
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
