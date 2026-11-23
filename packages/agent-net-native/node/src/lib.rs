//! Node-API binding of the native Agent-Net engine (`cindy-agent-net-native`) for the Desktop's Agent-Net worker thread.
//!
//! The same engine and the same calls as the phones' C ABI (`../src/lib.rs`): JSON commands and `io` frames. The phones'
//! pump thread (CindyAgentNetModule.kt `Pump`) is built in: from creation until `destroy`, a thread of its own waits for a
//! datagram or the core's next timer and gives the engine its turn, so receiving, acknowledging, retransmitting and pacing
//! never wait for JS, and JS is woken only when the engine has something for it to read: one byte to a loopback UDP port the
//! worker listens on (`create`'s `wakePort`), at most one on its way until JS reads with `io`.
//! Every call is serialized with the pump thread's turns by one mutex; none blocks longer than one engine call.
//!
//! The pump thread never calls into Node, so nothing it does depends on a worker's environment still existing: a datagram to
//! a closed port is simply lost. It first woke JS through a Node-API thread-safe function, and Electron 42 crashed when workers
//! that had moved data ended (2026-11-23, exit code 139); the module being unloaded under its threads turned out to be the
//! cause (`pin_module`), but a call from the pump thread into an environment that is going away remains a hazard of its own.
use std::{
    net::UdpSocket,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}},
    thread,
    time::Instant,
};
use cindy_agent_net_native::{NativeEngine, Waiter, create as create_engine};
use napi::{Env, JsBuffer};
use napi_derive::napi;
use serde_json::{Value, json};

/// The C ABI's limits (`../src/lib.rs`): one authenticated 1 MiB media block as base64 plus its envelope; one `io` turn.
const MAX_COMMAND: usize = 2 * 1024 * 1024;
const MAX_IO: usize = 4 * 1024 * 1024;
/// The pump thread takes a turn at least this often, as the phones' does: relay UDP registration and STUN keep their own timers.
const MAX_PUMP_WAIT_MS: u64 = 250;
/// While data streams in, JS is woken at most once per this long after its last read, and reads what came meanwhile in one go;
/// the first datagram after a quiet spell wakes it at once, so a request's answer is not held back. Woken for every datagram,
/// a 12.5 MB/s transfer read about ten thousand times a second, each read a JSON round over every connection (2026-11-23).
const BATCH_US: u64 = 1_000;

fn micros() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// The engine keeps `Rc`s that never leave it. It is only reached through `Shared::engine`'s mutex, one thread at a time,
/// which is what the C ABI requires of its callers too.
struct Cell(NativeEngine);
// SAFETY: see above; no `Rc` inside the engine is shared with anything outside it.
unsafe impl Send for Cell {}

struct Shared {
    engine: Mutex<Option<Cell>>,
    /// A wake byte is on its way: JS has not read with `io` since it was sent.
    notified: AtomicBool,
    /// When JS last read with `io` (`micros`).
    read_at: AtomicU64,
    closed: AtomicBool,
    /// Connected to the worker's wake port on loopback.
    wake: UdpSocket,
}
impl Shared {
    fn with<T>(&self, call: impl FnOnce(&mut NativeEngine) -> Result<T, &'static str>) -> Result<T, &'static str> {
        let mut guard = self.engine.lock().map_err(|_| "NATIVE_ENGINE_FAILURE")?;
        let cell = guard.as_mut().ok_or("AGENT_NET_ENGINE_CLOSED")?;
        match catch_unwind(AssertUnwindSafe(|| call(&mut cell.0))) {
            Ok(result) => result,
            Err(_) => { cell.0.poison(); Err("NATIVE_ENGINE_FAILURE") },
        }
    }
    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        // Dropping the engine closes its socket; the pump thread's waiter keeps its own handle until the thread ends.
        let engine = self.engine.lock().ok().and_then(|mut guard| guard.take());
        drop(engine);
    }
}

/// One engine: one identity, one UDP socket, its peer connections. Create with `create`.
#[napi]
pub struct AgentNetEngine { shared: Arc<Shared> }

/// `options`: the engine's JSON options (`keys` or seed and context, deviceId, udp, enhancedTransport; `../src/lib.rs` `create`).
/// `wakePort`: a UDP port on 127.0.0.1 the worker listens on; a byte from `wakeSource()` there means `io` has something to read.
#[napi]
pub fn create(mut env: Env, options: String, wake_port: u32) -> napi::Result<AgentNetEngine> {
    pin_module();
    let wake_port = u16::try_from(wake_port).ok().filter(|port| *port > 0).ok_or_else(|| failure("INVALID_WAKE_PORT"))?;
    if options.len() > MAX_COMMAND { return Err(failure("INVALID_NATIVE_COMMAND")); }
    let options: Value = serde_json::from_str(&options).map_err(|_| failure("INVALID_NATIVE_COMMAND"))?;
    let engine = match catch_unwind(AssertUnwindSafe(|| create_engine(&options))) {
        Ok(result) => result.map_err(failure)?,
        Err(_) => return Err(failure("NATIVE_ENGINE_FAILURE")),
    };
    let waiter = engine.waiter();
    let wake = UdpSocket::bind(("127.0.0.1", 0)).and_then(|socket| socket.connect(("127.0.0.1", wake_port)).map(|_| socket))
        .map_err(|_| failure("NATIVE_ENGINE_FAILURE"))?;
    let shared = Arc::new(Shared { engine: Mutex::new(Some(Cell(engine))), notified: AtomicBool::new(false), read_at: AtomicU64::new(0), closed: AtomicBool::new(false), wake });
    // A worker that ends without `destroy` ends its engines too: the socket closes and the pump thread stops.
    env.add_env_cleanup_hook(shared.clone(), |shared| shared.close())?;
    let pump_shared = shared.clone();
    thread::Builder::new()
        .name("cindy-agent-net-pump".into())
        .spawn(move || pump(pump_shared, waiter))
        .map_err(|_| failure("NATIVE_ENGINE_FAILURE"))?;
    Ok(AgentNetEngine { shared })
}

/// The engine's own loop: wait for a datagram or the core's next timer, take a turn, tell JS when there is something to
/// read. Ends when the engine is destroyed or fails; JS learns of a failure from its next call.
fn pump(shared: Arc<Shared>, waiter: Waiter) {
    let mut wait_ms = 0u64;
    loop {
        if wait_ms > 0 { waiter.wait(wait_ms as u32); }
        if shared.closed.load(Ordering::Acquire) { break; }
        match shared.with(|engine| engine.pump()) {
            Ok((work, wake_ms)) => {
                wait_ms = wake_ms.clamp(1, MAX_PUMP_WAIT_MS);
                if work {
                    let since_read = micros().saturating_sub(shared.read_at.load(Ordering::Acquire));
                    // Streaming: hold it until BATCH_US after the last read (the next turn comes by then at the latest).
                    if since_read >= BATCH_US { notify(&shared); } else { wait_ms = wait_ms.min((BATCH_US - since_read).div_ceil(1000)); }
                }
            },
            Err(_) => { notify(&shared); break; },
        }
    }
}
fn notify(shared: &Shared) {
    if !shared.notified.swap(true, Ordering::AcqRel) && shared.wake.send(&[1]).is_err() {
        shared.notified.store(false, Ordering::Release);
    }
}

#[napi]
impl AgentNetEngine {
    /// One JSON command (engine.rs `command`); returns `{"ok":true,"value":…}` or `{"ok":false,"code":…}` like the C ABI.
    #[napi]
    pub fn command(&self, input: String) -> String {
        let result = if input.len() > MAX_COMMAND { Err("INVALID_NATIVE_COMMAND") } else {
            serde_json::from_str::<Value>(&input).map_err(|_| "INVALID_NATIVE_COMMAND")
                .and_then(|command| self.shared.with(|engine| engine.command(&command)))
        };
        match result { Ok(value) => json!({"ok":true,"value":value}), Err(code) => json!({"ok":false,"code":code}) }.to_string()
    }
    /// One `io` frame in, one out (engine.rs `io`, `../src/lib.rs` `cindy_agent_net_io`): a little-endian u32 header length,
    /// the JSON header, then the raw bytes it lists. A call that reads (`"poll":true`) takes what `onWork` announced; what the
    /// engine collects after it is announced again.
    ///
    /// Bytes cross as plain Node buffers read in place and returned as a copy, not as napi-rs `Buffer`s: those release their
    /// reference through one callback for the whole process, made in the first worker's environment, and with a worker on the
    /// engine ending while another went on, Electron 42 crashed (2026-11-23, exit code 139).
    #[napi(ts_args_type = "input: Uint8Array", ts_return_type = "Buffer")]
    pub fn io(&self, env: Env, input: JsBuffer) -> napi::Result<JsBuffer> {
        let input = input.into_value()?;
        let result = if input.len() > MAX_IO { Err("INVALID_NATIVE_COMMAND") } else {
            split(&input).ok_or("INVALID_NATIVE_IO")
                .and_then(|(header, payload)| serde_json::from_slice::<Value>(header).map_err(|_| "INVALID_NATIVE_IO").map(|header| (header, payload)))
                .and_then(|(header, payload)| {
                    if header["poll"] == true {
                        self.shared.read_at.store(micros(), Ordering::Release);
                        self.shared.notified.store(false, Ordering::Release);
                    }
                    self.shared.with(|engine| engine.io(&header, payload))
                })
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
        Ok(env.create_buffer_copy(output)?.into_raw())
    }
    /// The engine takes a turn now; true when it has something for JS to read with `io`. JS calls it after writing: a write
    /// can leave a datagram for the relay WebSocket, which no arriving packet would announce. False once destroyed or failed.
    #[napi]
    pub fn ready(&self) -> bool {
        self.shared.with(|engine| engine.pump()).is_ok_and(|(work, _)| work)
    }
    /// The port wake bytes come from: the worker takes only those.
    #[napi]
    pub fn wake_source(&self) -> u32 {
        self.shared.wake.local_addr().map_or(0, |address| u32::from(address.port()))
    }
    /// Closes the socket and every connection without notice to peers (close them first for that), and ends the pump thread.
    #[napi]
    pub fn destroy(&self) { self.shared.close(); }
}
impl Drop for AgentNetEngine {
    fn drop(&mut self) { self.shared.close(); }
}

/// Keeps this module loaded for the rest of the process. Node unloads a native module when the last worker that loaded it ends,
/// while threads it started can still be running its code: the pump thread for up to MAX_PUMP_WAIT_MS, a relay or STUN name
/// lookup for as long as DNS takes. When they came back to unmapped code the whole process crashed (2026-11-23, Electron 42,
/// exit code 139 after the workers of a benchmark round ended; the engines had been destroyed).
fn pin_module() {
    static PINNED: std::sync::Once = std::sync::Once::new();
    PINNED.call_once(|| {
        #[cfg(windows)]
        {
            const PIN: u32 = 0x1;
            const FROM_ADDRESS: u32 = 0x4;
            #[link(name = "kernel32")] unsafe extern "system" {
                fn GetModuleHandleExW(flags: u32, name: *const u16, module: *mut *mut std::ffi::c_void) -> i32;
            }
            let mut module = std::ptr::null_mut();
            // SAFETY: an address inside this module names it; the handle needs no release once pinned.
            unsafe { GetModuleHandleExW(PIN | FROM_ADDRESS, pin_module as *const () as *const u16, &mut module); }
        }
        #[cfg(unix)]
        {
            #[repr(C)] struct DlInfo { fname: *const std::ffi::c_char, fbase: *mut std::ffi::c_void, sname: *const std::ffi::c_char, saddr: *mut std::ffi::c_void }
            #[cfg(target_vendor = "apple")] const NODELETE: i32 = 0x80;
            #[cfg(not(target_vendor = "apple"))] const NODELETE: i32 = 0x1000;
            const NOW: i32 = 0x2;
            unsafe extern "C" {
                fn dladdr(address: *const std::ffi::c_void, info: *mut DlInfo) -> i32;
                fn dlopen(file: *const std::ffi::c_char, mode: i32) -> *mut std::ffi::c_void;
            }
            let mut info = DlInfo { fname: std::ptr::null(), fbase: std::ptr::null_mut(), sname: std::ptr::null(), saddr: std::ptr::null_mut() };
            // SAFETY: dladdr fills `info` for an address inside this module; reopening it with NODELETE only adds a reference
            // that is never released.
            unsafe { if dladdr(pin_module as *const std::ffi::c_void, &mut info) != 0 && !info.fname.is_null() { dlopen(info.fname, NOW | NODELETE); } }
        }
    });
}
/// Splits an `io` frame: a little-endian u32 header length, the JSON header, then the raw bytes the header lists.
fn split(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let length = u32::from_le_bytes(input.get(..4)?.try_into().ok()?) as usize;
    let end = 4usize.checked_add(length).filter(|end| *end <= input.len())?;
    Some((&input[4..end], &input[end..]))
}
fn failure(code: &str) -> napi::Error { napi::Error::from_reason(code) }
