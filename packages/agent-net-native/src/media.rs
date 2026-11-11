//! Bounded, platform-neutral media crypto. File IO stays with the native host;
//! keys and incremental hashes never cross the C ABI. Wire format matches the
//! Node media-v3 adapter, including sender and recipient key capsules.
use std::collections::BTreeMap;
use agent_net_core::Crypto;
use ring::{aead, digest, hkdf};
use serde_json::{Value, json};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;
use crate::{bytes, encoded, text, crypto::NativeCrypto};

const HEADER: usize = 221;
const BLOCK: usize = 1024 * 1024;
const TAG: usize = 16;
const MAX_SIZE: u64 = 2 * 1024 * 1024 * 1024;
struct KeyLength;
impl hkdf::KeyType for KeyLength { fn len(&self) -> usize { 32 } }
fn derive(shared: &[u8; 32], salt: &[u8], binding: Option<&str>) -> Result<Zeroizing<[u8; 32]>, &'static str> {
    if shared.iter().fold(0, |a, b| a | b) == 0 { return Err("INVALID_MEDIA_PUBLIC_KEY"); }
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, salt);
    let prk = salt.extract(shared);
    let mut context = b"cindy-agent-net/media-key/3".to_vec();
    if let Some(binding) = binding { context.push(0); context.extend_from_slice(binding.as_bytes()); }
    let info = [context.as_slice()];
    let material = prk.expand(&info, KeyLength).map_err(|_| "MEDIA_KEY_FAILED")?;
    let mut key = Zeroizing::new([0; 32]);
    material.fill(key.as_mut()).map_err(|_| "MEDIA_KEY_FAILED")?;
    Ok(key)
}
fn nonce(header: &[u8], index: u32) -> aead::Nonce {
    let mut value = [0; 12]; value[..8].copy_from_slice(&header[33..41]);
    value[8..].copy_from_slice(&index.to_be_bytes());
    aead::Nonce::assume_unique_for_key(value)
}
fn aad(header: &[u8], index: u32) -> Vec<u8> { [header, &index.to_be_bytes()].concat() }
fn cipher(key: &[u8; 32]) -> aead::LessSafeKey {
    aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key).expect("AES key length"))
}
fn seal(key: &[u8; 32], header: &[u8], index: u32, aad: &[u8], plain: &[u8]) -> Result<Vec<u8>, &'static str> {
    let mut value = plain.to_vec();
    cipher(key).seal_in_place_append_tag(nonce(header, index), aead::Aad::from(aad), &mut value).map_err(|_| "MEDIA_ENCRYPT_FAILED")?;
    Ok(value)
}
fn open(key: &[u8; 32], header: &[u8], index: u32, aad: &[u8], encrypted: &[u8]) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    let mut value = Zeroizing::new(encrypted.to_vec());
    let size = cipher(key).open_in_place(nonce(header, index), aead::Aad::from(aad), &mut value).map_err(|_| "MEDIA_AUTHENTICATION_FAILED")?.len();
    value.truncate(size); Ok(value)
}
fn hash(bytes: &[u8]) -> String { digest::digest(&digest::SHA256, bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect() }
fn size_of(header: &[u8]) -> Result<u64, &'static str> {
    if header.len() != HEADER || header[0] != 3 || header[49..53] != (BLOCK as u32).to_be_bytes() { return Err("INVALID_MEDIA_HEADER"); }
    let size = u64::from_be_bytes(header[53..61].try_into().map_err(|_| "INVALID_MEDIA_HEADER")?);
    if size > MAX_SIZE { return Err("INVALID_MEDIA_SIZE"); } Ok(size)
}
struct Session {
    header: Vec<u8>, key: Zeroizing<[u8; 32]>, size: u64,
    upload: Option<(u32, digest::Context)>,
    binding: Option<String>,
}
#[derive(Default)]
pub struct MediaCrypto { sessions: BTreeMap<u32, Session>, next: u32 }
impl MediaCrypto {
    fn insert(&mut self, session: Session) -> Result<Value, &'static str> {
        if self.sessions.len() >= 16 { return Err("MEDIA_SESSION_LIMIT"); }
        let id = self.next.checked_add(1).ok_or("MEDIA_SESSION_LIMIT")?;
        self.next = id;
        let mut result = json!({"id":id,"header":encoded(&session.header),"size":session.size,
            "encryptedSize":HEADER as u64 + session.size + session.size.div_ceil(BLOCK as u64) * TAG as u64,
            "headerSha256":hash(&session.header)});
        if let Some(binding) = &session.binding { result["binding"] = json!(binding); }
        self.sessions.insert(id, session); Ok(result)
    }
    pub fn command(&mut self, crypto: &NativeCrypto, command: &Value) -> Result<Value, &'static str> {
        let op = text(command, "op")?;
        let binding = match command.get("binding") {
            None => None,
            Some(Value::String(value)) if !value.is_empty() && value.len() <= 256
                && value.bytes().all(|b| (0x21..=0x7e).contains(&b)) => Some(value.as_str()),
            _ => return Err("INVALID_MEDIA_BINDING"),
        };
        if op == "mediaCreateUpload" {
            let size = command["size"].as_u64().filter(|v| *v <= MAX_SIZE).ok_or("INVALID_MEDIA_SIZE")?;
            let recipient: [u8; 32] = bytes(&command["recipientKey"])?.try_into().map_err(|_| "INVALID_MEDIA_PUBLIC_KEY")?;
            let secret = StaticSecret::from(*Zeroizing::new(NativeCrypto::random::<32>()));
            let mut header = vec![0; HEADER]; header[0] = 3;
            header[1..33].copy_from_slice(PublicKey::from(&secret).as_bytes());
            header[33..49].copy_from_slice(&NativeCrypto::random::<16>());
            header[49..53].copy_from_slice(&(BLOCK as u32).to_be_bytes()); header[53..61].copy_from_slice(&size.to_be_bytes());
            let key = Zeroizing::new(NativeCrypto::random::<32>());
            for (index, public) in [crypto.static_public(), recipient].iter().enumerate() {
                let offset = 61 + index * 80;
                header[offset..offset+32].copy_from_slice(public);
                let shared = Zeroizing::new(secret.diffie_hellman(&PublicKey::from(*public)).to_bytes());
                let wrapping = derive(&shared, &header[33..49], binding)?;
                let aad = [aad(&header[..61], index as u32), public.to_vec()].concat();
                let capsule = seal(&wrapping, &header, index as u32, &aad, key.as_ref())?;
                header[offset+32..offset+80].copy_from_slice(&capsule);
            }
            return self.insert(Session { header, key, size, upload: Some((0, digest::Context::new(&digest::SHA256))), binding: binding.map(str::to_owned) });
        }
        if op == "mediaOpen" {
            let header = bytes(&command["header"])?; let size = size_of(&header)?;
            if hash(&header) != text(command, "headerSha256")? { return Err("INVALID_MEDIA_HEADER"); }
            let public = crypto.static_public();
            let index = (0..2).find(|i| header[61+i*80..93+i*80] == public).ok_or("MEDIA_RECIPIENT_MISMATCH")?;
            let ephemeral = header[1..33].try_into().map_err(|_| "INVALID_MEDIA_HEADER")?;
            let shared = Zeroizing::new(crypto.dh_static(&ephemeral).ok_or("INVALID_MEDIA_PUBLIC_KEY")?);
            let wrapping = derive(&shared, &header[33..49], binding)?;
            let aad = [aad(&header[..61], index as u32), public.to_vec()].concat();
            let plain = open(&wrapping, &header, index as u32, &aad, &header[93+index*80..141+index*80])?;
            let mut key = Zeroizing::new([0; 32]); key.copy_from_slice(&plain);
            return self.insert(Session { header, key, size, upload: None, binding: binding.map(str::to_owned) });
        }
        let id = command["id"].as_u64().and_then(|v| u32::try_from(v).ok()).ok_or("INVALID_MEDIA_SESSION")?;
        if op == "mediaClose" { self.sessions.remove(&id); return Ok(Value::Null); }
        let session = self.sessions.get_mut(&id).ok_or("INVALID_MEDIA_SESSION")?;
        match op {
            "mediaEncrypt" => {
                let plain = Zeroizing::new(bytes(&command["data"])?);
                let (index, digest) = session.upload.as_mut().ok_or("INVALID_MEDIA_SESSION")?;
                let offset = *index as u64 * BLOCK as u64;
                if offset >= session.size || plain.len() as u64 != (session.size-offset).min(BLOCK as u64) { return Err("INVALID_MEDIA_CHUNK"); }
                let encrypted = seal(&session.key, &session.header, *index, &aad(&session.header, *index), &plain)?;
                digest.update(&plain); *index += 1; Ok(json!(encoded(&encrypted)))
            },
            "mediaFinish" => {
                let (index, digest) = session.upload.as_ref().ok_or("INVALID_MEDIA_SESSION")?;
                if *index as u64 != session.size.div_ceil(BLOCK as u64) { return Err("MEDIA_INCOMPLETE"); }
                let hash: String = digest.clone().finish().as_ref().iter().map(|b| format!("{b:02x}")).collect();
                self.sessions.remove(&id); Ok(json!({"sha256":hash}))
            },
            "mediaDecrypt" => {
                if session.upload.is_some() { return Err("INVALID_MEDIA_SESSION"); }
                let index = command["index"].as_u64().and_then(|v| u32::try_from(v).ok()).ok_or("INVALID_MEDIA_CHUNK")?;
                let offset = index as u64 * BLOCK as u64;
                let encrypted = bytes(&command["data"])?;
                if offset >= session.size || encrypted.len() as u64 != (session.size-offset).min(BLOCK as u64) + TAG as u64 { return Err("INVALID_MEDIA_CHUNK"); }
                let plain = open(&session.key, &session.header, index, &aad(&session.header, index), &encrypted)?;
                Ok(json!(encoded(&plain)))
            },
            _ => Err("INVALID_MEDIA_COMMAND"),
        }
    }
}
