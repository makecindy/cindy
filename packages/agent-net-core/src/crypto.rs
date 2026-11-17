//! 加密算法接口。
//!
//! 核心只实现 Noise 握手流程和逐包保护，算法本身由调用方提供：产品里用系统自带的实现
//! （Node `crypto`、iOS CryptoKit、Android 系统库、硬件厂商 SDK），核心不引入任何依赖，也不接触长期私钥。
//!
//! 密钥交换固定为 X25519。认证加密和哈希由实现选择，名字写进 Noise 协议名，两端不一致时握手失败。

/// X25519 公钥和共享密钥的长度。
pub const PUBLIC_KEY_LEN: usize = 32;
/// 哈希输出、对称密钥的长度。
pub const HASH_LEN: usize = 32;
/// 认证标签的长度。
pub const TAG_LEN: usize = 16;

/// 加密算法的提供方。所有方法都不能失败，除了 `dh` 遇到无效公钥和 `open` 校验不通过。
///
/// 一条加密连接独占一个实现。多条连接共用同一个长期密钥时，给每条连接一个轻量的句柄，
/// 例如为 `&T` 或 `Arc<T>` 使用这里提供的转发实现。
pub trait Crypto {
    /// 一次性私钥。核心在最后一次用到它之后立即丢弃，实现负责在丢弃时清除内存。
    type Ephemeral;
    /// 导入后的对称密钥。实现可以在里面缓存密钥扩展的结果，每个包都会用到。
    type Key;

    /// 认证加密算法在 Noise 协议名里的写法，例如 `"AESGCM"`、`"ChaChaPoly"`。
    const CIPHER: &'static str;
    /// 哈希算法在 Noise 协议名里的写法，输出必须是 32 字节，例如 `"SHA256"`、`"BLAKE2s"`。
    const HASH: &'static str;

    /// 本机长期公钥。
    fn static_public(&self) -> [u8; PUBLIC_KEY_LEN];
    /// 生成一次性密钥对，返回私钥和公钥。
    fn generate_ephemeral(&self) -> (Self::Ephemeral, [u8; PUBLIC_KEY_LEN]);
    /// 本机长期私钥和对端公钥做 X25519。公钥无效时可以返回 `None`；结果全零由核心拒绝。
    fn dh_static(&self, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]>;
    /// 一次性私钥和对端公钥做 X25519。
    fn dh_ephemeral(&self, secret: &Self::Ephemeral, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]>;
    /// `parts` 依次拼接以后的哈希。
    fn hash(&self, parts: &[&[u8]]) -> [u8; HASH_LEN];
    /// 以 `key` 为密钥、`parts` 依次拼接为消息的 HMAC。
    fn hmac(&self, key: &[u8; HASH_LEN], parts: &[&[u8]]) -> [u8; HASH_LEN];
    /// 导入对称密钥。
    fn key(&self, bytes: &[u8; HASH_LEN]) -> Self::Key;
    /// 原地加密 `buffer`，返回认证标签。nonce 按 Noise 规范编码成 12 字节：
    /// AESGCM 是 4 个零字节加 8 字节大端，ChaChaPoly 是 4 个零字节加 8 字节小端。
    fn seal(&self, key: &Self::Key, nonce: u64, ad: &[u8], buffer: &mut [u8]) -> [u8; TAG_LEN];
    /// 原地解密并校验认证标签。校验不通过返回 `false`，此时 `buffer` 的内容不可用。
    fn open(&self, key: &Self::Key, nonce: u64, ad: &[u8], buffer: &mut [u8], tag: &[u8; TAG_LEN]) -> bool;
}

macro_rules! forward_crypto {
    ($($target:ty),*) => {$(
        impl<T: Crypto + ?Sized> Crypto for $target {
            type Ephemeral = T::Ephemeral;
            type Key = T::Key;
            const CIPHER: &'static str = T::CIPHER;
            const HASH: &'static str = T::HASH;

            fn static_public(&self) -> [u8; PUBLIC_KEY_LEN] {
                (**self).static_public()
            }
            fn generate_ephemeral(&self) -> (Self::Ephemeral, [u8; PUBLIC_KEY_LEN]) {
                (**self).generate_ephemeral()
            }
            fn dh_static(&self, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
                (**self).dh_static(peer)
            }
            fn dh_ephemeral(&self, secret: &Self::Ephemeral, peer: &[u8; PUBLIC_KEY_LEN]) -> Option<[u8; PUBLIC_KEY_LEN]> {
                (**self).dh_ephemeral(secret, peer)
            }
            fn hash(&self, parts: &[&[u8]]) -> [u8; HASH_LEN] {
                (**self).hash(parts)
            }
            fn hmac(&self, key: &[u8; HASH_LEN], parts: &[&[u8]]) -> [u8; HASH_LEN] {
                (**self).hmac(key, parts)
            }
            fn key(&self, bytes: &[u8; HASH_LEN]) -> Self::Key {
                (**self).key(bytes)
            }
            fn seal(&self, key: &Self::Key, nonce: u64, ad: &[u8], buffer: &mut [u8]) -> [u8; TAG_LEN] {
                (**self).seal(key, nonce, ad, buffer)
            }
            fn open(&self, key: &Self::Key, nonce: u64, ad: &[u8], buffer: &mut [u8], tag: &[u8; TAG_LEN]) -> bool {
                (**self).open(key, nonce, ad, buffer, tag)
            }
        }
    )*};
}

forward_crypto!(&T, alloc::sync::Arc<T>, alloc::rc::Rc<T>);
