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
static AUTHORIZED: Mutex<Option<Handle>> = Mutex::new(None);
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
pub fn pid() -> Result<u32> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service = service(&manager, SERVICE_QUERY_STATUS)?;
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
        || status.dwCurrentState != SERVICE_RUNNING
        || status.dwProcessId == 0
    {
        return denied();
    }
    Ok(status.dwProcessId)
}
pub fn install() -> Result<()> {
    let _guard = crate::security::protected_install()?;
    let manager = manager(SC_MANAGER_CREATE_SERVICE | SC_MANAGER_CONNECT)?;
    let name = wide(&crate::service_name()?);
    let executable = std::env::current_exe()?;
    let command = wide(&format!("\"{}\" --service", executable.display()));
    let raw = unsafe {
        CreateServiceW(
            manager.0,
            name.as_ptr(),
            wide("Cindy Remote Desktop").as_ptr(),
            SERVICE_START | SERVICE_QUERY_STATUS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_DEMAND_START,
            SERVICE_ERROR_NORMAL,
            command.as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
        )
    };
    let installed = if raw.is_null() {
        if unsafe { GetLastError() } != ERROR_SERVICE_EXISTS {
            return Err(error());
        }
        service(&manager, SERVICE_START | SERVICE_QUERY_STATUS)?
    } else {
        ServiceHandle(raw)
    };
    if unsafe { StartServiceW(installed.0, 0, ptr::null()) } == 0
        && unsafe { GetLastError() } != ERROR_SERVICE_ALREADY_RUNNING
    {
        return Err(error());
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if pid().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(io::Error::from(io::ErrorKind::TimedOut))
}
pub fn uninstall() -> Result<()> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service = match service(&manager, SERVICE_STOP | DELETE | SERVICE_QUERY_STATUS) {
        Ok(s) => s,
        Err(e) if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => return Ok(()),
        Err(e) => return Err(e),
    };
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
    Ok(())
}
pub fn elevate(command: &str) -> Result<()> {
    let _guard = crate::security::protected_install()?;
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
    let Ok(_installation) = crate::security::protected_install() else {
        status(SERVICE_STOPPED);
        return;
    };
    status(SERVICE_RUNNING);
    let registration_deadline = Instant::now() + Duration::from_secs(30);
    while !STOP.load(Ordering::SeqCst) {
        let should_stop = match AUTHORIZED.lock() {
            Ok(authorized) => match authorized.as_ref() {
                Some(main) => unsafe { WaitForSingleObject(main.0, 0) != WAIT_TIMEOUT },
                None => Instant::now() >= registration_deadline,
            },
            Err(_) => true,
        };
        if should_stop {
            STOP.store(true, Ordering::SeqCst);
            status(SERVICE_STOP_PENDING);
            break;
        }

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
    let init = client.line(1024)?;
    let parsed: serde_json::Value = serde_json::from_slice(&init)?;
    if parsed["mode"] == "authorize" {
        // Only the fixed UAC-elevated setup executable may register a process.
        let caller_token = token(caller.0)?;
        let mut elevation: TOKEN_ELEVATION = unsafe { mem::zeroed() };
        let mut needed = 0;
        if !crate::security::same_file(&image(caller.0)?, &std::env::current_exe()?)
            || unsafe {
                GetTokenInformation(
                    caller_token.0,
                    TokenElevation,
                    (&mut elevation as *mut TOKEN_ELEVATION).cast(),
                    mem::size_of_val(&elevation) as u32,
                    &mut needed,
                )
            } == 0
            || elevation.TokenIsElevated == 0
        {
            return denied();
        }
        let main_pid = parsed["pid"]
            .as_u64()
            .filter(|p| *p <= u32::MAX as u64)
            .ok_or_else(error)? as u32;
        let (main, _) = crate::security::authorize_client(main_pid)?;
        *AUTHORIZED.lock().map_err(|_| error())? = Some(main);
        return client.write(b"ready\n");
    }
    {
        let authorized = AUTHORIZED.lock().map_err(|_| error())?;
        let main = authorized.as_ref().ok_or_else(error)?;
        if unsafe { WaitForSingleObject(main.0, 0) } != WAIT_TIMEOUT
            || unsafe { GetProcessId(main.0) } != client.client_pid()?
        {
            return denied();
        }
    }
    let (owner, session) = crate::security::authorize_client(client.client_pid()?)?;
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
        {
            let authorized = AUTHORIZED.lock().map_err(|_| error())?;
            if !authorized.as_ref().is_some_and(|main| unsafe {
                WaitForSingleObject(main.0, 0) == WAIT_TIMEOUT
                    && GetProcessId(main.0) == GetProcessId(owner.0)
            }) {
                return denied();
            }
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
                            client.write(b"ok\n")?;
                            // Drop this input generation, including all pending batches.
                            return Ok(());
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
        let response = worker.line(240001)?;
        if session != unsafe { WTSGetActiveConsoleSessionId() } || STOP.load(Ordering::SeqCst) {
            return denied();
        }
        {
            let authorized = AUTHORIZED.lock().map_err(|_| error())?;
            if !authorized.as_ref().is_some_and(|main| unsafe {
                WaitForSingleObject(main.0, 0) == WAIT_TIMEOUT
                    && GetProcessId(main.0) == GetProcessId(owner.0)
            }) {
                return denied();
            }
        }
        client.write(&response)?;
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
        drop(self.pipe.take());
        unsafe {
            if WaitForSingleObject(self.child.0, 1200) != WAIT_OBJECT_0 {
                TerminateJobObject(self.job.0, 1);
            }
        }
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
        let mut capture = crate::capture::Capture::new(&init["rect"])?;
        pipe.write(b"ready\n")?;
        loop {
            if pipe.line(16)? != b"f\n" {
                return denied();
            }
            pipe.write(&capture.frame()?)?;
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
    // Observe input failure without blocking normal per-batch replies.
    let failed = std::sync::Arc::new(AtomicBool::new(false));
    let output = failed.clone();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        output.store(true, Ordering::SeqCst);
    });
    loop {
        let line = pipe.line(32768)?;
        if failed.load(Ordering::SeqCst) {
            return denied();
        }
        let events: Vec<serde_json::Value> = serde_json::from_slice(&line)?;
        if events.len() > 64 {
            return denied();
        }
        child.0.stdin.as_mut().ok_or_else(error)?.write_all(&line)?;
        pipe.write(b"ok\n")?;
    }
}

pub fn authorize(main_pid: u32) -> Result<()> {
    let mut pipe = Pipe::client(&crate::pipe_name()?)?;
    let server = process(pipe.server_pid()?)?;
    if !system(token(server.0)?.0)?
        || !crate::security::same_file(&image(server.0)?, &std::env::current_exe()?)
        || pipe.server_pid()? != pid()?
    {
        return denied();
    }
    pipe.write(format!("{{\"mode\":\"authorize\",\"pid\":{main_pid}}}\n").as_bytes())?;
    if pipe.line(1024)? != b"ready\n" {
        return denied();
    }
    Ok(())
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
