import { execFileSync } from 'node:child_process';

// Test-owned subprocesses only. Chrome starts a separate process group, so killing
// just the probe's group is insufficient: discover descendants before orphaning them.
export function terminateTestProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  const kill = (pid, signal) => {
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill(child.pid, 'SIGSTOP');
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const owned = [child.pid];
    for (let index = 0; index < owned.length; index++) {
      for (const [pid, parent] of rows) if (parent === owned[index] && !owned.includes(pid)) owned.push(pid);
    }
    for (const pid of owned.reverse()) {
      // Also includes children spawned into an owned group after the snapshot.
      kill(-pid, 'SIGKILL');
      kill(pid, 'SIGKILL');
    }
  } finally {
    kill(child.pid, 'SIGKILL');
  }
}
