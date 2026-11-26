import { app } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveLinuxCaptureBinary } from './linuxCapture';
import { isWaylandDesktop } from './waylandCapture';

/**
 * GNOME Shell on Wayland (Ubuntu's default session) through Mutter's own
 * ScreenCast/RemoteDesktop D-Bus APIs: unattended capture of one monitor with
 * cursor metadata, and keyboard/mouse control, without the portal picker.
 * GNOME shows its own screen-sharing/remote-control indicators meanwhile.
 * The existing remote-control opt-ins, peer checks and leases authorize each
 * connection, exactly as for Hyprland's native capture.
 */
const exec = promisify(execFile);
const binaryName = 'cindy-linux-gnome-capture';
export const GNOME_DISPLAY = /^gnome:[A-Za-z0-9_.-]{1,80}$/;

export interface GnomeMonitor {
  /** Mutter connector, e.g. `eDP-1`. Only helper-validated names reach arguments. */
  id: string;
  name: string;
  x: number;
  y: number;
  /** Logical size (desktop points). */
  width: number;
  height: number;
  /** Stream pixels per desktop point. */
  scale: number;
  primary: boolean;
}

export function isGnomeWaylandSession(env: Record<string, string | undefined> = process.env) {
  return (
    isWaylandDesktop(process.platform, env) &&
    !env.HYPRLAND_INSTANCE_SIGNATURE &&
    (env.XDG_CURRENT_DESKTOP ?? '').split(':').some((name) => name.toUpperCase() === 'GNOME')
  );
}

export async function resolveGnomeCaptureBinary(): Promise<string> {
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'tools', 'remote-desktop', binaryName);
  // Development builds compile it next to the main capture helper.
  return path.join(path.dirname(await resolveLinuxCaptureBinary()), binaryName);
}

let ready = false;
let probing: Promise<boolean> | null = null;
/** Synchronous view of the last probe, for routing decisions made per frame. */
export function gnomeDesktopReady(): boolean {
  return ready && isGnomeWaylandSession();
}
/** Interfaces present, PipeWire and JPEG usable. Creates no session, so it
 * never shows GNOME's sharing indicator. A positive result is kept for the
 * run; a failed probe is retried by the next caller. */
export function readGnomeDesktopSupport(): Promise<boolean> {
  if (!isGnomeWaylandSession()) return Promise.resolve(false);
  if (ready) return Promise.resolve(true);
  probing ??= (async () => {
    try {
      const { stdout } = await exec(await resolveGnomeCaptureBinary(), ['--check'], {
        timeout: 3000,
        maxBuffer: 1024,
      });
      ready = stdout.trim() === 'ready';
    } catch {
      ready = false;
    }
    return ready;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

export function parseGnomeMonitors(text: string): GnomeMonitor[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.length > 32) throw new Error('DESKTOP_DISPLAY_MISSING');
  return value.filter(
    (m): m is GnomeMonitor =>
      !!m &&
      typeof m.id === 'string' &&
      /^[A-Za-z0-9_.-]{1,80}$/.test(m.id) &&
      typeof m.name === 'string' &&
      m.name.length <= 256 &&
      [m.x, m.y, m.width, m.height].every(Number.isSafeInteger) &&
      m.width > 0 &&
      m.height > 0 &&
      m.width <= 16384 &&
      m.height <= 16384 &&
      Number.isFinite(m.scale) &&
      m.scale >= 0.25 &&
      m.scale <= 8 &&
      typeof m.primary === 'boolean',
  );
}

export async function gnomeMonitors(): Promise<GnomeMonitor[]> {
  const { stdout } = await exec(await resolveGnomeCaptureBinary(), ['--monitors'], {
    timeout: 3000,
    maxBuffer: 64000,
  });
  return parseGnomeMonitors(stdout);
}

export function gnomeDisplay(m: GnomeMonitor) {
  return { id: `gnome:${m.id}`, name: m.name || m.id, width: m.width, height: m.height };
}

export async function gnomeMonitor(displayId: string): Promise<GnomeMonitor> {
  const monitor = GNOME_DISPLAY.test(displayId)
    ? (await gnomeMonitors()).find((m) => gnomeDisplay(m).id === displayId)
    : undefined;
  if (!monitor) throw new Error('DESKTOP_DISPLAY_MISSING');
  return monitor;
}
