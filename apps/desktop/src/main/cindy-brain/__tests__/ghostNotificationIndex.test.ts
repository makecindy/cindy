/** Unit: repeated focus events must not scan unrelated installations. Existing
 * gateway tests cover delivery, not discovery lifetime. Watch events and clock
 * are controlled; no real waits. A stale hint must never survive invalidation. */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { GhostNotificationIndex } from '../ghostNotificationIndex.js';

let root: string;
let roots: string[];
let now: number;
let index: GhostNotificationIndex;
let scans: ReturnType<typeof vi.fn<() => Promise<InstalledGhost[]>>>;
const watches: Array<{ events: EventEmitter; change: (event: string, filename: string | null) => void; close: ReturnType<typeof vi.fn> }> = [];
class TestWatcher extends EventEmitter {
  close = vi.fn();
  ref() { return this; }
  unref() { return this; }
}
const subscriber = {
  manifest: { id: 'listener', subscribe: { topics: ['session'] } }, enabled: true,
} as InstalledGhost;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-notification-index-'));
  roots = ['content', 'state'].map(name => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
  watches.length = 0;
  vi.spyOn(fs, 'watch').mockImplementation((...args: unknown[]) => {
    const events = new TestWatcher();
    watches.push({ events, close: events.close, change: args[2] as (event: string, filename: string | null) => void });
    return events;
  });
  now = 0;
  scans = vi.fn(async () => [subscriber]);
  index = new GhostNotificationIndex({ roots: () => roots, scan: scans, now: () => now });
});

afterEach(() => {
  index.dispose();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('resolves unknown once and retains an empty subscriber set across focus events', async () => {
  scans.mockResolvedValue([{ ...subscriber, enabled: false }, { ...subscriber, manifest: { ...subscriber.manifest, subscribe: undefined } }]);
  await expect(index.read()).resolves.toEqual([]);
  await expect(index.read()).resolves.toEqual([]);
  expect(scans).toHaveBeenCalledOnce();
  index.invalidate();
  scans.mockResolvedValue([subscriber]);
  await expect(index.read()).resolves.toEqual([subscriber]);
  expect(scans).toHaveBeenCalledTimes(2);
});

it('shares in-flight discovery but never retains a scan racing a mutation', async () => {
  let release!: (value: InstalledGhost[]) => void;
  scans.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = index.read();
  const second = index.read();
  expect(scans).toHaveBeenCalledOnce();
  index.invalidate();
  scans.mockResolvedValue([]);
  await expect(index.read()).resolves.toEqual([]);
  release([subscriber]);
  await Promise.all([first, second]);
  await expect(index.read()).resolves.toEqual([]);
  expect(scans).toHaveBeenCalledTimes(2);
});

it('refreshes external receipt, marker and namespaced installation changes, not asset writes', async () => {
  await index.read();
  watches[0]!.change('change', 'listener/main.js');
  watches[1]!.change('change', 'skill-snapshots/listener/revision/SKILL.md');
  await index.read();
  expect(scans).toHaveBeenCalledOnce();
  for (const [watch, filename] of [[1, '_ns/acme/listener.json'], [0, 'listener/.disabled'], [0, '_ns/acme/new-plugin'], [0, null]] as const) {
    watches[watch]!.change('rename', filename);
    await index.read();
  }
  expect(scans).toHaveBeenCalledTimes(5);
});

it('bounds missed watcher events and drops the index on owner/root replacement', async () => {
  await index.read();
  now = 60_001;
  await index.read();
  expect(scans).toHaveBeenCalledTimes(2);
  const old = watches[0]!;
  const replacement = path.join(root, 'next-owner');
  fs.mkdirSync(replacement);
  roots = [replacement, roots[1]!];
  scans.mockResolvedValue([]);
  await expect(index.read()).resolves.toEqual([]);
  old.events.emit('error', new Error('late old watcher failure'));
  await index.read();
  expect(scans).toHaveBeenCalledTimes(3);
  expect(old.close).toHaveBeenCalledOnce();
});

it('falls back to fresh scans after watching fails and retries discovery failures', async () => {
  await index.read();
  watches[0]!.events.emit('error', new Error('watcher lost'));
  vi.mocked(fs.watch).mockImplementation(() => { throw new Error('unsupported'); });
  scans.mockRejectedValueOnce(new Error('read failed'));
  await expect(index.read()).rejects.toThrow('read failed');
  scans.mockResolvedValue([]);
  await expect(index.read()).resolves.toEqual([]);
  await expect(index.read()).resolves.toEqual([]);
  expect(scans).toHaveBeenCalledTimes(4);
});
