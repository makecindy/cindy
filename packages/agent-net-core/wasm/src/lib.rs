//! agent-net 核心的 WebAssembly 接口，给 Node 这类自己有事件循环的宿主用。
//!
//! 宿主管套接字、时钟和加密算法，这里只把核心的 [`Endpoint`] 按 C 调用约定暴露出去：
//!
//! - 一个实例就是一个本地端口。数据报、地址和其他变长数据都经两块固定缓冲交换：`io`（64 KiB）和 `addr`（24 字节），
//!   指针由 [`io_ptr`]、[`addr_ptr`] 给出。宿主在调用前写入、调用后读出。
//! - 时间是宿主单调时钟的微秒数，用 `f64` 传（2^53 微秒约 285 年，不会丢精度）。
//! - 加密算法从 `host` 模块导入，套件固定为 X25519、AES-256-GCM 和 SHA-256。长期私钥只在宿主手里，
//!   这里只拿得到公钥；一次性私钥和对称密钥也只是宿主那边的句柄，用完就通知宿主丢掉。
//! - 握手请求是否接受由宿主的 `admit` 回答。回答时不能回调这个实例。
//!
//! 地址的 24 字节：`[族 4 或 6][0][端口 2，小端][IPv6 作用域 4，小端][地址 16，IPv4 只用前 4 字节]`。
//! 族是 `L`（0x4C）时是宿主自己编号的通道（经中继转发等），`[L][代价][0 0][通道号 4，小端][0 …]`：
//! 发往它的数据报由宿主送进那个通道，代价见 `SecureConnection::set_path_cost`，UDP 地址的代价是 0。
//!
//! 只在 wasm32 上编译；别的目标上这个 crate 是空的。

#![cfg(target_arch = "wasm32")]

use std::cell::{RefCell, UnsafeCell};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

use agent_net_core::{
    BandwidthShare, Config, Crypto, Endpoint, HASH_LEN, Incoming, PUBLIC_KEY_LEN, PathAddress, Priority, RecoveryPolicy, StreamEvent, TAG_LEN,
};

const IO_LEN: usize = 65_536;
const ADDR_LEN: usize = 24;
const LINK_FAMILY: u8 = b'L';

/// UDP 地址，或者宿主编号的通道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Address {
    Udp(SocketAddr),
    Link { id: u32, cost: u8 },
}

impl PathAddress for Address {
    fn same_host(&self, other: &Self) -> bool {
        matches!((self, other), (Address::Udp(a), Address::Udp(b)) if a.ip() == b.ip())
    }

    fn cost(&self) -> u8 {
        match self {
            Address::Udp(_) => 0,
            Address::Link { cost, .. } => *cost,
        }
    }

    fn write_identity(&self, out: &mut Vec<u8>) {
        match self {
            Address::Udp(address) => address.write_identity(out),
            Address::Link { id, .. } => {
                out.push(LINK_FAMILY);
                out.extend_from_slice(&id.to_be_bytes());
            }
        }
    }
}

/// 和宿主交换数据的固定缓冲。
struct Exchange<const N: usize>(UnsafeCell<[u8; N]>);

// SAFETY: wasm 实例单线程。
unsafe impl<const N: usize> Sync for Exchange<N> {}

static IO: Exchange<IO_LEN> = Exchange(UnsafeCell::new([0; IO_LEN]));
static ADDR: Exchange<ADDR_LEN> = Exchange(UnsafeCell::new([0; ADDR_LEN]));

/// 每个导出函数只取一次：宿主只在两次调用之间读写这两块缓冲。
fn io() -> &'static mut [u8; IO_LEN] {
    // SAFETY: wasm 实例单线程，导出函数不重入（宿主的回调不能调回来），同一时刻只有这一个引用。
    unsafe { &mut *IO.0.get() }
}

fn addr() -> &'static mut [u8; ADDR_LEN] {
    // SAFETY: 同上。
    unsafe { &mut *ADDR.0.get() }
}

mod host {
    #[link(wasm_import_module = "host")]
    unsafe extern "C" {
        pub fn random(out: *mut u8, len: usize);
        pub fn panic(message: *const u8, len: usize);
        pub fn ephemeral_new(public_out: *mut u8) -> u32;
        pub fn ephemeral_drop(handle: u32);
        pub fn dh_static(peer: *const u8, out: *mut u8) -> i32;
        pub fn dh_ephemeral(handle: u32, peer: *const u8, out: *mut u8) -> i32;
        pub fn sha256(data: *const u8, len: usize, out: *mut u8);
        pub fn hmac_sha256(key: *const u8, data: *const u8, len: usize, out: *mut u8);
        pub fn key_new(bytes: *const u8) -> u32;
        pub fn key_drop(handle: u32);
        #[allow(clippy::too_many_arguments)]
        pub fn seal(key: u32, nonce_high: u32, nonce_low: u32, ad: *const u8, ad_len: usize, buffer: *mut u8, len: usize, tag_out: *mut u8);
        #[allow(clippy::too_many_arguments)]
        pub fn open(key: u32, nonce_high: u32, nonce_low: u32, ad: *const u8, ad_len: usize, buffer: *mut u8, len: usize, tag: *const u8) -> i32;
        pub fn admit(remote_static: *const u8, payload: *const u8, payload_len: usize, address: *const u8) -> i32;
    }
}

/// 宿主那边的一次性私钥。
struct Ephemeral(u32);

impl Drop for Ephemeral {
    fn drop(&mut self) {
        // SAFETY: 句柄由宿主发出，只丢一次。
        unsafe { host::ephemeral_drop(self.0) }
    }
}

/// 宿主那边的对称密钥。
struct Key(u32);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: 同上。
        unsafe { host::key_drop(self.0) }
    }
}

/// 拼起来交给宿主算哈希的数据可能含链式密钥，用完清零。
struct Joined(Vec<u8>);

impl Joined {
    fn new(parts: &[&[u8]]) -> Self {
        Self(parts.concat())
    }
}

impl Drop for Joined {
    fn drop(&mut self) {
        self.0.fill(0);
        std::hint::black_box(&mut self.0);
    }
}

#[derive(Clone)]
struct HostCrypto {
    public: [u8; PUBLIC_KEY_LEN],
}

impl Crypto for HostCrypto {
    type Ephemeral = Ephemeral;
    type Key = Key;
    const CIPHER: &'static str = "AESGCM";
    const HASH: &'static str = "SHA256";

    fn static_public(&self) -> [u8; PUBLIC_KEY_LEN] {
        self.public
    }

    fn generate_ephemeral(&self) -> (Ephemeral, [u8; PUBLIC_KEY_LEN]) {
        let mut public = [0; PUBLIC_KEY_LEN];
        // SAFETY: 宿主往 `public` 写 32 字节。
        let handle = unsafe { host::ephemeral_new(public.as_mut_ptr()) };
        (Ephemeral(handle), public)
    }

    fn dh_static(&self, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
        let mut out = [0; PUBLIC_KEY_LEN];
        // SAFETY: 宿主读 32 字节、写 32 字节。
        (unsafe { host::dh_static(peer.as_ptr(), out.as_mut_ptr()) } != 0).then_some(out)
    }

    fn dh_ephemeral(&self, secret: &Ephemeral, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
        let mut out = [0; PUBLIC_KEY_LEN];
        // SAFETY: 同上。
        (unsafe { host::dh_ephemeral(secret.0, peer.as_ptr(), out.as_mut_ptr()) } != 0).then_some(out)
    }

    fn hash(&self, parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let joined = Joined::new(parts);
        let mut out = [0; HASH_LEN];
        // SAFETY: 宿主读 `len` 字节、写 32 字节。
        unsafe { host::sha256(joined.0.as_ptr(), joined.0.len(), out.as_mut_ptr()) };
        out
    }

    fn hmac(&self, key: &[u8; HASH_LEN], parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let joined = Joined::new(parts);
        let mut out = [0; HASH_LEN];
        // SAFETY: 同上，另读 32 字节的密钥。
        unsafe { host::hmac_sha256(key.as_ptr(), joined.0.as_ptr(), joined.0.len(), out.as_mut_ptr()) };
        out
    }

    fn key(&self, bytes: &[u8; HASH_LEN]) -> Key {
        // SAFETY: 宿主读 32 字节。
        Key(unsafe { host::key_new(bytes.as_ptr()) })
    }

    fn seal(&self, key: &Key, nonce: u64, ad: &[u8], buffer: &mut [u8]) -> [u8; TAG_LEN] {
        let mut tag = [0; TAG_LEN];
        // SAFETY: 宿主原地加密 `buffer`，写 16 字节的标签。
        unsafe {
            host::seal(key.0, (nonce >> 32) as u32, nonce as u32, ad.as_ptr(), ad.len(), buffer.as_mut_ptr(), buffer.len(), tag.as_mut_ptr())
        };
        tag
    }

    fn open(&self, key: &Key, nonce: u64, ad: &[u8], buffer: &mut [u8], tag: &[u8; TAG_LEN]) -> bool {
        // SAFETY: 宿主原地解密 `buffer`，读 16 字节的标签。
        unsafe { host::open(key.0, (nonce >> 32) as u32, nonce as u32, ad.as_ptr(), ad.len(), buffer.as_mut_ptr(), buffer.len(), tag.as_ptr()) != 0 }
    }
}

struct State {
    endpoint: Endpoint<HostCrypto, Address>,
    crypto: HostCrypto,
    config: Config,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(fallback: R, run: impl FnOnce(&mut State) -> R) -> R {
    STATE.with_borrow_mut(|state| state.as_mut().map(run).unwrap_or(fallback))
}

fn micros(now: f64) -> u64 {
    if now.is_finite() && now > 0.0 { now as u64 } else { 0 }
}

fn decode_addr(bytes: &[u8; ADDR_LEN]) -> Option<Address> {
    let port = u16::from_le_bytes([bytes[2], bytes[3]]);
    let scope = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    match bytes[0] {
        4 => Some(Address::Udp(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(bytes[8], bytes[9], bytes[10], bytes[11]), port)))),
        6 => {
            let ip: [u8; 16] = bytes[8..24].try_into().ok()?;
            Some(Address::Udp(SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::from(ip), port, 0, scope))))
        }
        LINK_FAMILY => Some(Address::Link { id: scope, cost: bytes[1] }),
        _ => None,
    }
}

fn encode_addr(address: Address, out: &mut [u8; ADDR_LEN]) {
    *out = [0; ADDR_LEN];
    let address = match address {
        Address::Udp(address) => address,
        Address::Link { id, cost } => {
            out[0] = LINK_FAMILY;
            out[1] = cost;
            out[4..8].copy_from_slice(&id.to_le_bytes());
            return;
        }
    };
    out[2..4].copy_from_slice(&address.port().to_le_bytes());
    match address {
        SocketAddr::V4(v4) => {
            out[0] = 4;
            out[8..12].copy_from_slice(&v4.ip().octets());
        }
        SocketAddr::V6(v6) => {
            out[0] = 6;
            out[4..8].copy_from_slice(&v6.scope_id().to_le_bytes());
            out[8..24].copy_from_slice(&v6.ip().octets());
        }
    }
}

fn random_id() -> u32 {
    let mut bytes = [0; 4];
    // SAFETY: 宿主写 4 字节。
    unsafe { host::random(bytes.as_mut_ptr(), bytes.len()) };
    u32::from_le_bytes(bytes)
}

#[unsafe(no_mangle)]
pub extern "C" fn io_ptr() -> *mut u8 {
    io().as_mut_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn addr_ptr() -> *mut u8 {
    addr().as_mut_ptr()
}

/// 建立端点。io 里放本机长期公钥（32 字节）。`recovery`：0 自动、1 省流、2 偏速度；`share`：0 全速、1 让路。
/// 成功返回 0。
#[unsafe(no_mangle)]
pub extern "C" fn init(max_packet_size: u32, recovery: u32, share: u32) -> i32 {
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        // SAFETY: 宿主读 `len` 字节。
        unsafe { host::panic(message.as_ptr(), message.len()) };
    }));
    let recovery_policy = match recovery {
        0 => RecoveryPolicy::Auto,
        1 => RecoveryPolicy::Lean,
        2 => RecoveryPolicy::Fast,
        _ => return -1,
    };
    let bandwidth_share = match share {
        0 => BandwidthShare::Full,
        1 => BandwidthShare::Fair,
        _ => return -1,
    };
    if !(576..=IO_LEN).contains(&(max_packet_size as usize)) {
        return -1;
    }
    let public: [u8; PUBLIC_KEY_LEN] = io()[..PUBLIC_KEY_LEN].try_into().expect("32 bytes");
    let config = Config { max_packet_size: max_packet_size as usize, bandwidth_share, ..Config::for_policy(recovery_policy) };
    let state = State { endpoint: Endpoint::new(random_id), crypto: HostCrypto { public }, config };
    STATE.set(Some(state));
    0
}

/// 接受别人发起的连接。io：`[前言][回复里附带的数据]`。每个握手请求都会问宿主的 `admit`。
#[unsafe(no_mangle)]
pub extern "C" fn listen(prologue_len: u32, payload_len: u32) -> i32 {
    let io = io();
    let (prologue_len, payload_len) = (prologue_len as usize, payload_len as usize);
    let Some(payload) = io.get(prologue_len..prologue_len + payload_len) else { return -1 };
    let (prologue, payload) = (io[..prologue_len].to_vec(), payload.to_vec());
    with(-1, |state| {
        let crypto = state.crypto.clone();
        state.endpoint.listen(&prologue, state.config.clone(), &payload, move || crypto.clone(), |incoming: &Incoming<HostCrypto>, from| {
            let mut encoded = [0; ADDR_LEN];
            encode_addr(from, &mut encoded);
            let payload = incoming.payload();
            // SAFETY: 宿主只读这些字节，回答期间不调回这个实例。
            unsafe { host::admit(incoming.remote_static().as_ptr(), payload.as_ptr(), payload.len(), encoded.as_ptr()) != 0 }
        });
        0
    })
}

/// 发起连接。io：`[对端长期公钥 32][前言][附带数据]`，addr：对端地址。返回连接号，失败返回 0。
#[unsafe(no_mangle)]
pub extern "C" fn connect(now: f64, prologue_len: u32, payload_len: u32) -> u32 {
    let io = io();
    let start = PUBLIC_KEY_LEN + prologue_len as usize;
    let Some(payload) = io.get(start..start + payload_len as usize) else { return 0 };
    let Some(peer) = decode_addr(addr()) else { return 0 };
    let remote: [u8; PUBLIC_KEY_LEN] = io[..PUBLIC_KEY_LEN].try_into().expect("32 bytes");
    let prologue = &io[PUBLIC_KEY_LEN..start];
    with(0, |state| {
        let crypto = state.crypto.clone();
        state.endpoint.connect(micros(now), crypto, state.config.clone(), prologue, &remote, payload, peer).unwrap_or(0)
    })
}

/// 收到一个数据报。io：数据报，addr：来源。
#[unsafe(no_mangle)]
pub extern "C" fn datagram(now: f64, len: u32) {
    let Some(packet) = io().get(..len as usize) else { return };
    let Some(from) = decode_addr(addr()) else { return };
    with((), |state| state.endpoint.on_datagram(micros(now), from, packet));
}

/// 取下一个要发的数据报：写进 io，目的地址写进 addr，返回长度。没有要发的返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn transmit(now: f64) -> i32 {
    let io = io();
    with(-1, |state| {
        let limit = state.config.max_packet_size;
        match state.endpoint.poll_transmit(micros(now), &mut io[..limit]) {
            Some((size, to)) => {
                encode_addr(to, addr());
                size as i32
            }
            None => -1,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tick(now: f64) {
    with((), |state| state.endpoint.tick(micros(now)));
}

/// 下一次要调 [`tick`] 的时间；没有计时器时返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn next_wake() -> f64 {
    with(-1.0, |state| state.endpoint.next_wake().map_or(-1.0, |at| at as f64))
}

/// 新接受的连接号，没有返回 0。
#[unsafe(no_mangle)]
pub extern "C" fn accept() -> u32 {
    with(0, |state| state.endpoint.accept().unwrap_or(0))
}

/// 关掉一条连接。连接不存在返回 0。已建立的连接会先排好告诉对端的关闭包，之后照常用 `transmit` 取出发掉。
#[unsafe(no_mangle)]
pub extern "C" fn close(id: u32) -> i32 {
    with(0, |state| state.endpoint.close(id).is_some() as i32)
}

/// 主动验证连接 `id` 到 addr 里那个地址的路径（打洞、退回中继），见 `Endpoint::probe`。开始了新一轮验证时返回 1。
#[unsafe(no_mangle)]
pub extern "C" fn probe(id: u32, now: f64) -> i32 {
    let Some(address) = decode_addr(addr()) else { return 0 };
    with(0, |state| state.endpoint.probe(micros(now), id, address) as i32)
}

/// 这一端换了网络，见 `Endpoint::on_local_address_change`。
#[unsafe(no_mangle)]
pub extern "C" fn local_address_change(now: f64) {
    with((), |state| state.endpoint.on_local_address_change(micros(now)));
}

/// 连接状态：0 不存在；否则 1 加上“已建立”2、“已放弃”4、“还有数据没被对端确认”8、“对端发来了关闭包”16。
#[unsafe(no_mangle)]
pub extern "C" fn conn_state(id: u32) -> i32 {
    with(0, |state| match state.endpoint.connection(id) {
        Some(connection) => {
            1 | (connection.is_established() as i32) << 1
                | (connection.is_dead() as i32) << 2
                | (connection.connection().has_unacked_data() as i32) << 3
                | (connection.closed_by_peer() as i32) << 4
        }
        None => 0,
    })
}

/// 对端长期公钥写进 io，返回 32；连接不存在返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_remote_static(id: u32) -> i32 {
    let io = io();
    with(-1, |state| match state.endpoint.connection(id) {
        Some(connection) => {
            io[..PUBLIC_KEY_LEN].copy_from_slice(connection.remote_static());
            PUBLIC_KEY_LEN as i32
        }
        None => -1,
    })
}

/// 对端握手时附带的数据写进 io，返回长度；还没有返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_remote_payload(id: u32) -> i32 {
    let io = io();
    with(-1, |state| match state.endpoint.connection(id).and_then(|connection| connection.remote_payload()) {
        Some(payload) => {
            io[..payload.len()].copy_from_slice(payload);
            payload.len() as i32
        }
        None => -1,
    })
}

/// 数据现在发往的地址写进 addr，返回 1；不知道返回 0。
#[unsafe(no_mangle)]
pub extern "C" fn conn_peer(id: u32) -> i32 {
    with(0, |state| match state.endpoint.peer_addr(id) {
        Some(address) => {
            encode_addr(address, addr());
            1
        }
        None => 0,
    })
}

/// 开一条发往对端的流。`priority`：0 交互、1 普通、2 后台。返回流号，失败返回 0（0 是默认流，不会是新开的流）。
#[unsafe(no_mangle)]
pub extern "C" fn conn_open_stream(id: u32, priority: u32) -> u32 {
    let priority = match priority {
        0 => Priority::Interactive,
        1 => Priority::Normal,
        2 => Priority::Background,
        _ => return 0,
    };
    with(0, |state| state.endpoint.connection_mut(id).and_then(|connection| connection.open_stream(priority)).unwrap_or(0))
}

/// 写入一条流。io：数据。返回接受的字节数，缓冲满时小于 `len`；连接不存在返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_send(id: u32, now: f64, stream: u32, len: u32) -> i32 {
    let Some(data) = io().get(..len as usize) else { return -1 };
    with(-1, |state| match state.endpoint.connection_mut(id) {
        Some(connection) => connection.send_stream(micros(now), stream, data) as i32,
        None => -1,
    })
}

/// 这条流不再写了，见 `SecureConnection::finish_stream`。成功返回 1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_finish(id: u32, stream: u32) -> i32 {
    with(0, |state| state.endpoint.connection_mut(id).is_some_and(|connection| connection.finish_stream(stream)) as i32)
}

/// 按序读出一条流已到达的数据，写进 io，返回长度；连接不存在返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_recv(id: u32, now: f64, stream: u32) -> i32 {
    let io = io();
    with(-1, |state| match state.endpoint.connection_mut(id) {
        Some(connection) => connection.recv_stream(micros(now), stream, io) as i32,
        None => -1,
    })
}

/// 取下一个流事件：对端开了流 `s` 返回 `s`，对端写完了返回 `s + 2^32`，没有返回 -1。
#[unsafe(no_mangle)]
pub extern "C" fn conn_poll_event(id: u32) -> f64 {
    with(-1.0, |state| match state.endpoint.connection_mut(id).and_then(|connection| connection.poll_event()) {
        Some(StreamEvent::Opened(stream)) => stream as f64,
        Some(StreamEvent::Finished(stream)) => stream as f64 + 4_294_967_296.0,
        None => -1.0,
    })
}

/// 连接的计数按下面的顺序写成 `f64` 数组放进 io，返回个数；连接不存在返回 -1。
/// 往返（微秒）、最小往返、带宽估计（字节/秒）、发出包数、收到包数、线上发出字节、线上收到字节、重传分片、
/// 握手往返（微秒）、认证失败丢掉的包、重放丢掉的包、开始验证新路径的次数、换过去的次数、
/// 这一端主动验证路径的次数、其中数据路径断了退回备用路径的次数、验证通过但留作备用的次数、收到 cookie 的次数。
/// 之后追加：换连接号次数、缺备用号次数、作废本地号数、交号／确认包数、交号快照重发次数。
#[unsafe(no_mangle)]
pub extern "C" fn conn_stats(id: u32) -> i32 {
    let io = io();
    with(-1, |state| {
        let Some(connection) = state.endpoint.connection(id) else { return -1 };
        let stats = connection.stats();
        let security = connection.security_stats();
        let values = [
            stats.srtt_us,
            stats.min_rtt_us,
            stats.bandwidth,
            stats.packets_sent,
            stats.packets_received,
            stats.wire_bytes_sent,
            stats.wire_bytes_received,
            stats.retransmitted_segments,
            security.handshake_rtt_us,
            security.unauthenticated_packets,
            security.replayed_packets,
            security.path_challenges,
            security.migrations,
            security.path_probes,
            security.fallback_probes,
            security.alternates_kept,
            security.cookies_received,
            security.connection_id_rotations,
            security.connection_id_exhaustions,
            security.connection_ids_retired,
            security.connection_id_packets,
            security.connection_id_retransmissions,
        ];
        write_f64s(io, &values)
    })
}

/// 端点的计数按 `EndpointStats` 的字段顺序写成 `f64` 数组放进 io，返回个数。
#[unsafe(no_mangle)]
pub extern "C" fn stats() -> i32 {
    let io = io();
    with(-1, |state| {
        let stats = state.endpoint.stats();
        let values = [
            stats.datagrams_received,
            stats.bytes_received,
            stats.datagrams_sent,
            stats.bytes_sent,
            stats.unknown_destination,
            stats.rejected_initiations,
            stats.bad_mac1,
            stats.cookie_replies,
            stats.throttled_initiations,
        ];
        write_f64s(io, &values)
    })
}

fn write_f64s(io: &mut [u8], values: &[u64]) -> i32 {
    for (slot, value) in io.chunks_exact_mut(8).zip(values) {
        slot.copy_from_slice(&(*value as f64).to_le_bytes());
    }
    values.len() as i32
}
