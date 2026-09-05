import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeStartupBinaryUpdateMarker, writeStartupBinaryUpdateMarker } from '../startup-update';

vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

let userDataDir: string;
let markerPath: string;
beforeAll(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-update-marker-'));
  markerPath = path.join(userDataDir, 'agent-binary-update-once.json');
});
beforeEach(() => {
  fs.rmSync(markerPath, { force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(userDataDir, { recursive: true, force: true }); });

describe('one-time startup binary update marker', () => {
  it('does not request version checks on an ordinary startup', () => {
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '1.0.0')).toBe(false);
  });

  it('consumes the matching marker before checks run, while the caller can retain its decision for retries', () => {
    writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    const checkForUpdates = consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    expect(checkForUpdates).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBe(false);
    expect(checkForUpdates).toBe(true);
  });

  it.each(['1.0.0', '3.0.0'])('discards a stale marker when the actual app version is %s', (version) => {
    writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    expect(consumeStartupBinaryUpdateMarker(userDataDir, version)).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each(['{', 'null', '{}', '{"version":123}'])('cleans up malformed marker %s without blocking startup', (contents) => {
    fs.writeFileSync(markerPath, contents);
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('cleans up a cancelled apply and tolerates repeated cleanup', () => {
    const cancel = writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    expect(cancel).toBeTypeOf('function');
    cancel?.();
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(() => cancel?.()).not.toThrow();
  });

  it('does not let an older cancellation remove a newer attempt for the same version', () => {
    const cancelEarlier = writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    cancelEarlier?.();
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBe(true);
  });

  it('does not consume another userData directory marker', () => {
    writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    expect(consumeStartupBinaryUpdateMarker(path.join(userDataDir, 'other'), '2.0.0')).toBe(false);
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBe(true);
  });

  it('does not prevent applying an app update when marker writing fails', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    expect(writeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBeUndefined();
  });

  it('does not report a consumed marker if deletion fails', () => {
    writeStartupBinaryUpdateMarker(userDataDir, '2.0.0');
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('file locked'); });
    expect(consumeStartupBinaryUpdateMarker(userDataDir, '2.0.0')).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
