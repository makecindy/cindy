import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCodexHomeDirectory } from './session-runtime.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe('ensureCodexHomeDirectory', () => {
  it('creates the private CODEX_HOME required by codex app-server', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-headless-codex-home-'));
    directories.push(root);
    const codexHome = path.join(root, 'state', 'codex-home');

    ensureCodexHomeDirectory(codexHome);

    expect(fs.statSync(codexHome).isDirectory()).toBe(true);
    expect(fs.statSync(codexHome).mode & 0o777).toBe(0o700);
  });
});
