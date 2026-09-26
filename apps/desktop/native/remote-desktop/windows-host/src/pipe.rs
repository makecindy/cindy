//! Local-only, overlapped, bounded byte streams. Cancellation is completed before
//! dropping OVERLAPPED or its buffer. No raw input/pixels are written to logs.
use crate::win::*;
use std::{
    io, mem, ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::Authorization::*,
    Security::*,
    Storage::FileSystem::*,
    System::{Pipes::*, Threading::*, IO::*},
};
pub struct Pipe {
    handle: Handle,
    buffered: Vec<u8>,
    pub cancel: Arc<AtomicBool>,
    pub shutdown: Option<&'static AtomicBool>,
}
unsafe impl Send for Pipe {}
impl Pipe {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
            || self
                .shutdown
                .is_some_and(|stop| stop.load(Ordering::SeqCst))
    }
    pub fn server(name: &str, system_only: bool) -> Result<Self> {
        // GR/GW would include FILE_CREATE_PIPE_INSTANCE. Grant only data,
        // synchronization and read-attributes access: CreateFileW also checks
        // FILE_READ_ATTRIBUTES when opening the client end of a named pipe.
        let sddl = wide(if system_only {
            "D:P(A;;GA;;;SY)"
        } else {
            "D:P(A;;GA;;;SY)(A;;0x00100083;;;IU)"
        });
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let raw = unsafe {
            CreateNamedPipeW(
                wide(name).as_ptr(),
                PIPE_ACCESS_DUPLEX
                    | FILE_FLAG_OVERLAPPED
                    | if system_only {
                        FILE_FLAG_FIRST_PIPE_INSTANCE
                    } else {
                        0
                    },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                4,
                262144,
                32768,
                0,
                &attributes,
            )
        };
        unsafe {
            LocalFree(descriptor);
        }
        Ok(Self {
            handle: Handle::new(raw)?,
            buffered: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            shutdown: None,
        })
    }
    pub fn client(name: &str) -> Result<Self> {
        let name = wide(name);
        unsafe {
            WaitNamedPipeW(name.as_ptr(), 3000);
        }
        let handle = Handle::new(unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        })?;
        Ok(Self {
            handle,
            buffered: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            shutdown: None,
        })
    }
    fn operation(
        &self,
        run: impl FnOnce(*mut OVERLAPPED) -> BOOL,
        timeout: u32,
        connect: bool,
    ) -> Result<u32> {
        if self.cancelled() {
            return Err(io::Error::from(io::ErrorKind::Interrupted));
        }
        let event = Handle::new(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })?;
        let mut operation: OVERLAPPED = unsafe { mem::zeroed() };
        operation.hEvent = event.0;
        let ok = run(&mut operation);
        let code = unsafe { GetLastError() };
        if ok == 0 && connect && code == ERROR_PIPE_CONNECTED {
            return Ok(0);
        }
        if ok == 0 && code != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(code as i32));
        }
        let deadline = Instant::now() + Duration::from_millis(timeout as u64);
        let mut completed = ok != 0;
        while !completed && !self.cancelled() && Instant::now() < deadline {
            completed = unsafe { WaitForSingleObject(event.0, 100) } == WAIT_OBJECT_0;
        }
        if !completed {
            unsafe {
                CancelIoEx(self.handle.0, &operation);
                let mut bytes = 0;
                GetOverlappedResult(self.handle.0, &operation, &mut bytes, 1);
            }
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        let mut bytes = 0;
        if unsafe { GetOverlappedResult(self.handle.0, &operation, &mut bytes, 1) } == 0 {
            return Err(error());
        }
        Ok(bytes)
    }
    pub fn accept(&self, timeout: u32) -> Result<()> {
        self.operation(
            |op| unsafe { ConnectNamedPipe(self.handle.0, op) },
            timeout,
            true,
        )
        .map(|_| ())
    }
    pub fn client_pid(&self) -> Result<u32> {
        let mut pid = 0;
        if unsafe { GetNamedPipeClientProcessId(self.handle.0, &mut pid) } == 0 {
            Err(error())
        } else {
            Ok(pid)
        }
    }
    pub fn server_pid(&self) -> Result<u32> {
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(self.handle.0, &mut pid) } == 0 {
            Err(error())
        } else {
            Ok(pid)
        }
    }
    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.write_bounded(data, 240001)
    }
    /// Both capture-worker and broker responses use the negotiated budget.
    /// Ordinary requests and unnegotiated responses retain the original limit.
    pub fn write_response(&self, data: &[u8], init: &serde_json::Value) -> Result<()> {
        self.write_bounded(data, crate::capture_protocol::response_limit(init))
    }
    fn write_bounded(&self, data: &[u8], limit: usize) -> Result<()> {
        if data.len() > limit {
            return denied();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut offset = 0;
        while offset < data.len() {
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(5000) as u32;
            let count = self.operation(
                |op| unsafe {
                    WriteFile(
                        self.handle.0,
                        data[offset..].as_ptr(),
                        (data.len() - offset) as u32,
                        ptr::null_mut(),
                        op,
                    )
                },
                remaining,
                false,
            )? as usize;
            if count == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            offset += count;
        }
        Ok(())
    }
    pub fn line(&mut self, limit: usize) -> Result<Vec<u8>> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(end) = self.buffered.iter().position(|b| *b == b'\n') {
                if end + 1 > limit {
                    return denied();
                }
                return Ok(self.buffered.drain(..=end).collect());
            }
            if self.buffered.len() >= limit {
                return denied();
            }
            let mut chunk = [0u8; 8192];
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(5000) as u32;
            let count = self.operation(
                |op| unsafe {
                    ReadFile(
                        self.handle.0,
                        chunk.as_mut_ptr(),
                        chunk.len() as u32,
                        ptr::null_mut(),
                        op,
                    )
                },
                remaining,
                false,
            )? as usize;
            if count == 0 {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            self.buffered.extend_from_slice(&chunk[..count]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_protocol::OVERLAY_RESPONSE_LIMIT;
    use serde_json::json;

    #[test]
    fn interactive_client_can_open_service_pipe_and_exchange_probe() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            r"\\.\pipe\cindy-service-acl-test-{}-{nonce}",
            std::process::id()
        );
        // Exercise the real service ACL from an interactive, non-SYSTEM account.
        // The framing test below uses a caller-owned default ACL and cannot catch
        // missing rights in the SYSTEM service's interactive-client grant.
        let mut server = Pipe::server(&name, false).unwrap();
        let mut client = Pipe::client(&name).unwrap();
        server.accept(1000).unwrap();
        assert_eq!(server.client_pid().unwrap(), std::process::id());
        assert_eq!(client.server_pid().unwrap(), std::process::id());
        client.write(b"{\"mode\":\"probe\"}\n").unwrap();
        assert_eq!(server.line(1024).unwrap(), b"{\"mode\":\"probe\"}\n");
        server.write(b"ready\n").unwrap();
        assert_eq!(client.line(1024).unwrap(), b"ready\n");
        // Data access must not let interactive clients impersonate the service
        // by creating another server instance at its existing pipe name.
        assert_eq!(
            Pipe::server(&name, false)
                .err()
                .expect("client cannot create a server instance")
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn transfers_large_negotiated_frames_without_raising_other_write_limits() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(r"\\.\pipe\cindy-cursor-test-{}-{nonce}", std::process::id());
        // A caller-owned test pipe needs no SYSTEM/interactive service token.
        // Keep the production service ACL unchanged; only exercise framing here.
        let handle = Handle::new(unsafe {
            CreateNamedPipeW(
                wide(&name).as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                262144,
                32768,
                0,
                ptr::null(),
            )
        })
        .unwrap();
        let server = Pipe {
            handle,
            buffered: Vec::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            shutdown: None,
        };
        let writer = std::thread::spawn(move || {
            server.accept(5000).unwrap();
            let mut frame = vec![b'x'; OVERLAY_RESPONSE_LIMIT];
            *frame.last_mut().unwrap() = b'\n';
            assert_eq!(
                server.write(&frame).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
            for init in [
                json!({"mode":"capture"}),
                json!({"mode":"capture", "cursorOverlay":false}),
                json!({"mode":"input", "cursorOverlay":true}),
            ] {
                assert_eq!(
                    server.write_response(&frame, &init).unwrap_err().kind(),
                    io::ErrorKind::PermissionDenied
                );
            }
            let overlay = json!({"mode":"capture", "cursorOverlay":true});
            assert_eq!(
                server
                    .write_response(&vec![b'x'; OVERLAY_RESPONSE_LIMIT + 1], &overlay)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
            server.write_response(&frame, &overlay).unwrap();
        });
        let mut client = Pipe::client(&name).unwrap();
        let frame = client.line(OVERLAY_RESPONSE_LIMIT).unwrap();
        assert_eq!(frame.len(), OVERLAY_RESPONSE_LIMIT);
        assert_eq!(frame.last(), Some(&b'\n'));
        assert!(frame[..frame.len() - 1].iter().all(|byte| *byte == b'x'));
        writer.join().unwrap();
    }
}
