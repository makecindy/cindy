// Trusted Electron helper: OS input/lock facts only. No renderer, network listener,
// profile credentials, app links or permission prompts. Lifetime belongs to Host.
import { app, powerMonitor } from 'electron';
import { consoleSessionLocked } from '../remote-desktop/awayGuard.js';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
const profile = process.env.CINDY_PLATFORM_PROFILE;
if (!profile) throw new Error('PLATFORM_PROFILE_REQUIRED');
app.setPath('userData', profile);
app.setName('Cindy Platform');
app.dock?.hide();
let locked: boolean | null = null;
let ready = false;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('close', () => app.quit());
lines.on('line', line => {
  if (line.length > 1024) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!Number.isSafeInteger(request.id)) return;
  if (!ready || request.method !== 'sample') return send({ id: request.id, error: 'PLATFORM_NOT_READY' });
  const idle = powerMonitor.getSystemIdleTime();
  const state = locked === null ? powerMonitor.getSystemIdleState(1) : locked ? 'locked' : 'active';
  send({ id: request.id, result: { idle, state, known: locked !== null || process.platform !== 'darwin' } });
});
powerMonitor.on('lock-screen', () => { locked = true; send({ event: 'lock-screen' }); });
powerMonitor.on('unlock-screen', () => { locked = false; send({ event: 'unlock-screen' }); });
app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    // Same console identity/lock interpretation as desktop awayGuard.ts.
    await new Promise<void>(resolve => execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, output) => {
      if (!error && locked === null) {
        locked = consoleSessionLocked(output, process.getuid?.());
      }
      resolve();
    }));
  }
  ready = true;
  send({ ready: true, pid: process.pid });
}).catch(() => app.exit(1));
process.once('SIGTERM', () => app.quit());
