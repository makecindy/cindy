import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeDbSlimmingDevRelaunchSignal } from '../devDbSlimmingRelaunch';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('writeDbSlimmingDevRelaunchSignal', () => {
  it('atomically writes a request signal only inside the runner temp directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-cleanup-relaunch-'));
    temporaryDirectories.push(tempDir);
    const signalPath = path.join(tempDir, 'relaunch.json');

    expect(
      writeDbSlimmingDevRelaunchSignal('request-1', { signalPath, tempDir }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(signalPath, 'utf8'))).toMatchObject({
      version: 1,
      requestId: 'request-1',
    });
    expect(fs.existsSync(`${signalPath}.${process.pid}.tmp`)).toBe(false);
  });

  it('refuses paths outside the runner temp directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-db-cleanup-relaunch-'));
    temporaryDirectories.push(tempDir);
    const signalPath = path.join(path.dirname(tempDir), `${path.basename(tempDir)}-outside.json`);

    expect(
      writeDbSlimmingDevRelaunchSignal('request-1', { signalPath, tempDir }),
    ).toBe(false);
    expect(fs.existsSync(signalPath)).toBe(false);
  });
});
