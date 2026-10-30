use crate::naming::{InstallRecord, Installation, StagedCopy};
use crate::{pipe::Pipe, win::*};
use base64::Engine;
use sha2::{Digest, Sha256};
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
/// The installation this running service accepts clients from, taken from the
/// record in its own protected directory once that directory has been checked.
static INSTALL: Mutex<Option<InstallRecord>> = Mutex::new(None);

/// The installation the running service serves, or a refusal if it never
/// finished validating one.
fn approved_install() -> Result<InstallRecord> {
    match INSTALL.lock().map_err(|_| error())?.as_ref() {
        Some(install) => Ok(install.clone()),
        None => denied(),
    }
}
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
fn service(manager: &ServiceHandle, name: &str, access: u32) -> Result<ServiceHandle> {
    let value = unsafe { OpenServiceW(manager.0, wide(name).as_ptr(), access) };
    if value.is_null() {
        Err(error())
    } else {
        Ok(ServiceHandle(value))
    }
}
pub fn pid(name: &str) -> Result<u32> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let service = service(&manager, name, SERVICE_QUERY_STATUS)?;
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
/// Registers and starts the service for one installation, running the staged
/// copy rather than the executable inside the installation.
pub fn install(installation: &Installation) -> Staged<()> {
    let staged = crate::staging::stage(installation)?;
    install_registered(installation, staged)
}

/// Registers files that were staged by the protected setup bootstrap. The
/// bootstrap is a separate file, so this path never tries to overwrite the
/// executable that is currently running.
pub fn install_staged(installation: &Installation) -> Staged<()> {
    let _handles = crate::security::protected_staging(&installation.staged)?;
    install_registered(installation, installation.host())
}

fn install_registered(installation: &Installation, staged: std::path::PathBuf) -> Staged<()> {
    let manager = manager(SC_MANAGER_CREATE_SERVICE | SC_MANAGER_CONNECT).stage(Step::ScmOpen)?;
    let name = wide(&installation.service());
    // Service display names are also unique in the SCM namespace. Include the
    // installation id so Cindy and CindyDev (or two side-by-side installs)
    // cannot reject each other's registration with
    // ERROR_DUPLICATE_SERVICE_NAME.
    let display_name = wide(&format!("Cindy Remote Desktop ({})", installation.id));
    let command = wide(&format!("\"{}\" --service", staged.display()));
    let raw = unsafe {
        CreateServiceW(
            manager.0,
            name.as_ptr(),
            display_name.as_ptr(),
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
        let code = unsafe { GetLastError() };
        if code != ERROR_SERVICE_EXISTS {
            return Err(Failure::new(Step::ServiceCreate, code as i32));
        }
        // An existing registration may still point at an older staged copy, so
        // update its command line before starting it.
        let existing = service(
            &manager,
            &installation.service(),
            SERVICE_START | SERVICE_QUERY_STATUS | SERVICE_CHANGE_CONFIG,
        )
        .stage(Step::ServiceCreate)?;
        if unsafe {
            ChangeServiceConfigW(
                existing.0,
                SERVICE_NO_CHANGE,
                SERVICE_NO_CHANGE,
                SERVICE_NO_CHANGE,
                command.as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                display_name.as_ptr(),
            )
        } == 0
        {
            return Err(Failure::new(Step::ServiceCreate, last_error()));
        }
        existing
    } else {
        ServiceHandle(raw)
    };
    if unsafe { StartServiceW(installed.0, 0, ptr::null()) } == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_SERVICE_ALREADY_RUNNING {
            return Err(Failure::new(Step::ServiceStart, code as i32));
        }
    }
    // The service validates its own executable before reporting RUNNING, so a
    // refusal there shows up here as a start that never completes.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if pid(&installation.service()).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    refuse(Step::ServiceReady)
}
/// Stops and deregisters one service by name. The staged files are removed
/// separately, after the service that runs them has stopped.
pub fn uninstall(name: &str) -> Staged<()> {
    let manager = manager(SC_MANAGER_CONNECT).stage(Step::ScmOpen)?;
    let service = match service(&manager, name, SERVICE_STOP | DELETE | SERVICE_QUERY_STATUS) {
        Ok(s) => s,
        Err(e) if e.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32) => return Ok(()),
        Err(e) => {
            return Err(Failure::new(
                Step::ServiceStop,
                e.raw_os_error().unwrap_or(0),
            ))
        }
    };
    // SERVICE_STOPPED is reported by the service entry point immediately
    // before it returns. Keep a wait handle for the service process so the
    // staged executable is no longer loaded before its files are replaced.
    let process_handle = {
        let mut process_status: SERVICE_STATUS_PROCESS = unsafe { mem::zeroed() };
        let mut needed = 0;
        let queried = unsafe {
            QueryServiceStatusEx(
                service.0,
                SC_STATUS_PROCESS_INFO,
                (&mut process_status as *mut SERVICE_STATUS_PROCESS).cast(),
                mem::size_of_val(&process_status) as u32,
                &mut needed,
            )
        };
        if queried != 0
            && process_status.dwCurrentState != SERVICE_STOPPED
            && process_status.dwProcessId != 0
        {
            Some(process(process_status.dwProcessId).stage(Step::ServiceStop)?)
        } else {
            None
        }
    };
    let mut status: SERVICE_STATUS = unsafe { mem::zeroed() };
    if unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) } == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_SERVICE_NOT_ACTIVE {
            return Err(Failure::new(Step::ServiceStop, code as i32));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if unsafe { QueryServiceStatus(service.0, &mut status) } == 0 {
            return Err(Failure::new(Step::ServiceStop, last_error()));
        }
        if status.dwCurrentState == SERVICE_STOPPED {
            break;
        }
        if Instant::now() >= deadline {
            return refuse(Step::ServiceStop);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some(process) = process_handle {
        match unsafe { WaitForSingleObject(process.0, 5000) } {
            WAIT_OBJECT_0 => {}
            WAIT_FAILED => return Err(Failure::new(Step::ServiceStop, last_error())),
            _ => return Err(Failure::new(Step::ServiceStop, ERROR_TIMEOUT as i32)),
        }
    }
    if unsafe { DeleteService(service.0) } == 0 {
        return Err(Failure::new(Step::ServiceDelete, last_error()));
    }
    Ok(())
}
/// The OS error number of the call that just failed.
fn last_error() -> i32 {
    unsafe { GetLastError() as i32 }
}
/// Quotes a value for a single-quoted PowerShell literal. The complete script
/// is passed as UTF-16LE base64, so installation paths never become shell code.
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn powershell_script(
    source: &std::path::Path,
    bootstrap: &std::path::Path,
    source_hash: &str,
    input_hash: &str,
    trusted_main: Option<&std::path::Path>,
    child_args: &[String],
    remove_staging: bool,
) -> String {
    let args = child_args.to_vec();
    let source_expr = "('\"' + $source + '\"')";
    let args = args
        .iter()
        .enumerate()
        .map(|(index, value)| {
            if index == 1 {
                source_expr.to_owned()
            } else {
                powershell_literal(value)
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    // A failure raised by this bootstrap itself is its own step. The default
    // exit code 1 would decode as the child's argument check, hiding whether
    // setup or the arguments were wrong. Every refusal throws, so the code is
    // written once and no path or hash rewritten after the fact.
    let failed = Step::ElevateBootstrap as u32 + 1;
    let mut script = format!("$ErrorActionPreference='Stop'; trap {{ exit {failed} }}; $source=");
    script.push_str(&powershell_literal(&source.to_string_lossy()));
    script.push_str("; $bootstrap=");
    script.push_str(&powershell_literal(&bootstrap.to_string_lossy()));
    script.push_str("; $expectedHash=");
    script.push_str(&powershell_literal(source_hash));
    script.push_str("; $expectedInputHash=");
    script.push_str(&powershell_literal(input_hash));
    script.push_str(
        "; $inputPath=Join-Path (Split-Path -Parent $source) 'cindy-windows-desktop-input.exe';",
    );
    if let Some(main) = trusted_main {
        script.push_str(" $main=");
        script.push_str(&powershell_literal(&main.to_string_lossy()));
        script.push_str("; function Get-Signer([string]$Path) { $sig=Get-AuthenticodeSignature -LiteralPath $Path; if ($sig.Status -ne 'Valid' -or $null -eq $sig.SignerCertificate) { return $null }; return $sig.SignerCertificate.Thumbprint.ToUpperInvariant() }; $mainSigner=Get-Signer $main; if ($null -eq $mainSigner) { throw 'setup refused' }; if ((Get-Signer $source) -ne $mainSigner -or (Get-Signer $inputPath) -ne $mainSigner) { throw 'setup refused' };");
    }
    script.push_str("; $bootstrapDir=Split-Path -Parent $bootstrap; $stagingRoot=Split-Path -Parent $bootstrapDir; $programFiles=Split-Path -Parent $stagingRoot;");
    script.push_str(" $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');");
    script.push_str(" $writeMask=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership;");
    script.push_str(" function Test-Protected([string]$Path) { $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop; if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }; $acl=$item.GetAccessControl(); if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { return $false }; foreach ($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { if ($rule.AccessControlType -ne 'Allow' -or (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)) { continue }; $sid=$rule.IdentityReference.Value; if (($trusted -notcontains $sid) -and (($rule.FileSystemRights -band $writeMask) -ne 0)) { return $false } }; return $true };");
    script.push_str(" if (-not (Test-Path -LiteralPath $programFiles) -or -not (Test-Protected $programFiles)) { throw 'setup refused' };");
    script.push_str(" foreach ($dir in @($stagingRoot,$bootstrapDir)) { if (Test-Path -LiteralPath $dir) { if (-not (Test-Protected $dir)) { throw 'setup refused' } } else { New-Item -ItemType Directory -Path $dir -Force | Out-Null }; $security=New-Object System.Security.AccessControl.DirectorySecurity; $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'); Set-Acl -LiteralPath $dir -AclObject $security; if (-not (Test-Protected $dir)) { throw 'setup refused' } };");
    script.push_str(" if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'setup refused' }; if ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedInputHash) { throw 'setup refused' }; $existingBootstrap=Get-Item -LiteralPath $bootstrap -Force -ErrorAction SilentlyContinue; if ($null -ne $existingBootstrap) { if (($existingBootstrap.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'setup refused' }; Remove-Item -LiteralPath $bootstrap -Force }; Copy-Item -LiteralPath $source -Destination $bootstrap -Force; $fileSecurity=New-Object System.Security.AccessControl.FileSecurity; $fileSecurity.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)'); Set-Acl -LiteralPath $bootstrap -AclObject $fileSecurity; if (-not (Test-Protected $bootstrap)) { throw 'setup refused' }; if ((Get-FileHash -LiteralPath $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'setup refused' }; $child=Start-Process -FilePath $bootstrap -ArgumentList @(");
    script.push_str(&args);
    script.push_str(") -Wait -PassThru -WindowStyle Hidden;");
    if remove_staging {
        script.push_str(" if ($child.ExitCode -eq 0) { Remove-Item -LiteralPath $bootstrapDir -Recurse -Force -ErrorAction Stop };");
    }
    script.push_str(" exit $child.ExitCode");
    script
}

fn encode_powershell(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Uses the protected Windows PowerShell binary as the UAC bootstrap. The
/// user-writable helper is copied as data, then only the copy under Program
/// Files is started elevated, so an adjacent VCRUNTIME140.dll cannot be
/// loaded from Cindy's install directory.
pub fn elevate(
    installation: &Installation,
    child_args: &[String],
    trusted_main: Option<&std::path::Path>,
) -> Staged<()> {
    let source = std::env::current_exe().stage(Step::ElevateLaunch)?;
    let _source_lock = read_lock(&source).stage(Step::ElevateLaunch)?;
    let _input_lock =
        read_lock(&source.with_file_name(crate::naming::INPUT_EXE)).stage(Step::ElevateLaunch)?;
    let source_hash = Sha256::digest(std::fs::read(&source).stage(Step::ElevateLaunch)?);
    let source_hash = format!("{source_hash:x}");
    let input_hash = Sha256::digest(
        std::fs::read(source.with_file_name(crate::naming::INPUT_EXE))
            .stage(Step::ElevateLaunch)?,
    );
    let input_hash = format!("{input_hash:x}");
    let mut child_args = child_args.to_vec();
    child_args.insert(1, source.to_string_lossy().into_owned());
    if child_args
        .first()
        .is_some_and(|arg| arg == "--install-from")
    {
        child_args.insert(2, source_hash.clone());
        child_args.insert(3, input_hash.clone());
    }
    let remove_staging = child_args
        .first()
        .is_some_and(|arg| arg == "--uninstall-from");
    let script = powershell_script(
        &source,
        &installation.bootstrap(),
        &source_hash,
        &input_hash,
        trusted_main,
        &child_args,
        remove_staging,
    );
    let powershell_path =
        system_file("WindowsPowerShell\\v1.0\\powershell.exe").stage(Step::ElevateLaunch)?;
    let executable = wide(&powershell_path.to_string_lossy());
    let parameters = wide(&format!(
        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        encode_powershell(&script)
    ));
    let verb = wide("runas");
    let mut info: SHELLEXECUTEINFOW = unsafe { mem::zeroed() };
    info.cbSize = mem::size_of_val(&info) as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = executable.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(Failure::new(Step::ElevateLaunch, last_error()));
    }
    let process = Handle::new(info.hProcess).stage(Step::ElevateLaunch)?;
    if unsafe { WaitForSingleObject(process.0, 120000) } != WAIT_OBJECT_0 {
        return refuse(Step::ElevateTimeout);
    }
    let mut code = 1;
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
        return Err(Failure::new(Step::ElevateChild, last_error()));
    }
    if code != 0 {
        // The elevated child runs hidden, so its own failed step only reaches
        // us through its exit code.
        let (child, os) = match Failure::from_exit_code(code) {
            Some((child, os)) => (Some(child), os),
            None => (None, code as i32),
        };
        return Err(Failure {
            step: Step::ElevateChild,
            os,
            child,
        });
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
    let Ok(copy) = std::env::current_exe()
        .map_err(drop)
        .and_then(|exe| StagedCopy::of(&exe).map_err(drop))
    else {
        return;
    };
    let handle = RegisterServiceCtrlHandlerExW(
        wide(&copy.service()).as_ptr(),
        Some(control),
        ptr::null_mut(),
    );
    if handle.is_null() {
        return;
    }
    *STATUS.lock().unwrap() = handle as usize;
    // Prove this copy is still administrator-owned before acting as SYSTEM,
    // and only then read which installation it was staged for. The handles
    // stay held for the service's lifetime so the files cannot be swapped
    // after the check.
    let Ok(_staged) = crate::security::protected_staging(&copy.dir) else {
        status(SERVICE_STOPPED);
        return;
    };
    let Ok(install) = copy.install() else {
        status(SERVICE_STOPPED);
        return;
    };
    match INSTALL.lock() {
        Ok(mut approved) => *approved = Some(install),
        Err(_) => {
            status(SERVICE_STOPPED);
            return;
        }
    }
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
        let Ok(mut pipe) = Pipe::server(&copy.pipe(), false) else {
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
    let copy = StagedCopy::of(&std::env::current_exe()?).map_err(|_| error())?;
    let name = wide(&copy.service());
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
        // Only an elevated run of this same helper build may register a
        // process. The caller runs from the installation while this service
        // runs from its protected copy, so their paths differ by design and
        // identical contents is what proves they are the same build.
        let caller_token = token(caller.0)?;
        let mut elevation: TOKEN_ELEVATION = unsafe { mem::zeroed() };
        let mut needed = 0;
        if !crate::security::same_contents(&image(caller.0)?, &std::env::current_exe()?)?
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
        let install = approved_install()?;
        let (main, _) =
            crate::security::authorize_client(main_pid, &install.path, install.development)?;
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
    let install = approved_install()?;
    let (owner, session) = crate::security::authorize_client(
        client.client_pid()?,
        &install.path,
        install.development,
    )?;
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
        StagedCopy::of(&std::env::current_exe()?)
            .map_err(|_| error())?
            .service(),
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
        let response = worker.line(crate::capture_protocol::response_limit(&parsed))?;
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
    let copy = StagedCopy::of(&std::env::current_exe()?).map_err(|_| error())?;
    if !system(token(unsafe { GetCurrentProcess() })?.0)?
        || !name.starts_with(&format!(r"\\.\pipe\{}-", copy.service()))
    {
        return denied();
    }
    let mut pipe = Pipe::client(name)?;
    if pipe.server_pid()? != pid(&copy.service())? {
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
        if acknowledgement != "ok\n" {
            return denied();
        }
        pipe.write(b"ok\n")?;
    }
}

/// Registers the Cindy process this setup run was started for, from the
/// elevated child. The service must be running as SYSTEM from the staged copy
/// this installation just wrote.
pub fn authorize(installation: &Installation, main_pid: u32) -> Staged<()> {
    let mut pipe = Pipe::client(&installation.pipe()).stage(Step::AuthorizeConnect)?;
    let identity = (|| -> Result<bool> {
        let server = process(pipe.server_pid()?)?;
        Ok(system(token(server.0)?.0)?
            && crate::security::same_file(&image(server.0)?, &installation.host())
            && pipe.server_pid()? == pid(&installation.service())?)
    })()
    .stage(Step::AuthorizeIdentity)?;
    if !identity {
        return refuse(Step::AuthorizeIdentity);
    }
    pipe.write(format!("{{\"mode\":\"authorize\",\"pid\":{main_pid}}}\n").as_bytes())
        .stage(Step::AuthorizeReply)?;
    if pipe.line(1024).stage(Step::AuthorizeReply)? != b"ready\n" {
        return refuse(Step::AuthorizeReply);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    /// The UAC bootstrap is security-sensitive generated PowerShell. Parse the
    /// exact production script through the system PowerShell parser so quoting
    /// or a syntax regression cannot turn setup into an opaque retry.
    #[test]
    fn elevated_bootstrap_script_parses() {
        let args = vec![
            "--install-from".to_owned(),
            r"C:\Users\dev user\resources\tools\remote-desktop\cindy-windows-desktop-host.exe"
                .to_owned(),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_owned(),
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".to_owned(),
            "1234".to_owned(),
            "--development".to_owned(),
        ];
        let script = powershell_script(
            Path::new(
                r"C:\Users\dev user\resources\tools\remote-desktop\cindy-windows-desktop-host.exe",
            ),
            Path::new(
                r"C:\Program Files\Cindy Remote Desktop\abc\cindy-windows-desktop-bootstrap.exe",
            ),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            Some(Path::new(r"C:\Program Files\Cindy\Cindy.exe")),
            &args,
            false,
        );
        let encoded = encode_powershell(&script);
        let command = format!(
            "[void][ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}'))); exit 0",
            encoded
        );
        let powershell = system_file("WindowsPowerShell\\v1.0\\powershell.exe")
            .expect("System32 PowerShell is required on Windows");
        let output = Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
            .output()
            .expect("PowerShell parser should start");
        assert!(
            output.status.success(),
            "generated bootstrap script did not parse: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The copy the elevated step starts has to carry an administrator owner,
        // not the installing account: an owner can rewrite its own entries.
        assert!(script.contains("Set-Acl -LiteralPath $bootstrap -AclObject $fileSecurity"));
        // A refusal by the bootstrap itself must reach the parent as its own
        // step instead of the child's argument check.
        assert!(script.contains(&format!(
            "trap {{ exit {} }}",
            Step::ElevateBootstrap as u32 + 1
        )));
        // Comparing the ACL entries must not depend on resolving principal
        // names: on a localised Windows the ALL APPLICATION PACKAGES entries of
        // Program Files do not name-translate back, and setup died on that
        // lookup instead of checking the entries as SIDs.
        assert!(!script.contains(".Translate("));
        assert!(script.contains(
            "$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])"
        ));

        // Installation paths are data, not script text: a folder literally named
        // "exit 1" has to reach the script verbatim.
        let awkward =
            r"C:\Users\dev user\exit 1\resources\tools\remote-desktop\cindy-windows-desktop-host.exe";
        let script = powershell_script(
            Path::new(awkward),
            Path::new(
                r"C:\Program Files\Cindy Remote Desktop\abc\cindy-windows-desktop-bootstrap.exe",
            ),
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            Some(Path::new(r"C:\Program Files\Cindy\Cindy.exe")),
            &args,
            false,
        );
        assert!(script.contains(awkward));
    }
}
