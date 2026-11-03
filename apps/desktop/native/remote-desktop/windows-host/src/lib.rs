//! Main-only Node-API transport: the OS sees the actual Cindy PID opening the
//! pipe. A child process or a self-reported parent PID is never authorization.
mod capture_protocol;
mod naming;
mod pipe;
mod win;
use naming::Installation;
use napi_derive::napi;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use windows_sys::Win32::System::Services::*;
fn failure(_: impl std::fmt::Debug) -> napi::Error {
    napi::Error::from_reason("DESKTOP_SYSTEM_SERVICE_UNAVAILABLE")
}
#[napi]
pub struct DesktopConnection {
    pipe: Arc<Mutex<Option<pipe::Pipe>>>,
    cancel: Arc<AtomicBool>,
    response_limit: usize,
}
#[napi]
impl DesktopConnection {
    #[napi(factory)]
    pub async fn open(binary: String, init: String) -> napi::Result<Self> {
        tokio::task::spawn_blocking(move || {
            // `binary` is the helper shipped inside this installation. The
            // service runs the protected copy of it, so the pipe name is
            // derived from the installation rather than taken from a caller
            // supplied service name. The service itself checks the client PID
            // and the elevated setup flow checks the protected image.
            let bundled = PathBuf::from(binary)
                .canonicalize()
                .map_err(|e| failure(("bundled", e)))?;
            let installation =
                Installation::of_bundled(&bundled).map_err(|e| failure(e.detail()))?;
            let name = installation.service();
            let mut pipe = pipe::Pipe::client(&installation.pipe())
                .map_err(|e| failure(("pipe-client", e)))?;
            let pid = pipe.server_pid().map_err(|e| failure(("server-pid", e)))?;
            unsafe {
                let manager =
                    OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT);
                if manager.is_null() {
                    return Err(failure("scm"));
                }
                let service =
                    OpenServiceW(manager, win::wide(&name).as_ptr(), SERVICE_QUERY_STATUS);
                CloseServiceHandle(manager);
                if service.is_null() {
                    return Err(failure("service"));
                }
                let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
                let mut needed = 0;
                let ok = QueryServiceStatusEx(
                    service,
                    SC_STATUS_PROCESS_INFO,
                    (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
                    std::mem::size_of_val(&status) as u32,
                    &mut needed,
                );
                CloseServiceHandle(service);
                if ok == 0 || status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId != pid
                {
                    return Err(failure("service identity"));
                }
            }
            if init.len() > 1023 || init.contains('\n') {
                return Err(failure("init"));
            }
            let parsed: serde_json::Value = serde_json::from_str(&init).map_err(failure)?;
            let response_limit = capture_protocol::response_limit(&parsed);
            pipe.write(format!("{init}\n").as_bytes())
                .map_err(|e| failure(("write-init", e)))?;
            if pipe.line(1024).map_err(|e| failure(("read-ready", e)))? != b"ready\n" {
                return Err(failure("ready"));
            }
            let cancel = pipe.cancel.clone();
            Ok(Self {
                pipe: Arc::new(Mutex::new(Some(pipe))),
                cancel,
                response_limit,
            })
        })
        .await
        .map_err(failure)?
    }
    #[napi]
    pub async fn request(&self, line: String) -> napi::Result<String> {
        if line.len() > 32767 || line.contains('\n') || self.cancel.load(Ordering::SeqCst) {
            return Err(failure("request"));
        }
        let pipe = self.pipe.clone();
        let cancel = self.cancel.clone();
        let response_limit = self.response_limit;
        tokio::task::spawn_blocking(move || {
            let mut guard = pipe.lock().map_err(failure)?;
            let result = (|| {
                let pipe = guard.as_mut().ok_or_else(|| failure("closed"))?;
                pipe.write(format!("{line}\n").as_bytes())
                    .map_err(failure)?;
                let bytes = pipe.line(response_limit).map_err(failure)?;
                String::from_utf8(bytes).map_err(failure)
            })();
            if result.is_err() || cancel.load(Ordering::SeqCst) {
                guard.take();
            }
            result
        })
        .await
        .map_err(failure)?
    }
    #[napi]
    pub fn close(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.pipe.try_lock() {
            guard.take();
        }
    }
}
impl Drop for DesktopConnection {
    fn drop(&mut self) {
        self.close();
    }
}
