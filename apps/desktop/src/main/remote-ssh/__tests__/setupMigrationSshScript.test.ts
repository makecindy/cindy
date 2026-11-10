/**
 * Unit, the only change new-computer setup makes on a server
 * (docs/product-rules/new-device-setup-migration.md §3 invariant 2): the script the other computer
 * runs over SSH, executed here with a real POSIX sh against a temporary HOME. New script: no
 * existing coverage. Minimal inputs: an authorized_keys without a final newline, and the same key
 * twice. Not on Windows, where servers are reached from, not run as, POSIX shells.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AUTHORIZE_SCRIPT } from '../setupMigrationSshScript.js';

const KEY = `ssh-ed25519 ${'A'.repeat(68)} cindy-setup@new-mac`;
const homes: string[] = [];

function run(home: string): string {
  return execFileSync('/bin/sh', ['-c', AUTHORIZE_SCRIPT], {
    input: KEY,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  }).trim();
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('setup SSH authorize script', () => {
  it('appends once, after the last existing key, and leaves existing lines as they were', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-ssh-'));
    homes.push(home);
    fs.mkdirSync(path.join(home, '.ssh'));
    const file = path.join(home, '.ssh', 'authorized_keys');
    fs.writeFileSync(file, 'ssh-ed25519 OLD existing@laptop');

    expect(run(home)).toBe('ADDED');
    expect(run(home)).toBe('PRESENT');
    expect(fs.readFileSync(file, 'utf8')).toBe(`ssh-ed25519 OLD existing@laptop\n${KEY}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
