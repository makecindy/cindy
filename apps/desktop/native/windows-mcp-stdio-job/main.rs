//! One unnamed Windows job per stdio connection. The job is attached at creation,
//! before the server can run or spawn descendants. Only this supervisor holds it.
#![cfg(windows)]

use std::{
    env,
    ffi::{c_void, OsStr, OsString},
    fs::File,
    io::{self, Write},
    mem,
    os::windows::{
        ffi::OsStrExt,
        io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    },
    path::Path,
    ptr, thread,
    time::{Duration, Instant},
};

const GRACE: Duration = Duration::from_millis(500);
const KILL_WAIT: Duration = Duration::from_millis(1500);
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002000d;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x00020002;
const INFINITE: u32 = u32::MAX;

// Win32 ABI. This standalone helper builds with the same rustc-only toolchain as
// windows-atomic-rename, including outside a Cargo workspace in development.
#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    per_process_time: i64,
    per_job_time: i64,
    flags: u32,
    working_set_min: usize,
    working_set_max: usize,
    active_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    memory_limits_and_peaks: [usize; 4],
}
#[repr(C)]
#[derive(Default)]
struct Accounting {
    times: [i64; 4],
    page_faults: u32,
    total: u32,
    active: u32,
    terminated: u32,
}
#[repr(C)]
struct StartupInfoEx {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    coordinates_dimensions_and_fill: [u32; 7],
    flags: u32,
    show: u16,
    reserved_bytes: u16,
    reserved2: *mut u8,
    stdin: RawHandle,
    stdout: RawHandle,
    stderr: RawHandle,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInfo {
    process: RawHandle,
    thread: RawHandle,
    pid: u32,
    tid: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(security: *const c_void, name: *const u16) -> RawHandle;
    fn SetInformationJobObject(job: RawHandle, class: i32, data: *const c_void, len: u32) -> i32;
    fn QueryInformationJobObject(
        job: RawHandle,
        class: i32,
        data: *mut c_void,
        len: u32,
        returned: *mut u32,
    ) -> i32;
    fn TerminateJobObject(job: RawHandle, code: u32) -> i32;
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        bytes: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        key: usize,
        data: *const c_void,
        bytes: usize,
        previous: *mut c_void,
        returned: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        program: *const u16,
        cmd: *mut u16,
        process_sa: *const c_void,
        thread_sa: *const c_void,
        inherit: i32,
        flags: u32,
        env: *const c_void,
        cwd: *const u16,
        startup: *mut StartupInfoEx,
        info: *mut ProcessInfo,
    ) -> i32;
    fn SetHandleInformation(handle: RawHandle, mask: u32, flags: u32) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn CreateEventW(security: *const c_void, manual: i32, set: i32, name: *const u16) -> RawHandle;
    fn SetEvent(event: RawHandle) -> i32;
    fn WaitForMultipleObjects(count: u32, handles: *const RawHandle, all: i32, ms: u32) -> u32;
}

fn ok(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn owned(raw: RawHandle) -> io::Result<OwnedHandle> {
    if raw.is_null() {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
    }
}
fn inheritable(handle: &impl AsHandle) -> io::Result<OwnedHandle> {
    let copy = handle.as_handle().try_clone_to_owned()?;
    ok(unsafe { SetHandleInformation(copy.as_raw_handle(), 1, 1) })?;
    Ok(copy)
}

struct Job(OwnedHandle);
impl Job {
    fn new() -> io::Result<Self> {
        let job = Self(owned(unsafe {
            CreateJobObjectW(ptr::null(), ptr::null())
        })?);
        let mut limits = ExtendedLimits::default();
        limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        ok(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                9,
                ptr::from_ref(&limits).cast(),
                mem::size_of_val(&limits) as u32,
            )
        })?;
        Ok(job)
    }
    fn wait_empty(&self, timeout: Duration) -> io::Result<bool> {
        let until = Instant::now() + timeout;
        loop {
            let mut accounting = Accounting::default();
            ok(unsafe {
                QueryInformationJobObject(
                    self.0.as_raw_handle(),
                    1,
                    ptr::from_mut(&mut accounting).cast(),
                    mem::size_of_val(&accounting) as u32,
                    ptr::null_mut(),
                )
            })?;
            if accounting.active == 0 {
                return Ok(true);
            }
            if Instant::now() >= until {
                return Ok(false);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn drain(&self) -> io::Result<()> {
        if self.wait_empty(GRACE)? {
            return Ok(());
        }
        ok(unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) })?;
        if self.wait_empty(KILL_WAIT)? {
            Ok(())
        } else {
            Err(io::ErrorKind::TimedOut.into())
        }
    }
}

// The attribute list borrows its handle arrays until CreateProcessW returns.
struct Attributes(Vec<usize>);
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(mem::size_of::<usize>())];
        ok(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        })?;
        Ok(Self(storage))
    }
    fn set(&mut self, key: usize, handles: &[RawHandle]) -> io::Result<()> {
        ok(unsafe {
            UpdateProcThreadAttribute(
                self.0.as_mut_ptr().cast(),
                0,
                key,
                handles.as_ptr().cast(),
                mem::size_of_val(handles),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        })
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) }
    }
}

// Microsoft CRT argv quoting. cross-spawn's prepared cmd.exe arguments instead
// use its verbatim mode, exactly as they would for a Node child_process.spawn.
fn append_arg(line: &mut Vec<u16>, arg: &OsStr, verbatim: bool) {
    if verbatim {
        line.extend(arg.encode_wide());
        return;
    }
    const QUOTE: u16 = b'"' as u16;
    const SLASH: u16 = b'\\' as u16;
    line.push(QUOTE);
    let mut slashes = 0;
    for c in arg.encode_wide() {
        if c == SLASH {
            slashes += 1;
            continue;
        }
        let escapes = if c == QUOTE { slashes * 2 + 1 } else { slashes };
        line.extend(std::iter::repeat_n(SLASH, escapes));
        line.push(c);
        slashes = 0;
    }
    line.extend(std::iter::repeat_n(SLASH, slashes * 2));
    line.push(QUOTE);
}

fn launch(
    job: &Job,
    program: &OsStr,
    args: impl Iterator<Item = OsString>,
    verbatim: bool,
    input: &impl AsHandle,
) -> io::Result<OwnedHandle> {
    let program_wide: Vec<_> = program.encode_wide().chain(Some(0)).collect();
    let mut cmd = Vec::new();
    append_arg(&mut cmd, program, false);
    for arg in args {
        cmd.push(b' ' as u16);
        append_arg(&mut cmd, &arg, verbatim);
    }
    cmd.push(0);
    let stdin = inheritable(input)?;
    let stdout = inheritable(&io::stdout())?;
    let stderr = inheritable(&File::options().write(true).open("NUL")?)?;
    let handles = [
        stdin.as_raw_handle(),
        stdout.as_raw_handle(),
        stderr.as_raw_handle(),
    ];
    let jobs = [job.0.as_raw_handle()];
    let mut attrs = Attributes::new()?;
    attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let mut si: StartupInfoEx = unsafe { mem::zeroed() };
    si.cb = mem::size_of::<StartupInfoEx>() as u32;
    si.flags = 0x100; // STARTF_USESTDHANDLES
    [si.stdin, si.stdout, si.stderr] = handles;
    si.attributes = attrs.0.as_mut_ptr().cast();
    let mut child: ProcessInfo = unsafe { mem::zeroed() };
    ok(unsafe {
        CreateProcessW(
            program_wide.as_ptr(),
            cmd.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            0x08000000 | 0x00080000, // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT
            ptr::null(),
            ptr::null(),
            &mut si,
            &mut child,
        )
    })?;
    // A successful CreateProcessW transfers both handles to the caller.
    drop(unsafe { OwnedHandle::from_raw_handle(child.thread) });
    Ok(unsafe { OwnedHandle::from_raw_handle(child.process) })
}

fn serve(
    mut forward: io::PipeWriter,
    eof: &OwnedHandle,
    signal: OwnedHandle,
    child: &OwnedHandle,
    parent: &OwnedHandle,
) -> io::Result<()> {
    thread::Builder::new().spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut forward);
        drop(forward); // Deliver EOF to the server before starting its grace period.
        unsafe {
            SetEvent(signal.as_raw_handle());
        }
    })?;
    writeln!(io::stderr(), "READY")?;
    let handles = [
        eof.as_raw_handle(),
        child.as_raw_handle(),
        parent.as_raw_handle(),
    ];
    // A wakeup or an unexpected wait failure must both proceed to drain the job.
    unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 0, INFINITE) };
    Ok(())
}

fn supervise() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let pid = args
        .next()
        .and_then(|p| p.to_str()?.parse().ok())
        .ok_or(io::ErrorKind::InvalidInput)?;
    let verbatim = match args.next().as_deref().and_then(OsStr::to_str) {
        Some("--argv") => false,
        Some("--verbatim") => true,
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    let program = args
        .next()
        .filter(|p| Path::new(p).is_absolute())
        .ok_or(io::ErrorKind::InvalidInput)?;
    let parent = owned(unsafe { OpenProcess(0x00100000, 0, pid) })?; // SYNCHRONIZE only
    let job = Job::new()?;
    let eof = owned(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) })?;
    let signal = eof.try_clone()?;
    let (input, forward) = io::pipe()?;
    let child = launch(&job, &program, args, verbatim, &input)?;
    drop(input);
    let started = serve(forward, &eof, signal, &child, &parent);
    // Once CreateProcessW succeeds, even a failed forwarder or READY write
    // must confirm the whole job is empty before reporting a safe startup failure.
    if job.drain().is_err() {
        // The OS still closes the kill-on-close job handle during process teardown.
        std::process::exit(3);
    }
    started
}

fn main() {
    if let Err(error) = supervise() {
        let status = if error.kind() == io::ErrorKind::NotFound {
            "NOT_FOUND"
        } else {
            "START_FAILED"
        };
        // No paths, arguments, credentials or server diagnostics enter the startup receipt.
        let _ = writeln!(io::stderr(), "{status}");
        std::process::exit(2);
    }
}
