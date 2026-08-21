import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// listLocalSshKeys only needs ssh-add/ssh-keygen as optional metadata helpers.
// Keep this test filesystem-only and deterministic; failures in those helpers
// are intentionally swallowed by the production scanner.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(new Error('mocked helper unavailable'));
  }),
}));

import { listLocalSshKeys } from '../ssh-keys.js';

describe('listLocalSshKeys companion naming', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('lists guru.key + guru.pub alongside the default OpenSSH pair', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-keys-list-'));
    await fs.writeFile(path.join(dir, 'guru.key'), 'private');
    await fs.writeFile(path.join(dir, 'guru.pub'), 'ssh-ed25519 AAAA guru');
    await fs.writeFile(path.join(dir, 'release.key'), 'private');
    await fs.writeFile(path.join(dir, 'release.key.pub'), 'ssh-ed25519 AAAA release');
    await fs.writeFile(path.join(dir, 'id_ed25519'), 'private');
    await fs.writeFile(path.join(dir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA id');
    await fs.writeFile(path.join(dir, 'orphan.pub'), 'ssh-ed25519 AAAA orphan');

    const keys = await listLocalSshKeys(dir);
    expect(keys.map((key) => path.basename(key.privateKeyPath)).sort()).toEqual([
      'guru.key',
      'id_ed25519',
      'release.key',
    ]);
  });

  it('deduplicates one private key and prefers its explicit .key.pub companion', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-keys-list-'));
    await fs.writeFile(path.join(dir, 'work.key'), 'private');
    await fs.writeFile(path.join(dir, 'work.pub'), 'ssh-ed25519 AAAA legacy');
    await fs.writeFile(path.join(dir, 'work.key.pub'), 'ssh-ed25519 BBBB explicit');

    const keys = await listLocalSshKeys(dir);
    expect(keys).toHaveLength(1);
    expect(path.basename(keys[0]!.privateKeyPath)).toBe('work.key');
    expect(path.basename(keys[0]!.pubkeyPath)).toBe('work.key.pub');
  });
});
