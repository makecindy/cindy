import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readInterruptedTurnAutoResumeSettingsFrom } from '../maker-host/interruptedTurnAutoResumeSettingsCore';
import { readSilentStopAutoResumeSettingsFrom } from '../maker-host/silentStopAutoResumeSettingsCore';
import { createSessionRuntimeFallbackSettingsFile } from '../maker-host/sessionRuntimeFallbackSettingsCore';

// The auto-resume switches are read from the profile root the caller gives (the desktop passes
// its userData, the Node Host its profile directory). Each keeps its default while the file is
// missing or unreadable and observes a hand edit without a restart.
describe('auto-resume settings read from a profile root', () => {
  const roots: string[] = [];
  const root = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-settings-'));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['interrupted-turn-auto-resume-settings.json', readInterruptedTurnAutoResumeSettingsFrom],
    ['silent-stop-auto-resume-settings.json', readSilentStopAutoResumeSettingsFrom],
  ] as const)('%s: on by default, off when edited, default again when unreadable', (file, read) => {
    const dir = root();
    expect(read(dir)).toEqual({ enabled: true });
    fs.writeFileSync(path.join(dir, file), '{"enabled":false}');
    expect(read(dir)).toEqual({ enabled: false });
    fs.writeFileSync(path.join(dir, file), '{"enabled":');
    expect(read(dir)).toEqual({ enabled: true });
  });

  it('session-runtime-fallback-settings.json: off by default and read from the given root', () => {
    const dir = root();
    const store = createSessionRuntimeFallbackSettingsFile(() => dir);
    expect(store.read()).toEqual({ enabled: false });
    fs.writeFileSync(path.join(dir, 'session-runtime-fallback-settings.json'), '{"enabled":true}');
    // This store caches until its file identity is checked again, as on the desktop.
    store.invalidateIfChanged();
    expect(store.read()).toEqual({ enabled: true });
  });
});
