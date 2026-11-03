use std::time::{Duration, Instant};

use sysinfo::{Pid, System};

use crate::logger;

/// Poll until `pid` is no longer alive or `timeout` elapses.
/// Returns `true` if the process exited cleanly within the timeout.
pub fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
    let start = Instant::now();
    let mut sys = System::new();
    let target = Pid::from_u32(pid);
    loop {
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
        if sys.process(target).is_none() {
            logger::info(format!(
                "[pid-wait] pid {pid} exited after {:?}",
                start.elapsed()
            ));
            return true;
        }
        if start.elapsed() >= timeout {
            logger::warn(format!(
                "[pid-wait] pid {pid} still alive after {:?}, giving up",
                timeout
            ));
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
