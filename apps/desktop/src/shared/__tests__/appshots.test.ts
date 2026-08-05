import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPSHOT_SHORTCUT_PREFERENCES,
  coerceAppshotMetadata,
  formatAppshotContext,
  formatAppshotShortcut,
  isDualModifierSnapshot,
  normalizeAppshotShortcut,
  normalizeAppshotShortcutPreferences,
  type AppshotMetadata,
} from '../appshots';

const metadata: AppshotMetadata = {
  schemaVersion: 1,
  captureId: 'capture-1',
  capturedAt: '2026-08-05T00:00:00.000Z',
  applicationName: 'A&B',
  bundleIdentifier: 'com.example.app',
  windowTitle: '"Draft" <1>',
  accessibilityText: '<AXButton title="Send & close">',
  accessibilityTruncated: false,
};

describe('Appshot metadata', () => {
  it('coerces valid metadata into a fresh object', () => {
    const normalized = coerceAppshotMetadata(metadata);
    expect(normalized).toEqual(metadata);
    expect(normalized).not.toBe(metadata);
  });

  it('rejects unsupported schemas and oversized scalar fields', () => {
    expect(coerceAppshotMetadata({ ...metadata, schemaVersion: 2 })).toBeNull();
    expect(coerceAppshotMetadata({ ...metadata, applicationName: 'a'.repeat(4097) })).toBeNull();
  });

  it('accepts scalar fields at 4 KiB UTF-8 and rejects one code point above', () => {
    const boundary = '🙂'.repeat(1024);
    const oversized = `${boundary}🙂`;
    const fields = [
      'captureId',
      'capturedAt',
      'applicationName',
      'bundleIdentifier',
      'windowTitle',
    ] as const;

    for (const field of fields) {
      expect(coerceAppshotMetadata({ ...metadata, [field]: boundary })?.[field]).toBe(boundary);
      expect(coerceAppshotMetadata({ ...metadata, [field]: oversized })).toBeNull();
    }
  });

  it('rejects accessibility text over 512 KiB without truncating it', () => {
    expect(
      coerceAppshotMetadata({ ...metadata, accessibilityText: '🙂'.repeat(131_073) }),
    ).toBeNull();
  });

  it('formats escaped XML context', () => {
    expect(formatAppshotContext(metadata)).toBe(
      '<appshot app="A&amp;B" bundle-identifier="com.example.app" window-title="&quot;Draft&quot; &lt;1&gt;">\n' +
        'Window: ""Draft" &lt;1&gt;", App: A&amp;B.\n' +
        '<accessibility-tree>\n' +
        '&lt;AXButton title="Send &amp; close"&gt;\n' +
        '</accessibility-tree>\n' +
        '</appshot>',
    );
  });

  it('removes XML-disallowed controls and unpaired surrogates', () => {
    expect(
      formatAppshotContext({
        ...metadata,
        applicationName: 'A\u0000\u0008\ud800B',
        windowTitle: null,
        accessibilityText: 'Send\u0000\u0008\udc00 now',
      }),
    ).toBe(
      '<appshot app="AB" bundle-identifier="com.example.app">\n' +
        'App: AB.\n' +
        '<accessibility-tree>\n' +
        'Send now\n' +
        '</accessibility-tree>\n' +
        '</appshot>',
    );
  });
});

describe('Appshot shortcuts', () => {
  it('matches exactly two sides of the requested modifier', () => {
    expect(isDualModifierSnapshot(['MetaLeft', 'MetaRight'], 'command')).toBe(true);
    expect(isDualModifierSnapshot(['MetaRight', 'MetaLeft'], 'command')).toBe(true);
    expect(isDualModifierSnapshot(['AltLeft', 'AltRight'], 'option')).toBe(true);
    expect(isDualModifierSnapshot(['ShiftLeft', 'ShiftRight'], 'shift')).toBe(true);
    expect(isDualModifierSnapshot(['MetaLeft', 'MetaRight', 'KeyA'], 'command')).toBe(false);
    expect(isDualModifierSnapshot(['MetaLeft', 'AltRight'], 'command')).toBe(false);
  });

  it('falls back to the full default preferences when malformed', () => {
    const normalized = normalizeAppshotShortcutPreferences({
      preferred: { kind: 'dual-modifier', modifier: 'command' },
      fallback: { kind: 'accelerator', combo: { code: 'ShiftLeft', shift: true } },
    });
    expect(normalized).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    expect(normalized).not.toBe(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES);
    expect(normalized.preferred).not.toBe(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred);
    expect(normalizeAppshotShortcut(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback)).toEqual(
      DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback,
    );
    expect(formatAppshotShortcut(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred)).toBe(
      'Double Command',
    );
    expect(formatAppshotShortcut(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback, 'darwin')).toBe(
      '⇧⌘A',
    );
  });
});
