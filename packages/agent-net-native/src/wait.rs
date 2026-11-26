//! Waiting for a datagram on the engine's UDP socket, up to a deadline (engine.rs `Waiter`, lib.rs `cindy_agent_net_wait`).
//!
//! Windows: `WSAPoll`'s timeout follows the system timer, 15.6 ms unless some process raised its resolution. On 2026-11-23
//! (Windows 11) a 1 ms wait took 15.5 ms, and two engines pacing a transfer on such waits moved 16 MiB over a 12.5 MB/s,
//! 32 ms line at 9.4 MB/s against the WASM driver's 11.6 (6.25 MB/s, 200 ms: 4.3 against 5.1). Here the socket sets an
//! event when a datagram arrives (`WSAEventSelect`) and a high-resolution waitable timer ends the wait on time; both are
//! waited on at once, so the thread sleeps until one of them fires and no process-wide timer setting changes.
#[cfg(unix)]
pub(crate) fn readable(socket: &std::net::UdpSocket, timeout_ms: u32) -> bool {
    use std::os::fd::AsRawFd;
    #[repr(C)] struct PollFd { fd: i32, events: i16, revents: i16 }
    #[cfg(target_vendor = "apple")] type Count = std::ffi::c_uint;
    #[cfg(not(target_vendor = "apple"))] type Count = std::ffi::c_ulong;
    const POLLIN: i16 = 0x0001;
    unsafe extern "C" { fn poll(fds: *mut PollFd, count: Count, timeout: i32) -> i32; }
    let mut fd = PollFd { fd: socket.as_raw_fd(), events: POLLIN, revents: 0 };
    // SAFETY: one initialized pollfd that outlives the call; the descriptor is this socket's.
    unsafe { poll(&mut fd, 1, timeout_ms.min(i32::MAX as u32) as i32) > 0 && fd.revents & POLLIN != 0 }
}

#[cfg(windows)]
pub(crate) use windows::{SocketSignal, readable};

#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, net::UdpSocket, os::windows::io::AsRawSocket, ptr::null};
    type Handle = *mut c_void;
    const FD_READ: i32 = 0x01;
    const POLLRDNORM: i16 = 0x0100;
    const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION: u32 = 0x02;
    const TIMER_ALL_ACCESS: u32 = 0x001F_0003;
    const WAIT_OBJECT_0: u32 = 0;
    /// The plain timeout of the combined wait is only a backstop for a timer that failed to fire; two system ticks.
    const BACKSTOP_MS: u32 = 32;
    #[repr(C)] struct PollFd { fd: usize, events: i16, revents: i16 }
    #[link(name = "ws2_32")] unsafe extern "system" {
        fn WSAPoll(fds: *mut PollFd, count: u32, timeout: i32) -> i32;
        fn WSACreateEvent() -> Handle;
        fn WSAEventSelect(socket: usize, event: Handle, events: i32) -> i32;
        fn WSAResetEvent(event: Handle) -> i32;
        fn WSACloseEvent(event: Handle) -> i32;
    }
    #[link(name = "kernel32")] unsafe extern "system" {
        fn CreateWaitableTimerExW(attributes: *const c_void, name: *const u16, flags: u32, access: u32) -> Handle;
        fn SetWaitableTimer(timer: Handle, due: *const i64, period: i32, routine: *const c_void, argument: *const c_void, resume: i32) -> i32;
        fn CancelWaitableTimer(timer: Handle) -> i32;
        fn WaitForMultipleObjects(count: u32, handles: *const Handle, all: i32, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub(crate) fn readable(socket: &UdpSocket, timeout_ms: u32) -> bool { poll(socket.as_raw_socket() as usize, timeout_ms) }
    fn poll(socket: usize, timeout_ms: u32) -> bool {
        let mut fd = PollFd { fd: socket, events: POLLRDNORM, revents: 0 };
        // SAFETY: one initialized WSAPOLLFD that outlives the call; the socket is open for the caller's whole call.
        unsafe { WSAPoll(&mut fd, 1, timeout_ms.min(i32::MAX as u32) as i32) > 0 && fd.revents & POLLRDNORM != 0 }
    }

    /// One high-resolution timer per waiting thread, so threads waiting at once never re-arm each other's deadline.
    /// None before Windows 10 1803, which lacks the flag: those waits keep `WSAPoll`'s coarse timeout.
    struct Timer(Handle);
    impl Drop for Timer {
        fn drop(&mut self) { if !self.0.is_null() { unsafe { CloseHandle(self.0); } } }
    }
    thread_local! {
        static TIMER: Timer = Timer(unsafe { CreateWaitableTimerExW(null(), null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS) });
    }

    /// The engine socket's arrival event, shared by its waiters. A socket has one event selection at a time, so there is one
    /// per socket; it lives as long as the engine or the last waiter, and releases the selection before closing the event.
    pub(crate) struct SocketSignal { socket: UdpSocket, event: Handle }
    // SAFETY: the event handle is a kernel object usable from any thread; it is closed once, in drop.
    unsafe impl Send for SocketSignal {}
    unsafe impl Sync for SocketSignal {}
    impl SocketSignal {
        /// None when Windows refuses the event: the waiters fall back to `WSAPoll`.
        pub(crate) fn new(socket: &UdpSocket) -> Option<Self> {
            let socket = socket.try_clone().ok()?;
            let event = unsafe { WSACreateEvent() };
            if event.is_null() { return None; }
            // The socket is already non-blocking (engine.rs), which event selection also requires.
            if unsafe { WSAEventSelect(socket.as_raw_socket() as usize, event, FD_READ) } != 0 {
                unsafe { WSACloseEvent(event); }
                return None;
            }
            Some(Self { socket, event })
        }
        /// True as soon as a datagram is waiting, false after `timeout_ms` without one.
        ///
        /// A datagram that arrives after the readiness check below sets the event: the engine reads the socket until it
        /// would block, and every read re-enables the arrival notice. A datagram already waiting is found by that check, so
        /// resetting the event before it loses nothing; a reset by another thread waiting on the same event only costs that
        /// thread one more check.
        pub(crate) fn wait(&self, timeout_ms: u32) -> bool {
            let socket = self.socket.as_raw_socket() as usize;
            if poll(socket, 0) { return true; }
            if timeout_ms == 0 { return false; }
            TIMER.with(|timer| {
                let due = -(i64::from(timeout_ms) * 10_000);
                if timer.0.is_null() || unsafe { SetWaitableTimer(timer.0, &due, 0, null(), null(), 0) } == 0 {
                    return poll(socket, timeout_ms);
                }
                let handles = [self.event, timer.0];
                let ready = loop {
                    unsafe { WSAResetEvent(self.event); }
                    if poll(socket, 0) { break true; }
                    let woken = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout_ms.saturating_add(BACKSTOP_MS)) };
                    if woken != WAIT_OBJECT_0 { break poll(socket, 0); }
                };
                unsafe { CancelWaitableTimer(timer.0); }
                ready
            })
        }
    }
    impl Drop for SocketSignal {
        fn drop(&mut self) {
            unsafe {
                WSAEventSelect(self.socket.as_raw_socket() as usize, std::ptr::null_mut(), 0);
                WSACloseEvent(self.event);
            }
        }
    }
}
