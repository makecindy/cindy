//! Noise 握手，IK 模式，按 Noise 规范第 34 版实现：
//!
//! ```text
//! IK:
//!   <- s
//!   ...
//!   -> e, es, s, ss
//!   <- e, ee, se
//! ```
//!
//! 发起方事先知道响应方的长期公钥，一个来回完成握手。发起方的身份加密传输，被动监听看不到。
//! 传输密钥混入了两端一次性密钥的 DH（`ee`），长期私钥日后泄露也解不开录下的通信。
//! 第一条消息附带的数据只受响应方长期密钥保护：响应方的长期私钥泄露后可以解开，也能被重放，不要放秘密。
//!
//! 这是底层模块，一般用 [`crate::SecureConnection`]。直接使用时要自己处理丢包、重传和重放。

use alloc::vec::Vec;

use crate::crypto::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};

/// 握手失败的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// 消息长度不对，或者在错误的阶段调用。
    Malformed,
    /// 认证失败：消息被篡改，或者对方不持有对应的私钥。
    Decrypt,
    /// 对端公钥无效，DH 结果全零。
    InvalidKey,
    /// 附带数据放不进一个包。
    PayloadTooLarge,
}

/// 32 字节的秘密值，丢弃前清零。不用 unsafe 做不到保证，`black_box` 让编译器不能把清零当成无用写入删掉。
#[derive(Clone)]
struct Secret([u8; HASH_LEN]);

impl Drop for Secret {
    fn drop(&mut self) {
        self.0 = [0; HASH_LEN];
        core::hint::black_box(&mut self.0);
    }
}

fn wipe(bytes: &mut [u8; HASH_LEN]) {
    *bytes = [0; HASH_LEN];
    core::hint::black_box(bytes);
}

/// Noise 的 HKDF，输出两个值。
fn hkdf<C: Crypto>(crypto: &C, chaining_key: &[u8; HASH_LEN], input: &[u8]) -> (Secret, Secret) {
    let mut temp = crypto.hmac(chaining_key, &[input]);
    let first = crypto.hmac(&temp, &[&[1]]);
    let second = crypto.hmac(&temp, &[&first, &[2]]);
    wipe(&mut temp);
    (Secret(first), Secret(second))
}

/// 对称状态：链式密钥、握手哈希和当前的握手密钥。密钥只存字节，用到时才导入，所以失败的尝试可以整体丢弃。
#[derive(Clone)]
struct SymmetricState {
    chaining_key: Secret,
    hash: [u8; HASH_LEN],
    key: Option<Secret>,
    nonce: u64,
}

impl SymmetricState {
    fn new<C: Crypto>(crypto: &C) -> Self {
        let mut name = Vec::with_capacity(48);
        name.extend_from_slice(b"Noise_IK_25519_");
        name.extend_from_slice(C::CIPHER.as_bytes());
        name.push(b'_');
        name.extend_from_slice(C::HASH.as_bytes());
        let mut hash = [0; HASH_LEN];
        if name.len() <= HASH_LEN {
            hash[..name.len()].copy_from_slice(&name);
        } else {
            hash = crypto.hash(&[&name]);
        }
        Self { chaining_key: Secret(hash), hash, key: None, nonce: 0 }
    }

    fn mix_hash<C: Crypto>(&mut self, crypto: &C, data: &[u8]) {
        self.hash = crypto.hash(&[&self.hash, data]);
    }

    fn mix_key<C: Crypto>(&mut self, crypto: &C, input: &[u8]) {
        let (chaining_key, key) = hkdf(crypto, &self.chaining_key.0, input);
        self.chaining_key = chaining_key;
        self.key = Some(key);
        self.nonce = 0;
    }

    /// 握手里的每个密钥只加密一两次，所以每次现导入。
    fn encrypt_and_hash<C: Crypto>(&mut self, crypto: &C, plaintext: &[u8], out: &mut Vec<u8>) {
        let start = out.len();
        out.extend_from_slice(plaintext);
        if let Some(key) = &self.key {
            let key = crypto.key(&key.0);
            let tag = crypto.seal(&key, self.nonce, &self.hash, &mut out[start..]);
            out.extend_from_slice(&tag);
            self.nonce += 1;
        }
        let ciphertext = &out[start..];
        self.hash = crypto.hash(&[&self.hash, ciphertext]);
    }

    fn decrypt_and_hash<C: Crypto>(&mut self, crypto: &C, ciphertext: &[u8], out: &mut Vec<u8>) -> Result<(), HandshakeError> {
        let Some(key) = &self.key else {
            out.extend_from_slice(ciphertext);
            self.mix_hash(crypto, ciphertext);
            return Ok(());
        };
        let body = ciphertext.len().checked_sub(TAG_LEN).ok_or(HandshakeError::Malformed)?;
        let tag: [u8; TAG_LEN] = ciphertext[body..].try_into().map_err(|_| HandshakeError::Malformed)?;
        let start = out.len();
        out.extend_from_slice(&ciphertext[..body]);
        let key = crypto.key(&key.0);
        if !crypto.open(&key, self.nonce, &self.hash, &mut out[start..], &tag) {
            out.truncate(start);
            return Err(HandshakeError::Decrypt);
        }
        self.nonce += 1;
        self.mix_hash(crypto, ciphertext);
        Ok(())
    }

    fn split<C: Crypto>(&self, crypto: &C) -> (C::Key, C::Key) {
        let (first, second) = hkdf(crypto, &self.chaining_key.0, &[]);
        (crypto.key(&first.0), crypto.key(&second.0))
    }
}

fn checked_dh(result: Option<[u8; PUBLIC_KEY_LEN]>) -> Result<Secret, HandshakeError> {
    match result {
        Some(shared) if shared != [0; PUBLIC_KEY_LEN] => Ok(Secret(shared)),
        Some(mut shared) => {
            wipe(&mut shared);
            Err(HandshakeError::InvalidKey)
        }
        None => Err(HandshakeError::InvalidKey),
    }
}

fn take_key(message: &[u8], at: usize) -> Result<[u8; PUBLIC_KEY_LEN], HandshakeError> {
    message.get(at..at + PUBLIC_KEY_LEN).and_then(|bytes| bytes.try_into().ok()).ok_or(HandshakeError::Malformed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// 发起方还没写第一条消息，或者响应方还没读。
    Start,
    /// 第一条消息已经处理，等第二条。
    SentFirst,
    Done,
}

/// 第一条消息的固定部分：一次性公钥、加密的长期公钥。后面跟加密的附带数据。
pub const FIRST_MESSAGE_FIXED_LEN: usize = PUBLIC_KEY_LEN + PUBLIC_KEY_LEN + TAG_LEN + TAG_LEN;
/// 第二条消息的固定部分：一次性公钥。后面跟加密的附带数据。
pub const SECOND_MESSAGE_FIXED_LEN: usize = PUBLIC_KEY_LEN + TAG_LEN;

/// 握手完成后的传输密钥。每个方向一个，nonce 由调用方保证同一个密钥下永不重复。
pub struct TransportKeys<C: Crypto> {
    pub send: C::Key,
    pub recv: C::Key,
    /// 握手哈希，两端相同，可以用来把上层的认证绑定到这次握手。
    pub handshake_hash: [u8; HASH_LEN],
}

/// 一次 IK 握手。
pub struct Handshake<C: Crypto> {
    symmetric: SymmetricState,
    initiator: bool,
    stage: Stage,
    ephemeral: Option<C::Ephemeral>,
    remote_ephemeral: [u8; PUBLIC_KEY_LEN],
    remote_static: [u8; PUBLIC_KEY_LEN],
}

impl<C: Crypto> Handshake<C> {
    /// 发起方。`remote_static` 是事先知道的响应方长期公钥，`prologue` 两端必须完全一致。
    pub fn initiator(crypto: &C, prologue: &[u8], remote_static: &[u8; PUBLIC_KEY_LEN]) -> Self {
        let mut symmetric = SymmetricState::new(crypto);
        symmetric.mix_hash(crypto, prologue);
        symmetric.mix_hash(crypto, remote_static);
        Self {
            symmetric,
            initiator: true,
            stage: Stage::Start,
            ephemeral: None,
            remote_ephemeral: [0; PUBLIC_KEY_LEN],
            remote_static: *remote_static,
        }
    }

    /// 响应方。
    pub fn responder(crypto: &C, prologue: &[u8]) -> Self {
        let mut symmetric = SymmetricState::new(crypto);
        symmetric.mix_hash(crypto, prologue);
        symmetric.mix_hash(crypto, &crypto.static_public());
        Self {
            symmetric,
            initiator: false,
            stage: Stage::Start,
            ephemeral: None,
            remote_ephemeral: [0; PUBLIC_KEY_LEN],
            remote_static: [0; PUBLIC_KEY_LEN],
        }
    }

    /// 对端长期公钥。响应方读完第一条消息后才有。
    pub fn remote_static(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.remote_static
    }

    /// 对端一次性公钥。
    pub fn remote_ephemeral(&self) -> &[u8; PUBLIC_KEY_LEN] {
        &self.remote_ephemeral
    }

    /// 发起方写第一条消息：`e, es, s, ss` 和加密的附带数据，追加到 `out`。
    pub fn write_first(&mut self, crypto: &C, payload: &[u8], out: &mut Vec<u8>) -> Result<(), HandshakeError> {
        if !self.initiator || self.stage != Stage::Start {
            return Err(HandshakeError::Malformed);
        }
        let mut state = self.symmetric.clone();
        let (ephemeral, public) = crypto.generate_ephemeral();
        let start = out.len();
        out.extend_from_slice(&public);
        state.mix_hash(crypto, &public);
        let result = (|| -> Result<(), HandshakeError> {
            let es = checked_dh(crypto.dh_ephemeral(&ephemeral, &self.remote_static))?;
            state.mix_key(crypto, &es.0);
            state.encrypt_and_hash(crypto, &crypto.static_public(), out);
            let ss = checked_dh(crypto.dh_static(&self.remote_static))?;
            state.mix_key(crypto, &ss.0);
            state.encrypt_and_hash(crypto, payload, out);
            Ok(())
        })();
        if let Err(error) = result {
            out.truncate(start);
            return Err(error);
        }
        self.symmetric = state;
        self.ephemeral = Some(ephemeral);
        self.stage = Stage::SentFirst;
        Ok(())
    }

    /// 响应方读第一条消息，解出的附带数据追加到 `payload`。失败时状态不变。
    pub fn read_first(&mut self, crypto: &C, message: &[u8], payload: &mut Vec<u8>) -> Result<(), HandshakeError> {
        if self.initiator || self.stage != Stage::Start || message.len() < FIRST_MESSAGE_FIXED_LEN {
            return Err(HandshakeError::Malformed);
        }
        let mut state = self.symmetric.clone();
        let remote_ephemeral = take_key(message, 0)?;
        state.mix_hash(crypto, &remote_ephemeral);
        let es = checked_dh(crypto.dh_static(&remote_ephemeral))?;
        state.mix_key(crypto, &es.0);
        let mut remote_static = Vec::with_capacity(PUBLIC_KEY_LEN);
        state.decrypt_and_hash(crypto, &message[PUBLIC_KEY_LEN..PUBLIC_KEY_LEN * 2 + TAG_LEN], &mut remote_static)?;
        let remote_static: [u8; PUBLIC_KEY_LEN] = remote_static.try_into().map_err(|_| HandshakeError::Malformed)?;
        let ss = checked_dh(crypto.dh_static(&remote_static))?;
        state.mix_key(crypto, &ss.0);
        let start = payload.len();
        if let Err(error) = state.decrypt_and_hash(crypto, &message[PUBLIC_KEY_LEN * 2 + TAG_LEN..], payload) {
            payload.truncate(start);
            return Err(error);
        }
        self.symmetric = state;
        self.remote_ephemeral = remote_ephemeral;
        self.remote_static = remote_static;
        self.stage = Stage::SentFirst;
        Ok(())
    }

    /// 响应方写第二条消息：`e, ee, se` 和加密的附带数据。之后就可以 `finish`。
    pub fn write_second(&mut self, crypto: &C, payload: &[u8], out: &mut Vec<u8>) -> Result<(), HandshakeError> {
        if self.initiator || self.stage != Stage::SentFirst {
            return Err(HandshakeError::Malformed);
        }
        let mut state = self.symmetric.clone();
        let (ephemeral, public) = crypto.generate_ephemeral();
        let start = out.len();
        out.extend_from_slice(&public);
        state.mix_hash(crypto, &public);
        let result = (|| -> Result<(), HandshakeError> {
            let ee = checked_dh(crypto.dh_ephemeral(&ephemeral, &self.remote_ephemeral))?;
            state.mix_key(crypto, &ee.0);
            let se = checked_dh(crypto.dh_ephemeral(&ephemeral, &self.remote_static))?;
            state.mix_key(crypto, &se.0);
            Ok(())
        })();
        // 响应方的一次性私钥到这里就用完了。
        drop(ephemeral);
        if let Err(error) = result {
            out.truncate(start);
            return Err(error);
        }
        state.encrypt_and_hash(crypto, payload, out);
        self.symmetric = state;
        self.stage = Stage::Done;
        Ok(())
    }

    /// 发起方读第二条消息。失败时状态不变，可以继续等真正的回复。
    pub fn read_second(&mut self, crypto: &C, message: &[u8], payload: &mut Vec<u8>) -> Result<(), HandshakeError> {
        if !self.initiator || self.stage != Stage::SentFirst || message.len() < SECOND_MESSAGE_FIXED_LEN {
            return Err(HandshakeError::Malformed);
        }
        let ephemeral = self.ephemeral.as_ref().ok_or(HandshakeError::Malformed)?;
        let mut state = self.symmetric.clone();
        let remote_ephemeral = take_key(message, 0)?;
        state.mix_hash(crypto, &remote_ephemeral);
        let ee = checked_dh(crypto.dh_ephemeral(ephemeral, &remote_ephemeral))?;
        state.mix_key(crypto, &ee.0);
        let se = checked_dh(crypto.dh_static(&remote_ephemeral))?;
        state.mix_key(crypto, &se.0);
        let start = payload.len();
        if let Err(error) = state.decrypt_and_hash(crypto, &message[PUBLIC_KEY_LEN..], payload) {
            payload.truncate(start);
            return Err(error);
        }
        self.symmetric = state;
        self.remote_ephemeral = remote_ephemeral;
        // 发起方的一次性私钥到这里就用完了。
        self.ephemeral = None;
        self.stage = Stage::Done;
        Ok(())
    }

    /// 握手完成，导出传输密钥。没完成时返回 `None`。
    pub fn finish(self, crypto: &C) -> Option<TransportKeys<C>> {
        if self.stage != Stage::Done {
            return None;
        }
        let (first, second) = self.symmetric.split(crypto);
        let (send, recv) = if self.initiator { (first, second) } else { (second, first) };
        Some(TransportKeys { send, recv, handshake_hash: self.symmetric.hash })
    }
}
