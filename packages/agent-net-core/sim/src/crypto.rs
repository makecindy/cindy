//! 测试用的加密实现：X25519 用 x25519-dalek，认证加密、SHA-256 和 HMAC 用 ring。
//!
//! 只在模拟器和测试工具里用。产品里由各平台传入系统自带的实现，核心本身不依赖任何库。
//! 一次性密钥由确定性的伪随机数生成，模拟才能按种子重放，**不能**用在真实通信里。
//!
//! 另外带两项检查，给测试看守核心的行为：同一个密钥下 nonce 必须严格递增（重复就 panic），
//! 一次性私钥的存活个数（握手完成后必须是 0）。

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::marker::PhantomData;
use std::rc::Rc;

use agent_net_core::{Config, Crypto, HASH_LEN, Incoming, PUBLIC_KEY_LEN, PacketError, SecureConnection, TAG_LEN, is_initiation};
use ring::aead::{self, Aad, LessSafeKey, Nonce, Tag, UnboundKey};
use ring::{digest, hmac};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{Peer, Rng};

/// 认证加密算法。
pub trait Suite {
    const NAME: &'static str;
    fn algorithm() -> &'static aead::Algorithm;
    fn nonce(counter: u64) -> [u8; 12];
}

pub struct AesGcm;

impl Suite for AesGcm {
    const NAME: &'static str = "AESGCM";
    fn algorithm() -> &'static aead::Algorithm {
        &aead::AES_256_GCM
    }
    fn nonce(counter: u64) -> [u8; 12] {
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }
}

pub struct ChaChaPoly;

impl Suite for ChaChaPoly {
    const NAME: &'static str = "ChaChaPoly";
    fn algorithm() -> &'static aead::Algorithm {
        &aead::CHACHA20_POLY1305
    }
    fn nonce(counter: u64) -> [u8; 12] {
        let mut nonce = [0; 12];
        nonce[4..].copy_from_slice(&counter.to_le_bytes());
        nonce
    }
}

/// 给测试看的计数，多个实现可以共用一个。
#[derive(Default)]
pub struct Probe {
    pub live_ephemerals: Cell<i64>,
    pub ephemerals_created: Cell<u64>,
    pub packets_sealed: Cell<u64>,
    /// 做过的 X25519 次数，长期私钥和一次性私钥的都算。握手里最贵的就是它。
    pub dh_operations: Cell<u64>,
}

pub struct Ephemeral {
    secret: StaticSecret,
    probe: Rc<Probe>,
}

impl Drop for Ephemeral {
    fn drop(&mut self) {
        self.probe.live_ephemerals.set(self.probe.live_ephemerals.get() - 1);
    }
}

pub struct Key {
    key: LessSafeKey,
    bytes: [u8; 32],
}

pub struct TestCrypto<S: Suite = AesGcm> {
    secret: StaticSecret,
    public: [u8; PUBLIC_KEY_LEN],
    rng: RefCell<Rng>,
    scripted: RefCell<VecDeque<[u8; 32]>>,
    probe: Rc<Probe>,
    check_nonces: bool,
    last_nonce: RefCell<HashMap<[u8; 32], u64>>,
    suite: PhantomData<S>,
}

impl<S: Suite> TestCrypto<S> {
    pub fn from_secret(secret: [u8; 32], seed: u64) -> Self {
        let secret = StaticSecret::from(secret);
        let public = PublicKey::from(&secret).to_bytes();
        Self {
            secret,
            public,
            rng: RefCell::new(Rng::new(seed ^ 0xE9E9_0000_0000_0001)),
            scripted: RefCell::new(VecDeque::new()),
            probe: Rc::new(Probe::default()),
            check_nonces: true,
            last_nonce: RefCell::new(HashMap::new()),
            suite: PhantomData,
        }
    }

    /// 长期密钥和一次性密钥都由种子决定。
    pub fn from_seed(seed: u64) -> Self {
        Self::from_secret(random_bytes(&mut Rng::new(seed ^ 0x5717_1C00)), seed)
    }

    pub fn with_probe(mut self, probe: Rc<Probe>) -> Self {
        self.probe = probe;
        self
    }

    /// 接下来的一次性密钥按给定的私钥依次生成，用于对照官方测试向量。
    pub fn script_ephemerals(&self, secrets: &[[u8; 32]]) {
        self.scripted.borrow_mut().extend(secrets.iter().copied());
    }

    /// 测 CPU 时关掉 nonce 检查，否则测到的是检查本身。
    pub fn unchecked(mut self) -> Self {
        self.check_nonces = false;
        self
    }

    pub fn public(&self) -> [u8; PUBLIC_KEY_LEN] {
        self.public
    }

    /// 长期私钥。只给测试模拟“私钥日后泄露”。
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.secret.to_bytes()
    }

    pub fn probe(&self) -> Rc<Probe> {
        self.probe.clone()
    }
}

fn random_bytes(rng: &mut Rng) -> [u8; 32] {
    let mut bytes = [0; 32];
    for chunk in bytes.chunks_mut(8) {
        chunk.copy_from_slice(&rng.next_u64().to_le_bytes());
    }
    bytes
}

impl<S: Suite> Crypto for TestCrypto<S> {
    type Ephemeral = Ephemeral;
    type Key = Key;
    const CIPHER: &'static str = S::NAME;
    const HASH: &'static str = "SHA256";

    fn static_public(&self) -> [u8; PUBLIC_KEY_LEN] {
        self.public
    }

    fn generate_ephemeral(&self) -> (Ephemeral, [u8; PUBLIC_KEY_LEN]) {
        let bytes = self.scripted.borrow_mut().pop_front().unwrap_or_else(|| random_bytes(&mut self.rng.borrow_mut()));
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret).to_bytes();
        self.probe.live_ephemerals.set(self.probe.live_ephemerals.get() + 1);
        self.probe.ephemerals_created.set(self.probe.ephemerals_created.get() + 1);
        (Ephemeral { secret, probe: self.probe.clone() }, public)
    }

    fn dh_static(&self, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
        self.probe.dh_operations.set(self.probe.dh_operations.get() + 1);
        Some(self.secret.diffie_hellman(&PublicKey::from(*peer)).to_bytes())
    }

    fn dh_ephemeral(&self, secret: &Ephemeral, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
        self.probe.dh_operations.set(self.probe.dh_operations.get() + 1);
        Some(secret.secret.diffie_hellman(&PublicKey::from(*peer)).to_bytes())
    }

    fn hash(&self, parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let mut context = digest::Context::new(&digest::SHA256);
        for part in parts {
            context.update(part);
        }
        context.finish().as_ref().try_into().expect("SHA-256 is 32 bytes")
    }

    fn hmac(&self, key: &[u8; HASH_LEN], parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let mut context = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, key));
        for part in parts {
            context.update(part);
        }
        context.sign().as_ref().try_into().expect("HMAC-SHA256 is 32 bytes")
    }

    fn key(&self, bytes: &[u8; HASH_LEN]) -> Key {
        Key { key: LessSafeKey::new(UnboundKey::new(S::algorithm(), bytes).expect("32-byte key")), bytes: *bytes }
    }

    fn seal(&self, key: &Key, nonce: u64, ad: &[u8], buffer: &mut [u8]) -> [u8; TAG_LEN] {
        // `u64::MAX` 是 Noise `Rekey` 专用的 nonce，包号到不了，不参与递增检查。
        if self.check_nonces && nonce != u64::MAX {
            let mut last = self.last_nonce.borrow_mut();
            if let Some(&previous) = last.get(&key.bytes) {
                assert!(nonce > previous, "nonce {nonce} used after {previous} under the same key");
            }
            last.insert(key.bytes, nonce);
        }
        self.probe.packets_sealed.set(self.probe.packets_sealed.get() + 1);
        let tag = key.key.seal_in_place_separate_tag(Nonce::assume_unique_for_key(S::nonce(nonce)), Aad::from(ad), buffer).expect("seal");
        tag.as_ref().try_into().expect("16-byte tag")
    }

    fn open(&self, key: &Key, nonce: u64, ad: &[u8], buffer: &mut [u8], tag: &[u8; TAG_LEN]) -> bool {
        key.key.open_in_place_separate_tag(Nonce::assume_unique_for_key(S::nonce(nonce)), Aad::from(ad), Tag::from(*tag), buffer, 0..).is_ok()
    }
}

/// 模拟器里两端都用的握手前言。
pub const PROLOGUE: &[u8] = b"agent-net-sim/1";

enum SecureState<S: Suite> {
    /// 响应方等第一个握手请求。
    Listening(Option<TestCrypto<S>>),
    Open(Box<SecureConnection<TestCrypto<S>>>),
}

/// 让模拟器驱动加密连接。发起方创建时就开始握手，响应方收到请求后接受。
pub struct SecurePeer<S: Suite = AesGcm> {
    state: SecureState<S>,
    config: Config,
    buffer: Vec<u8>,
    pub check_invariants: bool,
    established_at: Option<u64>,
}

impl<S: Suite> SecurePeer<S> {
    /// 一对端点，密钥由种子决定。第一个是发起方。
    pub fn pair(config: Config, seed: u64) -> (Self, Self) {
        Self::pair_with(config, seed, true)
    }

    /// `checked` 为 `false` 时关掉 nonce 检查和内部账目检查，测 CPU 用。
    pub fn pair_with(config: Config, seed: u64, checked: bool) -> (Self, Self) {
        Self::pair_at(config, seed, checked, 0)
    }

    /// 发起方在 `created_us` 时刻发起，配合 `Shifted` 模拟时钟不从 0 开始的真实设备。
    pub fn pair_at(config: Config, seed: u64, checked: bool, created_us: u64) -> (Self, Self) {
        let build = |seed: u64| {
            let crypto = TestCrypto::<S>::from_seed(seed);
            if checked { crypto } else { crypto.unchecked() }
        };
        let initiator = build(seed.wrapping_mul(2).wrapping_add(1));
        let responder = build(seed.wrapping_mul(2).wrapping_add(2));
        let remote = responder.public();
        // 两端的连接号不同：写错成自己的号会被对端拒收。
        let (initiator_config, responder_config) =
            (Config { connection_id: seed as u32 ^ 0x5EED_0001, ..config.clone() }, Config { connection_id: seed as u32 ^ 0x5EED_0002, ..config.clone() });
        let connection = SecureConnection::connect(initiator, initiator_config.clone(), PROLOGUE, &remote, &[], created_us).expect("connect");
        let buffer = vec![0; config.max_packet_size];
        (
            Self { state: SecureState::Open(Box::new(connection)), config: initiator_config, buffer: buffer.clone(), check_invariants: checked, established_at: None },
            Self { state: SecureState::Listening(Some(responder)), config: responder_config, buffer, check_invariants: checked, established_at: None },
        )
    }

    pub fn connection(&self) -> Option<&SecureConnection<TestCrypto<S>>> {
        match &self.state {
            SecureState::Open(connection) => Some(connection),
            SecureState::Listening(_) => None,
        }
    }
}

impl<S: Suite> Peer for SecurePeer<S> {
    fn write(&mut self, now_us: u64, data: &[u8]) -> usize {
        match &mut self.state {
            SecureState::Open(connection) => connection.send(now_us, data),
            SecureState::Listening(_) => 0,
        }
    }
    fn read(&mut self, now_us: u64, out: &mut [u8]) -> usize {
        match &mut self.state {
            SecureState::Open(connection) => connection.recv(now_us, out),
            SecureState::Listening(_) => 0,
        }
    }
    fn input(&mut self, now_us: u64, packet: &[u8]) {
        match &mut self.state {
            SecureState::Listening(crypto) => {
                assert!(is_initiation(packet), "listener got a non-handshake packet first");
                let incoming = Incoming::read(crypto.as_ref().expect("listening"), PROLOGUE, packet).expect("valid initiation rejected");
                let connection = incoming.accept(crypto.take().expect("listening"), self.config.clone(), &[], now_us).expect("accept");
                self.state = SecureState::Open(Box::new(connection));
            }
            SecureState::Open(connection) => match connection.on_packet(now_us, packet) {
                // 网络复制的包、重发的握手消息。
                Ok(()) | Err(PacketError::Replayed) => {}
                Err(error) => {
                    let head = &packet[..packet.len().min(48)];
                    assert!(connection.is_dead(), "valid packet rejected: {error:?}, {} bytes: {head:02x?}", packet.len());
                }
            },
        }
        if self.established_at.is_none() && self.connection().is_some_and(|connection| connection.is_established()) {
            self.established_at = Some(now_us);
        }
    }
    fn pump(&mut self, now_us: u64, sink: &mut dyn FnMut(&[u8])) {
        let SecureState::Open(connection) = &mut self.state else { return };
        while let Some(size) = connection.poll_transmit(now_us, &mut self.buffer) {
            sink(&self.buffer[..size]);
        }
        if self.check_invariants {
            connection.connection().check_invariants();
        }
    }
    fn wake_at(&self) -> Option<u64> {
        self.connection().and_then(|connection| connection.next_wake())
    }
    fn on_wake(&mut self, now_us: u64) {
        if let SecureState::Open(connection) = &mut self.state {
            connection.tick(now_us);
        }
    }
    fn buffered(&self) -> usize {
        self.connection().map_or(0, |connection| connection.connection().buffered_bytes())
    }
    fn is_dead(&self) -> bool {
        self.connection().is_some_and(|connection| connection.is_dead())
    }
    fn describe(&self) -> String {
        match self.connection() {
            Some(connection) => format!(
                "established={} dead={} {:?} {:?}",
                connection.is_established(),
                connection.is_dead(),
                connection.security_stats(),
                connection.stats()
            ),
            None => "listening".into(),
        }
    }
    fn stats(&self) -> Option<agent_net_core::Stats> {
        self.connection().map(|connection| connection.stats())
    }
    fn established_at(&self) -> Option<u64> {
        self.established_at
    }
}
