import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  maskPath: (value: string) => value,
}));

import { addRestartRecord, listRestartRecords, removeRestartRecord } from '../restartRecords.js';

const record = (requestId: string) => ({
  requestId,
  sessionId: `task-${requestId}`,
  fromVersion: '0.1.86',
  targetVersion: '0.1.90',
  requestedAt: 1,
  pid: 1,
});

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-app-update-records-'));
  file = path.join(dir, 'agent-app-update.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('restart records file', () => {
  it('appends records and removes them one by one', () => {
    addRestartRecord(file, record('a'));
    addRestartRecord(file, record('b'));
    expect(listRestartRecords(file).map((entry) => entry.requestId)).toEqual(['a', 'b']);
    removeRestartRecord(file, 'a');
    expect(listRestartRecords(file).map((entry) => entry.requestId)).toEqual(['b']);
    removeRestartRecord(file, 'b');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('moves a corrupt file aside before writing, never overwriting it', () => {
    fs.writeFileSync(file, '{"records": [ broken');
    addRestartRecord(file, record('new'));
    expect(listRestartRecords(file).map((entry) => entry.requestId)).toEqual(['new']);
    const aside = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]!), 'utf8')).toBe('{"records": [ broken');
  });

  it('keeps a leftover backup next to the moved-aside file instead of overwriting it', () => {
    fs.writeFileSync(file, '{"records": [ broken');
    const backup = JSON.stringify({ records: [record('in-backup')] });
    fs.writeFileSync(`${file}.bak`, backup);
    addRestartRecord(file, record('new'));
    expect(listRestartRecords(file).map((entry) => entry.requestId)).toEqual(['new']);
    const asideBackup = fs.readdirSync(dir).filter((name) => /\.corrupt-\d+\.bak$/.test(name));
    expect(asideBackup).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, asideBackup[0]!), 'utf8')).toBe(backup);
  });

  it('leaves a corrupt file untouched when only reading or removing', () => {
    fs.writeFileSync(file, 'not json');
    expect(listRestartRecords(file)).toEqual([]);
    removeRestartRecord(file, 'a');
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });
});

describe('restart records capacity', () => {
  it('never drops an undelivered record to make room for a new one', () => {
    for (let i = 0; i < 25; i += 1) addRestartRecord(file, record(`r${i}`));
    expect(listRestartRecords(file)).toHaveLength(25);
    expect(listRestartRecords(file)[0]!.requestId).toBe('r0');
  });
});

describe('restart records with an invalid entry', () => {
  const withInvalid = () =>
    fs.writeFileSync(file, JSON.stringify({ records: [record('a'), { requestId: 'broken' }] }));

  it('moves the whole file aside before appending instead of dropping the entry', () => {
    withInvalid();
    addRestartRecord(file, record('new'));
    expect(listRestartRecords(file).map((entry) => entry.requestId)).toEqual(['new']);
    const aside = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(JSON.parse(fs.readFileSync(path.join(dir, aside[0]!), 'utf8')).records).toHaveLength(2);
  });

  it('keeps the invalid entry when removing a delivered one', () => {
    withInvalid();
    removeRestartRecord(file, 'a');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).records).toEqual([{ requestId: 'broken' }]);
  });
});
