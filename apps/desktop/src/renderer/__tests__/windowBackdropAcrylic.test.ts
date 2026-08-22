import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CINDY_ACRYLIC_WINDOW_BACKING } from '../../shared/windowBackdrop';
import { cindyDark } from '../themes/builtin/cindy-dark';
import { cindyLight } from '../themes/builtin/cindy-light';

const rendererRoot = resolve(__dirname, '..');
const desktopSourceRoot = resolve(rendererRoot, '..');
const globalsSource = readFileSync(resolve(rendererRoot, 'styles', 'globals.css'), 'utf8');
const mainEntrySource = readFileSync(resolve(rendererRoot, 'main-entry.tsx'), 'utf8');
const bootstrapSource = readFileSync(
  resolve(desktopSourceRoot, 'main', 'bootstrap-electron.ts'),
  'utf8',
);
const secondaryWindowsSource = readFileSync(
  resolve(desktopSourceRoot, 'main', 'secondary-windows.ts'),
  'utf8',
);
const preloadSource = readFileSync(resolve(desktopSourceRoot, 'preload', 'preload.ts'), 'utf8');

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

  it('lets only the ordinary Acrylic sidebar show the creation-time backing', () => {
    expect(globalsSource).toContain(
      "[data-platform='win32'][data-window-backdrop-material='acrylic'][data-theme='cindy-light']",
    );
    expect(globalsSource).toContain(
      "[data-platform='win32'][data-window-backdrop-material='acrylic'][data-theme='cindy-dark']",
    );
    expect(globalsSource).toContain('aside.bg-sidebar:not([data-sidebar-peek-drawer])');
    expect(globalsSource).toMatch(
      /aside\.bg-sidebar:not\(\[data-sidebar-peek-drawer\]\)[\s\S]*?\{\s*background:\s*transparent;/,
    );
    expect(globalsSource).toMatch(
      /aside\.bg-sidebar\[data-sidebar-peek-drawer\][\s\S]*?background:\s*var\(--surface-translucent-sidebar\);[\s\S]*?backdrop-filter:\s*blur\(28px\);/,
    );
  });
});
