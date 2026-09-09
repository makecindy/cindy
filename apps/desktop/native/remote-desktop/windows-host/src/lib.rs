//! Main-only Node-API transport: the OS sees the actual Cindy PID opening the
//! pipe. A child process or a self-reported parent PID is never authorization.
mod pipe;
mod win;
use napi_derive::napi;
use sha2::{Digest, Sha256};
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
}
#[napi]
impl DesktopConnection {
    #[napi(factory)]
    pub async fn open(binary: String, init: String) -> napi::Result<Self> {
        tokio::task::spawn_blocking(move || {
            let path = PathBuf::from(binary).canonicalize().map_err(failure)?;
            let name = format!(
                "CindyRemoteDesktop-{:x}",
                Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
            )[..35]
                .to_string();
            let mut pipe = pipe::Pipe::client(&format!(r"\\.\pipe\{}", name)).map_err(failure)?;
            let pid = pipe.server_pid().map_err(failure)?;
            let server = win::process(pid).map_err(failure)?;
            if !win::system(win::token(server.0).map_err(failure)?.0).map_err(failure)?
                || win::image(server.0)
                    .map_err(failure)?
                    .canonicalize()
                    .map_err(failure)?
                    != path
            {
                return Err(failure("identity"));
            }
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
            pipe.write(format!("{init}\n").as_bytes())
                .map_err(failure)?;
            if pipe.line(1024).map_err(failure)? != b"ready\n" {
                return Err(failure("ready"));
            }
            let cancel = pipe.cancel.clone();
            Ok(Self {
                pipe: Arc::new(Mutex::new(Some(pipe))),
                cancel,
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
        tokio::task::spawn_blocking(move || {
            let mut guard = pipe.lock().map_err(failure)?;
            let result = (|| {
                let pipe = guard.as_mut().ok_or_else(|| failure("closed"))?;
                pipe.write(format!("{line}\n").as_bytes())
                    .map_err(failure)?;
                let bytes = pipe.line(240001).map_err(failure)?;
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
