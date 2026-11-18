//! Elevated Windows instances cannot receive Electron's sandboxed WM_COPYDATA
//! from a normal browser launch. This pipe carries only bounded deep-link
//! envelopes to main; it is not a command/process/file broker.
use napi::{
    threadsafe_function::{
        ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
    },
    Env, JsFunction, Status,
};
use napi_derive::napi;
use std::{io, mem, ptr, sync::Arc, thread, time::Instant};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    Globalization::{CompareStringOrdinal, CSTR_EQUAL},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
        },
        GetTokenInformation, TokenElevation, TokenUser, OWNER_SECURITY_INFORMATION, PSID,
        SECURITY_ATTRIBUTES, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
        SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    },
    System::{
        Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
            GetNamedPipeServerProcessId, WaitNamedPipeW, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
        },
        RemoteDesktop::ProcessIdToSessionId,
        Threading::{
            CreateEventW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
            QueryFullProcessImageNameW, SetEvent, WaitForMultipleObjects, INFINITE,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
    UI::WindowsAndMessaging::AllowSetForegroundWindow,
};

const MAX_MESSAGE: usize = 32_768;
const IO_TIMEOUT: u32 = 1_500;

struct Handle(HANDLE);
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn owned(handle: HANDLE) -> io::Result<Handle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(Handle(handle))
    }
}
fn failure(error: impl std::fmt::Display) -> napi::Error {
    // Never attach the request body (which can contain credentials) to errors.
    napi::Error::from_reason(format!("Windows deep-link transport: {error}"))
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn token(process: HANDLE) -> io::Result<Handle> {
    let mut handle = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut handle) } == 0 {
        return Err(io::Error::last_os_error());
    }
    owned(handle)
}
fn elevated(process: HANDLE) -> io::Result<bool> {
    let token = token(process)?;
    let mut elevation: TOKEN_ELEVATION = unsafe { mem::zeroed() };
    let mut size = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            mem::size_of_val(&elevation) as u32,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(elevation.TokenIsElevated != 0)
}
fn user_sid(process: HANDLE) -> io::Result<String> {
    let token = token(process)?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
    }
    if size == 0 || size > 65_536 {
        return Err(io::Error::other("invalid token size"));
    }
    let mut storage =
        vec![0usize; (size as usize + mem::size_of::<usize>() - 1) / mem::size_of::<usize>()];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*(storage.as_ptr() as *const TOKEN_USER) };
    sid_string(user.User.Sid)
}
fn sid_string(sid: PSID) -> io::Result<String> {
    if sid.is_null() {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    let mut text = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        sid
    };
    Ok(result)
}
fn pipe_owner_sid(pipe: HANDLE) -> io::Result<String> {
    let mut owner = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            pipe,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let sid = sid_string(owner);
    unsafe {
        LocalFree(descriptor);
    }
    sid
}
fn pipe_name(scope: &str) -> io::Result<Vec<u16>> {
    if scope.len() != 64 || !scope.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(io::Error::other("invalid lock scope"));
    }
    let mut session = 0;
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(wide(&format!(
        r"\\.\pipe\cindy-deep-link-v1-{}-{session}-{scope}",
        user_sid(unsafe { GetCurrentProcess() })?
    )))
}
fn event() -> io::Result<Handle> {
    owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })
}

// Every connection/read/write has a deadline, except idle accept, which is
// cancelled on close. Drain cancellation before dropping OVERLAPPED storage.
fn io_operation(
    pipe: HANDLE,
    stop: HANDLE,
    timeout: u32,
    operation: impl FnOnce(*mut OVERLAPPED) -> i32,
) -> io::Result<u32> {
    let ready = event()?;
    let mut overlapped: OVERLAPPED = unsafe { mem::zeroed() };
    overlapped.hEvent = ready.0;
    if operation(&mut overlapped) == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_PIPE_CONNECTED {
            return Ok(0);
        }
        if error != ERROR_IO_PENDING {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        let handles = [stop, ready.0];
        if unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout) } != WAIT_OBJECT_0 + 1 {
            unsafe {
                CancelIoEx(pipe, &overlapped);
                let mut ignored = 0;
                GetOverlappedResult(pipe, &overlapped, &mut ignored, 1);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "handoff interrupted or timed out",
            ));
        }
    }
    let mut transferred = 0;
    if unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(transferred)
}
fn read_exact(pipe: HANDLE, stop: HANDLE, mut buffer: &mut [u8]) -> io::Result<()> {
    let started = Instant::now();
    while !buffer.is_empty() {
        let remaining =
            IO_TIMEOUT.saturating_sub(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
        if remaining == 0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let length = io_operation(pipe, stop, remaining, |overlapped| unsafe {
            ReadFile(
                pipe,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                ptr::null_mut(),
                overlapped,
            )
        })? as usize;
        if length == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buffer = &mut buffer[length..];
    }
    Ok(())
}
fn write_all(pipe: HANDLE, stop: HANDLE, mut buffer: &[u8]) -> io::Result<()> {
    let started = Instant::now();
    while !buffer.is_empty() {
        let remaining =
            IO_TIMEOUT.saturating_sub(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
        if remaining == 0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let length = io_operation(pipe, stop, remaining, |overlapped| unsafe {
            WriteFile(
                pipe,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                ptr::null_mut(),
                overlapped,
            )
        })? as usize;
        if length == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        buffer = &buffer[length..];
    }
    Ok(())
}
fn create_pipe(name: &[u16]) -> io::Result<Handle> {
    let sid = user_sid(unsafe { GetCurrentProcess() })?;
    // Protected ACL: only this user. Medium integrity permits a normal browser
    // launch, but not low-integrity sandbox processes. Remote clients are denied.
    // Elevated tokens may default to Administrators as owner. Bind ownership to
    // our TokenUser atomically so ordinary clients can verify this object without
    // querying Electron's protected elevated process token.
    create_pipe_with_security(name, &format!("O:{sid}D:P(A;;GA;;;{sid})S:(ML;;NW;;;ME)"))
}
fn create_pipe_with_security(name: &[u16], sddl: &str) -> io::Result<Handle> {
    let sddl = wide(sddl);
    let mut descriptor = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let result = owned(unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            MAX_MESSAGE as u32,
            MAX_MESSAGE as u32,
            0,
            &attributes,
        )
    });
    unsafe {
        LocalFree(descriptor);
    }
    result
}

#[napi]
pub struct DeepLinkServer {
    stop: Arc<Handle>,
}
#[napi]
impl DeepLinkServer {
    #[napi]
    pub fn close(&self) {
        unsafe {
            SetEvent(self.stop.0);
        }
    }
}
impl Drop for DeepLinkServer {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
pub fn is_process_elevated() -> napi::Result<bool> {
    elevated(unsafe { GetCurrentProcess() }).map_err(failure)
}

#[napi]
pub fn start_deep_link_server(
    env: Env,
    scope: String,
    receive: JsFunction,
) -> napi::Result<DeepLinkServer> {
    if !is_process_elevated()? {
        return Err(failure("listener requires an elevated primary"));
    }
    // Create synchronously after main acquires the Electron lock; avoid adding
    // asynchronous setup here. The tiny lock-to-pipe startup window remains a
    // best-effort boundary. Never steal an existing pipe.
    let pipe = create_pipe(&pipe_name(&scope).map_err(failure)?).map_err(failure)?;
    let stop = Arc::new(event().map_err(failure)?);
    let worker_stop = stop.clone();
    let mut callback: ThreadsafeFunction<String, ErrorStrategy::Fatal> = receive
        .create_threadsafe_function(16, |ctx: ThreadSafeCallContext<String>| {
            Ok(vec![ctx.env.create_string(&ctx.value)?])
        })?;
    callback.unref(&env)?;
    thread::Builder::new()
        .name("deep-link-handoff".into())
        .spawn(move || {
            // Move the owned handle, not just its raw pointer (Rust disjoint capture).
            let pipe = pipe;
            loop {
                if let Err(error) =
                    io_operation(pipe.0, worker_stop.0, INFINITE, |overlapped| unsafe {
                        ConnectNamedPipe(pipe.0, overlapped)
                    })
                {
                    // A client can disconnect between CreateFile and accept.
                    // That must not permanently disable links until app restart.
                    if error.raw_os_error() == Some(ERROR_NO_DATA as i32) {
                        unsafe {
                            DisconnectNamedPipe(pipe.0);
                        }
                        continue;
                    }
                    break;
                }
                let _ = (|| -> io::Result<()> {
                    verified_peer(pipe.0, false)?;
                    let mut header = [0u8; 4];
                    read_exact(pipe.0, worker_stop.0, &mut header)?;
                    let length = u32::from_le_bytes(header) as usize;
                    if length == 0 || length > MAX_MESSAGE {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    let mut bytes = vec![0u8; length];
                    read_exact(pipe.0, worker_stop.0, &mut bytes)?;
                    let message =
                        String::from_utf8(bytes).map_err(|_| io::ErrorKind::InvalidData)?;
                    // ACK means queued to the owning main, not invitation accepted
                    // or OAuth completed. Existing main validation still decides.
                    let queued = callback.call(message, ThreadsafeFunctionCallMode::NonBlocking)
                        == Status::Ok;
                    write_all(pipe.0, worker_stop.0, &[u8::from(queued)])?;
                    // Disconnect discards unread pipe data. Wait for the client to
                    // consume the receipt, bounded like every other client IO.
                    let mut consumed = [0u8];
                    read_exact(pipe.0, worker_stop.0, &mut consumed)
                })();
                unsafe {
                    DisconnectNamedPipe(pipe.0);
                }
            }
        })
        .map_err(failure)?;
    Ok(DeepLinkServer { stop })
}

fn process_image(process: HANDLE) -> io::Result<Vec<u16>> {
    let mut buffer = vec![0u16; 32_768];
    let mut length = buffer.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    Ok(buffer)
}
fn verified_peer(pipe: HANDLE, server: bool) -> io::Result<u32> {
    let mut pid = 0;
    let identified = unsafe {
        if server {
            GetNamedPipeServerProcessId(pipe, &mut pid)
        } else {
            GetNamedPipeClientProcessId(pipe, &mut pid)
        }
    };
    if identified == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
    let current = unsafe { GetCurrentProcess() };
    let mut server_session = 0;
    let mut current_session = 0;
    let peer_image = process_image(process.0)?;
    let current_image = process_image(current)?;
    let same_image = unsafe {
        CompareStringOrdinal(
            peer_image.as_ptr(),
            peer_image.len() as i32,
            current_image.as_ptr(),
            current_image.len() as i32,
            1,
        )
    } == CSTR_EQUAL;
    // Electron can deny TOKEN_QUERY from a normal process to its elevated main.
    // Server identity uses the connected pipe's explicit owner, together with
    // the kernel PID/session/image below. start_deep_link_server only creates a
    // listener when elevated, and always assigns its own TokenUser as owner.
    // The elevated receiver can still check the client's actual process token.
    let peer_user = if server {
        pipe_owner_sid(pipe)?
    } else {
        user_sid(process.0)?
    };
    if unsafe { ProcessIdToSessionId(pid, &mut server_session) } == 0
        || unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session) } == 0
        || server_session != current_session
        || peer_user != user_sid(current)?
        || !same_image
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "pipe owner mismatch",
        ));
    }
    Ok(pid)
}

#[napi]
pub fn send_deep_link(scope: String, message: String) -> napi::Result<bool> {
    if message.is_empty() || message.len() > MAX_MESSAGE || is_process_elevated()? {
        return Ok(false);
    }
    let name = pipe_name(&scope).map_err(failure)?;
    // No impersonation privilege is lent to a possible pipe squatter. Verify
    // owner user/session/image before transmitting any invitation or API key.
    let started = Instant::now();
    let pipe = loop {
        match owned(unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        }) {
            Ok(pipe) => break pipe,
            Err(error) => {
                let remaining = IO_TIMEOUT
                    .saturating_sub(started.elapsed().as_millis().min(u32::MAX as u128) as u32);
                if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32)
                    || remaining == 0
                    || unsafe { WaitNamedPipeW(name.as_ptr(), remaining) } == 0
                {
                    return Ok(false);
                }
            }
        }
    };
    let pid = verified_peer(pipe.0, true).map_err(failure)?;
    // The protocol-launch process owns the browser's foreground permission.
    // Pass it to the already-running instance instead of forcibly stealing focus.
    unsafe {
        AllowSetForegroundWindow(pid);
    }
    let stop = event().map_err(failure)?;
    let bytes = message.as_bytes();
    write_all(pipe.0, stop.0, &(bytes.len() as u32).to_le_bytes()).map_err(failure)?;
    write_all(pipe.0, stop.0, bytes).map_err(failure)?;
    let mut reply = [0u8];
    read_exact(pipe.0, stop.0, &mut reply).map_err(failure)?;
    let _ = write_all(pipe.0, stop.0, &[1]);
    Ok(reply == [1])
}

#[cfg(test)]
mod tests {
    use super::*;

    // Integration tier: real kernel pipe ownership, not a mock of the checker.
    // Regression: replacing protected-token queries must still reject an owner
    // mismatch even when its DACL allows connection and its PID/image match.
    // Existing Node/Electron transport tests only create legitimate listeners.
    #[test]
    #[ignore = "requires an elevated Windows integration shell; run --include-ignored"]
    fn connected_server_requires_current_user_owner() {
        assert!(is_process_elevated().unwrap());
        let current_sid = user_sid(unsafe { GetCurrentProcess() }).unwrap();
        for (index, owner) in [current_sid.as_str(), "BA"].iter().enumerate() {
            let scope = format!(
                "{:064x}",
                (unsafe { GetCurrentProcessId() } as u64) * 2 + index as u64
            );
            let name = pipe_name(&scope).unwrap();
            let _server = create_pipe_with_security(
                &name,
                &format!("O:{owner}D:P(A;;GA;;;{current_sid})S:(ML;;NW;;;ME)"),
            )
            .unwrap();
            let client = owned(unsafe {
                CreateFileW(
                    name.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                )
            })
            .unwrap();
            let verified = verified_peer(client.0, true);
            if index == 0 {
                assert_eq!(verified.unwrap(), unsafe { GetCurrentProcessId() });
            } else {
                assert_eq!(
                    verified.unwrap_err().kind(),
                    io::ErrorKind::PermissionDenied
                );
            }
        }
    }
}
