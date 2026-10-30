import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import type { RemoteDesktopDisplayMode } from '@cindy/device-link';
import { WAYLAND_DISPLAY_ID } from './waylandCapture';

const exec = promisify(execFile);
const executable = '/usr/bin/hyprctl';
/** Only compositor-enumerated identifiers ever reach a subprocess argument. */
export interface LinuxMonitor {
  name: string;
  width: number;
  height: number;
  refreshRate: number;
  x: number;
  y: number;
  scale: number;
  transform: number;
  availableModes: string[];
}
export function supportsLinuxDisplay(): boolean {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    accessSync(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export async function linuxMonitors(includeMirrored = false): Promise<LinuxMonitor[]> {
  const { stdout } = await exec(
    executable,
    ['-j', 'monitors', ...(includeMirrored ? ['all'] : [])],
    {
      timeout: 2000,
      maxBuffer: 128000,
    },
  );
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value) || value.length > 32) throw new Error('DESKTOP_DISPLAY_MISSING');
  return value.filter(
    (m): m is LinuxMonitor =>
      m &&
      typeof m.name === 'string' &&
      /^[A-Za-z0-9_.-]{1,80}$/.test(m.name) &&
      [m.width, m.height, m.x, m.y, m.transform].every(Number.isSafeInteger) &&
      m.width > 0 &&
      m.height > 0 &&
      m.width <= 16384 &&
      m.height <= 16384 &&
      Number.isFinite(m.scale) &&
      m.scale >= 0.25 &&
      m.scale <= 8 &&
      Number.isFinite(m.refreshRate) &&
      m.refreshRate > 0 &&
      m.refreshRate <= 1000 &&
      m.transform >= 0 &&
      m.transform <= 7 &&
      Array.isArray(m.availableModes) &&
      m.availableModes.length <= 256 &&
      m.availableModes.every(
        (mode: unknown) =>
          typeof mode === 'string' && /^\d{1,5}x\d{1,5}@\d{1,4}(\.\d{1,5})?Hz$/.test(mode),
      ),
  );
}
export async function linuxMonitor(
  displayId: string,
  includeMirrored = false,
): Promise<LinuxMonitor> {
  const monitors = await linuxMonitors(includeMirrored);
  const monitor =
    displayId === WAYLAND_DISPLAY_ID && monitors.length === 1
      ? monitors[0]
      : monitors.find((m) => `hyprland:${m.name}` === displayId);
  if (!monitor) throw new Error('DESKTOP_DISPLAY_MISSING');
  return monitor;
}
export function linuxDisplay(m: LinuxMonitor) {
  return {
    id: `hyprland:${m.name}`,
    name: m.name,
    width: Math.round((m.transform % 2 ? m.height : m.width) / m.scale),
    height: Math.round((m.transform % 2 ? m.width : m.height) / m.scale),
  };
}
/** Map a selected output into Hyprland's full logical layout, including negative origins. */
export function linuxInputMapping(monitors: LinuxMonitor[], displayId: string) {
  const selected = monitors.find((m) => linuxDisplay(m).id === displayId);
  if (!selected) throw new Error('DESKTOP_DISPLAY_MISSING');
  const left = Math.min(...monitors.map((m) => m.x)),
    top = Math.min(...monitors.map((m) => m.y));
  const width = Math.max(...monitors.map((m) => m.x + linuxDisplay(m).width)) - left;
  const height = Math.max(...monitors.map((m) => m.y + linuxDisplay(m).height)) - top;
  const size = linuxDisplay(selected);
  return (x: number, y: number) => ({
    x: (selected.x - left + x * (size.width - 1)) / width,
    y: (selected.y - top + y * (size.height - 1)) / height,
  });
}
export function linuxModeEntries(m: LinuxMonitor): (RemoteDesktopDisplayMode & { mode: string })[] {
  const rotated = m.transform % 2 === 1;
  return m.availableModes.map((mode) => {
    const [width, height, hz] = mode.replace('Hz', '').split(/[x@]/).map(Number);
    return {
      id: String(createHash('sha256').update(`${m.name}:${mode}`).digest().readUInt32BE(0)),
      width: Math.round((rotated ? height : width) / m.scale),
      height: Math.round((rotated ? width : height) / m.scale),
      current: width === m.width && height === m.height && Math.abs(hz - m.refreshRate) < 0.02,
      mode: mode.replace('Hz', ''),
    };
  });
}
export async function readLinuxDisplayModes(
  displayId: string,
): Promise<RemoteDesktopDisplayMode[]> {
  // Phone-fit mirrors the source onto a temporary output. Hyprland omits that
  // physical source from the active layout, but its native modes still exist.
  // Include it only for mode reads; capture and input must use the active layout.
  return linuxModeEntries(await linuxMonitor(displayId, true)).map(
    ({ id, width, height, current }) => ({ id, width, height, current }),
  );
}
export async function waitForLinuxDisplay(
  displayId: string,
  expected: { width: number; height: number } | undefined,
  current: () => void,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    current();
    const monitor = await linuxMonitor(displayId);
    current();
    const rotated = monitor.transform % 2 === 1;
    if (
      !expected ||
      (Math.round((rotated ? monitor.height : monitor.width) / monitor.scale) === expected.width &&
        Math.round((rotated ? monitor.width : monitor.height) / monitor.scale) === expected.height)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
}
export async function setLinuxDisplayMode(
  displayId: string,
  modeId: string,
  beforeChange: () => void,
): Promise<void> {
  const monitor = await linuxMonitor(displayId);
  const selected = linuxModeEntries(monitor).find((m) => m.id === modeId);
  if (!selected) throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
  let lua = false;
  try {
    const probe = await exec(executable, ['eval', 'assert(type(hl.monitor) == "function")'], {
      timeout: 2000,
      maxBuffer: 1024,
    });
    lua = probe.stdout.trim() === 'ok';
  } catch {
    /* Older Hyprland uses the keyword interface. */
  }
  beforeChange();
  // Probe before the lease guard, then perform exactly one authorized write.
  const code = `hl.monitor({output=${JSON.stringify(monitor.name)},mode=${JSON.stringify(selected.mode)},position="${monitor.x}x${monitor.y}",scale=${monitor.scale},transform=${monitor.transform}})`;
  const args = lua
    ? ['eval', code]
    : [
        'keyword',
        'monitor',
        `${monitor.name},${selected.mode},${monitor.x}x${monitor.y},${monitor.scale},transform,${monitor.transform}`,
      ];
  const { stdout } = await exec(executable, args, { timeout: 3000, maxBuffer: 1024 });
  if (stdout.trim() !== 'ok') throw new Error('DESKTOP_DISPLAY_MODE_MISSING');
}

export function supportsLinuxLock(): boolean {
  if (
    process.platform !== 'linux' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(process.env.XDG_SESSION_ID ?? '')
  )
    return false;
  try {
    accessSync('/usr/bin/loginctl', constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export async function lockLinuxDesktop(current: () => boolean, signal: AbortSignal): Promise<void> {
  if (!supportsLinuxLock()) throw new Error('DESKTOP_LOCK_UNAVAILABLE');
  const check = () => {
    if (!current() || signal.aborted) throw new Error('DESKTOP_LEASE_EXPIRED');
  };
  check();
  const session = process.env.XDG_SESSION_ID!;
  const shell = '/usr/bin/omarchy-shell';
  const status = async (): Promise<{ secure: boolean; passwordPam: boolean }> => {
    check();
    const { stdout } = await exec(shell, ['lock', 'status'], {
      timeout: 1000,
      signal,
      maxBuffer: 4096,
    });
    check();
    const value = JSON.parse(stdout);
    if (typeof value?.secure !== 'boolean' || typeof value?.passwordPam !== 'boolean')
      throw new Error('DESKTOP_LOCK_UNAVAILABLE');
    return value;
  };
  // Quickshell owns Omarchy's session lock. A logind request alone does not
  // invoke it, and LockedHint is not its compositor-lock acknowledgement.
  let omarchy: Awaited<ReturnType<typeof status>> | undefined;
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    try {
      omarchy = await status();
    } catch {
      check();
      // Other Linux desktops continue using their logind listener.
    }
  }
  check();
  if (omarchy) {
    if (omarchy.secure) return;
    if (!omarchy.passwordPam) throw new Error('DESKTOP_LOCK_UNAVAILABLE');
    const { stdout } = await exec(shell, ['lock', 'lock'], {
      timeout: 1000,
      signal,
      maxBuffer: 128,
    });
    check();
    if (stdout.trim() !== 'ok') throw new Error('DESKTOP_LOCK_FAILED');
    const deadline = Date.now() + 2000;
    do {
      // "requested" / "locked" can precede the compositor acknowledgement.
      if ((await status()).secure) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    check();
    throw new Error('DESKTOP_LOCK_FAILED');
  }
  await exec('/usr/bin/loginctl', ['lock-session', session], {
    timeout: 3000,
    signal,
    maxBuffer: 1024,
  });
  // logind only delivers a request; do not claim success unless the locker acts.
  for (let attempt = 0; attempt < 10; attempt++) {
    check();
    const { stdout } = await exec(
      '/usr/bin/loginctl',
      ['show-session', session, '-p', 'LockedHint', '--value'],
      { timeout: 1000, signal, maxBuffer: 128 },
    );
    check();
    if (stdout.trim() === 'yes') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('DESKTOP_LOCK_FAILED');
}
