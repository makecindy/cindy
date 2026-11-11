//! Platform host cryptography. These dependencies never enter agent-net-core.
use std::sync::Arc;
use agent_net_core::{Crypto, HASH_LEN, PUBLIC_KEY_LEN, TAG_LEN};
use ring::{aead, digest, hkdf, hmac, rand::{SecureRandom, SystemRandom}, signature::{Ed25519KeyPair, KeyPair}};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct NativeCrypto {
    transport: Arc<StaticSecret>,
    signing: Arc<Ed25519KeyPair>,
    notification: Arc<StaticSecret>,
}

struct KeyLength;
impl hkdf::KeyType for KeyLength { fn len(&self) -> usize { 32 } }

impl NativeCrypto {
    pub fn from_seed(context: &str, seed: &[u8; 32], legacy_signing: bool) -> Result<Self, &'static str> {
        let derive = |label: &[u8]| -> Result<Zeroizing<[u8; 32]>, &'static str> {
            let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, context.as_bytes());
            let prk = salt.extract(seed);
            let labels = [label];
            let material = prk.expand(&labels, KeyLength).map_err(|_| "KEY_DERIVATION_FAILED")?;
            let mut bytes = Zeroizing::new([0; 32]);
            material.fill(bytes.as_mut()).map_err(|_| "KEY_DERIVATION_FAILED")?;
            Ok(bytes)
        };
        let signing_seed = if legacy_signing { Zeroizing::new(*seed) }
            else { derive(b"cindy-agent-net/device-signing/2")? };
        let transport_seed = derive(b"cindy-agent-net/device-transport/2")?;
        let notification_seed = derive(b"cindy-agent-net/device-notification/2")?;
        let signing = Ed25519KeyPair::from_seed_unchecked(signing_seed.as_ref()).map_err(|_| "INVALID_SIGNING_KEY")?;
        Ok(Self { transport: Arc::new(StaticSecret::from(*transport_seed)), signing: Arc::new(signing),
            notification: Arc::new(StaticSecret::from(*notification_seed)) })
    }

    pub fn signing_public(&self) -> &[u8] { self.signing.public_key().as_ref() }
    pub fn notification_secret(&self) -> [u8; 32] { self.notification.to_bytes() }
    pub fn notification_public(&self) -> [u8; 32] { PublicKey::from(&*self.notification).to_bytes() }
    pub fn sign(&self, bytes: &[u8]) -> Vec<u8> { self.signing.sign(bytes).as_ref().to_vec() }
    pub fn random<const N: usize>() -> [u8; N] {
        let mut bytes = [0; N];
        SystemRandom::new().fill(&mut bytes).expect("system random unavailable");
        bytes
    }
    pub fn verify(public: &[u8], text: &[u8], signature: &[u8]) -> bool {
        ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public).verify(text, signature).is_ok()
    }
}

fn nonce(value: u64) -> aead::Nonce {
    let mut bytes = [0; 12];
    bytes[4..].copy_from_slice(&value.to_be_bytes());
    aead::Nonce::assume_unique_for_key(bytes)
}

impl Crypto for NativeCrypto {
    type Ephemeral = StaticSecret;
    type Key = aead::LessSafeKey;
    const CIPHER: &'static str = "AESGCM";
    const HASH: &'static str = "SHA256";
    fn static_public(&self) -> [u8; PUBLIC_KEY_LEN] { PublicKey::from(&*self.transport).to_bytes() }
    fn generate_ephemeral(&self) -> (Self::Ephemeral, [u8; PUBLIC_KEY_LEN]) {
        let bytes = Zeroizing::new(Self::random::<32>());
        let secret = StaticSecret::from(*bytes);
        let public = PublicKey::from(&secret).to_bytes();
        (secret, public)
    }
    fn dh_static(&self, peer: &[u8; 32]) -> Option<[u8; 32]> {
        Some(self.transport.diffie_hellman(&PublicKey::from(*peer)).to_bytes())
    }
    fn dh_ephemeral(&self, secret: &StaticSecret, peer: &[u8; 32]) -> Option<[u8; 32]> {
        Some(secret.diffie_hellman(&PublicKey::from(*peer)).to_bytes())
    }
    fn hash(&self, parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let mut hash = digest::Context::new(&digest::SHA256);
        for part in parts { hash.update(part); }
        hash.finish().as_ref().try_into().expect("SHA256 length")
    }
    fn hmac(&self, key: &[u8; HASH_LEN], parts: &[&[u8]]) -> [u8; HASH_LEN] {
        let mut mac = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, key));
        for part in parts { mac.update(part); }
        mac.sign().as_ref().try_into().expect("HMAC length")
    }
    fn key(&self, bytes: &[u8; HASH_LEN]) -> Self::Key {
        aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, bytes).expect("AES key length"))
    }
    fn seal(&self, key: &Self::Key, counter: u64, ad: &[u8], buffer: &mut [u8]) -> [u8; TAG_LEN] {
        key.seal_in_place_separate_tag(nonce(counter), aead::Aad::from(ad), buffer)
            .expect("AES-GCM input length").as_ref().try_into().expect("tag length")
    }
    fn open(&self, key: &Self::Key, counter: u64, ad: &[u8], buffer: &mut [u8], tag: &[u8; TAG_LEN]) -> bool {
        key.open_in_place_separate_tag(nonce(counter), aead::Aad::from(ad),
            aead::Tag::try_from(tag.as_slice()).expect("tag length"), buffer, 0..).is_ok()
    }
}
