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
        // GR/GW would include FILE_CREATE_PIPE_INSTANCE. Explicit data rights only.
        let sddl = wide(if system_only {
            "D:P(A;;GA;;;SY)"
        } else {
            "D:P(A;;GA;;;SY)(A;;0x00100003;;;IU)"
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
                FILE_READ_DATA | FILE_WRITE_DATA | SYNCHRONIZE,
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
        if data.len() > 240001 {
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
