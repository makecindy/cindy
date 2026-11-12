import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CcDebugRawTailer } from '../cc-debug-raw-tailer.js';

let root: string;
let sequence = 0;
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-raw-tail-')); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function file(initial = ''): string {
  const name = path.join(root, `${sequence++}.log`);
  fs.writeFileSync(name, initial);
  return name;
}

describe('bounded raw diagnostics', () => {
  it('skips historical bytes but captures the first append before the first poll', () => {
    const name = file('old\n');
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write);
    tailer.register(name, 'session');
    fs.appendFileSync(name, 'first\npartial');
    tailer.pollNow();
    fs.appendFileSync(name, ' line\n');
    tailer.pollNow();
    expect(write.mock.calls).toEqual([['first', 'session'], ['partial line', 'session']]);
  });

  it('does not enumerate history and stops disk polling when disabled', () => {
    vi.useFakeTimers();
    const name = file();
    const tailer = new CcDebugRawTailer(() => true);
    tailer.register(name, 'session');
    const open = vi.spyOn(fs, 'openSync');
    const readdir = vi.spyOn(fs, 'readdirSync');
    vi.advanceTimersByTime(10_000);
    expect(open).not.toHaveBeenCalled();
    tailer.setEnabled(true);
    vi.advanceTimersByTime(2_000);
    expect(open).toHaveBeenCalledTimes(1);
    tailer.setEnabled(false);
    vi.advanceTimersByTime(10_000);
    expect(open).toHaveBeenCalledTimes(1);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('shares a round budget fairly across files and bounds the allocation for a huge append', () => {
    const a = file(); const b = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write, 8);
    tailer.register(a, 'a'); tailer.register(b, 'b');
    fs.appendFileSync(a, 'aaa\naaa\n'.repeat(1000));
    fs.appendFileSync(b, 'bbb\n');
    const alloc = vi.spyOn(Buffer, 'allocUnsafe');
    tailer.pollNow();
    expect(write.mock.calls.every((call) => call[1] === 'a')).toBe(true);
    tailer.pollNow();
    expect(write).toHaveBeenCalledWith('bbb', 'b');
    expect(Math.max(...alloc.mock.calls.map(([bytes]) => bytes))).toBeLessThanOrEqual(8);
  });

  it('fragments an unterminated line instead of keeping its entire history', () => {
    const name = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write);
    tailer.register(name, 's');
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(name, 'x'.repeat(64 * 1024));
      tailer.pollNow();
    }
    expect(write).toHaveBeenCalledTimes(20);
    expect(write.mock.calls.every(([line]) => line.length < 65_600)).toBe(true);
  });

  it('pauses reads behind the writer and retries without dropping or duplicating lines', () => {
    const name = file();
    let ready = false;
    const lines: string[] = [];
    const tailer = new CcDebugRawTailer((line) => { if (!ready) return false; lines.push(line); return true; });
    tailer.register(name, 's');
    fs.appendFileSync(name, 'one\ntwo\n');
    tailer.pollNow();
    const read = vi.spyOn(fs, 'readSync');
    tailer.pollNow();
    expect(read).not.toHaveBeenCalled();
    ready = true;
    tailer.pollNow();
    tailer.pollNow();
    expect(lines).toEqual(['one', 'two']);
  });

  it('decodes multibyte characters split across polls', () => {
    const name = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write, 2);
    tailer.register(name, 's');
    fs.appendFileSync(name, '你好\n');
    for (let i = 0; i < 5; i++) tailer.pollNow();
    expect(write).toHaveBeenCalledExactlyOnceWith('你好', 's');
  });

  it('keeps shared writers until the last release and then forgets the file', () => {
    const name = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write);
    const releaseA = tailer.register(name, 's');
    const releaseB = tailer.register(name, 's');
    releaseA(); releaseA();
    fs.appendFileSync(name, 'live\n');
    tailer.pollNow();
    expect(write).toHaveBeenCalledWith('live', 's');
    releaseB();
    const open = vi.spyOn(fs, 'openSync');
    tailer.pollNow();
    expect(open).not.toHaveBeenCalled();
  });

  it('clears partial text when a file disappears and follows its replacement from zero', () => {
    const name = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write);
    tailer.register(name, 's');
    fs.appendFileSync(name, 'partial'); tailer.pollNow();
    fs.unlinkSync(name); tailer.pollNow();
    fs.writeFileSync(name, 'replacement\n'); tailer.pollNow();
    expect(write.mock.calls).toEqual([['replacement', 's']]);
  });

  it('handles truncate and isolates one read failure from other writers', () => {
    const a = file('old data'); const b = file();
    const write = vi.fn((_line: string, _sessionId: string) => true);
    const tailer = new CcDebugRawTailer(write);
    tailer.register(a, 'a'); tailer.register(b, 'b');
    fs.writeFileSync(a, 'a\n'); fs.appendFileSync(b, 'b\n');
    vi.spyOn(fs, 'readSync').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(() => tailer.pollNow()).not.toThrow();
    tailer.pollNow();
    expect(write).toHaveBeenCalledWith('a', 'a');
    expect(write).toHaveBeenCalledWith('b', 'b');
  });
});
