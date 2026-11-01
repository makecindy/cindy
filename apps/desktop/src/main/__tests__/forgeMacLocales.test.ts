import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { stageMacPermissionLocales } from '../../../forge-mac-locales';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

// Unit: macOS reads permission copy from bundle resources, not the UI catalog.
// Verify the production packaging entry writes main/helper bundles while retaining
// Electron's existing UTF-16 localized bundle name. Existing staging tests cover notices only.
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('stages ten native locales for the app and helpers without losing existing strings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mac-locales-'));
  fixtures.push(root);
  const resources = path.join(root, 'Cindy.app', 'Contents', 'Resources');
  const helper = path.join(root, 'Cindy.app', 'Contents', 'Frameworks', 'Cindy Helper (Renderer).app', 'Contents', 'Resources');
  const strings = path.join(resources, 'fr.lproj', 'InfoPlist.strings');
  const compiledStrings = path.join(helper, 'en.lproj', 'InfoPlist.strings');
  const regional = path.join(resources, 'es_419.lproj');
  fs.mkdirSync(path.dirname(strings), { recursive: true });
  fs.mkdirSync(path.dirname(compiledStrings), { recursive: true });
  fs.mkdirSync(regional, { recursive: true });
  fs.writeFileSync(compiledStrings, Buffer.from('bplist00\0compiled-native-resource'));
  // Only the native format decoder is substituted on Windows; the production
  // staging/merge/write path must keep keys returned by macOS's plist reader.
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ CFBundleDisplayName: 'Cindy Helper' }));
  fs.writeFileSync(strings, '\ufeff"CFBundleDisplayName" = "Cindy";\n', 'utf16le');
  stageMacPermissionLocales(resources);
  const first = fs.readFileSync(strings);
  const firstCompiled = fs.readFileSync(compiledStrings);
  stageMacPermissionLocales(resources);
  expect(fs.readFileSync(strings)).toEqual(first);
  expect(fs.readFileSync(compiledStrings)).toEqual(firstCompiled);
  const text = first.toString('utf16le');
  expect(text).toContain('"CFBundleDisplayName" = "Cindy";');
  expect(text).toContain('"NSMicrophoneUsageDescription" = "Cindy a besoin');
  expect(text).toContain('"NSContactsUsageDescription"');
  expect(fs.readFileSync(compiledStrings, 'utf8')).toContain('"CFBundleDisplayName" = "Cindy Helper";');
  expect(fs.readFileSync(path.join(regional, 'InfoPlist.strings'), 'utf8')).toContain('Cindy necesita acceso al micrófono');
  for (const dir of [resources, helper]) {
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.lproj') && name !== 'es_419.lproj').sort()).toEqual([
      'de.lproj', 'en.lproj', 'es.lproj', 'fr.lproj', 'ja.lproj', 'ko.lproj', 'pt-BR.lproj', 'pt-PT.lproj', 'zh-Hans.lproj', 'zh-Hant.lproj',
    ]);
    expect(fs.readFileSync(path.join(dir, 'pt-BR.lproj', 'InfoPlist.strings'), 'utf8')).toContain('se conectar diretamente, com criptografia');
  }
});
