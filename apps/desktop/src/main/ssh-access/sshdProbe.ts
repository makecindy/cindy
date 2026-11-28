/**
 * What the SSH access target reports about this machine's own sshd: whether it answers on loopback, its port, its host
 * keys and the addresses another device can try. Read-only, no root, no sudo, never changes system settings (macOS
 * Remote Login is only detected, the person turns it on). Shared by the desktop and the Node Host.
 *
 * The banner probe reads at most one line. The target checks loopback; a controller may check a peer's reported addresses.
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SSH_ACCESS_MAX_HOST_KEYS, isSshAccessHost, type SshAccessAddress } from '@cindy/device-link';

const BANNER_TIMEOUT_MS = 1_500;
const MAX_BANNER_BYTES = 256;
const MAX_CONFIG_BYTES = 256 * 1024;
const HOST_KEY_TYPES = ['ed25519', 'ecdsa', 'rsa'] as const;
const HOST_KEY_LINE = /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]{16,1400}={0,2})(?:\s.*)?$/;

/** True when the given host and port greet with an SSH identification line (`SSH-2.0-…`). */
export function probeSshBanner(port: number, options: { timeoutMs?: number; host?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let received = '';
    let settled = false;
    const socket = net.connect({ host: options.host ?? '127.0.0.1', port });
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? BANNER_TIMEOUT_MS);
    timer.unref?.();
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.includes('\n') || received.length >= MAX_BANNER_BYTES) finish(/^SSH-\d+\.\d+-/.test(received));
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(/^SSH-\d+\.\d+-/.test(received)));
  });
}

async function readBounded(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The first `Port` in sshd_config (following `Include` of files and `dir/*.conf` globs, as Ubuntu ships), or 22 when the
 * configuration is unreadable or sets none. Parsing stops at the first `Match` block, where Port is not allowed anyway.
 */
export async function readSshdPort(configFile = '/etc/ssh/sshd_config'): Promise<number> {
  const visited = new Set<string>();
  const scan = async (file: string, depth: number): Promise<number | null> => {
    if (depth > 4 || visited.has(file)) return null;
    visited.add(file);
    const content = await readBounded(file);
    if (content === null) return null;
    for (const raw of content.split('\n')) {
      const line = raw.replace(/#.*/, '').trim();
      // `Keyword value` or `Keyword=value` (sshd_config(5)).
      const [keyword, value] = line.split(/\s*=\s*|\s+/, 2) as [string, string | undefined];
      const name = keyword?.toLowerCase();
      if (name === 'match') return null;
      if (name === 'port' && value && /^\d{1,5}$/.test(value)) {
        const port = Number(value);
        if (port >= 1 && port <= 65_535) return port;
      }
      if (name === 'include' && value) {
        const pattern = path.isAbsolute(value) ? value : path.join(path.dirname(configFile), value);
        const files = pattern.endsWith('/*.conf')
          ? await fs.readdir(path.dirname(pattern)).then((names) => names.filter((n) => n.endsWith('.conf')).sort()
            .map((n) => path.join(path.dirname(pattern), n)), () => [] as string[])
          : pattern.includes('*') ? [] : [pattern];
        for (const included of files) {
          const port = await scan(included, depth + 1);
          if (port !== null) return port;
        }
      }
    }
    return null;
  };
  return (await scan(configFile, 0)) ?? 22;
}

/** `<type> <base64>` of the readable sshd host public keys (ed25519 first), at most SSH_ACCESS_MAX_HOST_KEYS. */
export async function readSshHostKeys(dir = '/etc/ssh'): Promise<string[]> {
  const keys: string[] = [];
  for (const type of HOST_KEY_TYPES) {
    const content = await readBounded(path.join(dir, `ssh_host_${type}_key.pub`));
    const match = content === null ? null : HOST_KEY_LINE.exec(content.split('\n')[0]!.trim());
    if (match && !keys.includes(`${match[1]} ${match[2]}`)) keys.push(`${match[1]} ${match[2]}`);
    if (keys.length >= SSH_ACCESS_MAX_HOST_KEYS) break;
  }
  return keys;
}

/** LAN addresses: non-internal IPv4 first, then global or unique-local IPv6 (link-local needs a zone, so it is left out). */
export function readLanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): SshAccessAddress[] {
  const v4: SshAccessAddress[] = [];
  const v6: SshAccessAddress[] = [];
  for (const rows of Object.values(interfaces)) {
    for (const row of rows ?? []) {
      if (row.internal || !isSshAccessHost(row.address)) continue;
      if (row.family === 'IPv4' && !row.address.startsWith('169.254.')) v4.push({ kind: 'lan', host: row.address });
      else if (row.family === 'IPv6' && !/^fe[89ab]/i.test(row.address)) v6.push({ kind: 'lan', host: row.address });
    }
  }
  return [...v4, ...v6];
}

/** The Bonjour name other Macs on the network can resolve; only macOS advertises it by default. */
export function readMdnsName(platform: NodeJS.Platform | string, hostname = os.hostname()): string | null {
  if (platform !== 'darwin') return null;
  const base = hostname.replace(/\.local\.?$/i, '').split('.')[0] ?? '';
  const name = `${base}.local`;
  return base && isSshAccessHost(name) ? name : null;
}
