import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createIpcChannelUsage, registeredIpcChannels, tapIpcChannelUsage } from '../ipcChannelUsage';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Electron 42 shape: invoke checks has() then get(); handle() checks has() first. */
class FakeIpcMain extends EventEmitter {
  _invokeHandlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    if (this._invokeHandlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this._invokeHandlers.set(channel, listener);
  }
  invoke(channel: string): unknown {
    if (!this._invokeHandlers.has(channel)) throw new Error(`No handler registered for '${channel}'`);
    return this._invokeHandlers.get(channel)!();
  }
}

describe('IPC channel usage', () => {
  it('counts outcomes per channel and ranks unserved channels', () => {
    const lines: string[] = [];
    const usage = createIpcChannelUsage({ mode: 'client', log: (line) => lines.push(line) });
    usage.record('maker:a', 'invoke', 'unsupported');
    usage.record('maker:a', 'invoke', 'unsupported');
    usage.record('b', 'invoke', 'missing');
    usage.record('c', 'event', 'handled');

    expect(usage.report().channels['invoke:maker:a']).toEqual({ kind: 'invoke', count: 2, handled: 0, missing: 0, unsupported: 2 });
    expect(usage.topUnserved(5).map(([channel]) => channel)).toEqual(['maker:a', 'b']);
    // One log line per unserved channel, not per call.
    expect(lines).toEqual(['[ipc-usage] no handler for invoke maker:a (unsupported)', '[ipc-usage] no handler for invoke b (missing)']);
  });

  it('writes the report atomically on flush', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-usage-'));
    roots.push(root);
    const file = path.join(root, 'nested', 'usage.json');
    const usage = createIpcChannelUsage({ mode: 'embedded', file, flushDelayMs: 60_000 });
    usage.record('x', 'invoke', 'handled');
    usage.flush();

    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(report.mode).toBe('embedded');
    expect(report.channels).toEqual({ 'invoke:x': { kind: 'invoke', count: 1, handled: 1, missing: 0, unsupported: 0 } });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['usage.json']);
  });

  it('includes the registered handler snapshot when asked', () => {
    const ipcMain = new FakeIpcMain();
    ipcMain.handle('b:invoke', () => 1);
    ipcMain.handle('a:invoke', () => 2);
    ipcMain.on('z:event', () => {});
    const usage = createIpcChannelUsage({ mode: 'client', registered: () => registeredIpcChannels(ipcMain) });
    expect(usage.report().registered).toEqual({ invoke: ['a:invoke', 'b:invoke'], event: ['z:event'] });
    expect(createIpcChannelUsage({ mode: 'client' }).report()).not.toHaveProperty('registered');
  });

  it('taps invokes and events without counting registrations or changing results', () => {
    const ipcMain = new FakeIpcMain();
    const usage = createIpcChannelUsage({ mode: 'embedded' });
    tapIpcChannelUsage(ipcMain, usage);

    ipcMain.handle('known', () => 'ok');
    expect(() => ipcMain.handle('known', () => 'again')).toThrow(/second handler/);
    expect(ipcMain.invoke('known')).toBe('ok');
    expect(() => ipcMain.invoke('absent')).toThrow(/No handler registered/);
    const heard: unknown[] = [];
    ipcMain.on('listened', (payload) => heard.push(payload));
    ipcMain.emit('listened', 1);
    ipcMain.emit('nobody');

    expect(heard).toEqual([1]);
    expect(usage.report().channels).toEqual({
      'invoke:known': { kind: 'invoke', count: 1, handled: 1, missing: 0, unsupported: 0 },
      'invoke:absent': { kind: 'invoke', count: 1, handled: 0, missing: 1, unsupported: 0 },
      'event:listened': { kind: 'event', count: 1, handled: 1, missing: 0, unsupported: 0 },
      'event:nobody': { kind: 'event', count: 1, handled: 0, missing: 1, unsupported: 0 },
    });
  });
});

// PR #10047 P2: a sync event and an invoke can share the same channel name.
// Production entry: createIpcChannelUsage; result: distinct counts persisted in JSON.
// Existing coverage only used unique names. Minimal input: one call of each kind.
// Tier: unit; no Electron, network, or real timers required.
it('preserves both kinds for the same channel through report JSON and unserved ranking', () => {
  const usage = createIpcChannelUsage({ mode: 'client' });
  usage.record('ghosts:workdir-prefs', 'invoke', 'unsupported');
  usage.record('ghosts:workdir-prefs', 'event', 'missing');
  usage.record('ghosts:workdir-prefs', 'event', 'missing');
  const report = JSON.parse(JSON.stringify(usage.report()));
  expect(report.version).toBe(2);
  expect(report.channels['invoke:ghosts:workdir-prefs'].count).toBe(1);
  expect(report.channels['event:ghosts:workdir-prefs'].count).toBe(2);
  expect(usage.topUnserved(5).map(([channel, entry]) => [channel, entry.kind, entry.count])).toEqual([
    ['ghosts:workdir-prefs', 'event', 2], ['ghosts:workdir-prefs', 'invoke', 1],
  ]);
});
