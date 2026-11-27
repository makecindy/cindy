//! Background notification decryption has no access to a transport/signing key or endpoint.
use crate::{bytes, encoded, text, crypto::NativeCrypto};
use ring::{aead, hkdf};
use serde_json::{Value, json};
use x25519_dalek::{StaticSecret, PublicKey};
use zeroize::Zeroizing;

struct KeyLength;
impl hkdf::KeyType for KeyLength { fn len(&self) -> usize { 32 } }
pub(crate) fn seal(crypto: &NativeCrypto, input: &Value) -> Result<Value, &'static str> {
    let signed = text(input, "text")?;
    if signed.len() + 64 > 1889 { return Err("NOTIFICATION_TOO_LARGE"); }
    let peer: [u8; 32] = bytes(&input["recipientKey"])?.try_into().map_err(|_| "INVALID_NOTIFICATION_KEY")?;
    let ephemeral = StaticSecret::from(NativeCrypto::random::<32>());
    let shared = ephemeral.diffie_hellman(&PublicKey::from(peer));
    if !shared.was_contributory() { return Err("INVALID_NOTIFICATION_KEY"); }
    let nonce = NativeCrypto::random::<12>();
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &nonce);
    let prk = salt.extract(shared.as_bytes());
    let labels = [b"cindy-agent-net/notification/2".as_slice()];
    let material = prk.expand(&labels, KeyLength).map_err(|_| "INVALID_NOTIFICATION")?;
    let mut key = Zeroizing::new([0; 32]);
    material.fill(key.as_mut()).map_err(|_| "INVALID_NOTIFICATION")?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.as_ref()).map_err(|_| "INVALID_NOTIFICATION")?);
    let mut header = vec![4];
    header.extend_from_slice(PublicKey::from(&ephemeral).as_bytes()); header.extend_from_slice(&nonce);
    let mut clear = Zeroizing::new(signed.as_bytes().to_vec());
    clear.extend_from_slice(&crypto.sign(signed.as_bytes()));
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(&header), &mut *clear)
        .map_err(|_| "INVALID_NOTIFICATION")?;
    header.extend_from_slice(&clear);
    Ok(json!(encoded(&header)))
}
pub(crate) fn open(input: &Value) -> Result<Value, &'static str> {
    let config = &input["config"];
    let now = input["now"].as_u64().ok_or("INVALID_NOTIFICATION_TIME")?;
    let expiry = config["expiresAt"].as_u64().ok_or("INVALID_NOTIFICATION_TRUST")?;
    if expiry <= now || expiry.saturating_sub(now) > 14 * 24 * 60 * 60_000 { return Err("NOTIFICATION_TRUST_EXPIRED"); }
    if !config["version"].is_null() && !matches!(config["version"].as_u64(), Some(2 | 3)) { return Err("INVALID_NOTIFICATION_TRUST"); }
    let seed = Zeroizing::new(bytes(&config["secret"])?);
    let secret = StaticSecret::from(<[u8; 32]>::try_from(seed.as_slice()).map_err(|_| "INVALID_NOTIFICATION_KEY")?);
    let packet = bytes(&input["envelope"])?;
    if packet.len() < 61 + 64 || packet.len() > 1_950 || packet[0] != 4 { return Err("INVALID_NOTIFICATION"); }
    let public: [u8; 32] = packet[1..33].try_into().map_err(|_| "INVALID_NOTIFICATION")?;
    let shared = secret.diffie_hellman(&PublicKey::from(public));
    if !shared.was_contributory() { return Err("INVALID_NOTIFICATION_KEY"); }
    let salt = hkdf::Salt::new(hkdf::HKDF_SHA256, &packet[33..45]);
    let prk = salt.extract(shared.as_bytes());
    let labels = [b"cindy-agent-net/notification/2".as_slice()];
    let material = prk.expand(&labels, KeyLength).map_err(|_| "INVALID_NOTIFICATION")?;
    let mut key = Zeroizing::new([0; 32]);
    material.fill(key.as_mut()).map_err(|_| "INVALID_NOTIFICATION")?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, key.as_ref()).map_err(|_| "INVALID_NOTIFICATION")?);
    let nonce = aead::Nonce::try_assume_unique_for_key(&packet[33..45]).map_err(|_| "INVALID_NOTIFICATION")?;
    let mut clear = Zeroizing::new(packet[45..].to_vec());
    let clear = key.open_in_place(nonce, aead::Aad::from(&packet[..45]), &mut clear).map_err(|_| "INVALID_NOTIFICATION")?;
    if clear.len() < 64 { return Err("INVALID_NOTIFICATION"); }
    let (signed, signature) = clear.split_at(clear.len() - 64);
    let value: Value = serde_json::from_slice(signed).map_err(|_| "INVALID_NOTIFICATION")?;
    let a = value.as_array().filter(|a| a.len() == 9).ok_or("INVALID_NOTIFICATION")?;
    let from = a[3].as_str().ok_or("INVALID_NOTIFICATION")?;
    let issued = a[6].as_u64().ok_or("INVALID_NOTIFICATION")?;
    let until = a[7].as_u64().ok_or("INVALID_NOTIFICATION")?;
    if a[0] != "cindy-agent-net/notification/2" || a[1] != 2 || a[2] != config["networkId"] || a[4] != config["deviceId"]
        || a[5].as_str().is_none_or(|s| s.is_empty() || s.len() > 64)
        || issued > now.saturating_add(30_000) || until <= now || until <= issued || until - issued > 5 * 60_000
    { return Err("INVALID_NOTIFICATION"); }
    if config["version"] == 3 && config["peerExpiresAt"][from].as_u64().is_none_or(|until| until <= now) {
        return Err("NOTIFICATION_SENDER_EXPIRED");
    }
    let signing_key = bytes(&config["peers"][from])?;
    if signing_key.len() != 32 || !NativeCrypto::verify(&signing_key, signed, signature) { return Err("UNTRUSTED_NOTIFICATION_SENDER"); }
    let payload = &a[8];
    if !matches!(text(payload, "category")?, "session-done" | "session-error" | "session-needs-reply")
        || text(payload, "title")?.len() > 512 || text(payload, "deepLink")?.len() > 512
        || !(text(payload, "deepLink")?.starts_with("cindy://") || text(payload, "deepLink")?.starts_with("/"))
    { return Err("INVALID_NOTIFICATION_PAYLOAD"); }
    // ASCII/base64 only across JNI; modified UTF-8 must never corrupt arbitrary notification text.
    Ok(json!({"id":a[5], "expiresAt":until, "payload":encoded(payload.to_string().as_bytes())}))
}
