mod keymap;
mod wire;
use hidapi::{HidApi, HidDevice};
use serde_json::{json, Value};
use std::{
    ffi::CString,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

/// File RPCs move the whole keymap through 64-byte reports.
const FS_TIMEOUT: Duration = Duration::from_secs(5);
/// Restore runs after the off frame, still inside the main client's 1s teardown budget.
const RESTORE_TIMEOUT: Duration = Duration::from_millis(450);

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Preserve remote rejection details for narrow optional-method compatibility decisions.
#[derive(Debug)]
struct RpcFailure(Value);
impl std::fmt::Display for RpcFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Micro RPC rejected")
    }
}
impl std::error::Error for RpcFailure {}
impl RpcFailure {
    fn unsupported_method(&self) -> bool {
        if self.0.get("code").and_then(Value::as_i64) == Some(-32601) {
            return true;
        }
        let code: String = self
            .0
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .chars()
            .filter(|c| !matches!(c, '_' | '-' | ' '))
            .collect();
        if [
            "notsupported",
            "unsupported",
            "notimplemented",
            "methodnotfound",
            "enosys",
        ]
        .iter()
        .any(|marker| code.contains(marker))
        {
            return true;
        }
        let message = self
            .0
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| self.0.as_str())
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        [
            "not supported",
            "unsupported",
            "not implemented",
            "unknown method",
            "method not found",
        ]
        .iter()
        .any(|marker| {
            message == *marker || (message.contains("status") && message.contains(marker))
        })
    }
}

fn rpc_response(reply: &Value) -> Result<Value> {
    if let Some(error) = reply.get("error") {
        return Err(Box::new(RpcFailure(error.clone())));
    }
    Ok(reply["result"].clone())
}

fn optional_status(outcome: Result<Value>) -> Result<Value> {
    match outcome {
        Err(error)
            if error
                .downcast_ref::<RpcFailure>()
                .is_some_and(RpcFailure::unsupported_method) =>
        {
            Ok(json!({}))
        }
        // Timeouts, HID errors and other remote rejections still recycle the handle.
        other => other,
    }
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod status_tests {
    use super::*;
    #[test]
    fn unsupported_status_rpc_keeps_the_device_usable_without_telemetry() {
        for error in [
            json!({"code":-32601,"message":"Method not found"}),
            json!({"message":"not supported"}),
            json!({"code":"ERR_NOT_IMPLEMENTED","message":"status unavailable"}),
        ] {
            let response = json!({"id":1,"error":error});
            assert!(rpc_response(&response).is_err()); // Non-status RPCs remain fatal.
            assert_eq!(optional_status(rpc_response(&response)).unwrap(), json!({}));
        }
    }
    #[test]
    fn real_status_errors_and_transport_failures_stay_fatal() {
        for error in [
            json!({"code":-13,"message":"permission denied"}),
            json!({"message":"device disconnected"}),
            json!({"code":-32602,"message":"invalid params"}),
        ] {
            assert!(optional_status(rpc_response(&json!({"error":error}))).is_err());
        }
        assert!(optional_status(Err("Micro RPC timed out".into())).is_err());
        assert!(optional_status(Err("short Micro write".into())).is_err());
        assert_eq!(
            optional_status(Ok(json!({"version":"1.2.3"}))).unwrap(),
            json!({"version":"1.2.3"})
        );
    }
}

fn emit(message: Value) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &message)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

/// Only owns the primary Micro TLC; enumeration never opens the input stream.
struct Micro {
    api: HidApi,
    device: Option<HidDevice>,
    decoder: wire::Decoder,
    sequence: u64,
    rpc_timeout: Duration,
    serial: Option<String>,
    backup_dir: Option<PathBuf>,
    /// Agent layer from main; every task key carries its own AG code.
    keymap: Option<Value>,
    keymap_bound: bool,
    keymap_written: bool,
    keymap_ready_at: Option<Instant>,
    /// Firmware without file RPCs keeps its factory keymap; main routes HID by it.
    factory_keymap: bool,
}

impl Micro {
    fn find(&mut self) -> Result<Option<(CString, Option<String>)>> {
        self.api.refresh_devices()?;
        Ok(self
            .api
            .device_list()
            .find(|d| wire::matches(d.vendor_id(), d.product_id(), d.usage_page(), d.usage()))
            .map(|d| (d.path().to_owned(), d.serial_number().map(str::to_owned))))
    }
    fn discover(&mut self) -> Result<()> {
        emit(
            json!({"kind":"presence","present":self.find()?.is_some(),"deviceType":"codex-micro","isUsbConnection":true}),
        )
    }
    fn connect(&mut self) -> Result<bool> {
        if self.device.is_some() {
            return Ok(true);
        }
        let Some((path, serial)) = self.find()? else {
            emit(json!({"kind":"presence","present":false}))?;
            emit(json!({"kind":"state","status":"not-detected"}))?;
            return Ok(false);
        };
        self.device = Some(self.api.open_path(&path)?);
        self.serial = serial;
        self.decoder = wire::Decoder::default();
        self.status()?;
        Ok(true)
    }
    fn read(&mut self, timeout: i32) -> Result<Vec<Value>> {
        let mut report = [0; 64];
        let Some(device) = self.device.as_ref() else {
            return Ok(Vec::new());
        };
        let len = device.read_timeout(&mut report, timeout)?;
        if len == 0 {
            return Ok(Vec::new());
        }
        // Malformed device data is discarded, never forwarded to main as commands.
        let messages = self.decoder.feed(&report[..len]).unwrap_or_default();
        for message in &messages {
            if let Some(input) = wire::input(message) {
                emit(json!({"kind":"activity"}))?;
                emit(input)?;
            }
        }
        Ok(messages)
    }
    fn rpc(&mut self, message: Value) -> Result<Value> {
        self.rpc_within(message, self.rpc_timeout)
    }
    fn rpc_within(&mut self, mut message: Value, timeout: Duration) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        message["id"] = json!(id);
        let device = self.device.as_ref().ok_or("Micro disconnected")?;
        for report in wire::encode(&message) {
            if device.write(&report)? != report.len() {
                return Err("short Micro write".into());
            }
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            for reply in self.read(20)? {
                if reply["id"].as_u64() == Some(id) {
                    return rpc_response(&reply);
                }
            }
        }
        Err("Micro RPC timed out".into())
    }
    fn status(&mut self) -> Result<()> {
        let status = optional_status(self.rpc(json!({"method":"device.status"})))?;
        emit(json!({"kind":"device","device":{
            "deviceType":"codex-micro", "isUsbConnection":true,
            "firmwareVersion":status.get("version").and_then(Value::as_str),
            "batteryPercentage":status.get("battery").and_then(Value::as_f64).map(|n| n.clamp(0.0,100.0)),
            "isCharging":status.get("is_charging").and_then(Value::as_bool),
            "inputMonitoringPermission":"not-required",
            "factoryKeymap":self.factory_keymap
        }}))?;
        emit(json!({"kind":"state","status":"connected"}))
    }
    /// Rewrites the active layer once per connection and after each rebind, like the
    /// utility host. Returns true after a write, so lighting is sent again.
    fn bind_keymap(&mut self) -> Result<bool> {
        if self.keymap_bound || self.device.is_none() {
            return Ok(false);
        }
        let Some(desired) = self.keymap.clone() else {
            return Ok(false);
        };
        let read = json!({"method":"fs.read","params":{"file":keymap::FILE}});
        let read = match self.rpc_within(read, FS_TIMEOUT) {
            Err(error)
                if error
                    .downcast_ref::<RpcFailure>()
                    .is_some_and(RpcFailure::unsupported_method) =>
            {
                // Firmware without file RPCs keeps its factory keymap; tell main so it
                // routes keys and lights by the factory codes, not the rewritten ones.
                self.keymap_bound = true;
                self.factory_keymap = true;
                emit(json!({"kind":"log","level":"warn",
                    "message":"Codex Micro firmware cannot rewrite its keymap"}))?;
                self.status()?;
                return Ok(false);
            }
            other => other?,
        };
        let live = keymap::text(&read).ok_or("fs.read keymap.json returned an empty payload")?;
        let document =
            keymap::parse(&live).ok_or("keymap.json is not a Work Louder keymap document")?;
        let status = optional_status(self.rpc(json!({"method":"device.status"})))?;
        let (profile, layer) = keymap::active_layer(&document, &status);
        let next = match keymap::bind(&document, profile, layer, &desired) {
            keymap::Bind::AlreadyBound => {
                self.keymap_bound = true;
                // Nothing was changed, so nothing to hand back, unless an earlier
                // occupancy was never released and its snapshot is still waiting.
                self.keymap_written = self.session_path().is_some_and(|path| path.exists());
                return Ok(false);
            }
            keymap::Bind::Unchanged => {
                self.keymap_bound = true;
                return Ok(false);
            }
            keymap::Bind::Write(next) => next,
        };
        self.backup_keymap(&live, profile, layer)?;
        let write = json!({"method":"fs.write","params":{"file":keymap::FILE,"data":next}});
        self.rpc_within(write, FS_TIMEOUT)?;
        self.keymap_bound = true;
        self.keymap_written = true;
        self.keymap_ready_at = Some(Instant::now() + Duration::from_millis(keymap::RELOAD_MS));
        Ok(true)
    }
    /// The first snapshot is the factory fallback; the session snapshot is the layout
    /// in use before this occupancy, unless the board already carries Cindy's layer.
    fn backup_keymap(&self, live: &str, profile: usize, layer: usize) -> Result<()> {
        let dir = self
            .backup_dir
            .as_ref()
            .ok_or("Work Louder keymap backup directory is missing")?;
        fs::create_dir_all(dir)?;
        let (factory, session) = keymap::backup_files(self.serial.as_deref());
        let factory = dir.join(factory);
        if !factory.exists() {
            write_atomic(&factory, live)?;
        }
        let session = dir.join(session);
        if keymap::should_save_session(
            keymap::is_cindy_keymap(live, profile, layer),
            session.exists(),
        ) {
            write_atomic(&session, live)?;
        }
        Ok(())
    }
    fn session_path(&self) -> Option<PathBuf> {
        let dir = self.backup_dir.as_ref()?;
        Some(dir.join(keymap::backup_files(self.serial.as_deref()).1))
    }
    fn restore_keymap(&mut self) -> Result<()> {
        if !self.keymap_written || self.device.is_none() {
            return Ok(());
        }
        let Some(dir) = self.backup_dir.clone() else {
            return Ok(());
        };
        let (factory, session) = keymap::backup_files(self.serial.as_deref());
        let Ok(saved) = fs::read_to_string(dir.join(&session))
            .or_else(|_| fs::read_to_string(dir.join(factory)))
        else {
            return Ok(());
        };
        let write = json!({"method":"fs.write","params":{"file":keymap::FILE,"data":saved}});
        self.rpc_within(write, RESTORE_TIMEOUT)?;
        self.keymap_bound = false;
        self.keymap_written = false;
        // A snapshot that outlives its restore would overwrite the next, unrelated layout.
        let _ = fs::remove_file(dir.join(session));
        Ok(())
    }
    /// Lighting waits for the firmware to reload a freshly written keymap.
    fn keymap_ready(&mut self) -> bool {
        if self
            .keymap_ready_at
            .is_some_and(|ready_at| Instant::now() < ready_at)
        {
            return false;
        }
        self.keymap_ready_at = None;
        true
    }
    fn apply(&mut self, frame: &Value) -> Result<()> {
        for request in wire::lighting(frame) {
            self.rpc(request)?;
        }
        Ok(())
    }
    fn failed(&mut self) -> Result<()> {
        self.device = None;
        self.decoder = wire::Decoder::default();
        // The next connection reads the board again before it rewrites or restores.
        self.keymap_bound = false;
        self.keymap_written = false;
        self.keymap_ready_at = None;
        self.factory_keymap = false;
        // Do not pretend a transport failure proves physical absence.
        emit(json!({"kind":"state","status":"error","reason":"connection-failed"}))
    }
    fn stop(&mut self, had_lighting: bool) {
        if had_lighting && self.device.is_some() {
            // Leave time inside the main client's 1s teardown budget to close the handle.
            self.rpc_timeout = Duration::from_millis(150);
            let _ = self.apply(&wire::off_frame());
        }
        // Hand the board back with the layout the user had before Cindy.
        let _ = self.restore_keymap();
        self.device = None;
    }
}

fn run() -> Result<()> {
    let (tx, rx) = mpsc::sync_channel(32);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line.len() > 65_536 {
                break;
            }
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                let stopping = message["kind"] == "stop";
                if tx.send(message).is_err() || stopping {
                    break;
                }
            }
        }
    });
    let mut micro = Micro {
        api: HidApi::new()?,
        device: None,
        decoder: wire::Decoder::default(),
        sequence: 0,
        rpc_timeout: Duration::from_millis(800),
        serial: None,
        backup_dir: None,
        keymap: None,
        keymap_bound: false,
        keymap_written: false,
        keymap_ready_at: None,
        factory_keymap: false,
    };
    let mut wanted = false;
    let mut latest_frame = None;
    let mut apply = false;
    let mut retry_at = Instant::now();
    loop {
        let mut requests = Vec::new();
        let idle_wait = if micro.device.is_some() { 10 } else { 250 };
        match rx.recv_timeout(Duration::from_millis(idle_wait)) {
            Ok(message) => requests.push(message),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        requests.extend(rx.try_iter().take(31));
        let mut discover = false;
        let mut probe = false;
        for request in requests {
            match request["kind"].as_str() {
                Some("stop") => {
                    micro.stop(latest_frame.is_some());
                    emit(json!({"kind":"stopped"}))?;
                    return Ok(());
                }
                Some("discover") => discover = true,
                Some("probe") => probe = true,
                Some("listen") => wanted = true,
                Some("apply") => {
                    wanted = true;
                    latest_frame = Some(request["frame"].clone());
                    apply = true;
                }
                Some("init") => {
                    micro.backup_dir = request["keymapBackupDir"]
                        .as_str()
                        .filter(|dir| !dir.is_empty())
                        .map(PathBuf::from);
                    if let Some(layer) = keymap::requested(&request["creatorKeymap"]) {
                        micro.keymap = Some(layer);
                    }
                }
                Some("rebind-creator-keymap") => {
                    if let Some(layer) = keymap::requested(&request["keymap"]) {
                        micro.keymap = Some(layer);
                        micro.keymap_bound = false;
                    }
                }
                _ => (),
            }
        }
        if discover && micro.discover().is_err() {
            micro.failed()?;
        }
        if wanted && micro.device.is_none() && Instant::now() >= retry_at {
            retry_at = Instant::now() + Duration::from_secs(3);
            match micro.connect() {
                Ok(connected) => apply |= connected,
                Err(_) => micro.failed()?,
            }
        }
        if micro.device.is_some() {
            let outcome = (|| -> Result<()> {
                if probe {
                    micro.status()?;
                }
                apply |= micro.bind_keymap()?;
                if apply && micro.keymap_ready() {
                    if let Some(frame) = &latest_frame {
                        micro.apply(frame)?;
                    }
                    apply = false;
                }
                micro.read(10)?;
                Ok(())
            })();
            if outcome.is_err() {
                micro.failed()?;
                retry_at = Instant::now() + Duration::from_secs(3);
            }
        } else if probe && !wanted {
            micro.discover()?;
        }
    }
    micro.stop(latest_frame.is_some());
    Ok(())
}

fn main() {
    if run().is_err() {
        let _ = emit(json!({"kind":"log","level":"error","message":"Windows Micro helper failed"}));
        std::process::exit(1);
    }
}
