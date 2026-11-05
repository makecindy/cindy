//! agent-net 的真机 UDP 驱动。核心（`agent-net-core`）不碰套接字和时钟，这里补上：
//!
//! - 一个 UDP 套接字上跑多条加密连接。数据包和握手回复按连接号（[`destination_id`]）找连接，不按来源地址：
//!   NAT 换了端口、手机换了网络，地址都会变。握手请求按 [`Endpoint::listen`] 设的规则决定接不接受。
//! - 每条连接自己给来源地址编路径号：0 是建连时的地址，之后每见到一个新地址编一个新号，核心据此验证新路径、换过去。
//!   新地址和数据路径 IP 相同、只差端口时告诉核心（`on_packet_via_route`），换过去时不重量往返和带宽。
//! - 时钟用单调时钟，计时器到点就处理，有包就收，能发就发。
//! - [`Endpoint::rebind`] 换一个本地端口或网卡重新绑定，换网时用。
//!
//! 只用标准库，也不带任何产品专属的东西：身份、接受规则、传什么都由调用方决定。
//! 单线程，调用方反复调用 [`Endpoint::poll`]。

use std::collections::{BTreeMap, VecDeque};
use std::hash::{BuildHasher, Hasher as _};
use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use agent_net_core::{Config, Crypto, HandshakeError, Incoming, PUBLIC_KEY_LEN, PacketError, SecureConnection, destination_id, is_initiation};

/// 一条连接最多记住这么多个来源地址，再多就忘掉最久没见到的（正在用的和正在验证的除外）。
/// 伪造来源的包每个都会占一个号，不能无限增长。
const MAX_PATHS: usize = 16;
/// 还没确认的连接最多这么多条。重放的握手请求会各开一条，确认不了，`dead_after_us` 后自己放弃。
const MAX_UNCONFIRMED: usize = 1024;
/// 一次 `poll` 最多处理这么多个到达的包，然后先把该发的发出去。
const MAX_DATAGRAMS_PER_POLL: usize = 1024;
/// 收包缓冲按 UDP 的上限开：缓冲比包小时，有的系统会报错而不是截断。
const RECEIVE_BUFFER: usize = 65_536;
/// 要等这么久以上才在套接字上阻塞等包。套接字的读超时按系统时钟节拍取整，Linux 上 500 微秒会变成好几毫秒，
/// 发送节奏会被驱动自己拖慢；等得短时改成不阻塞地读，没有包就睡一小会。空闲时等得长，阻塞省电。
const BLOCKING_WAIT: Duration = Duration::from_millis(10);
/// 不阻塞地读、没有包时睡这么久，到达的包最多晚这么久处理。
const SHORT_SLEEP: Duration = Duration::from_micros(200);

/// 驱动层的计数。
#[derive(Clone, Copy, Debug, Default)]
pub struct EndpointStats {
    pub datagrams_received: u64,
    pub datagrams_sent: u64,
    pub bytes_received: u64,
    pub bytes_sent: u64,
    /// 连接号对不上任何连接的包。
    pub unknown_destination: u64,
    /// 读不开、或者被接受规则拒绝的握手请求。
    pub rejected_initiations: u64,
    /// 发送失败的包：网络不可达、发送缓冲满。可靠层会当丢包处理。
    pub send_errors: u64,
    pub rebinds: u64,
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
            let keep: Vec<u64> = std::iter::once(self.connection.path()).chain(self.connection.validating()).collect();
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

/// 一个本地 UDP 端口和上面的所有连接。
pub struct Endpoint<C: Crypto> {
    socket: UdpSocket,
    epoch: Instant,
    connections: BTreeMap<u32, Slot<C>>,
    listener: Option<Listener<C>>,
    accepted: VecDeque<u32>,
    incoming: Vec<u8>,
    outgoing: Vec<u8>,
    stats: EndpointStats,
}

/// 新连接的连接号随机选：同一台机器先后的连接号连着的话，路上的人能据此把它们对上。
/// 标准库的散列种子由系统随机数生成，每次取新的种子，空输入的散列值就是一个随机数。
fn random_id() -> u32 {
    std::collections::hash_map::RandomState::new().build_hasher().finish() as u32
}

impl<C: Crypto> Endpoint<C> {
    /// 绑定本地地址，例如 `0.0.0.0:0`。`max_packet_size` 不能小于各连接配置里的值。
    pub fn bind(address: SocketAddr, max_packet_size: usize) -> io::Result<Self> {
        Ok(Self {
            socket: UdpSocket::bind(address)?,
            epoch: Instant::now(),
            connections: BTreeMap::new(),
            listener: None,
            accepted: VecDeque::new(),
            incoming: vec![0; RECEIVE_BUFFER],
            outgoing: vec![0; max_packet_size],
            stats: EndpointStats::default(),
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.socket.local_addr()
    }

    /// 核心用的时间：从建这个端点起的微秒数，单调递增。调用连接的 `send`、`recv` 时传它。
    pub fn now_us(&self) -> u64 {
        self.epoch.elapsed().as_micros() as u64
    }

    pub fn stats(&self) -> EndpointStats {
        self.stats
    }

    fn allocate_id(&self) -> u32 {
        loop {
            let id = random_id();
            if !self.connections.contains_key(&id) {
                return id;
            }
        }
    }

    /// 向 `peer` 发起加密连接，返回这条连接在本端点的编号（也就是它的连接号）。`config.connection_id` 会被替换。
    pub fn connect(
        &mut self,
        crypto: C,
        config: Config,
        prologue: &[u8],
        remote_static: &[u8; PUBLIC_KEY_LEN],
        payload: &[u8],
        peer: SocketAddr,
    ) -> Result<u32, HandshakeError> {
        let id = self.allocate_id();
        let now = self.now_us();
        let connection = SecureConnection::connect(crypto, Config { connection_id: id, ..config }, prologue, remote_static, payload, now)?;
        self.connections.insert(id, Slot::new(connection, peer, now));
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

    /// 换一个本地地址重新绑定：换了网卡、旧端口不能用了。`notify` 为 `true` 时告诉每条连接这一端换了网络
    /// （见 `SecureConnection::on_local_address_change`），它们会马上发包让对端跟过来；为 `false` 时连接自己察觉不到，
    /// 和 NAT 换了端口一样，靠对端验证新地址、自己安静时探测。
    pub fn rebind(&mut self, address: SocketAddr, notify: bool) -> io::Result<()> {
        self.socket = UdpSocket::bind(address)?;
        self.stats.rebinds += 1;
        if notify {
            let now = self.now_us();
            for slot in self.connections.values_mut() {
                slot.connection.on_local_address_change(now);
            }
        }
        Ok(())
    }

    /// 下一次需要处理计时器的时间，按 [`now_us`](Self::now_us) 计。
    pub fn next_wake(&self) -> Option<u64> {
        self.connections.values().filter_map(|slot| slot.connection.next_wake()).min()
    }

    /// 发出该发的包，最多等 `max_wait` 收包，处理到期的计时器，再发一轮。计时器到点或者有包到达都会提前返回。
    pub fn poll(&mut self, max_wait: Duration) -> io::Result<()> {
        self.flush();
        let now = self.now_us();
        let wait = match self.next_wake() {
            Some(at) if at <= now => Duration::ZERO,
            Some(at) => max_wait.min(Duration::from_micros(at - now)),
            None => max_wait,
        };
        self.receive(wait)?;
        let now = self.now_us();
        for slot in self.connections.values_mut() {
            if slot.connection.next_wake().is_some_and(|at| at <= now) {
                slot.connection.tick(now);
            }
        }
        self.flush();
        Ok(())
    }

    fn receive(&mut self, wait: Duration) -> io::Result<()> {
        let blocking = wait > BLOCKING_WAIT;
        if blocking {
            self.socket.set_nonblocking(false)?;
            self.socket.set_read_timeout(Some(wait))?;
        } else {
            self.socket.set_nonblocking(true)?;
        }
        let mut incoming = std::mem::take(&mut self.incoming);
        let mut result = Ok(());
        let mut received = 0;
        for _ in 0..MAX_DATAGRAMS_PER_POLL {
            match self.socket.recv_from(&mut incoming) {
                Ok((size, from)) => {
                    received += 1;
                    if received == 1 && blocking {
                        // 等到了第一个包，剩下的不再等，有多少收多少。
                        if let Err(error) = self.socket.set_nonblocking(true) {
                            result = Err(error);
                            break;
                        }
                    }
                    let now = self.now_us();
                    self.dispatch(now, from, &incoming[..size]);
                }
                Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => break,
                // Windows 上发往已关闭端口的包换回的 ICMP 会让下一次收包报错，套接字本身没坏。
                Err(error) if matches!(error.kind(), io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused) => {}
                Err(error) => {
                    result = Err(error);
                    break;
                }
            }
        }
        self.incoming = incoming;
        if result.is_ok() && !blocking && received == 0 && !wait.is_zero() {
            std::thread::sleep(wait.min(SHORT_SLEEP));
        }
        result
    }

    fn dispatch(&mut self, now_us: u64, from: SocketAddr, packet: &[u8]) {
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

    fn flush(&mut self) {
        let now = self.now_us();
        for slot in self.connections.values_mut() {
            while let Some((size, path)) = slot.connection.poll_transmit_via(now, &mut self.outgoing) {
                // 路径号被忘掉了（来源地址太多），这个包只能丢掉，可靠层会重传。
                let Some(&(address, _)) = slot.paths.get(&path) else { continue };
                match self.socket.send_to(&self.outgoing[..size], address) {
                    Ok(_) => {
                        self.stats.datagrams_sent += 1;
                        self.stats.bytes_sent += size as u64;
                    }
                    Err(_) => self.stats.send_errors += 1,
                }
            }
        }
    }
}
