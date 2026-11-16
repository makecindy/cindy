import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkAppIcons, readAppIconManifest } from './generate-app-icons.mjs';
import { checkProjectSymbols } from './generate-project-symbols.mjs';

// Entry: the `--check` functions behind `pnpm generate:app-icons` and
// `pnpm generate:project-symbols`, run on this checkout.
// Rule: Desktop and Mobile take app icons and project symbols from one shared
// source (packages/maker-shared/app-icons, PROJECT_SYMBOLS); the committed
// renditions must come from it. Nothing else notices a source edited without
// regenerating: the apps would ship different icons.
// Minimal failing input: a manifest entry added without running the command.
// Tier: standard unit; no rendering, file hashes only.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-generated-icons-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('generated icon renditions', () => {
  it('are up to date with the shared sources', () => {
    expect(checkAppIcons()).toEqual([]);
    expect(checkProjectSymbols()).toEqual([]);
  });

  // Contract: the icon name is the only per-icon text each app still owns. A
  // choice without one shows a raw key as its tooltip and accessibility label.
  it('has a name for every shared app icon in both apps', () => {
    const ids = readAppIconManifest().map((icon) => icon.id);
    const names = (file, pick) =>
      Object.keys(pick(JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'))).appIcon.options);
    expect(
      names('apps/desktop/src/renderer/i18n/locales/en/common.json', (json) => json.settings.appearance),
    ).toEqual(expect.arrayContaining(ids));
    expect(
      names('apps/mobile/src/i18n/locales/en/settings.json', (json) => json.appearance),
    ).toEqual(expect.arrayContaining(ids));
  });

  it('reports a shared icon list changed without regenerating', () => {
    for (const dir of [
      'packages/maker-shared/app-icons',
      'apps/desktop/resources/app-icons',
      'apps/mobile/assets/app-icons',
    ]) {
      fs.cpSync(path.join(repoRoot, dir), path.join(temp, dir), { recursive: true });
    }
    for (const file of [
      'packages/maker-shared/src/appIcons.generated.ts',
      'apps/mobile/src/settings/appIconPreviews.generated.ts',
      'apps/mobile/assets/icon.png',
    ]) {
      fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, file), path.join(temp, file));
    }
    expect(checkAppIcons(temp)).toEqual([]);

    const manifestPath = path.join(temp, 'packages/maker-shared/app-icons/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sourceDir = path.dirname(manifestPath);
    fs.copyFileSync(path.join(sourceDir, 'cat.png'), path.join(sourceDir, 'night-cat.png'));
    manifest.icons.push({ id: 'night-cat', artwork: { light: 'night-cat.png' } });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(checkAppIcons(temp)).toEqual(
      expect.arrayContaining([
        'packages/maker-shared/app-icons/manifest.json changed since the last run',
        'packages/maker-shared/src/appIcons.generated.ts is out of date',
      ]),
    );
  });
});
