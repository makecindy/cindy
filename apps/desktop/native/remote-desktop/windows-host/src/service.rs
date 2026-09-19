use crate::{pipe::Pipe, win::*};
use std::{
    io::{self, BufRead, Write},
    mem, ptr,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::DELETE,
    System::{Com::*, JobObjects::*, RemoteDesktop::*, Services::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::*},
};
// Runtime handles guard against PID reuse; the durable grant is the protected
// installation record, never a stale PID from a previous application run.
static AUTHORIZED: Mutex<Vec<(Handle, Vec<Handle>)>> = Mutex::new(Vec::new());
static APPROVAL: Mutex<Option<crate::approval::Approval>> = Mutex::new(None);
static STOP: AtomicBool = AtomicBool::new(false);
static CLIENTS: AtomicUsize = AtomicUsize::new(0);
static STATUS: Mutex<usize> = Mutex::new(0);
struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}
fn manager(access: u32) -> Result<ServiceHandle> {
    let value = unsafe { OpenSCManagerW(ptr::null(), ptr::null(), access) };
    if value.is_null() {
        Err(error())
    } else {
        Ok(ServiceHandle(value))
    }
}
fn service(manager: &ServiceHandle, access: u32) -> Result<ServiceHandle> {
    let value = unsafe { OpenServiceW(manager.0, wide(&crate::service_name()?).as_ptr(), access) };
    if value.is_null() {
        Err(error())
    } else {
        Ok(ServiceHandle(value))
    }
}
fn query_status(service: &ServiceHandle) -> Result<SERVICE_STATUS_PROCESS> {
    let mut status: SERVICE_STATUS_PROCESS = unsafe { mem::zeroed() };
    let mut size = 0;
    if unsafe {
        QueryServiceStatusEx(
            service.0,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            mem::size_of_val(&status) as u32,
            &mut size,
        )
    } == 0
    {
        return Err(error());
    }
    Ok(status)
}

fn process_id(status: &SERVICE_STATUS_PROCESS) -> Option<u32> {
    (status.dwProcessId != 0).then_some(status.dwProcessId)
}

pub fn pid() -> Result<u32> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service = service(&manager, SERVICE_QUERY_STATUS)?;
    let status = query_status(&service)?;
    if status.dwCurrentState != SERVICE_RUNNING {
        return denied();
    }
    process_id(&status).ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}

pub fn registered() -> Result<bool> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    match service(&manager, SERVICE_QUERY_STATUS) {
        Ok(_) => Ok(true),
        Err(error) if error.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => Ok(false),
        Err(error) => Err(error),
    }
}
pub fn install() -> Result<()> {
    crate::security::require_elevated()?;
    let manager = manager(SC_MANAGER_CREATE_SERVICE | SC_MANAGER_CONNECT)?;
    let installation = crate::installation::Installation::current()?;
    let name = wide(&installation.name);
    let display_name = wide(&format!(
        "Cindy Remote Desktop ({})",
        &installation.name[19..]
    ));
    let executable = installation.binary();
    let _guard = crate::security::check_paths(vec![executable.clone()])?;
    let command = wide(&format!("\"{}\" --service", executable.display()));
    let raw = unsafe {
        CreateServiceW(
            manager.0,
            name.as_ptr(),
            display_name.as_ptr(),
            SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_STOP | DELETE,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_NORMAL,
            command.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
        )
    };
    let created = !raw.is_null();
    let installed = if raw.is_null() {
        if unsafe { GetLastError() } != ERROR_SERVICE_EXISTS {
            return Err(error());
        }
        service(&manager, SERVICE_START | SERVICE_QUERY_STATUS)?
    } else {
        ServiceHandle(raw)
    };
    let start_error = if unsafe { StartServiceW(installed.0, 0, ptr::null()) } == 0 {
        let code = unsafe { GetLastError() };
        (code != ERROR_SERVICE_ALREADY_RUNNING).then(|| io::Error::from_raw_os_error(code as i32))
    } else {
        None
    };
    if start_error.is_none() {
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if pid().is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // A newly created AUTO_START service must not remain registered if it never
    // reached RUNNING. An already-registered service is left for the next update.
    if created {
        let mut status: SERVICE_STATUS = unsafe { mem::zeroed() };
        let _ = unsafe { ControlService(installed.0, SERVICE_CONTROL_STOP, &mut status) };
        let _ = unsafe { DeleteService(installed.0) };
    }
    Err(start_error.unwrap_or_else(|| io::Error::from(io::ErrorKind::TimedOut)))
}
pub fn uninstall() -> Result<()> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service = match service(&manager, SERVICE_STOP | DELETE | SERVICE_QUERY_STATUS) {
        Ok(s) => s,
        Err(e) if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => return Ok(()),
        Err(e) => return Err(e),
    };
    let running_process = query_status(&service)
        .ok()
        .and_then(|status| process_id(&status))
        .and_then(|id| process(id).ok());
    let mut status: SERVICE_STATUS = unsafe { mem::zeroed() };
    if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) } == 0
        && unsafe { GetLastError() } != ERROR_SERVICE_NOT_ACTIVE
    {
        return Err(error());
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
            return Err(error());
        }
        if status.dwCurrentState == SERVICE_STOPPED {
            break;
        }
        if Instant::now() >= deadline {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if unsafe { DeleteService(service.0) } == 0 {
        return Err(error());
    }
    if let Some(process) = running_process {
        if unsafe { WaitForSingleObject(process.0, 15000) } != WAIT_OBJECT_0 {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
    }
    Ok(())
}
pub fn elevate(command: &str) -> Result<()> {
    let executable = wide(&std::env::current_exe()?.to_string_lossy());
    let verb = wide("runas");
    let parameters = wide(command);
    let mut info: SHELLEXECUTEINFOW = unsafe { mem::zeroed() };
    info.cbSize = mem::size_of_val(&info) as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = executable.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(error());
    }
    let process = Handle::new(info.hProcess)?;
    if unsafe { WaitForSingleObject(process.0, 120000) } != WAIT_OBJECT_0 {
        return Err(io::Error::from(io::ErrorKind::TimedOut));
    }
    let mut code = 1;
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 || code != 0 {
        return denied();
    }
    Ok(())
}
fn status(state: u32) {
    let handle = *STATUS.lock().unwrap() as SERVICE_STATUS_HANDLE;
    if handle.is_null() {
        return;
    }
    let value = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: if state == SERVICE_STOP_PENDING {
            15000
        } else {
            0
        },
    };
    unsafe {
        SetServiceStatus(handle, &value);
    }
}
unsafe extern "system" fn control(
    code: u32,
    _event: u32,
    _data: *mut core::ffi::c_void,
    _context: *mut core::ffi::c_void,
) -> u32 {
    if code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN {
        STOP.store(true, Ordering::SeqCst);
        status(SERVICE_STOP_PENDING);
    }
    0
}
unsafe extern "system" fn entry(_argc: u32, _argv: *mut *mut u16) {
    let Ok(name) = crate::service_name() else {
        return;
    };
    let handle =
        RegisterServiceCtrlHandlerExW(wide(&name).as_ptr(), Some(control), ptr::null_mut());
    if handle.is_null() {
        return;
    }
    *STATUS.lock().unwrap() = handle as usize;
    if crate::security::allow_service_identity_queries().is_err() {
        status(SERVICE_STOPPED);
        return;
    }
    let Ok(_installation) = crate::security::protected_service() else {
        status(SERVICE_STOPPED);
        return;
    };
    let Ok(approval) = crate::approval::Approval::read() else {
        status(SERVICE_STOPPED);
        return;
    };
    *APPROVAL.lock().unwrap() = Some(approval);
    status(SERVICE_RUNNING);
    while !STOP.load(Ordering::SeqCst) {
        // A closed Cindy releases its code handles, not the installed grant.
        // This also allows the normal installer to replace a stopped app.
        AUTHORIZED
            .lock()
            .unwrap()
            .retain(|(main, _)| unsafe { WaitForSingleObject(main.0, 0) == WAIT_TIMEOUT });

        if CLIENTS.load(Ordering::SeqCst) >= 3 {
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let Ok(mut pipe) = Pipe::server(&crate::pipe_name().unwrap(), false) else {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        };
        pipe.shutdown = Some(&STOP);
        if pipe.accept(500).is_err() {
            continue;
        }
        if CLIENTS.fetch_add(1, Ordering::SeqCst) >= 4 {
            CLIENTS.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        std::thread::spawn(move || {
            let _ = serve(pipe);
            CLIENTS.fetch_sub(1, Ordering::SeqCst);
        });
    }
    // Existing clients have finite I/O deadlines; service process exit is also
    // a kernel-enforced job-close boundary for every worker and input child.
    let until = Instant::now() + Duration::from_secs(12);
    while CLIENTS.load(Ordering::SeqCst) > 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    status(SERVICE_STOPPED);
}
pub fn run() -> Result<()> {
    let name = wide(&crate::service_name()?);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: name.as_ptr().cast_mut(),
            lpServiceProc: Some(entry),
        },
        SERVICE_TABLE_ENTRYW {
            lpServiceName: ptr::null_mut(),
            lpServiceProc: None,
        },
    ];
    if unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } == 0 {
        Err(error())
    } else {
        Ok(())
    }
}

fn enable_session_privilege() -> Result<()> {
    let mut raw = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut raw,
        )
    } == 0
    {
        return Err(error());
    }
    let token = Handle::new(raw)?;
    let mut luid = unsafe { mem::zeroed() };
    if unsafe { LookupPrivilegeValueW(ptr::null(), wide("SeTcbPrivilege").as_ptr(), &mut luid) }
        == 0
    {
        return Err(error());
    }
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    if unsafe {
        AdjustTokenPrivileges(token.0, 0, &privileges, 0, ptr::null_mut(), ptr::null_mut())
    } == 0
        || unsafe { GetLastError() } == ERROR_NOT_ALL_ASSIGNED
    {
        return Err(error());
    }
    Ok(())
}
fn spawn_worker(name: &str, session: u32) -> Result<(Handle, Handle, u32)> {
    enable_session_privilege()?;
    let mut original = ptr::null_mut();
    if unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut original,
        )
    } == 0
    {
        return Err(error());
    }
    let original = Handle::new(original)?;
    let mut raw = ptr::null_mut();
    if unsafe {
        DuplicateTokenEx(
            original.0,
            TOKEN_ALL_ACCESS,
            ptr::null(),
            SecurityImpersonation,
            TokenPrimary,
            &mut raw,
        )
    } == 0
    {
        return Err(error());
    }
    let token = Handle::new(raw)?;
    if unsafe { SetTokenInformation(token.0, TokenSessionId, (&session as *const u32).cast(), 4) }
        == 0
    {
        return Err(error());
    }
    let job = Handle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(error());
    }
    let executable = std::env::current_exe()?;
    let path = wide(&executable.to_string_lossy());
    let mut command = wide(&format!("\"{}\" --worker {}", executable.display(), name));
    let desktop = wide("winsta0\\default");
    let mut startup: STARTUPINFOW = unsafe { mem::zeroed() };
    startup.cb = mem::size_of_val(&startup) as u32;
    startup.lpDesktop = desktop.as_ptr().cast_mut();
    let mut process: PROCESS_INFORMATION = unsafe { mem::zeroed() };
    if unsafe {
        CreateProcessAsUserW(
            token.0,
            path.as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            ptr::null(),
            wide(&executable.parent().unwrap().to_string_lossy()).as_ptr(),
            &startup,
            &mut process,
        )
    } == 0
    {
        return Err(error());
    }
    let thread = Handle::new(process.hThread)?;
    let child = Handle::new(process.hProcess)?;
    if unsafe { AssignProcessToJobObject(job.0, child.0) } == 0 {
        unsafe {
            TerminateProcess(child.0, 1);
        }
        return Err(error());
    }
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(error());
    }
    Ok((job, child, process.dwProcessId))
}
fn serve(mut client: Pipe) -> Result<()> {
    let caller = process(client.client_pid()?)?;
    if unsafe { WaitForSingleObject(caller.0, 0) } != WAIT_TIMEOUT {
        return denied();
    }
    let init = client.line(1024)?;
    if unsafe { WaitForSingleObject(caller.0, 0) } != WAIT_TIMEOUT {
        return denied();
    }
    let parsed: serde_json::Value = serde_json::from_slice(&init)?;
    if !matches!(parsed["mode"].as_str(), Some("probe" | "input" | "capture")) {
        return denied();
    }
    let (owner, session) = authorize_connection(caller)?;
    if parsed["mode"] == "probe" {
        return client.write(b"ready\n");
    }
    if parsed["mode"] != "input" && parsed["mode"] != "capture" {
        return denied();
    }
    let mut guid = unsafe { mem::zeroed() };
    if unsafe { CoCreateGuid(&mut guid) } < 0 {
        return denied();
    }
    let name = format!(
        r"\\.\pipe\{}-{:08x}{:04x}{:04x}{:02x?}",
        crate::service_name()?,
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4
    )
    .replace([',', ' ', '[', ']'], "");
    let mut worker = Pipe::server(&name, true)?;
    worker.shutdown = Some(&STOP);
    let (job, child, pid) = spawn_worker(&name, session)?;
    let mut worker = Worker {
        pipe: Some(worker),
        child,
        job,
    };
    worker.accept(5000)?;
    if worker.client_pid()? != pid {
        return denied();
    }
    worker.write(&init)?;
    client.write(&worker.line(1024)?)?;
    let mut held = std::collections::HashSet::<String>::new();
    loop {
        let request = client.line(32768)?;
        if STOP.load(Ordering::SeqCst)
            || unsafe { WaitForSingleObject(owner.0, 0) } != WAIT_TIMEOUT
            || session != unsafe { WTSGetActiveConsoleSessionId() }
        {
            return denied();
        }
        if parsed["mode"] == "input" {
            let events: Vec<serde_json::Value> = serde_json::from_slice(&request)?;
            if events.len() > 64 {
                return denied();
            }
            for event in events {
                if event["kind"] == "release" {
                    held.clear();
                }
                if event["kind"] == "key" {
                    if let (Some(code), Some(down)) =
                        (event["code"].as_str(), event["down"].as_bool())
                    {
                        if down
                            && code == "Delete"
                            && (held.contains("ControlLeft") || held.contains("ControlRight"))
                            && (held.contains("AltLeft") || held.contains("AltRight"))
                        {
                            worker.write(b"[{\"kind\":\"release\"}]\n")?;
                            worker.line(1024)?;
                            send_sas(&owner)?;
                            // Drop this input generation, including all pending batches.
                            worker.retire()?;
                            drop(worker);
                            return client.write(b"desktop_changed\n");
                        }
                        if down {
                            held.insert(code.to_owned());
                        } else {
                            held.remove(code);
                        }
                        if held.len() > 256 {
                            return denied();
                        }
                    }
                }
            }
        }
        worker.write(&request)?;
        let response = worker.line(crate::capture_protocol::response_limit(&parsed))?;
        if session != unsafe { WTSGetActiveConsoleSessionId() } || STOP.load(Ordering::SeqCst) {
            return denied();
        }
        if unsafe { WaitForSingleObject(owner.0, 0) } != WAIT_TIMEOUT {
            return denied();
        }
        if parsed["mode"] == "input" && response == b"desktop_changed\n" {
            // The acknowledgement also certifies that the old worker/job is
            // gone, so Main can safely establish a fresh input generation.
            worker.retire()?;
            drop(worker);
            return client.write(b"desktop_changed\n");
        }
        client.write_response(&response, &parsed)?;
    }
}
struct Worker {
    pipe: Option<Pipe>,
    child: Handle,
    job: Handle,
}
impl std::ops::Deref for Worker {
    type Target = Pipe;
    fn deref(&self) -> &Pipe {
        self.pipe.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for Worker {
    fn deref_mut(&mut self) -> &mut Pipe {
        self.pipe.as_mut().unwrap()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.retire();
    }
}
impl Worker {
    fn retire(&mut self) -> Result<()> {
        drop(self.pipe.take());
        unsafe {
            if WaitForSingleObject(self.child.0, 1200) != WAIT_OBJECT_0 {
                if TerminateJobObject(self.job.0, 1) == 0 {
                    return Err(error());
                }
                if WaitForSingleObject(self.child.0, 5000) != WAIT_OBJECT_0 {
                    return Err(io::Error::from(io::ErrorKind::TimedOut));
                }
            }
        }
        Ok(())
    }
}
struct InputChild(std::process::Child);
impl Drop for InputChild {
    fn drop(&mut self) {
        if let Some(mut input) = self.0.stdin.take() {
            let _ = input.write_all(b"[{\"kind\":\"release\"}]\n");
        }
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until {
            if self.0.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
pub fn worker(name: &str) -> Result<()> {
    if !system(token(unsafe { GetCurrentProcess() })?.0)?
        || !name.starts_with(&format!(r"\\.\pipe\{}-", crate::service_name()?))
    {
        return denied();
    }
    let mut pipe = Pipe::client(name)?;
    if pipe.server_pid()? != pid()? {
        return denied();
    }
    let init: serde_json::Value = serde_json::from_slice(&pipe.line(1024)?)?;
    if init["mode"] == "capture" {
        let mut capture = crate::capture::Capture::new(&init)?;
        pipe.write(b"ready\n")?;
        loop {
            if pipe.line(16)? != b"f\n" {
                return denied();
            }
            pipe.write_response(&capture.frame()?, &init)?;
        }
    }
    if init["mode"] != "input" {
        return denied();
    }
    let binary = std::env::current_exe()?.with_file_name("cindy-windows-desktop-input.exe");
    use std::os::windows::process::CommandExt;
    let mut child = InputChild(
        std::process::Command::new(binary)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()?,
    );
    let mut reader = io::BufReader::new(child.0.stdout.take().ok_or_else(error)?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if line != "ready\n" {
        return denied();
    }
    pipe.write(b"ready\n")?;
    loop {
        let line = pipe.line(32768)?;
        let events: Vec<serde_json::Value> = serde_json::from_slice(&line)?;
        if events.len() > 64 {
            return denied();
        }
        child.0.stdin.as_mut().ok_or_else(error)?.write_all(&line)?;
        // A pipe write is not input completion. Do not let Agent input overlap
        // a remote text batch still being applied by the worker.
        let mut acknowledgement = String::new();
        reader.read_line(&mut acknowledgement)?;
        if acknowledgement == "desktop_changed\n" {
            return pipe.write(b"desktop_changed\n");
        }
        if acknowledgement != "ok\n" {
            return denied();
        }
        pipe.write(b"ok\n")?;
    }
}

fn authorize_connection(caller: Handle) -> Result<(Handle, u32)> {
    let pid = pid_of(caller.0)?;
    let approval = APPROVAL.lock().map_err(|_| error())?;
    let approval = approval.as_ref().ok_or_else(error)?;
    let (owner, session) = crate::security::authorize_client_process(
        caller,
        &approval.application,
        Some(&approval.user_sid),
    )?;
    let mut authorized = AUTHORIZED.lock().map_err(|_| error())?;
    authorized.retain(|(main, _)| unsafe { WaitForSingleObject(main.0, 0) == WAIT_TIMEOUT });
    if !authorized
        .iter()
        .any(|(main, _)| pid_of(main.0).ok() == Some(pid))
    {
        if authorized.len() >= 8 {
            return denied();
        }
        let (main, _, guards) = approval.authorize(&owner)?;
        authorized.push((main, guards));
    }
    Ok((owner, session))
}

pub fn installed_pid() -> Result<u32> {
    let pid = pid()?;
    let process = process(pid)?;
    if !system(token(process.0)?.0)?
        || !crate::security::same_file(
            &image(process.0)?,
            &crate::installation::Installation::current()?.binary(),
        )
    {
        return denied();
    }
    Ok(pid)
}

fn send_sas(owner: &Handle) -> Result<()> {
    let mut raw = ptr::null_mut();
    if unsafe { OpenProcessToken(owner.0, TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) } == 0 {
        return Err(error());
    }
    let original = Handle::new(raw)?;
    let mut raw = ptr::null_mut();
    if unsafe {
        DuplicateTokenEx(
            original.0,
            TOKEN_QUERY | TOKEN_IMPERSONATE,
            ptr::null(),
            SecurityImpersonation,
            TokenImpersonation,
            &mut raw,
        )
    } == 0
    {
        return Err(error());
    }
    let impersonation = Handle::new(raw)?;
    if unsafe { SetThreadToken(ptr::null(), impersonation.0) } == 0 {
        return Err(error());
    }
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            unsafe {
                RevertToSelf();
            }
        }
    }
    let _revert = Revert;
    // Windows policy decides whether software SAS is permitted. Never change it.
    unsafe {
        windows_sys::Win32::Security::Authentication::Identity::SendSAS(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn status_distinguishes_registration_from_a_running_pid() {
        let source = include_str!("service.rs");
        assert!(source.contains("pub fn registered()"));
        assert!(source.contains("ERROR_SERVICE_DOES_NOT_EXIST"));
        let pid = source.split("pub fn pid()").nth(1).unwrap();
        assert!(pid.contains("SERVICE_RUNNING"));
        let registered = source
            .split("pub fn registered() -> Result<bool>")
            .nth(1)
            .unwrap()
            .split("pub fn install()")
            .next()
            .unwrap();
        assert!(registered.contains("ERROR_SERVICE_DOES_NOT_EXIST"));
    }
    #[test]
    fn pipe_client_process_is_opened_before_the_init_read() {
        let serve = include_str!("service.rs")
            .split("fn serve(")
            .nth(1)
            .unwrap()
            .split("fn authorize_connection")
            .next()
            .unwrap();
        assert!(
            serve.find("process(client.client_pid()?)").unwrap()
                < serve.find("client.line(1024)").unwrap()
        );
        assert!(serve.contains("authorize_connection(caller)"));
        assert!(!serve.contains("authorize_connection(caller_pid)"));
    }
}
