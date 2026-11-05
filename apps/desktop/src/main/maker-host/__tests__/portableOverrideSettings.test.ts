import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOverrideSettingsFile, portableOverrideSettings } from '../override-settings-file.js';

interface Settings {
  enabled: boolean;
  limit: number;
  folder: string;
  /** Optional: absent from defaults, kept by normalize when supplied. */
  note?: string;
}

const DEFAULTS: Settings = { enabled: true, limit: 5, folder: '' };
const dirs: string[] = [];

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-portable-settings-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  const settings = createOverrideSettingsFile<Settings>({
    filePath: () => file,
    defaults: DEFAULTS,
    normalize: (raw) => {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return {
        enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
        limit: typeof r.limit === 'number' ? Math.min(20, r.limit) : DEFAULTS.limit,
        folder: typeof r.folder === 'string' ? r.folder : DEFAULTS.folder,
        ...(typeof r.note === 'string' ? { note: r.note } : {}),
      };
    },
    log: { info: vi.fn(), warn: vi.fn() },
    label: 'portable-test',
  });
  return { settings, file };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('portableOverrideSettings', () => {
  it('exports only values the user changed, minus device-bound keys', () => {
    const { settings } = store();
    settings.writePatch({ limit: 9, folder: '/Users/me/chats' });
    const portable = portableOverrideSettings(settings, { omitKeys: ['folder'] });
    expect(portable.readCustomized()).toEqual({ limit: 9 });
  });

  it('applies another computer’s choice through normalize and keeps an explicit default explicit', async () => {
    const { settings, file } = store();
    const portable = portableOverrideSettings(settings);
    expect(await portable.applyPatch(() => ({ enabled: true, limit: 50 }))).toBe(true);
    // `enabled: true` equals the default but was an explicit choice on the other computer.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabled: true, limit: 20 });
    expect(settings.readState().customizedKeys.sort()).toEqual(['enabled', 'limit']);
  });

  it('ignores omitted and unknown keys instead of marking the store customized', async () => {
    const { settings, file } = store();
    const portable = portableOverrideSettings(settings, { omitKeys: ['folder'] });
    expect(await portable.applyPatch(() => ({ folder: '/Users/other', futureKey: 1, 'bad key': true }))).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(settings.readState().isCustomized).toBe(false);
  });

  it('accepts optional keys a store declares even though a fresh store has none of them', async () => {
    const { settings, file } = store();
    await portableOverrideSettings(settings).applyPatch(() => ({ note: 'dropped' }));
    expect(fs.existsSync(file)).toBe(false);
    await portableOverrideSettings(settings, { optionalKeys: ['note'] }).applyPatch(() => ({ note: 'kept' }));
    expect(settings.read().note).toBe('kept');
  });

  it('lets a store drop values that only mean something on the source computer', () => {
    const { settings } = store();
    settings.writePatch({ folder: 'custom', limit: 3 });
    const portable = portableOverrideSettings(settings, {
      filter: (values) => {
        const rest = { ...values };
        delete rest.folder;
        return rest;
      },
    });
    expect(portable.readCustomized()).toEqual({ limit: 3 });
  });

  it('resolves a lazily created per-account store on every call', () => {
    const first = store().settings;
    const second = store().settings;
    second.writePatch({ limit: 7 });
    let current = first;
    const portable = portableOverrideSettings(() => current);
    expect(portable.readCustomized()).toEqual({});
    current = second;
    expect(portable.readCustomized()).toEqual({ limit: 7 });
  });
});
