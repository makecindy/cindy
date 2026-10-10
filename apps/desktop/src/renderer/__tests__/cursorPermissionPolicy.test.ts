import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;

describe('Cursor native permission copy', () => {
  it.each(locales)('describes all Cursor approval modes independently of Pi in %s', (locale) => {
    const desktop = JSON.parse(readFileSync(resolve('src/renderer/i18n/locales', locale, 'common.json'), 'utf8'));
    const mobile = JSON.parse(readFileSync(resolve('../mobile/src/i18n/locales', locale, 'session.json'), 'utf8'));
    const modes = desktop.newChat.permissionSelector.modes;
    const full = desktop.newChat.chatInput.fullAccessConfirmation.cursor;
    expect(full.description).toContain('Cursor');
    expect(full.note).toContain('Cursor');
    for (const item of ['files', 'commands', 'network']) expect(full.items[item].description).toContain('Cursor');
    for (const mode of ['ask', 'default', 'auto', 'bypassPermissions']) {
      expect(modes.cursor[mode].label.trim()).not.toBe('');
      expect(modes.cursor[mode].description).toContain('Cursor');
      expect(modes.cursor[mode].description).not.toBe(modes.pi.ask.description);
      const mobileHint = mode === 'auto' ? mobile.collab.cursorPermissionAutoHint
        : mode === 'bypassPermissions' ? mobile.collab.cursorPermissionFullHint : mobile.collab.permissionAskHint;
      expect(mobileHint).toBe(modes.cursor[mode].description);
    }
  });

  it('does not promise a prompt for every workspace edit', () => {
    const desktop = JSON.parse(readFileSync(resolve('src/renderer/i18n/locales/en/common.json'), 'utf8'));
    const description = desktop.newChat.permissionSelector.modes.cursor.ask.description;
    expect(description).toContain('native configured permission policy');
    expect(description).toContain('only the approval requests Cursor sends');
    expect(description).toContain('workspace edits may run without a prompt');
  });
});
