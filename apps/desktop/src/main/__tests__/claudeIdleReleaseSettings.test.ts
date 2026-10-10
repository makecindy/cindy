import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../maker-host/logger-adapter.js', () => ({ desktopMakerLogger: {
  child: () => ({ info: vi.fn(), warn: vi.fn() }),
} }));
import { normalizeClaudeIdleSettings, readClaudeIdleMinutes } from '../maker-host/claude-idle-release-settings';

describe('Claude idle release override', () => {
  it.each([undefined, null, {}, { minutes: -1 }, { minutes: 1.5 }, { minutes: 1441 },
    { minutes: '0' }, { minutes: NaN }, { minutes: Infinity }])('rejects malformed settings %j', raw => {
    expect(normalizeClaudeIdleSettings(raw)).toEqual({ minutes: 30 });
  });
  it.each([0, 1, 30, 1440])('accepts %i minutes', minutes => {
    expect(normalizeClaudeIdleSettings({ minutes })).toEqual({ minutes });
  });
  it('does not persist defaults and reloads explicit overrides and reset without restarting', () => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-idle-settings-'));
    const file = path.join(state.dir, 'claude-idle-release.json');
    try {
      expect(readClaudeIdleMinutes()).toBe(30); expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(file, '{"minutes":0}'); expect(readClaudeIdleMinutes()).toBe(0);
      fs.writeFileSync(file, '{"minutes":60}');
      expect(readClaudeIdleMinutes()).toBe(60);
      fs.unlinkSync(file); expect(readClaudeIdleMinutes()).toBe(30);
    } finally { fs.rmSync(state.dir, { recursive: true, force: true }); }
  });
  it.each(['rewrite', 'replace'])('reloads a same-size %s with an unchanged mtime', mode => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-idle-settings-'));
    const file = path.join(state.dir, 'claude-idle-release.json');
    const timestamp = new Date('2026-01-01T00:00:00Z');
    try {
      fs.writeFileSync(file, '{"minutes":30}'); fs.utimesSync(file, timestamp, timestamp);
      const before = fs.statSync(file);
      expect(readClaudeIdleMinutes()).toBe(30);
      const destination = mode === 'replace' ? `${file}.tmp` : file;
      fs.writeFileSync(destination, '{"minutes":0 }');
      fs.utimesSync(destination, timestamp, timestamp);
      if (mode === 'replace') fs.renameSync(destination, file);
      expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
      expect(fs.statSync(file).size).toBe(before.size);
      expect(readClaudeIdleMinutes()).toBe(0);
    } finally { fs.rmSync(state.dir, { recursive: true, force: true }); }
  });
  it('keeps malformed overrides intact and observes their repair', () => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-idle-settings-'));
    const file = path.join(state.dir, 'claude-idle-release.json');
    try {
      fs.writeFileSync(file, '{invalid');
      expect(readClaudeIdleMinutes()).toBe(30);
      expect(fs.readFileSync(file, 'utf-8')).toBe('{invalid');
      fs.writeFileSync(file, '{"minutes":0}');
      expect(readClaudeIdleMinutes()).toBe(0);
    } finally { fs.rmSync(state.dir, { recursive: true, force: true }); }
  });
});
