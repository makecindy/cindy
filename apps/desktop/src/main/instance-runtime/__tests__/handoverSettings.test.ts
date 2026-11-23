import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SetupSettingsGroup } from '../../setup-migration/settingsGroups.js';
import { SETUP_SETTINGS_GROUPS } from '../../setup-migration/settingsGroups.js';
import {
  applyHandoverInbox,
  collectHandoverSettings,
  HANDOVER_SETTINGS_FILE,
  startCloudHandoverSettings,
  writeHandoverSettings,
} from '../handoverSettings.js';

const temporary: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const directory = () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-settings-'));
  temporary.push(created);
  return created;
};

/** A settings store reduced to what the handover touches: customized values and a guarded patch. */
function store(customized: Record<string, unknown>, knownKeys: string[] = Object.keys(customized)) {
  const applyPatch = vi.fn(async (select: (here: Record<string, unknown>) => Record<string, unknown>) => {
    const values = Object.fromEntries(Object.entries(select({ ...customized })).filter(([key]) => knownKeys.includes(key)));
    if (Object.keys(values).length === 0) return false;
    Object.assign(customized, values);
    return true;
  });
  return { customized, settings: { readCustomized: () => ({ ...customized }), applyPatch } };
}
const group = (id: string, settings: SetupSettingsGroup['settings'], platforms?: NodeJS.Platform[]): SetupSettingsGroup => ({ id, settings, ...(platforms ? { platforms } : {}) });
const inbox = (root: string, id: string, body: string) => {
  const target = path.join(root, 'handover-inbox', id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, HANDOVER_SETTINGS_FILE), body);
  return target;
};

describe('handover settings snapshot', () => {
  it('holds what the owner changed, and nothing about how this installation updates or another platform', () => {
    const appearance = store({ theme: 'dark' }), untouched = store({}), update = store({ enabled: false }), menubar = store({ visible: false });
    const broken = { readCustomized: () => { throw new Error('unreadable'); }, applyPatch: async () => false };
    const groups = [group('appearance', appearance.settings), group('collaboration', untouched.settings), group('autoUpdate', update.settings),
      group('updateChannel', update.settings), group('menubar', menubar.settings, ['darwin']), group('gitSafety', broken)];
    expect(collectHandoverSettings(groups, 'linux')).toEqual({ version: 1, groups: { appearance: { theme: 'dark' } } });
  });

  it('never offers the stores that decide how the app updates itself', () => {
    const ids = SETUP_SETTINGS_GROUPS.map((entry) => entry.id);
    // These two exist in the shared list; the handover must keep leaving them out by name.
    expect(ids).toEqual(expect.arrayContaining(['autoUpdate', 'updateChannel']));
    const all = SETUP_SETTINGS_GROUPS.map((entry) => group(entry.id, store({ value: 1 }).settings, entry.platforms ? [...entry.platforms] : undefined));
    const collected = Object.keys(collectHandoverSettings(all, 'linux').groups);
    expect(collected).not.toContain('autoUpdate');
    expect(collected).not.toContain('updateChannel');
    expect(collected).toContain('appearance');
  });

  it('is written where CIS looks for it, privately, and only when it changed', () => {
    const owner = directory(), appearance = store({ theme: 'dark' }), groups = [group('appearance', appearance.settings)];
    expect(writeHandoverSettings(owner, groups, 'linux')).toBe(true);
    const file = path.join(owner, 'handover', HANDOVER_SETTINGS_FILE);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, groups: { appearance: { theme: 'dark' } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual([HANDOVER_SETTINGS_FILE]);
    expect(writeHandoverSettings(owner, groups, 'linux')).toBe(false);
    appearance.customized.theme = 'light';
    expect(writeHandoverSettings(owner, groups, 'linux')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).groups.appearance.theme).toBe('light');
  });
});

describe('handover settings inbox', () => {
  it('fills in what the receiver left at the defaults and keeps every choice they made', async () => {
    const root = directory();
    const appearance = store({ theme: 'light' }, ['theme', 'fontSize']), collaboration = store({}, ['mode']), update = store({}, ['enabled']);
    const groups = [group('appearance', appearance.settings), group('collaboration', collaboration.settings), group('autoUpdate', update.settings)];
    const entry = inbox(root, 'handover-1', JSON.stringify({ version: 1, groups: {
      appearance: { theme: 'dark', fontSize: 15, unknownKey: true }, collaboration: { mode: 'review' }, autoUpdate: { enabled: false }, somethingNew: { a: 1 } } }));
    expect((await applyHandoverInbox(root, groups, 'linux')).sort()).toEqual(['appearance', 'collaboration']);
    expect(appearance.customized).toEqual({ theme: 'light', fontSize: 15 });
    expect(collaboration.customized).toEqual({ mode: 'review' });
    expect(update.settings.applyPatch).not.toHaveBeenCalled();
    // Offered once: the entry is gone, and a second start changes nothing.
    expect(fs.existsSync(entry)).toBe(false);
    expect(await applyHandoverInbox(root, groups, 'linux')).toEqual([]);
  });

  it('discards an entry it cannot use without touching any setting', async () => {
    const root = directory(), appearance = store({}, ['theme']), groups = [group('appearance', appearance.settings)];
    const entries = [inbox(root, 'not-json', '{'), inbox(root, 'wrong-version', JSON.stringify({ version: 2, groups: { appearance: { theme: 'dark' } } })),
      inbox(root, 'wrong-shape', JSON.stringify({ version: 1, groups: { appearance: ['dark'] } })), inbox(root, 'too-large', JSON.stringify({ version: 1, groups: { appearance: { theme: 'x'.repeat(300_000) } } }))];
    fs.mkdirSync(path.join(root, 'handover-inbox', 'empty'));
    expect(await applyHandoverInbox(root, groups, 'linux')).toEqual([]);
    expect(appearance.customized).toEqual({});
    for (const entry of entries) expect(fs.existsSync(entry)).toBe(false);
    expect(await applyHandoverInbox(directory(), groups, 'linux')).toEqual([]);
  });
});

describe('cloud handover settings lifecycle', () => {
  it('waits for the instance member, applies the inbox once, then keeps the snapshot current until quit', async () => {
    vi.useFakeTimers();
    const root = directory(), owner = path.join(root, 'owners', 'key'), warn = vi.fn();
    inbox(root, 'handover-1', JSON.stringify({ version: 1, groups: {} }));
    let active: string | null = null;
    const stop = startCloudHandoverSettings({ membershipId: 'member-a', activeOwnerId: () => active, ownerDirectory: () => owner, userDataDirectory: () => root, warn, intervalMs: 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    // Signed out, or someone else: nothing is read or written.
    expect(fs.existsSync(path.join(root, 'handover-inbox', 'handover-1'))).toBe(true);
    expect(fs.existsSync(path.join(owner, 'handover'))).toBe(false);
    active = 'member-b';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(path.join(owner, 'handover'))).toBe(false);
    active = 'member-a';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fs.existsSync(path.join(root, 'handover-inbox', 'handover-1'))).toBe(false);
    const file = path.join(owner, 'handover', HANDOVER_SETTINGS_FILE);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(1);
    fs.rmSync(file);
    stop();
    // The quitting write restores it even though no timer fired in between.
    expect(fs.existsSync(file)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
