import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessConfigStore } from './config.js';
import { isRemoteWorkdirAllowed } from './workdir-guard.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('isRemoteWorkdirAllowed', () => {
  it('allows only real paths under configured roots and rejects symlink escapes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-workdir-'));
    dirs.push(dir);
    const root = path.join(dir, 'projects');
    const inside = path.join(root, 'api');
    const outside = path.join(dir, 'private');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const config = new HeadlessConfigStore(path.join(dir, 'config.json'));
    const base = await config.read();
    await config.write({ ...base, workdirRoots: [root] });

    await expect(isRemoteWorkdirAllowed(config, inside)).resolves.toBe(true);
    await expect(isRemoteWorkdirAllowed(config, path.join(root, 'escape'))).resolves.toBe(false);
    await expect(isRemoteWorkdirAllowed(config, outside)).resolves.toBe(false);
  });
});
