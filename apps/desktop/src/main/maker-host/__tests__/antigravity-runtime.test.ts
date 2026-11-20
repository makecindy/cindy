import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { assertVerifiedAntigravityBinary, supportsAntigravityRuntime } from '../antigravity-runtime';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));

it('admits Windows x64 and macOS arm64 installers', () => {
  expect(supportsAntigravityRuntime('win32', 'x64')).toBe(true);
  expect(supportsAntigravityRuntime('darwin', 'arm64')).toBe(true);
  expect(supportsAntigravityRuntime('linux', 'x64')).toBe(false);
});

it.runIf(supportsAntigravityRuntime())('checks the signer again when an installed CLI changes at the same path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agy-signature-'));
  const binary = path.join(fs.realpathSync(root), process.platform === 'win32' ? 'agy.exe' : 'agy');
  const verify = vi.mocked(spawnSync);
  verify.mockReset();
  try {
    const verified = { status: 0 } as ReturnType<typeof spawnSync>;
    verify.mockReturnValueOnce(verified).mockReturnValueOnce(verified)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);
    fs.writeFileSync(binary, 'signed older version', { mode: 0o700 });
    assertVerifiedAntigravityBinary(binary);
    assertVerifiedAntigravityBinary(binary);
    expect(verify).toHaveBeenCalledTimes(1);

    fs.writeFileSync(binary, 'signed newer release with a different length');
    assertVerifiedAntigravityBinary(binary);
    expect(verify).toHaveBeenCalledTimes(2);

    fs.writeFileSync(binary, 'untrusted replacement');
    expect(() => assertVerifiedAntigravityBinary(binary)).toThrow('ANTIGRAVITY_UNVERIFIED_RUNTIME');
    expect(verify).toHaveBeenCalledTimes(3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
