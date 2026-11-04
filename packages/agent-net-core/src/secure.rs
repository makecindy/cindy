//! 加密连接：Noise IK 握手，之后每个包都做认证加密，并拒绝重放。
//!
//! 线上格式：
//!
//! - 握手请求：`[0x81][发起方一次性公钥 32][加密的发起方长期公钥 48][加密的附带数据]`
//! - 握手回复：`[0x82][响应方一次性公钥 32][加密的附带数据]`
//! - 数据包：`[包头 3][加密的帧][认证标签 16]`。包头不加密但参与认证，nonce 是完整包号。
//!
//! 数据包的首字节高 3 位是 `101`，握手是 `100`，不会混淆。
//!
//! 附带数据加密前是 `[长度 2][数据][填充]`。请求填满到 `max_packet_size`，回复填到和请求一样长。
//! 握手因此顺便确认了这条路径两个方向都能过满长度的包。
//!
//! **不放大流量。** 请求可能是录下来重放的，来源地址也可能是伪造的。响应方在收到发起方第一个
//! 有效数据包之前，只发和请求一样长的回复，而且只在每次收到请求时发一次，不发任何数据。
//! 发起方收到回复后马上发一个探测包，让响应方尽快确认。
//!
//! **定期换密钥。** 包号每过 2^20 个，两个方向各自按 Noise 的 `Rekey` 推导新密钥，旧密钥随即丢弃。
//! 这样同一个密钥加密的包数远低于 AES-GCM 的安全上限，用过的密钥也不会一直留在内存里。
//! 换密钥只看包号，线上不需要任何额外字段，两端也不需要协调。

use alloc::vec;
use alloc::vec::Vec;

use crate::connection::{Config, Connection, PacketError, Stats};
use crate::crypto::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};
use crate::noise::{FIRST_MESSAGE_FIXED_LEN, Handshake, HandshakeError, SECOND_MESSAGE_FIXED_LEN, TransportKeys};
use crate::stream::{Priority, StreamEvent};
use crate::wire;

const INITIATION: u8 = 0x81;
const RESPONSE: u8 = 0x82;
const LENGTH_PREFIX: usize = 2;
const INITIATION_OVERHEAD: usize = 1 + FIRST_MESSAGE_FIXED_LEN + LENGTH_PREFIX;
const RESPONSE_OVERHEAD: usize = 1 + SECOND_MESSAGE_FIXED_LEN + LENGTH_PREFIX;
/// 防重放窗口，单位是包号。比这更旧的包直接丢弃，可靠层会重传里面的数据。
/// 1 Gbit/s 下这是约 45 毫秒的乱序，比判丢需要的乱序容忍大得多。
const REPLAY_WINDOW: u64 = 4096;
const REPLAY_WORDS: usize = (REPLAY_WINDOW / 64) as usize;
/// 每过这么多个包号换一次密钥，即 2^20 个包，满长度约 1.4 GB。
/// QUIC 给 AES-GCM 定的上限是每个密钥 2^23 个包，见 RFC 9001 §6.6。
pub(crate) const REKEY_SHIFT: u32 = 20;
/// 认证失败的包超过这个数就放弃连接。QUIC 给 ChaCha20-Poly1305 定的完整性上限是 2^36，AES-GCM 更高。
const MAX_FORGERIES: u64 = 1 << 36;
/// Noise `Rekey` 用的 nonce，包号永远到不了。
const REKEY_NONCE: u64 = u64::MAX;

/// 这是不是一个握手请求。调用方据此把陌生来源的包交给 [`Incoming::read`]。
pub fn is_initiation(packet: &[u8]) -> bool {
    packet.first() == Some(&INITIATION)
}

/// 握手附带数据的上限：请求和回复都要放进一个包。`max_packet_size` 太小放不下握手时是 0。
pub fn max_handshake_payload(config: &Config) -> usize {
    config.max_packet_size.saturating_sub(INITIATION_OVERHEAD)
}

fn padded(payload: &[u8], total: usize) -> Vec<u8> {
    let mut plain = Vec::with_capacity(total);
    plain.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    plain.extend_from_slice(payload);
    plain.resize(total, 0);
    plain
}

fn unpadded(plain: &[u8]) -> Option<&[u8]> {
    let length = u16::from_be_bytes([*plain.first()?, *plain.get(1)?]) as usize;
    plain.get(LENGTH_PREFIX..LENGTH_PREFIX + length)
}

fn packet_error(error: HandshakeError) -> PacketError {
    match error {
        HandshakeError::Malformed | HandshakeError::PayloadTooLarge => PacketError::Malformed,
        HandshakeError::Decrypt | HandshakeError::InvalidKey => PacketError::Unauthenticated,
    }
}

fn ephemeral_of(initiation: &[u8]) -> Option<&[u8]> {
    initiation.get(1..1 + PUBLIC_KEY_LEN)
}

/// Noise 的 `Rekey`：用当前密钥加密 32 个零字节，取密文当新密钥。
fn rekey<C: Crypto>(crypto: &C, key: &C::Key) -> C::Key {
    let mut bytes = [0; HASH_LEN];
    let _ = crypto.seal(key, REKEY_NONCE, &[], &mut bytes);
    let next = crypto.key(&bytes);
    bytes = [0; HASH_LEN];
    core::hint::black_box(&mut bytes);
    next
}

fn epoch_of(number: u64) -> u64 {
    number >> REKEY_SHIFT
}

struct SendKey<C: Crypto> {
    epoch: u64,
    key: C::Key,
}

impl<C: Crypto> SendKey<C> {
    fn for_packet(&mut self, crypto: &C, number: u64) -> &C::Key {
        while self.epoch < epoch_of(number) {
            self.key = rekey(crypto, &self.key);
            self.epoch += 1;
        }
        &self.key
    }
}

/// 接收方向的密钥：当前的、上一个（换密钥前后乱序到达的包），以及推导好但还没用上的下一个。
struct RecvKeys<C: Crypto> {
    epoch: u64,
    current: C::Key,
    previous: Option<C::Key>,
    next: Option<C::Key>,
}

/// 用哪个接收密钥解这个包。
#[derive(Clone, Copy)]
enum RecvSlot {
    Previous,
    Current,
    Next,
}

impl<C: Crypto> RecvKeys<C> {
    fn slot(&mut self, crypto: &C, number: u64) -> Option<RecvSlot> {
        let epoch = epoch_of(number);
        if epoch == self.epoch {
            Some(RecvSlot::Current)
        } else if epoch + 1 == self.epoch && self.previous.is_some() {
            Some(RecvSlot::Previous)
        } else if epoch == self.epoch + 1 {
            if self.next.is_none() {
                self.next = Some(rekey(crypto, &self.current));
            }
            Some(RecvSlot::Next)
        } else {
            None
        }
    }

    fn key(&self, slot: RecvSlot) -> &C::Key {
        match slot {
            RecvSlot::Previous => self.previous.as_ref().unwrap_or(&self.current),
            RecvSlot::Current => &self.current,
            RecvSlot::Next => self.next.as_ref().unwrap_or(&self.current),
        }
    }

    /// 新密钥解开了一个包，对端已经换过去了。再往前的密钥不会再用到，丢掉。
    fn advance(&mut self) {
        if let Some(next) = self.next.take() {
            self.previous = Some(core::mem::replace(&mut self.current, next));
            self.epoch += 1;
        }
    }
}

/// 收到过的包号。只在认证通过后记录，所以伪造的包推不动窗口。
struct ReplayWindow {
    largest: Option<u64>,
    seen: [u64; REPLAY_WORDS],
}

impl ReplayWindow {
    fn new() -> Self {
        Self { largest: None, seen: [0; REPLAY_WORDS] }
    }

    fn expected(&self, initial: u64) -> u64 {
        self.largest.map_or(initial, |largest| largest + 1)
    }

    fn slot(number: u64) -> (usize, u64) {
        let index = number % REPLAY_WINDOW;
        ((index / 64) as usize, 1 << (index % 64))
    }

    fn is_fresh(&self, number: u64) -> bool {
        match self.largest {
            None => true,
            Some(largest) if number > largest => true,
            Some(largest) if largest - number >= REPLAY_WINDOW => false,
            Some(_) => {
                let (word, bit) = Self::slot(number);
                self.seen[word] & bit == 0
            }
        }
    }

    fn mark(&mut self, number: u64) {
        if let Some(largest) = self.largest.filter(|&largest| number > largest) {
            // 窗口前移，让出来的位置清空。
            if number - largest >= REPLAY_WINDOW {
                self.seen = [0; REPLAY_WORDS];
            } else {
                for cleared in largest + 1..number {
                    let (word, bit) = Self::slot(cleared);
                    self.seen[word] &= !bit;
                }
            }
        }
        if self.largest.is_none_or(|largest| number > largest) {
            self.largest = Some(number);
        }
        let (word, bit) = Self::slot(number);
        self.seen[word] |= bit;
    }
}

/// 加密层的计数。
#[derive(Clone, Copy, Debug, Default)]
pub struct SecurityStats {
    pub handshake_packets_sent: u64,
    /// 发起方重发请求的次数。
    pub handshake_retransmissions: u64,
    /// 认证失败被丢弃的包：被篡改、不属于这条连接，或者在密钥协商好之前到达。
    pub unauthenticated_packets: u64,
    /// 重复或过旧被丢弃的包，包括重复的握手消息。
    pub replayed_packets: u64,
    /// 发起方从第一次发出请求到收到回复的时间。请求重发过时为 0，因为分不清回复对应哪一次。
    pub handshake_rtt_us: u64,
    /// 两端同时发起时，这一端改当响应方的次数。
    pub role_switches: u64,
    /// 已经换过几次密钥，两个方向合计。
    pub rekeys: u64,
}

/// 收到的握手请求，还没有回复。调用方检查对方身份和附带数据后决定是否接受。
pub struct Incoming<C: Crypto> {
    handshake: Handshake<C>,
    payload: Vec<u8>,
    initiation: Vec<u8>,
}

impl<C: Crypto> Incoming<C> {
    /// 解开握手请求，需要做两次 DH。`prologue` 必须和发起方的一致。
    ///
    /// 请求可能是录下来重放的，所以这里只证明对方曾经持有那个长期私钥，不证明对方此刻在线。
    /// 需要拒绝重放的请求时，发起方可以在附带数据里放时间戳，由调用方检查。
    /// 对方的第一个数据包到达后，[`SecureConnection::is_established`] 才变成 `true`。
    pub fn read(crypto: &C, prologue: &[u8], packet: &[u8]) -> Result<Self, PacketError> {
        if !is_initiation(packet) {
            return Err(PacketError::Malformed);
        }
        let mut handshake = Handshake::responder(crypto, prologue);
        let mut plain = Vec::new();
        handshake.read_first(crypto, &packet[1..], &mut plain).map_err(packet_error)?;
        let payload = unpadded(&plain).ok_or(PacketError::Malformed)?.to_vec();
        Ok(Self { handshake, payload, initiation: packet.to_vec() })
    }

    /// 发起方的长期公钥。
    pub fn remote_static(&self) -> &[u8; PUBLIC_KEY_LEN] {
        self.handshake.remote_static()
    }

    /// 发起方附带的数据。只受响应方长期密钥保护，不具备前向保密，也可能是重放的。
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    /// 接受这个请求：生成回复，返回连接。之后照常调用 `poll_transmit` 把回复发出去。
    /// 写入的数据要等发起方确认在线后才发，见模块说明。
    pub fn accept(self, crypto: C, config: Config, payload: &[u8], now_us: u64) -> Result<SecureConnection<C>, HandshakeError> {
        let local_static = crypto.static_public();
        let known_ephemeral = ephemeral_of(&self.initiation).and_then(|bytes| bytes.try_into().ok());
        let (phase, accepted) = respond(&crypto, &config, self, payload, now_us)?;
        let connection = Connection::with_overhead(config.clone(), now_us, TAG_LEN);
        let scratch = vec![0; config.max_packet_size];
        Ok(SecureConnection {
            crypto,
            config,
            connection,
            phase,
            replay: ReplayWindow::new(),
            scratch,
            local_static,
            remote_static: accepted.remote_static,
            remote_payload: Some(accepted.remote_payload),
            handshake_hash: Some(accepted.handshake_hash),
            known_ephemeral,
            dead: false,
            stats: SecurityStats::default(),
        })
    }
}

struct Accepted {
    remote_static: [u8; PUBLIC_KEY_LEN],
    remote_payload: Vec<u8>,
    handshake_hash: [u8; HASH_LEN],
}

/// 写回复并导出密钥。回复和请求一样长，不会更大。
fn respond<C: Crypto>(crypto: &C, config: &Config, incoming: Incoming<C>, payload: &[u8], now_us: u64) -> Result<(Phase<C>, Accepted), HandshakeError> {
    let Incoming { mut handshake, payload: remote_payload, initiation } = incoming;
    let total = config.max_packet_size.min(initiation.len());
    if total < RESPONSE_OVERHEAD || payload.len() > total - RESPONSE_OVERHEAD {
        return Err(HandshakeError::PayloadTooLarge);
    }
    let mut message = vec![RESPONSE];
    handshake.write_second(crypto, &padded(payload, total - 1 - SECOND_MESSAGE_FIXED_LEN), &mut message)?;
    let remote_static = *handshake.remote_static();
    let keys = handshake.finish(crypto).ok_or(HandshakeError::Malformed)?;
    let handshake_hash = keys.handshake_hash;
    let phase = Phase::Established {
        keys: Keys::new(keys, config),
        confirmed: false,
        established_at: now_us,
        response: Some(Response { message, initiation, due: true }),
    };
    Ok((phase, Accepted { remote_static, remote_payload, handshake_hash }))
}

struct Keys<C: Crypto> {
    send: SendKey<C>,
    recv: RecvKeys<C>,
}

impl<C: Crypto> Keys<C> {
    /// 两端的包号从同一个 `initial_packet_number` 开始，握手导出的是那一段的密钥。
    fn new(keys: TransportKeys<C>, config: &Config) -> Self {
        let epoch = epoch_of(config.initial_packet_number);
        Self {
            send: SendKey { epoch, key: keys.send },
            recv: RecvKeys { epoch, current: keys.recv, previous: None, next: None },
        }
    }
}

struct Initiation<C: Crypto> {
    /// 收到回复后取走。
    handshake: Option<Handshake<C>>,
    message: Vec<u8>,
    prologue: Vec<u8>,
    payload: Vec<u8>,
    started_at: u64,
    first_sent_at: Option<u64>,
    next_send_at: u64,
    interval_us: u64,
}

struct Response {
    message: Vec<u8>,
    /// 回复所对应的那个请求。同样的请求再来，说明回复丢了，重发一次。
    initiation: Vec<u8>,
    due: bool,
}

enum Phase<C: Crypto> {
    Initiating(alloc::boxed::Box<Initiation<C>>),
    Established {
        keys: Keys<C>,
        /// 响应方收到发起方第一个有效数据包之前是 `false`：那之前请求可能是重放的，对方可能根本不在。
        confirmed: bool,
        established_at: u64,
        /// 响应方确认之前保留回复，请求重发时再发一次。
        response: Option<Response>,
    },
}

/// 加密的连接。用法和 [`Connection`] 相同，只是多了握手：
///
/// ```ignore
/// // 发起方：事先知道对方的长期公钥。
/// let mut connection = SecureConnection::connect(crypto, config, b"my-app/1", &peer_public, &[], now_us)?;
/// // 响应方：陌生来源发来的握手请求。
/// let incoming = Incoming::read(&crypto, b"my-app/1", packet)?;
/// // 检查 incoming.remote_static() 和 incoming.payload() 之后：
/// let mut connection = incoming.accept(crypto, config, &[], now_us)?;
/// ```
///
/// 之后照常 `send`、`on_packet`、`tick`、`poll_transmit`、`recv`。握手完成前写入的数据先缓存，完成后才发。
/// `max_packet_size` 仍是整个 UDP 载荷的上限，加密的 16 字节标签算在里面，握手要求它至少 99 字节。
/// 两端的 `initial_packet_number` 必须相同，和 [`Connection`] 一样。
pub struct SecureConnection<C: Crypto> {
    crypto: C,
    config: Config,
    connection: Connection,
    phase: Phase<C>,
    replay: ReplayWindow,
    scratch: Vec<u8>,
    local_static: [u8; PUBLIC_KEY_LEN],
    remote_static: [u8; PUBLIC_KEY_LEN],
    remote_payload: Option<Vec<u8>>,
    handshake_hash: Option<[u8; HASH_LEN]>,
    /// 已经处理过的那个请求的一次性公钥：响应方是接受的那个，发起方是同时发起时忽略的那个。
    /// 同样的请求再来，是网络重复或重放，不是新连接。
    known_ephemeral: Option<[u8; PUBLIC_KEY_LEN]>,
    /// 握手失败、超时，或者认证失败的包太多。
    dead: bool,
    stats: SecurityStats,
}

impl<C: Crypto> SecureConnection<C> {
    /// 向长期公钥为 `remote_static` 的对端发起连接。`prologue` 两端必须完全一致，
    /// 可以放协议名和版本，让不同用途的连接互不相通。`payload` 随请求加密发送，见 [`Incoming::payload`] 的限制。
    pub fn connect(
        crypto: C,
        config: Config,
        prologue: &[u8],
        remote_static: &[u8; PUBLIC_KEY_LEN],
        payload: &[u8],
        now_us: u64,
    ) -> Result<Self, HandshakeError> {
        if config.max_packet_size < INITIATION_OVERHEAD || payload.len() > max_handshake_payload(&config) {
            return Err(HandshakeError::PayloadTooLarge);
        }
        let mut handshake = Handshake::initiator(&crypto, prologue, remote_static);
        let mut message = vec![INITIATION];
        handshake.write_first(&crypto, &padded(payload, config.max_packet_size - 1 - FIRST_MESSAGE_FIXED_LEN), &mut message)?;
        let local_static = crypto.static_public();
        let connection = Connection::with_overhead(config.clone(), now_us, TAG_LEN);
        let scratch = vec![0; config.max_packet_size];
        let interval_us = config.initial_rto_us;
        Ok(Self {
            crypto,
            config,
            connection,
            phase: Phase::Initiating(alloc::boxed::Box::new(Initiation {
                handshake: Some(handshake),
                message,
                prologue: prologue.to_vec(),
                payload: payload.to_vec(),
                started_at: now_us,
                first_sent_at: None,
                next_send_at: now_us,
                interval_us,
            })),
            replay: ReplayWindow::new(),
            scratch,
            local_static,
            remote_static: *remote_static,
            remote_payload: None,
            handshake_hash: None,
            known_ephemeral: None,
            dead: false,
            stats: SecurityStats::default(),
        })
    }

    /// 双方都已证明身份、密钥已确认。发起方收到回复后、响应方收到对方第一个数据包后成立。
    pub fn is_established(&self) -> bool {
        !self.is_dead() && matches!(self.phase, Phase::Established { confirmed: true, .. })
    }

    pub fn remote_static(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.remote_static
    }

    /// 对端握手时附带的数据。发起方收到回复以后才有。
    pub fn remote_payload(&self) -> Option<&[u8]> {
        self.remote_payload.as_deref()
    }

    /// 握手哈希，两端相同。上层可以对它签名，把别的身份凭证绑定到这次连接。
    pub fn handshake_hash(&self) -> Option<&[u8; HASH_LEN]> {
        self.handshake_hash.as_ref()
    }

    pub fn security_stats(&self) -> SecurityStats {
        self.stats
    }

    /// 内部的可靠连接，只读：缓冲量、内部账目检查等。
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// 可靠层的统计。流量计数含加密标签，不含握手包，握手见 [`SecurityStats`]。
    pub fn stats(&self) -> Stats {
        self.connection.stats()
    }

    pub fn is_dead(&self) -> bool {
        self.dead || self.connection.is_dead()
    }

    pub fn send(&mut self, now_us: u64, data: &[u8]) -> usize {
        self.connection.send(now_us, data)
    }

    pub fn open_stream(&mut self, priority: Priority) -> Option<u32> {
        self.connection.open_stream(priority)
    }

    pub fn set_priority(&mut self, stream: u32, priority: Priority) -> bool {
        self.connection.set_priority(stream, priority)
    }

    pub fn send_stream(&mut self, now_us: u64, stream: u32, data: &[u8]) -> usize {
        self.connection.send_stream(now_us, stream, data)
    }

    pub fn finish_stream(&mut self, stream: u32) -> bool {
        self.connection.finish_stream(stream)
    }

    pub fn poll_event(&mut self) -> Option<StreamEvent> {
        self.connection.poll_event()
    }

    pub fn recv(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        self.connection.recv(now_us, out)
    }

    pub fn recv_stream(&mut self, now_us: u64, stream: u32, out: &mut [u8]) -> usize {
        self.connection.recv_stream(now_us, stream, out)
    }

    /// 处理一个收到的包。错误只表示这个包被丢弃，不影响连接；`Handshake` 表示对端发来了新的握手请求，
    /// 交给 [`Incoming::read`]，新连接确认之前不要关掉这一条。
    ///
    /// 两端同时向对方发起时，长期公钥较大的一方继续当发起方并忽略对方的请求（返回 `Ok`），
    /// 另一方自动改当响应方，已写入的数据不受影响。
    pub fn on_packet(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        if self.is_dead() {
            return Err(PacketError::Dead);
        }
        let result = match packet.first() {
            Some(&INITIATION) => self.on_initiation(now_us, packet),
            Some(&RESPONSE) => self.on_response(now_us, packet),
            _ => self.on_transport(now_us, packet),
        };
        match result {
            Err(PacketError::Unauthenticated) => self.stats.unauthenticated_packets += 1,
            Err(PacketError::Replayed) => self.stats.replayed_packets += 1,
            _ => {}
        }
        result
    }

    fn on_transport(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        let Phase::Established { keys, confirmed, response, .. } = &mut self.phase else {
            return Err(PacketError::Unauthenticated);
        };
        if packet.len() < wire::PACKET_HEADER_LEN + 1 + TAG_LEN || packet.len() > self.config.max_packet_size {
            return Err(PacketError::Malformed);
        }
        let (truncated, _) = wire::parse_header(packet).ok_or(PacketError::Malformed)?;
        let number = wire::expand(truncated, self.replay.expected(self.config.initial_packet_number), wire::PACKET_NUMBER_BITS);
        if !self.replay.is_fresh(number) {
            return Err(PacketError::Replayed);
        }
        let Some(slot) = keys.recv.slot(&self.crypto, number) else {
            return Err(Self::forgery(&mut self.dead, &self.stats));
        };
        let body_end = packet.len() - TAG_LEN;
        let tag: [u8; TAG_LEN] = packet[body_end..].try_into().map_err(|_| PacketError::Malformed)?;
        let plain = &mut self.scratch[..body_end];
        plain.copy_from_slice(&packet[..body_end]);
        let (header, body) = plain.split_at_mut(wire::PACKET_HEADER_LEN);
        if !self.crypto.open(keys.recv.key(slot), number, header, body, &tag) {
            return Err(Self::forgery(&mut self.dead, &self.stats));
        }
        if matches!(slot, RecvSlot::Next) {
            keys.recv.advance();
            self.stats.rekeys += 1;
        }
        self.replay.mark(number);
        if !*confirmed {
            *confirmed = true;
            *response = None;
        }
        self.connection.on_packet_numbered(now_us, Some(number), &self.scratch[..body_end])
    }

    /// 认证失败太多次时放弃连接，计数本身由 `on_packet` 加。
    fn forgery(dead: &mut bool, stats: &SecurityStats) -> PacketError {
        if stats.unauthenticated_packets + 1 >= MAX_FORGERIES {
            *dead = true;
        }
        PacketError::Unauthenticated
    }

    fn on_initiation(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        if let Phase::Established { response: Some(response), .. } = &mut self.phase
            && response.initiation == packet
        {
            response.due = true;
            return Ok(());
        }
        if self.known_ephemeral.is_some_and(|known| ephemeral_of(packet) == Some(&known[..])) {
            return Err(PacketError::Replayed);
        }
        let Phase::Initiating(initiation) = &self.phase else {
            return Err(PacketError::Handshake);
        };
        let incoming = Incoming::read(&self.crypto, &initiation.prologue, packet)?;
        if incoming.remote_static() != &self.remote_static {
            return Err(PacketError::Handshake);
        }
        let ephemeral = ephemeral_of(packet).and_then(|bytes| bytes.try_into().ok());
        if self.local_static > self.remote_static {
            // 同时发起，这一端继续当发起方，对方会改当响应方。
            self.known_ephemeral = ephemeral;
            return Ok(());
        }
        let payload = initiation.payload.clone();
        let (phase, accepted) = respond(&self.crypto, &self.config, incoming, &payload, now_us).map_err(packet_error)?;
        self.phase = phase;
        self.known_ephemeral = ephemeral;
        self.remote_payload = Some(accepted.remote_payload);
        self.handshake_hash = Some(accepted.handshake_hash);
        self.connection.reset_clock(now_us);
        self.stats.role_switches += 1;
        Ok(())
    }

    fn on_response(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        let Phase::Initiating(initiation) = &mut self.phase else {
            return Err(PacketError::Replayed);
        };
        let handshake = initiation.handshake.as_mut().ok_or(PacketError::Malformed)?;
        let mut plain = Vec::new();
        handshake.read_second(&self.crypto, &packet[1..], &mut plain).map_err(packet_error)?;
        // 回复已通过认证，格式还不对说明对端的实现不兼容，这次握手无法继续。
        let Some(remote_payload) = unpadded(&plain).map(<[u8]>::to_vec) else {
            self.dead = true;
            return Err(PacketError::Malformed);
        };
        if self.stats.handshake_retransmissions == 0 {
            self.stats.handshake_rtt_us = initiation.first_sent_at.map_or(0, |sent| now_us.saturating_sub(sent));
        }
        let keys = initiation.handshake.take().and_then(|handshake| handshake.finish(&self.crypto)).ok_or(PacketError::Malformed)?;
        self.handshake_hash = Some(keys.handshake_hash);
        self.remote_payload = Some(remote_payload);
        self.phase = Phase::Established { keys: Keys::new(keys, &self.config), confirmed: true, established_at: now_us, response: None };
        self.connection.reset_clock(now_us);
        // 响应方要见到这一端的数据包才确认，没有数据要发时也要让它尽快确认。
        self.connection.ping();
        Ok(())
    }

    /// 取下一个要发的包。`out` 至少要有 `max_packet_size` 字节。
    pub fn poll_transmit(&mut self, now_us: u64, out: &mut [u8]) -> Option<usize> {
        if self.is_dead() {
            return None;
        }
        match &mut self.phase {
            Phase::Initiating(initiation) => {
                if initiation.next_send_at > now_us {
                    return None;
                }
                if initiation.first_sent_at.is_some() {
                    self.stats.handshake_retransmissions += 1;
                } else {
                    initiation.first_sent_at = Some(now_us);
                }
                initiation.next_send_at = now_us + initiation.interval_us;
                initiation.interval_us = (initiation.interval_us * 2).min(self.config.max_rto_us);
                let size = initiation.message.len();
                out[..size].copy_from_slice(&initiation.message);
                self.stats.handshake_packets_sent += 1;
                Some(size)
            }
            Phase::Established { keys, confirmed, response, .. } => {
                if let Some(response) = response.as_mut().filter(|response| response.due) {
                    response.due = false;
                    let size = response.message.len();
                    out[..size].copy_from_slice(&response.message);
                    self.stats.handshake_packets_sent += 1;
                    return Some(size);
                }
                if !*confirmed {
                    return None;
                }
                let size = self.connection.poll_transmit(now_us, out)?;
                let number = self.connection.last_packet_number();
                let before = keys.send.epoch;
                let key = keys.send.for_packet(&self.crypto, number);
                let (header, body) = out[..size].split_at_mut(wire::PACKET_HEADER_LEN);
                let tag = self.crypto.seal(key, number, header, body);
                self.stats.rekeys += keys.send.epoch - before;
                out[size..size + TAG_LEN].copy_from_slice(&tag);
                Some(size + TAG_LEN)
            }
        }
    }

    /// 处理到期的计时器。握手在 `dead_after_us` 内没有完成就放弃。
    pub fn tick(&mut self, now_us: u64) {
        if self.is_dead() {
            return;
        }
        let pending_since = match &self.phase {
            Phase::Initiating(initiation) => Some(initiation.started_at),
            Phase::Established { confirmed: false, established_at, .. } => Some(*established_at),
            Phase::Established { .. } => None,
        };
        match pending_since {
            Some(since) if now_us.saturating_sub(since) >= self.config.dead_after_us => self.dead = true,
            Some(_) => {}
            None => self.connection.tick(now_us),
        }
    }

    /// 下一次需要调用 `tick` 和 `poll_transmit` 的时间。
    pub fn next_wake(&self) -> Option<u64> {
        if self.is_dead() {
            return None;
        }
        match &self.phase {
            Phase::Initiating(initiation) => Some(initiation.next_send_at.min(initiation.started_at + self.config.dead_after_us)),
            Phase::Established { confirmed: false, established_at, response, .. } => {
                // 确认之前不发数据，可靠层的计时器都不算。
                if response.as_ref().is_some_and(|response| response.due) {
                    Some(*established_at)
                } else {
                    Some(established_at + self.config.dead_after_us)
                }
            }
            Phase::Established { established_at, .. } => {
                let inner = self.connection.next_wake();
                if self.connection.ping_pending() { Some(inner.map_or(*established_at, |at| at.min(*established_at))) } else { inner }
            }
        }
    }
}
