import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CcDebugRawTailer } from '../cc-debug-raw-tailer.js';

const roots: string[] = [];

function makeFile(initial = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-debug-tailer-'));
  roots.push(root);
  const file = path.join(root, 'cc-debug.raw.log');
  fs.writeFileSync(file, initial);
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('CcDebugRawTailer', () => {
  it('starts at EOF and only emits newly appended complete lines', () => {
    const file = makeFile('historical\n');
    const writeLine = vi.fn();
    const tailer = new CcDebugRawTailer(writeLine);
    tailer.register(file, 'session-1');

    tailer.pollNow();
    fs.appendFileSync(file, 'new line\npartial');
    tailer.pollNow();
    fs.appendFileSync(file, ' line\n');
    tailer.pollNow();

    expect(writeLine.mock.calls).toEqual([
      ['new line', 'session-1'],
      ['partial line', 'session-1'],
    ]);
  });

  it('bounds each poll while continuing from the prior offset', () => {
    const file = makeFile();
    const writeLine = vi.fn();
    const tailer = new CcDebugRawTailer(writeLine, { maxReadBytesPerPoll: 8 });
    tailer.register(file, 'session-2');
    tailer.pollNow();

    fs.appendFileSync(file, 'one\ntwo\nthree\n');
    tailer.pollNow();
    expect(writeLine.mock.calls).toEqual([
      ['one', 'session-2'],
      ['two', 'session-2'],
    ]);

    tailer.pollNow();
    expect(writeLine.mock.calls).toEqual([
      ['one', 'session-2'],
      ['two', 'session-2'],
      ['three', 'session-2'],
    ]);
  });

  it('isolates read failures to one target', () => {
    const failingFile = makeFile();
    const healthyFile = makeFile();
    const writeLine = vi.fn();
    const tailer = new CcDebugRawTailer(writeLine);
    tailer.register(failingFile, 'session-failing');
    tailer.register(healthyFile, 'session-healthy');
    tailer.pollNow();
    fs.appendFileSync(failingFile, 'unreadable\n');
    fs.appendFileSync(healthyFile, 'healthy\n');

    const readSync = vi.spyOn(fs, 'readSync').mockImplementationOnce(() => {
      throw new Error('simulated read failure');
    });
    try {
      expect(() => tailer.pollNow()).not.toThrow();
    } finally {
      readSync.mockRestore();
    }

    expect(writeLine.mock.calls).toEqual([['healthy', 'session-healthy']]);
  });

  it('stops polling while disabled', () => {
    vi.useFakeTimers();
    try {
      const file = makeFile();
      const writeLine = vi.fn();
      const tailer = new CcDebugRawTailer(writeLine, { pollIntervalMs: 10 });
      tailer.start(file);
      tailer.stop();
      fs.appendFileSync(file, 'ignored\n');

      vi.advanceTimersByTime(20);
      expect(writeLine).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves session targets across stop and restarts them at EOF', () => {
    vi.useFakeTimers();
    try {
      const globalFile = makeFile();
      const sessionFile = makeFile();
      const writeLine = vi.fn();
      const tailer = new CcDebugRawTailer(writeLine, { pollIntervalMs: 10 });
      tailer.register(sessionFile, 'session-3');
      tailer.start(globalFile);
      tailer.stop();

      fs.appendFileSync(sessionFile, 'while disabled\n');
      tailer.start(globalFile);
      fs.appendFileSync(sessionFile, 'after restart\n');
      tailer.pollNow();
      tailer.stop();

      expect(writeLine.mock.calls).toEqual([['after restart', 'session-3']]);
    } finally {
      vi.useRealTimers();
    }
  });
});
