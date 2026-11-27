import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const executable = '/usr/bin/xdotool';

export function linuxDisplaySocket(env: NodeJS.ProcessEnv): string | null {
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland') return null;
  const match = /^:([0-9]{1,5})(?:\.[0-9]{1,2})?$/.exec(env.DISPLAY ?? '');
  return match ? `/tmp/.X11-unix/X${Number(match[1])}` : null;
}

/** Pin a local X11 Unix socket without requiring xdotool. Rejects Wayland/XWayland
 * and remote DISPLAY strings, and detects a replaced X server socket. */
export async function openLinuxX11Socket(env: NodeJS.ProcessEnv = process.env) {
  const environment = {
    DISPLAY: env.DISPLAY,
    XAUTHORITY: env.XAUTHORITY,
    HOME: env.HOME,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    WAYLAND_DISPLAY: env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: env.XDG_SESSION_TYPE,
  };
  const socket = linuxDisplaySocket(environment);
  if (!socket) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
  const original = await stat(socket);
  if (!original.isSocket()) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  const current = async () => {
    if (
      env.DISPLAY !== environment.DISPLAY ||
      env.XAUTHORITY !== environment.XAUTHORITY ||
      env.WAYLAND_DISPLAY ||
      env.XDG_SESSION_TYPE === 'wayland'
    )
      return false;
    try {
      const actual = await stat(socket);
      return (
        actual.isSocket() &&
        actual.ino === original.ino &&
        actual.dev === original.dev &&
        actual.ctimeMs === original.ctimeMs
      );
    } catch {
      return false;
    }
  };
  return { current, environment };
}

export async function openLinuxDisplay(env: NodeJS.ProcessEnv = process.env) {
  const socket = linuxDisplaySocket(env);
  if (!socket) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
  await access(executable, constants.X_OK);
  const { current, environment } = await openLinuxX11Socket(env);
  let geometry: string;
  try {
    const { stdout } = await exec(executable, ['getdisplaygeometry'], {
      env: environment,
      timeout: 1500,
      maxBuffer: 2048,
    });
    if (!(await current())) throw new Error('DESKTOP_DISPLAY_CHANGED');
    geometry = stdout.trim();
  } catch {
    throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  }
  const dimensions = /^([1-9][0-9]{0,4}) ([1-9][0-9]{0,4})$/.exec(geometry);
  if (!dimensions) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  return { current, environment, width: Number(dimensions[1]), height: Number(dimensions[2]) };
}
