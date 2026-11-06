mod wire;
use hidapi::{HidApi, HidDevice};
use serde_json::{json, Value};
use std::{
    ffi::CString,
    io::{self, BufRead, Write},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

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
}

impl Micro {
    fn find(&mut self) -> Result<Option<CString>> {
        self.api.refresh_devices()?;
        Ok(self
            .api
            .device_list()
            .find(|d| wire::matches(d.vendor_id(), d.product_id(), d.usage_page(), d.usage()))
            .map(|d| d.path().to_owned()))
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
        let Some(path) = self.find()? else {
            emit(json!({"kind":"presence","present":false}))?;
            emit(json!({"kind":"state","status":"not-detected"}))?;
            return Ok(false);
        };
        self.device = Some(self.api.open_path(&path)?);
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
    fn rpc(&mut self, mut message: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        message["id"] = json!(id);
        let device = self.device.as_ref().ok_or("Micro disconnected")?;
        for report in wire::encode(&message) {
            if device.write(&report)? != report.len() {
                return Err("short Micro write".into());
            }
        }
        let deadline = Instant::now() + self.rpc_timeout;
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
            "inputMonitoringPermission":"not-required"
        }}))?;
        emit(json!({"kind":"state","status":"connected"}))
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
        // Do not pretend a transport failure proves physical absence.
        emit(json!({"kind":"state","status":"error","reason":"connection-failed"}))
    }
    fn stop(&mut self, had_lighting: bool) {
        if had_lighting && self.device.is_some() {
            // Leave time inside the main client's 1s teardown budget to close the handle.
            self.rpc_timeout = Duration::from_millis(150);
            let _ = self.apply(&wire::off_frame());
        }
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
    };
    let mut wanted = false;
    let mut latest_frame = None;
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
        let mut apply = false;
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
                _ => (), // init and Creator keymap changes do not mutate this Micro device.
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
                if apply {
                    if let Some(frame) = &latest_frame {
                        micro.apply(frame)?;
                    }
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
