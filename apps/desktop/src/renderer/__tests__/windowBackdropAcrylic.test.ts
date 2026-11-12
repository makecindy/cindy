import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../shared/windowBackdrop';
import { cindyDark } from '../themes/builtin/cindy-dark';
import { cindyLight } from '../themes/builtin/cindy-light';

const rendererRoot = resolve(__dirname, '..');
const desktopSourceRoot = resolve(rendererRoot, '..');
const normalizeSource = (source: string) => source.replace(/\r\n?/g, '\n');
const globalsSource = normalizeSource(
  readFileSync(resolve(rendererRoot, 'styles', 'globals.css'), 'utf8'),
);
const mainEntrySource = normalizeSource(
  readFileSync(resolve(rendererRoot, 'main-entry.tsx'), 'utf8'),
);
const bootstrapSource = normalizeSource(
  readFileSync(resolve(desktopSourceRoot, 'main', 'bootstrap-electron.ts'), 'utf8'),
);
const secondaryWindowsSource = normalizeSource(
  readFileSync(resolve(desktopSourceRoot, 'main', 'secondary-windows.ts'), 'utf8'),
);
const preloadSource = normalizeSource(
  readFileSync(resolve(desktopSourceRoot, 'preload', 'preload.ts'), 'utf8'),
);

describe('Windows Acrylic resize backing contract', () => {
  it('uses the exact sidebar tint tokens for the native backing', () => {
    expect(cindyLight.colors['surface-translucent-sidebar']).toBe(
      CINDY_ACRYLIC_WINDOW_BACKING.light,
    );
    expect(cindyDark.colors['surface-translucent-sidebar']).toBe(CINDY_ACRYLIC_WINDOW_BACKING.dark);
  });

  it('uses the persisted family when choosing the creation-time material', () => {
    expect(bootstrapSource).toContain(
      "persistedTheme?.familyId ?? 'cindy',\n    isDark,\n    process.platform,",
    );
    expect(secondaryWindowsSource).toContain(
      "persistedTheme?.familyId ?? 'cindy',\n    isDark,\n    process.platform,",
    );
  });

  it('publishes the actual window material to a root data attribute', () => {
    expect(bootstrapSource).toContain(
      "createWindowBackdropMaterialArgument(winBackdropConfig.backgroundMaterial ?? 'none')",
    );
    expect(secondaryWindowsSource).toContain(
      "createWindowBackdropMaterialArgument(winBackdropConfig.backgroundMaterial ?? 'none')",
    );
    expect(preloadSource).toContain(
      'windowBackdropMaterial: readWindowBackdropMaterialFromArgv(process.argv)',
    );
    expect(mainEntrySource).toMatch(
      /dataset\.windowBackdropMaterial\s*=\s*\n?\s*window\.electronAPI\.windowBackdropMaterial\s*\?\?\s*'none'/,
    );
  });

  it('keeps the root material attribute in sync with runtime material changes', () => {
    const materialChangedSend =
      /win\.webContents\.send\(\s*WINDOW_BACKDROP_MATERIAL_CHANGED_CHANNEL\s*,\s*config\.backgroundMaterial\s*,?\s*\)/;
    expect(bootstrapSource).toMatch(materialChangedSend);
    expect(secondaryWindowsSource).toMatch(materialChangedSend);
    expect(preloadSource).toContain(
      'fanOutWindowBackdropMaterialChanged((material) => {\n      if (typeof material === \'string\' && isWindowsBackdropMaterial(material))',
    );
    expect(mainEntrySource).toContain(
      'window.electronAPI.onWindowBackdropMaterialChanged?.((material) => {\n    document.documentElement.dataset.windowBackdropMaterial = material;',
    );
  });

  // #9623: the native backing alone cannot carry the sidebar tint. While a window is restored
  // or another window is shown/hidden, DWM can drop it for a few frames and the sidebar flashes.
  // Clearing `.sidebar-frost` under Acrylic is exactly that bug, so the tint must stay in CSS.
  it('keeps the CSS sidebar tint on top of Acrylic', () => {
    expect(globalsSource).not.toMatch(
      /\[data-window-backdrop-material='acrylic'\][^{]*\.sidebar-frost[^{]*\{\s*background:\s*transparent;/,
    );
    expect(globalsSource).toMatch(
      /\[data-theme='cindy-light'\] aside\.bg-sidebar > \.sidebar-frost,\n\[data-theme='cindy-dark'\] aside\.bg-sidebar > \.sidebar-frost \{\n {2}background: var\(--surface-translucent-sidebar\);/,
    );
    expect(globalsSource).toMatch(
      /aside\.bg-sidebar\[data-sidebar-peek-drawer\][\s\S]*?background:\s*var\(--surface-translucent-sidebar\);[\s\S]*?backdrop-filter:\s*blur\(28px\);/,
    );
  });
});
