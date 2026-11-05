//! 加密连接：Noise IK 握手，之后每个包都做认证加密，并拒绝重放；地址变了，连接照常继续。
//!
//! 线上格式：
//!
//! - 握手请求：`[0x81][发起方一次性公钥 32][加密的发起方长期公钥 48][加密的附带数据]`
//! - 握手回复：`[0x82][发起方的连接号 4][响应方一次性公钥 32][加密的附带数据]`
//! - 数据包：`[包头 3][收包方的连接号 4][加密的帧][认证标签 16]`。包头和连接号不加密但参与认证，nonce 是完整包号。
//!
//! 数据包的首字节高 3 位是 `101`，握手是 `100`，不会混淆。
//!
//! 附带数据加密前是 `[发送方的连接号 4][长度 2][数据][填充]`。请求填满到 `max_packet_size`，回复填到和请求一样长。
//! 握手因此顺便确认了这条路径两个方向都能过满长度的包。
//!
//! **连接号。** 每一端自己选一个号（`Config::connection_id`），握手时告诉对端，之后对端发来的每个数据包都带着它。
//! 一个端口上有多条连接时，调用方用 [`destination_id`] 取出连接号找连接，不按来源地址找：NAT 换了端口、
//! 手机换了网络，地址都会变。连接号整条连接期间不变，路上的人能据此把换网前后的通信对上。
//!
//! **不放大流量。** 请求可能是录下来重放的，来源地址也可能是伪造的。响应方在收到发起方第一个
//! 有效数据包之前，只发和请求一样长的回复，而且只在每次收到请求时发一次，不发任何数据。
//! 发起方收到回复后马上发一个探测包，让响应方尽快确认。
//!
//! **换地址。** 调用方用 [`SecureConnection::on_packet_via`] 说明每个包从哪条路径来，用
//! [`SecureConnection::poll_transmit_via`] 取包和它该发往的路径。路径是调用方自己编的号，核心只比较是否相同，
//! 建连时的路径是 0。对端从别的路径发来一个通过认证、包号比之前都大的包，这一端就在那条路径上发路径验证
//! （`PATH_CHALLENGE`），对端原样回过来（`PATH_RESPONSE`）才算通过：这时数据才换过去，在途的包全部重传，
//! 往返、带宽和丢包从头量。验证期间数据照旧发往原路径，发往新路径的只有验证包，字节数不超过从那里收到的三倍，
//! 伪造来源也放大不了流量；约 3 秒没有通过就放弃，原路径的包又成了最新的也放弃。
//! 调用方看得出新地址只换了端口（IP 和数据路径相同，多半是 NAT 换了外部端口）时用
//! [`SecureConnection::on_packet_via_route`] 说明：验证照样做，通过后在途的包照样重传，但往返和带宽照旧，不从启动阶段重新冲，
//! 并马上补一个确认（验证期间的确认都发往了旧端口）。验证包也带上这个标记，被验证的一端同样不重量，验证期间收不到确认也不判超时。
//! 看不出时一律当成换了网络。
//! 录下的包重放过来会被防重放窗口挡掉。路上的人抢在原包之前送到的复制包只换来几个发往它那里的验证包，
//! 每个包都抢先复制也带不走数据；它要替两边转发才能通过验证，那就是一条普通的路径，加密照样保护内容。
//! 对端真换了地址、它的包又被抢先复制时，从新地址来的真包都成了重复包：所以最新的那个包的重复从数据路径以外来、
//! 认证又通过时，也去验证那里。这只多出几个受同样放大限制的验证包；2026-11-05 以前对端真换了网络、每个包又都被抢先复制时
//! 连接会断，QUIC 也有这个问题（RFC 9000 §9.3.3）。
//! 只含路径验证的包不触发验证，也不交给可靠层。
//!
//! 换了地址自己却不知道（NAT 换了端口，手机换了网络但系统没有通知）、又没有包要发的一端，对端的包全发到了旧地址。
//! 所以这一端没有包在途、对端又安静下来时，过一会儿发一个探测包，没有回音就每隔同样久再发，对端从新地址收到就会跟过来。对端回了以后、
//! 一直没有新数据时，每隔 `dead_after_us` 的一半（默认 15 秒）再探测一次：对端的数据可能在路上被挡掉了，
//! 这一端之后再悄悄换地址也不会失联，NAT 的映射也不会过期。知道自己换了网络时调用
//! [`SecureConnection::on_local_address_change`]，马上就发。
//!
//! **定期换密钥。** 包号每过 2^20 个，两个方向各自按 Noise 的 `Rekey` 推导新密钥，旧密钥随即丢弃。
//! 这样同一个密钥加密的包数远低于 AES-GCM 的安全上限，用过的密钥也不会一直留在内存里。
//! 换密钥只看包号，线上不需要任何额外字段，两端也不需要协调。

use alloc::boxed::Box;
use alloc::collections::VecDeque;
use alloc::vec;
use alloc::vec::Vec;

use crate::connection::{Config, Connection, PacketError, Stats};
use crate::crypto::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};
use crate::noise::{FIRST_MESSAGE_FIXED_LEN, Handshake, HandshakeError, SECOND_MESSAGE_FIXED_LEN, TransportKeys};
use crate::stream::{Priority, StreamEvent};
use crate::wire;

const INITIATION: u8 = 0x81;
const RESPONSE: u8 = 0x82;
const CONNECTION_ID_LEN: usize = 4;
const LENGTH_PREFIX: usize = 2;
/// 附带数据加密前开头的发送方连接号和长度。
const PAYLOAD_PREFIX: usize = CONNECTION_ID_LEN + LENGTH_PREFIX;
const INITIATION_OVERHEAD: usize = 1 + FIRST_MESSAGE_FIXED_LEN + PAYLOAD_PREFIX;
/// 回复开头不加密的部分：类型和发起方的连接号。
const RESPONSE_PREFIX: usize = 1 + CONNECTION_ID_LEN;
const RESPONSE_OVERHEAD: usize = RESPONSE_PREFIX + SECOND_MESSAGE_FIXED_LEN + PAYLOAD_PREFIX;
/// 数据包开头不加密、参与认证的部分：包头和收包方的连接号。
const DATA_PREFIX: usize = wire::PACKET_HEADER_LEN + CONNECTION_ID_LEN;
/// 最短的路径验证包。
const MIN_PROBE_LEN: usize = DATA_PREFIX + wire::PATH_FRAME_LEN + TAG_LEN;
/// 一轮路径验证最多发几次。第 n 次（从 0 数）之后隔 `initial_rto_us << n` 再发下一次。
const MAX_CHALLENGES: u32 = 4;
/// 一轮验证从开始到判定失败的时间是 `initial_rto_us` 的这么多倍，即四次间隔 1 + 2 + 4 + 8。
/// 默认配置下是 3 秒，比 QUIC 建议的约 2 秒宽一些，往返一秒多的卫星链路也来得及。
const VALIDATION_RTOS: u64 = 15;
/// 同时验证的新路径最多这么多条。对端真换了网络时，路上的人抢先送到的复制包也会让这一端去验证它那里的地址，
/// 只验证一条的话两边轮流把对方顶掉，真的那条永远验证不完。
const MAX_CANDIDATES: usize = 4;
/// 没验证过的路径上，发出的字节不超过收到的这么多倍。和 QUIC 一样。
const AMPLIFICATION_FACTOR: u64 = 3;
/// 最多攒这么多个还没回的路径验证，再多就丢掉最早的：对端会重发。
const MAX_PENDING_RESPONSES: usize = 4;
/// 对端忽然安静多久以后探测：至少这么久，也至少这么多个往返。之后没有回音就隔这么久再探测，不退避，
/// 默认是安静后每秒一次，到对端判死的 `dead_after_us`（默认 30 秒）为止。断网多久不知道，网络一恢复，
/// 下一次探测最多再等一个间隔；丢包三成的新网络上，探测、验证、回复丢掉一个就白试一次，试得越多越不会断。
/// 2026-11-05 以前从第二次起间隔翻倍、最多 4 倍（第 1、2、4、8、12 秒……），不知道换了网络、又只在下载的一端
/// 平均要 2.0 秒才恢复，丢包三成时 4.8 秒、约 1% 的连接会断；每秒一次是 0.8 秒和 1.9 秒、不再断开，
/// 代价是对端不回话的 30 秒里最多约 30 个小包，见 `sim/results/2026-11-05-port-change/`。
const SILENCE_PING_US: u64 = 1_000_000;
const SILENCE_PING_RTTS: u64 = 4;
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

/// 这个包是发给哪个连接号的：数据包和握手回复带着收包方的连接号，握手请求没有，交给 [`Incoming::read`]。
/// 一个端口上有多条连接时调用方据此找连接。这个号没有经过认证，找到的连接还会再认证。
pub fn destination_id(packet: &[u8]) -> Option<u32> {
    match *packet.first()? {
        INITIATION => None,
        RESPONSE => read_id(packet, 1),
        _ => wire::parse_header(packet).and_then(|_| read_id(packet, wire::PACKET_HEADER_LEN)),
    }
}

/// 握手附带数据的上限：请求和回复都要放进一个包。`max_packet_size` 太小放不下握手时是 0。
pub fn max_handshake_payload(config: &Config) -> usize {
    config.max_packet_size.saturating_sub(INITIATION_OVERHEAD)
}

fn read_id(bytes: &[u8], at: usize) -> Option<u32> {
    let id: [u8; CONNECTION_ID_LEN] = bytes.get(at..at + CONNECTION_ID_LEN)?.try_into().ok()?;
    Some(u32::from_be_bytes(id))
}

fn padded(id: u32, payload: &[u8], total: usize) -> Vec<u8> {
    let mut plain = Vec::with_capacity(total);
    plain.extend_from_slice(&id.to_be_bytes());
    plain.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    plain.extend_from_slice(payload);
    plain.resize(total, 0);
    plain
}

/// 附带数据开头的发送方连接号，和数据本身。
fn unpadded(plain: &[u8]) -> Option<(u32, &[u8])> {
    let id = read_id(plain, 0)?;
    let length = u16::from_be_bytes([*plain.get(CONNECTION_ID_LEN)?, *plain.get(CONNECTION_ID_LEN + 1)?]) as usize;
    Some((id, plain.get(PAYLOAD_PREFIX..PAYLOAD_PREFIX + length)?))
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

    /// 比收到过的包号都大：对端最新发出的包。
    fn is_newest(&self, number: u64) -> bool {
        self.largest.is_none_or(|largest| number > largest)
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
    /// 对端的包从别的路径来、开始验证那条路径的次数。
    pub path_challenges: u64,
    /// 新路径验证通过、数据换过去的次数。
    pub migrations: u64,
    /// 其中只换了端口、往返和带宽照旧的次数。
    pub port_migrations: u64,
    /// 新路径验证超时的次数，数据一直留在原路径上。
    pub path_failures: u64,
    /// 对端忽然安静时发出的探测，见模块说明。
    pub silence_pings: u64,
}

/// 收到的握手请求，还没有回复。调用方检查对方身份和附带数据后决定是否接受。
pub struct Incoming<C: Crypto> {
    handshake: Handshake<C>,
    payload: Vec<u8>,
    initiation: Vec<u8>,
    remote_id: u32,
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
        let (remote_id, payload) = unpadded(&plain).ok_or(PacketError::Malformed)?;
        let payload = payload.to_vec();
        Ok(Self { handshake, payload, initiation: packet.to_vec(), remote_id })
    }

    /// 发起方的长期公钥。
    pub fn remote_static(&self) -> &[u8; PUBLIC_KEY_LEN] {
        self.handshake.remote_static()
    }

    /// 发起方附带的数据。只受响应方长期密钥保护，不具备前向保密，也可能是重放的。
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    /// 接受这个请求：生成回复，返回连接。之后照常调用 `poll_transmit` 把回复发出去，
    /// 回复发往路径 0，即请求来的那条。写入的数据要等发起方确认在线后才发，见模块说明。
    pub fn accept(self, crypto: C, config: Config, payload: &[u8], now_us: u64) -> Result<SecureConnection<C>, HandshakeError> {
        let known_ephemeral = ephemeral_of(&self.initiation).and_then(|bytes| bytes.try_into().ok());
        let (phase, accepted) = respond(&crypto, &config, self, payload, now_us)?;
        let mut connection = SecureConnection::new(crypto, config, phase, accepted.remote_static, now_us);
        connection.adopt(accepted);
        connection.known_ephemeral = known_ephemeral;
        Ok(connection)
    }
}

struct Accepted {
    remote_static: [u8; PUBLIC_KEY_LEN],
    remote_payload: Vec<u8>,
    handshake_hash: [u8; HASH_LEN],
    remote_id: u32,
}

/// 写回复并导出密钥。回复和请求一样长，不会更大。
fn respond<C: Crypto>(crypto: &C, config: &Config, incoming: Incoming<C>, payload: &[u8], now_us: u64) -> Result<(Phase<C>, Accepted), HandshakeError> {
    let Incoming { mut handshake, payload: remote_payload, initiation, remote_id } = incoming;
    let total = config.max_packet_size.min(initiation.len());
    if total < RESPONSE_OVERHEAD || payload.len() > total - RESPONSE_OVERHEAD {
        return Err(HandshakeError::PayloadTooLarge);
    }
    let mut message = vec![RESPONSE];
    message.extend_from_slice(&remote_id.to_be_bytes());
    handshake.write_second(crypto, &padded(config.connection_id, payload, total - RESPONSE_PREFIX - SECOND_MESSAGE_FIXED_LEN), &mut message)?;
    let remote_static = *handshake.remote_static();
    let keys = handshake.finish(crypto).ok_or(HandshakeError::Malformed)?;
    let handshake_hash = keys.handshake_hash;
    let phase = Phase::Established {
        keys: Keys::new(keys, config),
        confirmed: false,
        established_at: now_us,
        response: Some(Response { message, initiation, due: true }),
    };
    Ok((phase, Accepted { remote_static, remote_payload, handshake_hash, remote_id }))
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
    Initiating(Box<Initiation<C>>),
    Established {
        keys: Keys<C>,
        /// 响应方收到发起方第一个有效数据包之前是 `false`：那之前请求可能是重放的，对方可能根本不在。
        confirmed: bool,
        established_at: u64,
        /// 响应方确认之前保留回复，请求重发时再发一次。
        response: Option<Response>,
    },
}

/// 对端像是换到了这条路径，正在验证。
struct Candidate {
    path: u64,
    /// 从这条路径收到和往这条路径发出的字节数，发出的不超过收到的三倍。
    received: u64,
    sent: u64,
    /// 这一轮发出的验证值是从 `first` 起连续 `challenges` 个，对端回哪一个都算。
    first: u64,
    challenges: u32,
    due_at: u64,
    interval_us: u64,
    deadline: u64,
    /// 调用方说这条路径和数据路径只差端口。
    same_route: bool,
}

/// 往哪条路径发，以及正在验证的新路径。路径是调用方编的号，见模块说明。
struct Paths {
    /// 数据都发往这里：握手或者路径验证证明过对端在这里收得到。
    active: u64,
    /// 正在验证的路径，最多 `MAX_CANDIDATES` 条，先开始的在前。
    candidates: Vec<Candidate>,
    /// 还没回的路径验证：（来自哪条路径，值，包长）。回复发回验证来的那条路径。
    responses: VecDeque<(u64, u64, usize)>,
    next_value: u64,
}

impl Paths {
    fn new() -> Self {
        Self { active: 0, candidates: Vec::new(), responses: VecDeque::new(), next_value: 0 }
    }

    fn candidate(&self, path: u64) -> Option<&Candidate> {
        self.candidates.iter().find(|candidate| candidate.path == path)
    }

    /// 还能往 `path` 发多少字节，`None` 表示不限。只有正在验证的路径受限，别的路径只发和验证包一样长的回复。
    fn room(&self, path: u64) -> Option<usize> {
        let candidate = self.candidate(path)?;
        let room = candidate.received.saturating_mul(AMPLIFICATION_FACTOR).saturating_sub(candidate.sent);
        Some(usize::try_from(room).unwrap_or(usize::MAX))
    }

    fn on_received(&mut self, path: u64, bytes: usize) {
        if let Some(candidate) = self.candidates.iter_mut().find(|candidate| candidate.path == path) {
            candidate.received += bytes as u64;
        }
    }

    fn on_sent(&mut self, path: u64, bytes: usize) {
        if let Some(candidate) = self.candidates.iter_mut().find(|candidate| candidate.path == path) {
            candidate.sent += bytes as u64;
        }
    }

    /// 对端最新的包（或者它从数据路径以外来的重复）从 `path` 来。从数据路径来就不用再验证别的路径：说明对端还在那里，
    /// 刚才从别处来的多半是路上的人抢先送到的复制包。从别的路径来就开始验证它，已经在验证的接着验证。
    /// 验证满了就放弃最早开始的那条。返回是否开始了新一轮验证。
    fn observe(&mut self, now_us: u64, path: u64, interval_us: u64, same_route: bool) -> bool {
        if path == self.active {
            self.candidates.clear();
            return false;
        }
        if self.candidate(path).is_some() {
            return false;
        }
        if self.candidates.len() == MAX_CANDIDATES {
            self.candidates.remove(0);
        }
        let deadline = now_us + interval_us * VALIDATION_RTOS;
        self.candidates.push(Candidate { path, received: 0, sent: 0, first: self.next_value, challenges: 0, due_at: now_us, interval_us, deadline, same_route });
        self.next_value += MAX_CHALLENGES as u64;
        true
    }

    /// 到期要发的验证：发往的路径、值、包长、是否只换了端口。放大限制连最短的验证包都不允许的路径跳过。
    fn next_challenge(&mut self, now_us: u64, max_packet_size: usize) -> Option<(u64, u64, usize, bool)> {
        let index = self.candidates.iter().position(|candidate| {
            candidate.challenges < MAX_CHALLENGES && candidate.due_at <= now_us && self.room(candidate.path).is_some_and(|room| room >= MIN_PROBE_LEN)
        })?;
        let room = self.room(self.candidates[index].path)?;
        let candidate = &mut self.candidates[index];
        let value = candidate.first + candidate.challenges as u64;
        candidate.due_at = now_us + (candidate.interval_us << candidate.challenges);
        candidate.challenges += 1;
        // 只用一半额度：验证包丢了还要重发，从这条路径收到更多之前得留着。
        Some((candidate.path, value, (room / 2).clamp(MIN_PROBE_LEN, max_packet_size), candidate.same_route))
    }

    /// 对端回了验证。是哪一条正在验证的路径发出的值，数据就换到那条路径，其余的验证都不用了，
    /// 返回那条路径是否只换了端口；不是任何一条的值时返回 `None`。
    fn on_response(&mut self, value: u64) -> Option<bool> {
        let candidate = self.candidates.iter().find(|candidate| (candidate.first..candidate.first + candidate.challenges as u64).contains(&value))?;
        let same_route = candidate.same_route;
        self.active = candidate.path;
        self.candidates.clear();
        Some(same_route)
    }

    fn queue_response(&mut self, path: u64, value: u64, size: usize) {
        if self.responses.len() == MAX_PENDING_RESPONSES {
            self.responses.pop_front();
        }
        self.responses.push_back((path, value, size));
    }

    /// 下一个要发的验证回复：发往哪条路径、值、包长。发回数据路径时填满到 `max_packet_size`：
    /// 对端在验证这一端的新地址，正受放大限制，回复越长它能发的越多，验证包丢了才重发得出来，
    /// 也顺便确认了这个方向能过满长度的包。发往别的路径时和验证包一样长，放大不了；
    /// 发往这一端自己也在验证的路径时还要守那里的额度，不够就缩短，再短不了就不回，对端会重发。
    fn next_response(&mut self, max_packet_size: usize) -> Option<(u64, u64, usize)> {
        while let Some((path, value, size)) = self.responses.pop_front() {
            let size = if path == self.active { max_packet_size } else { self.room(path).map_or(size, |room| room.min(size)) };
            if size >= MIN_PROBE_LEN {
                return Some((path, value, size));
            }
        }
        None
    }

    /// 验证到期没有通过就放弃，数据一直留在原路径上。返回放弃了几条。
    fn expire(&mut self, now_us: u64) -> u64 {
        let before = self.candidates.len();
        self.candidates.retain(|candidate| candidate.deadline > now_us);
        (before - self.candidates.len()) as u64
    }

    /// 路径验证下一次要做事的时间：重发验证，或者判定失败。额度连最短的验证包都不够的路径只等失败。
    fn wake_at(&self) -> Option<u64> {
        self.candidates
            .iter()
            .map(|candidate| {
                let sendable = candidate.challenges < MAX_CHALLENGES && self.room(candidate.path).is_some_and(|room| room >= MIN_PROBE_LEN);
                if sendable { candidate.due_at.min(candidate.deadline) } else { candidate.deadline }
            })
            .min()
    }
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
/// 地址可能变的场合改用 `on_packet_via` 和 `poll_transmit_via`，见模块说明。
/// `max_packet_size` 仍是整个 UDP 载荷的上限，加密的 16 字节标签和 4 字节连接号算在里面，握手要求它至少 103 字节。
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
    /// 对端的连接号，写进发给它的每个数据包。握手完成以后才知道。
    remote_id: u32,
    /// 已经处理过的那个请求的一次性公钥：响应方是接受的那个，发起方是同时发起时忽略的那个。
    /// 同样的请求再来，是网络重复或重放，不是新连接。
    known_ephemeral: Option<[u8; PUBLIC_KEY_LEN]>,
    paths: Paths,
    /// 上一次因为安静发出探测时，最后一次收到对端包的时间。之后又收到包就从头算。
    silence_heard: u64,
    /// 最近一次因为安静发出探测的时间。
    silence_sent_at: Option<u64>,
    /// 最近一次因为这一端换了网络而从头量的时间。
    moved_at: Option<u64>,
    /// 握手失败、超时，或者认证失败的包太多。
    dead: bool,
    stats: SecurityStats,
}

impl<C: Crypto> SecureConnection<C> {
    fn new(crypto: C, config: Config, phase: Phase<C>, remote_static: [u8; PUBLIC_KEY_LEN], now_us: u64) -> Self {
        let local_static = crypto.static_public();
        let connection = Connection::with_overhead(config.clone(), now_us, CONNECTION_ID_LEN + TAG_LEN);
        let scratch = vec![0; config.max_packet_size];
        Self {
            crypto,
            config,
            connection,
            phase,
            replay: ReplayWindow::new(),
            scratch,
            local_static,
            remote_static,
            remote_payload: None,
            handshake_hash: None,
            remote_id: 0,
            known_ephemeral: None,
            paths: Paths::new(),
            silence_heard: 0,
            silence_sent_at: None,
            moved_at: None,
            dead: false,
            stats: SecurityStats::default(),
        }
    }

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
        handshake.write_first(&crypto, &padded(config.connection_id, payload, config.max_packet_size - 1 - FIRST_MESSAGE_FIXED_LEN), &mut message)?;
        let phase = Phase::Initiating(Box::new(Initiation {
            handshake: Some(handshake),
            message,
            prologue: prologue.to_vec(),
            payload: payload.to_vec(),
            started_at: now_us,
            first_sent_at: None,
            next_send_at: now_us,
            interval_us: config.initial_rto_us,
        }));
        Ok(Self::new(crypto, config, phase, *remote_static, now_us))
    }

    fn adopt(&mut self, accepted: Accepted) {
        self.remote_payload = Some(accepted.remote_payload);
        self.handshake_hash = Some(accepted.handshake_hash);
        self.remote_id = accepted.remote_id;
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

    /// 可靠层的统计。流量计数含加密标签和路径验证包，不含握手包，握手见 [`SecurityStats`]。
    pub fn stats(&self) -> Stats {
        self.connection.stats()
    }

    pub fn is_dead(&self) -> bool {
        self.dead || self.connection.is_dead()
    }

    /// 数据现在发往哪条路径。对端在这里收得到，握手或者路径验证证明过。
    pub fn path(&self) -> u64 {
        self.paths.active
    }

    /// 正在验证的新路径，先开始的在前。验证通过之前数据照旧发往 [`path`](Self::path)，发往新路径的只有验证包，受放大限制。
    pub fn validating(&self) -> impl Iterator<Item = u64> + '_ {
        self.paths.candidates.iter().map(|candidate| candidate.path)
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

    /// 尽快发一个探测包，对端会确认。上层可以拿它当心跳：NAT 的映射一般几十秒到两分钟没有流量就失效。
    pub fn ping(&mut self) {
        self.connection.ping();
    }

    /// 这一端换了网络（换了网卡、重新绑定了端口），对端的地址不变。在途的包多半跟着旧网络丢了，全部重传，
    /// 往返和带宽从头量，并马上发一个包：对端从新地址收到就会跟过来。
    pub fn on_local_address_change(&mut self, now_us: u64) {
        if self.is_established() {
            self.moved_at = Some(now_us);
            self.connection.on_path_change(now_us);
            self.ping();
        }
    }

    /// 处理一个收到的包。错误只表示这个包被丢弃，不影响连接；`Handshake` 表示对端发来了新的握手请求，
    /// 交给 [`Incoming::read`]，新连接确认之前不要关掉这一条。
    ///
    /// 两端同时向对方发起时，长期公钥较大的一方继续当发起方并忽略对方的请求（返回 `Ok`），
    /// 另一方自动改当响应方，已写入的数据不受影响。
    pub fn on_packet(&mut self, now_us: u64, packet: &[u8]) -> Result<(), PacketError> {
        self.on_packet_via(now_us, self.paths.active, packet)
    }

    /// 同 [`on_packet`](Self::on_packet)，`path` 是这个包从哪条路径来，见模块说明的“换地址”。
    pub fn on_packet_via(&mut self, now_us: u64, path: u64, packet: &[u8]) -> Result<(), PacketError> {
        self.on_packet_via_route(now_us, path, false, packet)
    }

    /// 同 [`on_packet_via`](Self::on_packet_via)。`same_route` 是调用方看出这个包的来源和数据路径只差端口
    /// （IP 相同）：从这里开始验证、通过后不重量往返和带宽。来源就是数据路径时不起作用。
    pub fn on_packet_via_route(&mut self, now_us: u64, path: u64, same_route: bool, packet: &[u8]) -> Result<(), PacketError> {
        if self.is_dead() {
            return Err(PacketError::Dead);
        }
        let result = match packet.first() {
            Some(&INITIATION) => self.on_initiation(now_us, path, packet),
            Some(&RESPONSE) => self.on_response(now_us, packet),
            _ => self.on_transport(now_us, path, same_route, packet),
        };
        match result {
            Err(PacketError::Unauthenticated) => self.stats.unauthenticated_packets += 1,
            Err(PacketError::Replayed) => self.stats.replayed_packets += 1,
            _ => {}
        }
        result
    }

    fn on_transport(&mut self, now_us: u64, path: u64, same_route: bool, packet: &[u8]) -> Result<(), PacketError> {
        let Phase::Established { keys, confirmed, response, .. } = &mut self.phase else {
            return Err(PacketError::Unauthenticated);
        };
        if packet.len() < DATA_PREFIX + 1 + TAG_LEN || packet.len() > self.config.max_packet_size {
            return Err(PacketError::Malformed);
        }
        let (truncated, _) = wire::parse_header(packet).ok_or(PacketError::Malformed)?;
        // 不是发给这条连接的：调用方把别的连接的包送错了地方。
        if read_id(packet, wire::PACKET_HEADER_LEN) != Some(self.config.connection_id) {
            return Err(PacketError::Unauthenticated);
        }
        let number = wire::expand(truncated, self.replay.expected(self.config.initial_packet_number), wire::PACKET_NUMBER_BITS);
        // 对端最新的那个包又从数据路径以外的地方来了一遍：路上的人抢先送到复制包时，对端从新地址发的真包就成了重复包，
        // 新地址只有从这里看得到。认证通过就去验证那里，包本身照旧当重复包丢掉。
        let duplicate = !self.replay.is_fresh(number);
        if duplicate && (self.replay.largest != Some(number) || path == self.paths.active) {
            return Err(PacketError::Replayed);
        }
        let Some(slot) = keys.recv.slot(&self.crypto, number) else {
            return Err(Self::forgery(&mut self.dead, &self.stats));
        };
        let body_end = packet.len() - TAG_LEN;
        let tag: [u8; TAG_LEN] = packet[body_end..].try_into().map_err(|_| PacketError::Malformed)?;
        let plain = &mut self.scratch[..body_end];
        plain.copy_from_slice(&packet[..body_end]);
        let (header, body) = plain.split_at_mut(DATA_PREFIX);
        if !self.crypto.open(keys.recv.key(slot), number, header, body, &tag) {
            return Err(Self::forgery(&mut self.dead, &self.stats));
        }
        if duplicate {
            if !wire::is_path_frame(&self.scratch[DATA_PREFIX..body_end]) && self.paths.observe(now_us, path, self.config.initial_rto_us, same_route) {
                self.stats.path_challenges += 1;
            }
            self.paths.on_received(path, packet.len());
            return Err(PacketError::Replayed);
        }
        if matches!(slot, RecvSlot::Next) {
            keys.recv.advance();
            self.stats.rekeys += 1;
        }
        let newest = self.replay.is_newest(number);
        self.replay.mark(number);
        if !*confirmed {
            *confirmed = true;
            *response = None;
        }
        let frames = &self.scratch[DATA_PREFIX..body_end];
        if wire::is_path_frame(frames) {
            let (frame, value) = wire::parse_path_frame(frames).ok_or(PacketError::Malformed)?;
            self.on_probe(now_us, path, packet.len(), frame, value);
            return Ok(());
        }
        // 可靠层要的是包头紧跟着帧：把包头挪到连接号的位置上。
        self.scratch.copy_within(..wire::PACKET_HEADER_LEN, CONNECTION_ID_LEN);
        let result = self.connection.on_packet_numbered(now_us, Some(number), &self.scratch[CONNECTION_ID_LEN..body_end]);
        if result.is_ok() && newest && self.paths.observe(now_us, path, self.config.initial_rto_us, same_route) {
            self.stats.path_challenges += 1;
        }
        self.paths.on_received(path, packet.len());
        result
    }

    /// 只含路径验证的包：回复对端的验证，或者确认自己发出的验证。
    fn on_probe(&mut self, now_us: u64, path: u64, size: usize, frame: wire::PathFrame, value: u64) {
        self.connection.on_probe_received(size);
        self.paths.on_received(path, size);
        match frame {
            wire::PathFrame::Challenge { same_route } => {
                self.paths.queue_response(path, value, size);
                // 对端在验证这一端的新地址：这一端换了网络自己却不知道，往返和带宽也该从头量。
                // 对端看出只换了端口时不用，走的还是同一条路；但验证通过之前对端的确认都发往旧端口，
                // 这两个往返里收不到确认不判超时，否则在途的包会被当成丢了全部重传（往返长的蜂窝线路上常见）。
                // 一轮验证会收到好几次，只在一轮验证的时长里第一次收到时重来。
                let window = self.config.initial_rto_us * VALIDATION_RTOS;
                if same_route && path == self.paths.active {
                    self.connection.hold_timeouts(now_us + 2 * self.connection.srtt_us());
                } else if path == self.paths.active && self.moved_at.is_none_or(|at| now_us.saturating_sub(at) >= window) {
                    self.moved_at = Some(now_us);
                    self.connection.on_path_change(now_us);
                }
            }
            wire::PathFrame::Response => {
                // 验证通过才换路径，这时才重量往返和带宽。抢先送到的复制包只换来几个发往假地址的验证包，数据一直在原路径上。
                // 只换了端口时在途的包照样重传，往返和带宽照旧，并马上补一个确认：对端没有重来，窗口还满着，
                // 验证期间的确认又都发往了旧端口。真换了网络时不补：自己知道换了网络的对端已经重来，补的确认只确认旧路径上的包，
                // 2026-11-05 模拟里这时上传反而慢 2%、双向慢 3%。
                let Some(same_route) = self.paths.on_response(value) else { return };
                if same_route {
                    self.connection.on_port_change();
                    self.connection.ack_now(now_us);
                    self.stats.port_migrations += 1;
                } else {
                    self.connection.on_path_change(now_us);
                }
                self.stats.migrations += 1;
            }
        }
    }

    /// 认证失败太多次时放弃连接，计数本身由 `on_packet` 加。
    fn forgery(dead: &mut bool, stats: &SecurityStats) -> PacketError {
        if stats.unauthenticated_packets + 1 >= MAX_FORGERIES {
            *dead = true;
        }
        PacketError::Unauthenticated
    }

    fn on_initiation(&mut self, now_us: u64, path: u64, packet: &[u8]) -> Result<(), PacketError> {
        if let Phase::Established { response: Some(response), .. } = &mut self.phase
            && response.initiation == packet
        {
            response.due = true;
            // 发起方握手途中换了地址：回复跟着最新的请求走。还没确认之前只回和请求一样长的回复，换到哪里都放大不了。
            self.paths.active = path;
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
        self.adopt(accepted);
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
        handshake.read_second(&self.crypto, packet.get(RESPONSE_PREFIX..).unwrap_or(&[]), &mut plain).map_err(packet_error)?;
        // 回复已通过认证，格式还不对说明对端的实现不兼容，这次握手无法继续。
        let Some((remote_id, remote_payload)) = unpadded(&plain).map(|(id, payload)| (id, payload.to_vec())) else {
            self.dead = true;
            return Err(PacketError::Malformed);
        };
        if self.stats.handshake_retransmissions == 0 {
            self.stats.handshake_rtt_us = initiation.first_sent_at.map_or(0, |sent| now_us.saturating_sub(sent));
        }
        let keys = initiation.handshake.take().and_then(|handshake| handshake.finish(&self.crypto)).ok_or(PacketError::Malformed)?;
        self.handshake_hash = Some(keys.handshake_hash);
        self.remote_payload = Some(remote_payload);
        self.remote_id = remote_id;
        self.phase = Phase::Established { keys: Keys::new(keys, &self.config), confirmed: true, established_at: now_us, response: None };
        self.connection.reset_clock(now_us);
        // 响应方要见到这一端的数据包才确认，没有数据要发时也要让它尽快确认。
        self.connection.ping();
        Ok(())
    }

    /// 取下一个要发的包。`out` 至少要有 `max_packet_size` 字节。
    pub fn poll_transmit(&mut self, now_us: u64, out: &mut [u8]) -> Option<usize> {
        self.poll_transmit_via(now_us, out).map(|(size, _)| size)
    }

    /// 同 [`poll_transmit`](Self::poll_transmit)，另外返回这个包该发往哪条路径。
    pub fn poll_transmit_via(&mut self, now_us: u64, out: &mut [u8]) -> Option<(usize, u64)> {
        if self.is_dead() {
            return None;
        }
        let current = self.paths.active;
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
                Some((size, current))
            }
            Phase::Established { confirmed, response, .. } => {
                if let Some(response) = response.as_mut().filter(|response| response.due) {
                    response.due = false;
                    let size = response.message.len();
                    out[..size].copy_from_slice(&response.message);
                    self.stats.handshake_packets_sent += 1;
                    return Some((size, current));
                }
                if !*confirmed {
                    return None;
                }
                self.poll_established(now_us, out)
            }
        }
    }

    /// 确认以后要发的包：先发路径验证，再发数据。
    fn poll_established(&mut self, now_us: u64, out: &mut [u8]) -> Option<(usize, u64)> {
        let (size, number, path) = match self.write_probe(now_us, out) {
            Some(probe) => probe,
            None => {
                // 可靠层写的是包头紧跟着帧，在两者之间插进对端的连接号。
                let size = self.connection.poll_transmit(now_us, &mut out[CONNECTION_ID_LEN..])?;
                out.copy_within(CONNECTION_ID_LEN..DATA_PREFIX, 0);
                self.address(out);
                (size + CONNECTION_ID_LEN, self.connection.last_packet_number(), self.paths.active)
            }
        };
        let Phase::Established { keys, .. } = &mut self.phase else {
            return None;
        };
        let before = keys.send.epoch;
        let key = keys.send.for_packet(&self.crypto, number);
        let (header, body) = out[..size].split_at_mut(DATA_PREFIX);
        let tag = self.crypto.seal(key, number, header, body);
        self.stats.rekeys += keys.send.epoch - before;
        out[size..size + TAG_LEN].copy_from_slice(&tag);
        self.paths.on_sent(path, size + TAG_LEN);
        Some((size + TAG_LEN, path))
    }

    /// 包头后面写上对端的连接号。
    fn address(&self, out: &mut [u8]) {
        out[wire::PACKET_HEADER_LEN..DATA_PREFIX].copy_from_slice(&self.remote_id.to_be_bytes());
    }

    /// 路径验证包的明文：先回对端的验证，再在没验证过的新路径上发验证。返回明文长度、包号和发往的路径。
    fn write_probe(&mut self, now_us: u64, out: &mut [u8]) -> Option<(usize, u64, u64)> {
        let (frame, path, value, size) = match self.paths.next_response(self.config.max_packet_size) {
            Some((path, value, size)) => (wire::PathFrame::Response, path, value, size),
            None => {
                let (path, value, size, same_route) = self.paths.next_challenge(now_us, self.config.max_packet_size)?;
                (wire::PathFrame::Challenge { same_route }, path, value, size)
            }
        };
        let number = self.connection.take_packet_number(size);
        let plain = size - TAG_LEN;
        wire::write_header(out, number, false);
        self.address(out);
        wire::write_path_frame(&mut out[DATA_PREFIX..plain], frame, value);
        Some((plain, number, path))
    }

    /// 这一端没有包在途、对端又安静下来时，下一次探测的时间，见模块说明。
    /// 一直没有回音就按同样的间隔重试，到对端判死的时限为止。
    fn silence_ping_at(&self) -> Option<u64> {
        if self.connection.bytes_in_flight() > 0 {
            return None;
        }
        let heard = self.connection.last_heard();
        let answered = self.silence_sent_at.is_some_and(|sent| heard > sent && self.connection.last_data_at() <= sent);
        if answered {
            // 对端回了上一次探测、之后没再发数据：多半只是没东西要发，但也可能是它的数据在路上被挡掉了。
            // 这一端之后再悄悄换了地址，对端就再也找不到这里，所以隔对端判死时限的一半再探测一次，顺便让 NAT 的映射不过期。
            return Some(heard + self.config.dead_after_us / 2);
        }
        let base = SILENCE_PING_US.max(SILENCE_PING_RTTS * self.connection.srtt_us());
        let last = match self.silence_sent_at {
            Some(sent) if self.silence_heard == heard => sent,
            _ => heard,
        };
        let at = last + base;
        (at - heard < self.config.dead_after_us).then_some(at)
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
            None => self.tick_established(now_us),
        }
    }

    fn tick_established(&mut self, now_us: u64) {
        self.stats.path_failures += self.paths.expire(now_us);
        self.connection.tick(now_us);
        if self.silence_ping_at().is_some_and(|at| at <= now_us) {
            self.silence_heard = self.connection.last_heard();
            self.silence_sent_at = Some(now_us);
            self.stats.silence_pings += 1;
            self.ping();
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
                // `established_at` 早已过去，用它表示马上。
                let mut wake = self.paths.wake_at();
                let mut consider = |at: u64| wake = Some(wake.map_or(at, |value: u64| value.min(at)));
                if !self.paths.responses.is_empty() || self.connection.ping_pending() {
                    consider(*established_at);
                }
                if let Some(at) = self.connection.next_wake() {
                    consider(at);
                }
                if let Some(at) = self.silence_ping_at() {
                    consider(at);
                }
                wake
            }
        }
    }
}
