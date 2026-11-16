//! 握手准入：在做任何 DH 之前，用几次哈希挡掉伪造的握手请求；忙的时候再要求对方证明来源地址，并且限流。
//!
//! 解开一份握手请求要做两次 DH，接受它还要再做两次。伪造请求很便宜，算它们很贵，所以要在 DH 之前拦住。
//! 做法和 WireGuard 的 cookie 机制相同：
//!
//! - **mac1**：请求末尾带 `MAC(HASH("mac1----" ‖ 响应方长期公钥), 请求)`。不知道响应方公钥的人算不出来，
//!   响应方只算一次 HMAC 就能丢掉，而且不回任何东西，扫描的人看不出这里有服务。
//! - **mac2 和 cookie**：响应方忙的时候（处理握手的速度超过 [`Admission::handshakes_per_second`]），不再直接处理请求，
//!   先往请求的来源地址回一个加密的 cookie：`HMAC(每两分钟换一次的随机密钥, 来源地址)`。发起方把它用在下一次请求的
//!   mac2 上（`MAC(cookie, 请求)`），响应方确认 mac2 对得上这个来源地址才处理。伪造来源地址的人收不到 cookie。
//! - **限流**：忙的时候，证明过地址的请求按地址限流。cookie 回复不限流：它固定 81 字节，请求至少 135 字节、通常填满到包长，
//!   伪造来源只会让被冒充的地址收到更少的字节；算它只要两次 HMAC 和一次加密。限了它，伪造的请求会把额度用光，真的发起方反而拿不到 cookie。
//!
//! 所以花在陌生请求上的 DH 每秒不超过 `handshakes_per_second`，再加上证明过地址的、按地址限过流的那些。
//! 认不认对方是上层的事（`Endpoint::listen` 的 `admit`），这里只管 CPU。
//!
//! 线上格式：
//!
//! - 握手请求的最后 32 字节是 `[mac1 16][mac2 16]`，没有 cookie 时 mac2 全零。mac1 覆盖它之前的全部字节，mac2 覆盖它之前的全部字节（含 mac1）。
//! - cookie 回复：`[0x83][请求的 mac1 16][盐 16][加密的 cookie 32][认证标签 16]`，共 81 字节。
//!   密钥是 `HMAC(HASH("cookie--" ‖ 响应方长期公钥), 盐)`，nonce 为 0，请求的 mac1 作附加数据：
//!   每个回复的密钥都不同，只有发出那个请求、又知道响应方公钥的一端能解开。

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::crypto::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};

pub(crate) const MAC_LEN: usize = 16;
pub(crate) const COOKIE_LEN: usize = HASH_LEN;
const SALT_LEN: usize = 16;
pub(crate) const COOKIE_REPLY: u8 = 0x83;
pub(crate) const COOKIE_REPLY_LEN: usize = 1 + MAC_LEN + SALT_LEN + COOKIE_LEN + TAG_LEN;
/// 响应方每隔这么久换一次算 cookie 的密钥，上一把再认一个间隔，所以一个 cookie 至少能用这么久。
const COOKIE_ROTATION_US: u64 = 120_000_000;
/// 发起方用一个 cookie 的期限，比响应方肯认的短一些。
pub(crate) const COOKIE_USABLE_US: u64 = COOKIE_ROTATION_US - 5_000_000;
/// 处理握手的额度用完以后，至少这么久都算忙。
const BUSY_HOLD_US: u64 = 1_000_000;
/// 最多给这么多个来源地址分别限流。只有证明过地址的才进来，伪造来源占不了位置。
const MAX_LIMITED_ADDRESSES: usize = 4096;
/// 令牌桶里一个令牌的单位：微秒乘以每秒个数，正好是百万分之一个。
const UNIT: u64 = 1_000_000;

const MAC1_LABEL: &[u8] = b"mac1----";
const COOKIE_LABEL: &[u8] = b"cookie--";

/// 握手准入的限额，见模块说明。默认值够一台设备同时和几十个对端重新建连；超出时多一个往返，不会被拒。
#[derive(Clone, Copy, Debug)]
pub struct Admission {
    /// 不要求证明来源地址时每秒最多处理这么多个握手请求，可以一下子用掉 `handshake_burst` 个。用完就算忙。
    pub handshakes_per_second: u32,
    pub handshake_burst: u32,
    /// 忙的时候，每个证明过的来源地址每秒最多这么多个请求。同一个公网地址后面可能有好几台设备。
    pub per_address_per_second: u32,
    pub per_address_burst: u32,
}

impl Default for Admission {
    fn default() -> Self {
        Self { handshakes_per_second: 64, handshake_burst: 64, per_address_per_second: 8, per_address_burst: 16 }
    }
}

pub(crate) fn mac1_key<C: Crypto>(crypto: &C, responder: &[u8; PUBLIC_KEY_LEN]) -> [u8; HASH_LEN] {
    crypto.hash(&[MAC1_LABEL, responder])
}

fn cookie_key<C: Crypto>(crypto: &C, responder: &[u8; PUBLIC_KEY_LEN]) -> [u8; HASH_LEN] {
    crypto.hash(&[COOKIE_LABEL, responder])
}

pub(crate) fn mac<C: Crypto>(crypto: &C, key: &[u8; HASH_LEN], message: &[u8]) -> [u8; MAC_LEN] {
    let full = crypto.hmac(key, &[message]);
    let mut out = [0; MAC_LEN];
    out.copy_from_slice(&full[..MAC_LEN]);
    out
}

/// 不随内容提前返回的比较，免得对方按耗时一个字节一个字节地猜。
pub(crate) fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// 请求的 mac1。请求太短时是 `None`。
pub(crate) fn mac1_of(packet: &[u8]) -> Option<&[u8]> {
    let end = packet.len().checked_sub(MAC_LEN)?;
    packet.get(end.checked_sub(MAC_LEN)?..end)
}

/// mac1 对不对。`key` 是 [`mac1_key`] 算出的、这一端自己公钥的那一个。
pub(crate) fn check_mac1<C: Crypto>(crypto: &C, key: &[u8; HASH_LEN], packet: &[u8]) -> bool {
    let Some(end) = packet.len().checked_sub(2 * MAC_LEN) else { return false };
    same(&mac(crypto, key, &packet[..end]), &packet[end..end + MAC_LEN])
}

/// 发起方解开 cookie 回复。`mac1` 是这一端正在发的请求的 mac1，对不上就不是回给它的。
pub(crate) fn open_cookie<C: Crypto>(crypto: &C, responder: &[u8; PUBLIC_KEY_LEN], mac1: &[u8], packet: &[u8]) -> Option<[u8; COOKIE_LEN]> {
    if packet.len() != COOKIE_REPLY_LEN || packet[0] != COOKIE_REPLY || !same(&packet[1..1 + MAC_LEN], mac1) {
        return None;
    }
    let salt = &packet[1 + MAC_LEN..1 + MAC_LEN + SALT_LEN];
    let key = crypto.key(&crypto.hmac(&cookie_key(crypto, responder), &[salt]));
    let start = 1 + MAC_LEN + SALT_LEN;
    let mut cookie = [0; COOKIE_LEN];
    cookie.copy_from_slice(&packet[start..start + COOKIE_LEN]);
    let tag: [u8; TAG_LEN] = packet[start + COOKIE_LEN..].try_into().ok()?;
    crypto.open(&key, 0, mac1, &mut cookie, &tag).then_some(cookie)
}

/// 响应方检查请求、写 cookie 回复用的东西。
pub(crate) struct Gate<C: Crypto> {
    crypto: C,
    mac1_key: [u8; HASH_LEN],
    cookie_key: [u8; HASH_LEN],
}

impl<C: Crypto> Gate<C> {
    pub(crate) fn new(crypto: C) -> Self {
        let public = crypto.static_public();
        let mac1_key = mac1_key(&crypto, &public);
        let cookie_key = cookie_key(&crypto, &public);
        Self { crypto, mac1_key, cookie_key }
    }

    pub(crate) fn mac1_ok(&self, packet: &[u8]) -> bool {
        check_mac1(&self.crypto, &self.mac1_key, packet)
    }

    fn cookie(&self, secret: &[u8; HASH_LEN], address: &[u8]) -> [u8; COOKIE_LEN] {
        self.crypto.hmac(secret, &[address])
    }

    fn mac2_ok(&self, packet: &[u8], cookie: &[u8; COOKIE_LEN]) -> bool {
        let Some(end) = packet.len().checked_sub(MAC_LEN) else { return false };
        same(&mac(&self.crypto, cookie, &packet[..end]), &packet[end..])
    }

    fn reply(&self, packet: &[u8], cookie: [u8; COOKIE_LEN], salt: [u8; SALT_LEN]) -> Vec<u8> {
        let mac1 = mac1_of(packet).unwrap_or(&[]);
        let key = self.crypto.key(&self.crypto.hmac(&self.cookie_key, &[&salt]));
        let mut sealed = cookie;
        let tag = self.crypto.seal(&key, 0, mac1, &mut sealed);
        let mut reply = Vec::with_capacity(COOKIE_REPLY_LEN);
        reply.push(COOKIE_REPLY);
        reply.extend_from_slice(mac1);
        reply.extend_from_slice(&salt);
        reply.extend_from_slice(&sealed);
        reply.extend_from_slice(&tag);
        reply
    }
}

#[derive(Clone, Copy)]
struct Bucket {
    tokens: u64,
    at: u64,
}

impl Bucket {
    fn full(burst: u32, now_us: u64) -> Self {
        Self { tokens: burst as u64 * UNIT, at: now_us }
    }

    fn take(&mut self, now_us: u64, per_second: u32, burst: u32) -> bool {
        let elapsed = now_us.saturating_sub(self.at);
        self.at = self.at.max(now_us);
        self.tokens = self.tokens.saturating_add(elapsed.saturating_mul(per_second as u64)).min(burst as u64 * UNIT);
        if self.tokens < UNIT {
            return false;
        }
        self.tokens -= UNIT;
        true
    }
}

struct Secrets {
    current: [u8; HASH_LEN],
    previous: [u8; HASH_LEN],
    rotated_at: u64,
}

fn random_bytes<const N: usize>(random: &mut dyn FnMut() -> u32) -> [u8; N] {
    let mut bytes = [0; N];
    for chunk in bytes.chunks_mut(4) {
        chunk.copy_from_slice(&random().to_le_bytes()[..chunk.len()]);
    }
    bytes
}

pub(crate) enum Verdict {
    /// 可以做 DH 了。
    Process,
    /// 先回这个 cookie。
    Cookie(Vec<u8>),
    /// 证明过地址，但这个地址超过了限额，丢掉。
    Throttled,
}

/// 响应方的准入状态：额度、算 cookie 的密钥、各来源地址的额度。
pub(crate) struct Admitter {
    pub(crate) config: Admission,
    handshakes: Option<Bucket>,
    busy_until: u64,
    secrets: Option<Secrets>,
    limited: BTreeMap<Vec<u8>, Bucket>,
}

impl Admitter {
    pub(crate) fn new() -> Self {
        Self { config: Admission::default(), handshakes: None, busy_until: 0, secrets: None, limited: BTreeMap::new() }
    }

    /// 一个 mac1 已经对上的请求。`address` 是来源地址的字节，同一个地址每次都一样。
    pub(crate) fn check<C: Crypto>(&mut self, gate: &Gate<C>, now_us: u64, address: &[u8], packet: &[u8], random: &mut dyn FnMut() -> u32) -> Verdict {
        let config = self.config;
        if now_us >= self.busy_until {
            let handshakes = self.handshakes.get_or_insert_with(|| Bucket::full(config.handshake_burst, now_us));
            if handshakes.take(now_us, config.handshakes_per_second, config.handshake_burst) {
                return Verdict::Process;
            }
            self.busy_until = now_us + BUSY_HOLD_US;
        }
        let secrets = self.secrets(now_us, random);
        let current = gate.cookie(&secrets.current, address);
        let previous = gate.cookie(&secrets.previous, address);
        if gate.mac2_ok(packet, &current) || gate.mac2_ok(packet, &previous) {
            return if self.limit(now_us, address) { Verdict::Process } else { Verdict::Throttled };
        }
        Verdict::Cookie(gate.reply(packet, current, random_bytes(random)))
    }

    /// 算 cookie 的密钥，到时候就换。隔了两个间隔以上没用过，两把都换新的。
    fn secrets(&mut self, now_us: u64, random: &mut dyn FnMut() -> u32) -> &Secrets {
        let stale = self.secrets.as_ref().map(|secrets| now_us.saturating_sub(secrets.rotated_at) / COOKIE_ROTATION_US);
        match stale {
            None | Some(2..) => self.secrets = Some(Secrets { current: random_bytes(random), previous: random_bytes(random), rotated_at: now_us }),
            Some(1) => {
                if let Some(secrets) = self.secrets.as_mut() {
                    secrets.previous = core::mem::replace(&mut secrets.current, random_bytes(random));
                    secrets.rotated_at = now_us;
                }
            }
            Some(_) => {}
        }
        self.secrets.as_ref().expect("secrets were just set")
    }

    fn limit(&mut self, now_us: u64, address: &[u8]) -> bool {
        let config = self.config;
        if !self.limited.contains_key(address) && self.limited.len() >= MAX_LIMITED_ADDRESSES {
            // 先忘掉额度早已回满的地址，还满就忘掉最久没来的那个。
            let idle_us = (config.per_address_burst as u64 * UNIT).div_ceil(config.per_address_per_second.max(1) as u64);
            self.limited.retain(|_, bucket| now_us.saturating_sub(bucket.at) < idle_us);
            if self.limited.len() >= MAX_LIMITED_ADDRESSES
                && let Some(oldest) = self.limited.iter().min_by_key(|(_, bucket)| bucket.at).map(|(address, _)| address.clone())
            {
                self.limited.remove(&oldest);
            }
        }
        self.limited
            .entry(address.to_vec())
            .or_insert_with(|| Bucket::full(config.per_address_burst, now_us))
            .take(now_us, config.per_address_per_second, config.per_address_burst)
    }
}
