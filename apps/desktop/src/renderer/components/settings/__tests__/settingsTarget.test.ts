// The IM cards reach settings only through the settings target, so another surface can scope
// them to a different computer. Opening an external link stays on this computer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const files = [
  'HookConnectionsSection.tsx',
  'HookWorkspacePrefsEditor.tsx',
  'TelegramBehaviorSettings.tsx',
];

describe('settings target', () => {
  it.each(files)('%s calls no local settings API directly', (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const direct = [...source.matchAll(/window\.electronAPI\.([a-zA-Z]+)/g)].map((m) => m[1]);
    expect(direct.filter((api) => api !== 'openExternal')).toEqual([]);
    expect(source).not.toMatch(/contactsService/);
  });
});
