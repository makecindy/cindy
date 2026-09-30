import type { IPty } from 'node-pty';

/** Stop the owned PTY tree, including Forge/Vite descendants on macOS and Linux. */
export function stopMakeTestProcess(
  child: Pick<IPty, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  kill: typeof process.kill = process.kill,
): void {
  if (platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
    // forkpty creates a private session/process group. Signalling only its Node
    // entry point can orphan the compiler and Electron processes beneath it.
    try {
      kill(-child.pid, 'SIGKILL');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        // Group already gone; close the PTY process itself.
      } else {
        // EPERM (and similar) on the group must not skip the leaf process.
        try {
          child.kill();
          return;
        } catch {
          throw error;
        }
      }
    }
  }
  // node-pty owns the Windows console tree and closes it via ConPTY.
  child.kill();
}
