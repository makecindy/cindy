//! agent-net 的真机 UDP 驱动。核心（`agent-net-core`）不碰套接字和时钟，这里补上：
//!
//! - 一个 UDP 套接字上跑多条加密连接。按连接号分发、给来源地址编路径号都在核心的 [`agent_net_core::Endpoint`] 里，
//!   和其他平台的驱动共用；这里只负责收发数据报。
//! - 时钟用单调时钟，计时器到点就处理，有包就收，能发就发。
//! - [`Endpoint::rebind`] 换一个本地端口或网卡重新绑定，换网时用。
//!
//! 只用标准库，也不带任何产品专属的东西：身份、接受规则、传什么都由调用方决定。
//! 单线程，调用方反复调用 [`Endpoint::poll`]。

use std::hash::{BuildHasher, Hasher as _};
use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use agent_net_core::{Config, Crypto, HandshakeError, Incoming, PUBLIC_KEY_LEN, SecureConnection};

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
    /// mac1 不对、没做 DH 就丢掉的握手请求，见核心的 `EndpointStats`。
    pub bad_mac1: u64,
    /// 忙的时候回出去的 cookie。
    pub cookie_replies: u64,
    /// 忙的时候超过限额、没做 DH 就丢掉的握手请求。
    pub throttled_initiations: u64,
    /// 发送失败的包：网络不可达、发送缓冲满。可靠层会当丢包处理。
    pub send_errors: u64,
    pub rebinds: u64,
}

/// 一个本地 UDP 端口和上面的所有连接。
pub struct Endpoint<C: Crypto> {
    socket: UdpSocket,
    epoch: Instant,
    core: agent_net_core::Endpoint<C>,
    incoming: Vec<u8>,
    outgoing: Vec<u8>,
    datagrams_sent: u64,
    bytes_sent: u64,
    send_errors: u64,
    rebinds: u64,
}

/// 新连接的连接号随机选。标准库的散列种子由系统随机数生成，每次取新的种子，空输入的散列值就是一个随机数。
fn random_id() -> u32 {
    std::collections::hash_map::RandomState::new().build_hasher().finish() as u32
}

impl<C: Crypto> Endpoint<C> {
    /// 绑定本地地址，例如 `0.0.0.0:0`。`max_packet_size` 不能小于各连接配置里的值。
    pub fn bind(address: SocketAddr, max_packet_size: usize) -> io::Result<Self> {
        Ok(Self {
            socket: UdpSocket::bind(address)?,
            epoch: Instant::now(),
            core: agent_net_core::Endpoint::new(random_id),
            incoming: vec![0; RECEIVE_BUFFER],
            outgoing: vec![0; max_packet_size],
            datagrams_sent: 0,
            bytes_sent: 0,
            send_errors: 0,
            rebinds: 0,
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
        let core = self.core.stats();
        EndpointStats {
            datagrams_received: core.datagrams_received,
            datagrams_sent: self.datagrams_sent,
            bytes_received: core.bytes_received,
            bytes_sent: self.bytes_sent,
            unknown_destination: core.unknown_destination,
            rejected_initiations: core.rejected_initiations,
            bad_mac1: core.bad_mac1,
            cookie_replies: core.cookie_replies,
            throttled_initiations: core.throttled_initiations,
            send_errors: self.send_errors,
            rebinds: self.rebinds,
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
        let now = self.now_us();
        self.core.connect(now, crypto, config, prologue, remote_static, payload, peer)
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
        self.core.listen(prologue, config, payload, crypto, admit);
    }

    /// 新接受的连接，取一个少一个。
    pub fn accept(&mut self) -> Option<u32> {
        self.core.accept()
    }

    pub fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.core.ids()
    }

    pub fn connection(&self, id: u32) -> Option<&SecureConnection<C>> {
        self.core.connection(id)
    }

    pub fn connection_mut(&mut self, id: u32) -> Option<&mut SecureConnection<C>> {
        self.core.connection_mut(id)
    }

    /// 这条连接的数据现在发往哪个地址。
    pub fn peer_addr(&self, id: u32) -> Option<SocketAddr> {
        self.core.peer_addr(id)
    }

    /// 关掉一条连接，不再收发。
    pub fn close(&mut self, id: u32) -> Option<SecureConnection<C>> {
        self.core.close(id)
    }

    /// 换一个本地地址重新绑定：换了网卡、旧端口不能用了。`notify` 为 `true` 时告诉每条连接这一端换了网络
    /// （见 `SecureConnection::on_local_address_change`），它们会马上发包让对端跟过来；为 `false` 时连接自己察觉不到，
    /// 和 NAT 换了端口一样，靠对端验证新地址、自己安静时探测。
    pub fn rebind(&mut self, address: SocketAddr, notify: bool) -> io::Result<()> {
        self.socket = UdpSocket::bind(address)?;
        self.rebinds += 1;
        if notify {
            let now = self.now_us();
            self.core.on_local_address_change(now);
        }
        Ok(())
    }

    /// 下一次需要处理计时器的时间，按 [`now_us`](Self::now_us) 计。
    pub fn next_wake(&self) -> Option<u64> {
        self.core.next_wake()
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
        self.core.tick(now);
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
        let mut result = Ok(());
        let mut received = 0;
        for _ in 0..MAX_DATAGRAMS_PER_POLL {
            match self.socket.recv_from(&mut self.incoming) {
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
                    self.core.on_datagram(now, from, &self.incoming[..size]);
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
        if result.is_ok() && !blocking && received == 0 && !wait.is_zero() {
            std::thread::sleep(wait.min(SHORT_SLEEP));
        }
        result
    }

    fn flush(&mut self) {
        let now = self.now_us();
        while let Some((size, address)) = self.core.poll_transmit(now, &mut self.outgoing) {
            match self.socket.send_to(&self.outgoing[..size], address) {
                Ok(_) => {
                    self.datagrams_sent += 1;
                    self.bytes_sent += size as u64;
                }
                Err(_) => self.send_errors += 1,
            }
        }
    }
}
