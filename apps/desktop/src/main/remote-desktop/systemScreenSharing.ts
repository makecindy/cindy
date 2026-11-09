/**
 * macOS host: what a Mac controller needs to open this Mac in the system
 * Screen Sharing app (`vnc://`). Cindy only reports it; the connection, sign-in
 * and saved password stay entirely between the two Screen Sharing apps.
 */
import type { RemoteDesktopSystemScreenSharing } from '@cindy/device-link';
import { app } from 'electron';
import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

export const SCREEN_SHARING_PORT = 5900;
const MAX_HOSTS = 8;

/** Resolves whether something accepts TCP connections at host:port within the timeout. */
export function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function localHostName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 1000 }, (error, out) => {
      const name = String(out ?? '').trim();
      resolve(!error && /^[A-Za-z0-9-]{1,63}$/.test(name) ? name : null);
    });
  });
}

function ipv4Addresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.'))
        continue;
      if (!out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}

/** This Mac can take part in High Performance screen sharing (either end). */
export function supportsHighPerformance(): boolean {
  const appleSilicon = process.arch === 'arm64' || app.runningUnderARM64Translation;
  const major = Number(process.getSystemVersion().split('.')[0]);
  return appleSilicon && Number.isInteger(major) && major >= 14;
}

export async function readSystemScreenSharing(): Promise<RemoteDesktopSystemScreenSharing> {
  const [listening, name] = await Promise.all([
    probeTcp('127.0.0.1', SCREEN_SHARING_PORT, 500),
    localHostName(),
  ]);
  return {
    listening,
    hosts: [...(name ? [`${name}.local`] : []), ...ipv4Addresses()].slice(0, MAX_HOSTS),
    user: os.userInfo().username,
    highPerformance: supportsHighPerformance(),
    addressVerification: 1,
  };
}
