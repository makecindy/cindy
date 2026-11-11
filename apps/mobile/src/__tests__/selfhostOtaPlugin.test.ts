import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const contract = require('../../plugins/selfhost-ota/contract');
const patcher = require('../../plugins/selfhost-ota/patches');
const plugin = require('../../plugins/with-selfhost-ota').__testing;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('self-host native OTA build contract', () => {
  it('uses one canonical header identity including release', () => {
    expect(contract.requestHeaders()).toEqual({ 'EAS-Client-ID': '00000000-0000-4000-8000-000000000000',
      'x-cindy-update-channel': '' });
    expect(contract.requestHeaders('beta')['x-cindy-update-channel']).toBe('beta');
    expect(() => contract.requestHeaders('unknown')).toThrow();
  });
  it.each(['', 'http://updates.example.invalid', 'https://user:pass@example.invalid',
    'https://updates.example.invalid?a=b', 'https://updates.example.invalid#hash'])('rejects unsafe build URL %s', (url) => {
    expect(() => contract.resolveUpdatesUrl(url)).toThrow();
  });
  it('normalizes only the manifest suffix', () => {
    expect(contract.resolveUpdatesUrl('https://updates.example.invalid/root/')).toBe('https://updates.example.invalid/root/manifest');
    expect(contract.resolveUpdatesUrl('https://updates.example.invalid/root/manifest/')).toBe('https://updates.example.invalid/root/manifest');
  });
  it('includes both native implementations in the resolved fingerprint digest', () => {
    const first = contract.nativeSourceHash((file: string) => file);
    const second = contract.nativeSourceHash((file: string) => file.endsWith('.swift') ? file + ':changed' : file);
    const third = contract.nativeSourceHash((file: string) => file.endsWith('.kt') ? file + ':changed' : file);
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
    expect(contract.nativeSourceHash()).toMatch(/^[a-f0-9]{64}$/);
  });
  it('validates every pinned upstream hook and refuses ambiguous or missing anchors', () => {
    const { patched } = plugin.resolveSources(process.cwd());
    expect(patched.size).toBe(23);
    expect(() => patcher.replaceChecked('a a', 'a', 'b', 'ambiguous')).toThrow('anchor mismatch');
    expect(() => patcher.replaceChecked('x', 'a', 'b', 'missing')).toThrow('anchor mismatch');
    expect(patcher.replaceChecked('a a', 'a', 'b', 'two audited hooks', 2)).toBe('b b');
    const android = 'android/src/main/java/expo/modules/updates/';
    expect(patched.get(android + 'loader/LoaderTask.kt')).toContain('.observeEmbedded(embeddedUpdate)');
    expect(patched.get(android + 'procedures/FetchUpdateProcedure.kt')).toContain('loadUpdateWithId(availableUpdate.id)');
    expect(patched.get('ios/EXUpdates/Procedures/FetchUpdateProcedure.swift')).toContain('self.database.update(withId: update.updateId');
    expect(patched.get(android + 'errorrecovery/ErrorRecoveryHandler.kt')).toContain('if (cindyActive) super.dispatchMessage(msg)');
    expect(patched.get('ios/EXUpdates/Procedures/StartupProcedure.swift')).toContain('errorRecovery.cindyRetire()');
  });
  it('assembles an isolated source dependency without changing shared node_modules', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-ota-adapter-'));
    directories.push(directory);
    const { packageRoot, patched } = plugin.resolveSources(process.cwd());
    const original = readFileSync(join(packageRoot, 'ios/EXUpdates/UpdatesModule.swift'), 'utf8');
    const destination = plugin.prepareAdapter(process.cwd(), directory);
    for (const [file, source] of patched) expect(readFileSync(join(destination, file), 'utf8')).toBe(source);
    expect(readFileSync(join(destination, 'ios/EXUpdates/CindyOtaJournal.swift'), 'utf8')).toContain('maximumAttempts = 2');
    expect(readFileSync(join(packageRoot, 'ios/EXUpdates/UpdatesModule.swift'), 'utf8')).toBe(original);
    expect(plugin.prepareAdapter(process.cwd(), directory)).toBe(destination);
    expect(readFileSync(join(packageRoot, 'ios/EXUpdates/UpdatesModule.swift'), 'utf8')).toBe(original);
  }, 20_000);
  it('does not overwrite an unrelated directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cindy-ota-unowned-'));
    directories.push(directory);
    const destination = join(directory, 'cindy-selfhost-expo-updates');
    mkdirSync(destination);
    writeFileSync(join(destination, 'user-file.txt'), 'keep');
    expect(() => plugin.prepareAdapter(process.cwd(), directory)).toThrow();
    expect(readFileSync(join(destination, 'user-file.txt'), 'utf8')).toBe('keep');
  });
  it('registers only the generated dependency and is idempotent', () => {
    const podfile = "target 'Cindy' do\n  use_expo_modules!\nend\n";
    const modified = plugin.patchPodfile(podfile);
    expect(modified.indexOf("pod 'EXUpdates'")).toBeLessThan(modified.indexOf('use_expo_modules!'));
    expect(plugin.patchPodfile(modified)).toBe(modified);
    const gradle = 'expoAutolinking.useExpoModules()\ninclude(":app")\n';
    expect(plugin.patchSettingsGradle(gradle)).toContain("project(':expo-updates').projectDir");
    expect(plugin.patchSettingsGradle(plugin.patchSettingsGradle(gradle))).toBe(plugin.patchSettingsGradle(gradle));
  });
});
