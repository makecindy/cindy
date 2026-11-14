import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskManagementStore, DAY_MS } from '../store.js';

// #10310, unit: override-file tests do not cover task retention surviving reset
// or reopening. Minimal input is a restored task followed by a settings reset.
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-task-archive-'));
  directories.push(dir);
  let owner = 'owner-a';
  const options = {
    filePath: (name: string) => path.join(dir, owner, name),
    scopeKey: () => owner,
  };
  return {
    options,
    store: createTaskManagementStore(options),
    switchOwner: () => {
      owner = 'owner-b';
    },
  };
}
describe('task archive preferences and restore retention', () => {
  it('uses opt-in defaults without materializing a file and preserves restored tasks through reset/reopen', async () => {
    const f = fixture();
    expect(f.store.read()).toEqual({ enabled: false, days: 7 });
    expect(fs.existsSync(f.options.filePath('task-management.json'))).toBe(false);
    await f.store.update({ enabled: true, days: 14 });
    await f.store.restored(['task'], 500 * DAY_MS);
    await f.store.reset();
    const reopened = createTaskManagementStore(f.options);
    expect(reopened.read()).toEqual({ enabled: false, days: 7 });
    expect(reopened.restoredAt()).toEqual({ task: 500 * DAY_MS });
    expect(
      JSON.parse(fs.readFileSync(f.options.filePath('task-management.json'), 'utf8')),
    ).not.toHaveProperty('enabled');
    f.switchOwner();
    expect(reopened.read()).toEqual({ enabled: false, days: 7 });
    expect(reopened.restoredAt()).toEqual({});
  });

  it('rejects invalid periods and retains explicit defaults without losing concurrent restore metadata', async () => {
    const f = fixture();
    await expect(f.store.update({ days: 0 })).rejects.toThrow();
    await expect(f.store.update({ days: 366 })).rejects.toThrow();
    await expect(f.store.update({ days: 1.5 })).rejects.toThrow();
    const second = createTaskManagementStore(f.options);
    await Promise.all([
      f.store.update({ days: 7, enabled: false }),
      second.restored(['task'], 500 * DAY_MS),
    ]);
    expect(f.store.read()).toEqual({ enabled: false, days: 7 });
    expect(f.store.restoredAt()).toEqual({ task: 500 * DAY_MS });
    expect(
      JSON.parse(fs.readFileSync(f.options.filePath('task-management.json'), 'utf8')),
    ).toMatchObject({ enabled: false, days: 7 });
  });

  it('fails closed on malformed settings and does not overwrite the unreadable file', async () => {
    const f = fixture();
    const file = f.options.filePath('task-management.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    expect(f.store.read().enabled).toBe(false);
    await expect(f.store.update({ enabled: true })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
  });
});
