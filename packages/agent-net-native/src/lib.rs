//! Serialized C ABI for iOS and Android. The caller owns a handle and must
//! serialize its calls; no process-global endpoint, key, clock or IO buffer.
mod crypto;
mod engine;
mod media;
mod media_http;
mod notification;
mod udp_paths;
mod wait;

use std::{ffi::{c_char, CString}, panic::{AssertUnwindSafe, catch_unwind}};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use zeroize::{Zeroizing, Zeroize};
use crypto::NativeCrypto;
pub use engine::{NativeEngine, Waiter};

// One authenticated 1 MiB media block, base64 encoded, plus its JSON envelope.
const MAX_COMMAND: usize = 2 * 1024 * 1024;

pub(crate) fn bytes(value: &Value) -> Result<Vec<u8>, &'static str> {
    let text = value.as_str().ok_or("INVALID_BYTES")?;
    let result = URL_SAFE_NO_PAD.decode(text).map_err(|_| "INVALID_BYTES")?;
    if URL_SAFE_NO_PAD.encode(&result) != text { return Err("INVALID_BYTES"); }
    Ok(result)
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    value.get(key).and_then(Value::as_str).ok_or("INVALID_ARGUMENT")
}
pub(crate) fn encoded(bytes: &[u8]) -> String { URL_SAFE_NO_PAD.encode(bytes) }

/// `seed` and `context` derive the identity's keys (`identityFromSeed`); `keys` gives them as they are, for identities stored
/// that way (the Desktop's): `transport`, the X25519 secret, and `signing`, the Ed25519 seed, both base64url.
pub fn create(options: &Value) -> Result<NativeEngine, &'static str> {
    let stored = options.get("keys").filter(|keys| !keys.is_null());
    let key = |value: &Value, error: &'static str| -> Result<Zeroizing<[u8; 32]>, &'static str> {
        let bytes = Zeroizing::new(bytes(value)?);
        Ok(Zeroizing::new(bytes.as_slice().try_into().map_err(|_| error)?))
    };
    let crypto = match stored {
        Some(keys) => NativeCrypto::from_keys(&*key(&keys["transport"], "INVALID_TRANSPORT_KEY")?, &*key(&keys["signing"], "INVALID_SIGNING_KEY")?)?,
        None => {
            let seed = key(&options["seed"], "INVALID_IDENTITY_SEED")?;
            let context = text(options, "context")?;
            if context.is_empty() || context.len() > 256 { return Err("INVALID_IDENTITY_CONTEXT"); }
            NativeCrypto::from_seed(context, &*seed, options["legacySigning"] == true)?
        },
    };
    let device_id = text(options, "deviceId")?;
    if device_id.is_empty() || device_id.len() > 128
        || !device_id.as_bytes()[0].is_ascii_alphanumeric()
        || !device_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
    { return Err("INVALID_DEVICE_ID"); }
    NativeEngine::new(crypto, device_id.to_owned(), options["udp"].as_bool().unwrap_or(true), options["enhancedTransport"].as_bool().unwrap_or(false))
}

/// SAFETY: input must address length readable bytes. Handle calls are serialized
/// by the native module's dedicated queue. No handle may outlive destroy().
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_create(input: *const u8, length: usize) -> *mut NativeEngine {
    if input.is_null() || length > MAX_COMMAND { return std::ptr::null_mut(); }
    catch_unwind(AssertUnwindSafe(|| {
        let input = unsafe { std::slice::from_raw_parts(input, length) };
        let options = serde_json::from_slice(input).ok()?;
        create(&options).ok().map(|value| Box::into_raw(Box::new(value)))
    })).ok().flatten().unwrap_or(std::ptr::null_mut())
}

/// Returns an owned UTF-8 JSON C string, released exactly once with free_string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_command(handle: *mut NativeEngine, input: *const u8, length: usize) -> *mut c_char {
    let result = if handle.is_null() || input.is_null() || length > MAX_COMMAND {
        Err("INVALID_NATIVE_COMMAND")
    } else {
        match catch_unwind(AssertUnwindSafe(|| {
            let input = unsafe { std::slice::from_raw_parts(input, length) };
            let command = serde_json::from_slice(input).map_err(|_| "INVALID_NATIVE_COMMAND")?;
            unsafe { &mut *handle }.command(&command)
        })) {
            Ok(result) => result,
            Err(_) => { unsafe { &mut *handle }.poison(); Err("NATIVE_ENGINE_FAILURE") },
        }
    };
    let value = match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => json!({"ok":false,"code":code}) };
    CString::new(value.to_string()).expect("JSON cannot contain raw NUL").into_raw()
}

/// One `io` call (`binary-io` builds): the application's stream writes, plus a poll's stream data and datagrams back.
const MAX_IO: usize = 4 * 1024 * 1024;

/// Splits an `io` frame: a little-endian u32 header length, the JSON header, then the raw bytes the header lists.
fn frame(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let length = u32::from_le_bytes(input.get(..4)?.try_into().ok()?) as usize;
    let end = 4usize.checked_add(length).filter(|end| *end <= input.len())?;
    Some((&input[4..end], &input[end..]))
}

/// `binary-io` builds (`NativeEngine::io`), serialized with the handle's other calls like a command. Input and output are
/// frames: a little-endian u32 header length, the JSON header, then raw bytes. The output header is `{"ok":true,"value":…}`
/// or `{"ok":false,"code":…}`. Returns an owned buffer of `*out_length` bytes, released exactly once with free_bytes; null
/// only when `out_length` is null.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_io(handle: *mut NativeEngine, input: *const u8, length: usize, out_length: *mut usize) -> *mut u8 {
    if out_length.is_null() { return std::ptr::null_mut(); }
    let result = if handle.is_null() || input.is_null() || length > MAX_IO {
        Err("INVALID_NATIVE_COMMAND")
    } else {
        match catch_unwind(AssertUnwindSafe(|| {
            let input = unsafe { std::slice::from_raw_parts(input, length) };
            let (header, payload) = frame(input).ok_or("INVALID_NATIVE_IO")?;
            let header: Value = serde_json::from_slice(header).map_err(|_| "INVALID_NATIVE_IO")?;
            unsafe { &mut *handle }.io(&header, payload)
        })) {
            Ok(result) => result,
            Err(_) => { unsafe { &mut *handle }.poison(); Err("NATIVE_ENGINE_FAILURE") },
        }
    };
    let (header, payload) = match result {
        Ok((value, payload)) => (json!({"ok":true,"value":value}), payload),
        Err(code) => (json!({"ok":false,"code":code}), Vec::new()),
    };
    let header = header.to_string().into_bytes();
    let mut output = Vec::with_capacity(4 + header.len() + payload.len());
    output.extend_from_slice(&(header.len() as u32).to_le_bytes());
    output.extend_from_slice(&header);
    output.extend_from_slice(&payload);
    let output = output.into_boxed_slice();
    unsafe { *out_length = output.len(); }
    Box::into_raw(output) as *mut u8
}

/// Releases an `io` result: the pointer and length `io` returned, exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_free_bytes(value: *mut u8, length: usize) {
    if value.is_null() { return; }
    let mut bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(value, length)) };
    bytes.zeroize();
}

/// The engine's own turn (`NativeEngine::pump`), serialized with the handle's other calls like a command.
/// Negative on failure; otherwise bit 0 says the application has something to read with the `poll` command, and the
/// remaining bits are the milliseconds after which to call again when no datagram arrives first.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_pump(handle: *mut NativeEngine) -> i64 {
    if handle.is_null() { return -1; }
    match catch_unwind(AssertUnwindSafe(|| unsafe { &mut *handle }.pump())) {
        Ok(Ok((work, wake_ms))) => ((wake_ms as i64) << 1) | work as i64,
        Ok(Err(_)) => -1,
        Err(_) => { unsafe { &mut *handle }.poison(); -1 },
    }
}

/// A waiter for this engine's UDP socket, created like a command (serialized with the handle). It stays valid after the
/// engine is destroyed and is released exactly once with waiter_free, after every wait on it has returned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_waiter(handle: *mut NativeEngine) -> *mut Waiter {
    if handle.is_null() { return std::ptr::null_mut(); }
    catch_unwind(AssertUnwindSafe(|| Box::into_raw(Box::new(unsafe { &*handle }.waiter())))).unwrap_or(std::ptr::null_mut())
}

/// Blocks up to `timeout_ms` for a datagram on the engine's socket: 1 when one is waiting, 0 on timeout. Any thread, and
/// several at once; it touches no engine state, so it runs beside the handle's serialized calls.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_wait(waiter: *const Waiter, timeout_ms: u32) -> i32 {
    if waiter.is_null() { return 0; }
    catch_unwind(AssertUnwindSafe(|| unsafe { &*waiter }.wait(timeout_ms) as i32)).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_waiter_free(waiter: *mut Waiter) {
    if !waiter.is_null() { drop(unsafe { Box::from_raw(waiter) }); }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_free_string(value: *mut c_char) {
    if !value.is_null() { unsafe { CString::from_raw(value) }.into_bytes_with_nul().zeroize(); }
}

/// Independent background decryption. Input contains only a notification key and public trust.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_notification_open(input: *const u8, length: usize) -> *mut c_char {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if input.is_null() || length > 512 * 1024 { return Err("INVALID_NOTIFICATION"); }
        let input = unsafe { std::slice::from_raw_parts(input, length) };
        let value = serde_json::from_slice(input).map_err(|_| "INVALID_NOTIFICATION")?;
        notification::open(&value)
    })).unwrap_or(Err("INVALID_NOTIFICATION"));
    let value = match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => json!({"ok":false,"code":code}) };
    CString::new(value.to_string()).expect("JSON cannot contain raw NUL").into_raw()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn cindy_agent_net_destroy(handle: *mut NativeEngine) {
    if !handle.is_null() { drop(unsafe { Box::from_raw(handle) }); }
}
