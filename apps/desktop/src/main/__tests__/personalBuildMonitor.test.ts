import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersonalBuildMonitor, consumePersonalMonitorEnvironment } from '../personalBuildMonitor.js';

// Unit tier through the actual monitor tick and real temporary files. No existing test exercises
// developer supervisor quit requests. A stale pid/generation or activity beginning during await
// must not authorize quitting. No real user profile, Electron process, timers or credentials.
describe.runIf(process.platform === 'darwin')('personal build host handoff', () => {
  it('consumes routing before child spawn and refuses a second writer for the same generation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-owner-'));
    try {
      const generation = '11111111-1111-1111-1111-111111111111';
      const env = { CINDY_PERSONAL_MONITOR_DIR: directory, CINDY_PERSONAL_GENERATION: generation, KEEP: 'value' };
      expect(consumePersonalMonitorEnvironment(env)).toEqual({ directory, generation });
      expect({ ...env }).toEqual({ KEEP: 'value' });
      expect(consumePersonalMonitorEnvironment(env)).toBeNull();
      const deps = { directory, generation, pid: 42, now: () => 1000,
        ready: () => true, remoteReady: () => true, idle: () => false, quitting: () => false,
        busy: async () => true, quit: () => { throw new Error('unexpected quit'); } };
      const owner = createPersonalBuildMonitor(deps);
      await owner();
      const before = fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8');
      const child = createPersonalBuildMonitor({ ...deps, pid: 43, busy: async () => false });
      await child();
      expect(fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8')).toBe(before);
      await owner();
      expect(JSON.parse(before)).toMatchObject({ pid: 42, busy: true });
      fs.unlinkSync(path.join(directory, 'host-owner.json'));
      await createPersonalBuildMonitor({ ...deps, pid: 44 })();
      expect(fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8')).toBe(before);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('requires a fresh supervisor plugin request, waits for idle, and records a single application result', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-plugin-monitor-'));
    try {
      const generation = '11111111-1111-1111-1111-111111111111';
      let updates = 0, busy = true;
      const tick = createPersonalBuildMonitor({ directory, generation, pid: 42, now: () => 1000,
        ready: () => true, remoteReady: () => true, idle: () => true, quitting: () => false,
        busy: async () => busy, quit: () => { throw new Error('unexpected quit'); },
        updateLocalPlugins: async () => { updates++; return { state: 'verified' }; } });
      await tick(); expect(updates).toBe(0);
      const request = path.join(directory, 'plugins-request.json');
      fs.writeFileSync(request, JSON.stringify({ action: 'update-local-plugins', generation, pid: 42, expiresAt: 2000 }));
      await tick(); expect(updates).toBe(0);
      busy = false; await tick(); await tick(); expect(updates).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'plugins-result.json'), 'utf8')))
        .toMatchObject({ phase: 'completed', pid: 42, generation, report: { state: 'verified' } });
      for (const invalid of [{ pid: 43 }, { generation: 'old' }, { expiresAt: 999 }]) {
        fs.writeFileSync(request, JSON.stringify({ action: 'update-local-plugins', generation, pid: 42, expiresAt: 2000, ...invalid }));
        await tick(); expect(updates).toBe(1);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('requires current identity and fresh request, and resamples activity before quitting', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-monitor-'));
    try {
      const generation = '11111111-1111-1111-1111-111111111111';
      let quit = 0, calls = 0, busyAtSecondRead = false, now = 1000, expireDuringRead = false, remote = true;
      const tick = createPersonalBuildMonitor({ directory, generation, pid: 42, now: () => now,
        ready: () => true, remoteReady: () => remote, idle: () => true, quitting: () => false,
        busy: async () => { calls++; if (expireDuringRead && calls % 2 === 0) now = 2001; return busyAtSecondRead && calls % 2 === 0; }, quit: () => { quit++; } });
      const request = (extra = {}) => fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({ action: 'quit', generation, pid: 42, expiresAt: 2000, ...extra }));
      for (const invalid of [{ pid: 43 }, { generation: 'old' }, { expiresAt: 999 }, { action: 'replace' }]) {
        request(invalid); await tick(); expect(quit).toBe(0);
      }
      calls = 0; busyAtSecondRead = true; request(); await tick(); expect(quit).toBe(0);
      calls = 0; busyAtSecondRead = false; expireDuringRead = true; request(); await tick(); expect(quit).toBe(0);
      expireDuringRead = false; now = 1000; remote = false; request({ requireRemote: true }); await tick(); expect(quit).toBe(0);
      remote = true;
      calls = 0; busyAtSecondRead = false; request(); await tick(); expect(quit).toBe(1);
      expect(fs.existsSync(path.join(directory, 'request.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8'))).toMatchObject({ pid: 42, generation, ready: true });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('unknown activity remains busy and never quits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-monitor-'));
    try {
      let quit = false;
      const tick = createPersonalBuildMonitor({ directory, generation: '11111111-1111-1111-1111-111111111111', pid: 1,
        now: () => 1000, ready: () => true, remoteReady: () => true, idle: () => true, quitting: () => false,
        busy: async () => { throw new Error('unavailable'); }, quit: () => { quit = true; } });
      await tick(); expect(quit).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'heartbeat.json'), 'utf8')).busy).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
