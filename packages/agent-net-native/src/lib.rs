//! Serialized C ABI for iOS and Android. The caller owns a handle and must
//! serialize its calls; no process-global endpoint, key, clock or IO buffer.
mod crypto;
mod engine;
mod media;
mod media_http;
mod notification;

use std::{ffi::{c_char, CString}, panic::{AssertUnwindSafe, catch_unwind}};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use zeroize::{Zeroizing, Zeroize};
use crypto::NativeCrypto;
pub use engine::NativeEngine;

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

pub fn create(options: &Value) -> Result<NativeEngine, &'static str> {
    let seed = Zeroizing::new(bytes(&options["seed"])?);
    let seed: &[u8; 32] = seed.as_slice().try_into().map_err(|_| "INVALID_IDENTITY_SEED")?;
    let context = text(options, "context")?;
    if context.is_empty() || context.len() > 256 { return Err("INVALID_IDENTITY_CONTEXT"); }
    let device_id = text(options, "deviceId")?;
    if device_id.is_empty() || device_id.len() > 128
        || !device_id.as_bytes()[0].is_ascii_alphanumeric()
        || !device_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:@/-".contains(&b))
    { return Err("INVALID_DEVICE_ID"); }
    let crypto = NativeCrypto::from_seed(context, seed, options["legacySigning"] == true)?;
    NativeEngine::new(crypto, device_id.to_owned(), options["udp"].as_bool().unwrap_or(true))
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
