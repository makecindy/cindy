import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function readMainSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

function expectBefore(source: string, registration: string, load: string): void {
  const registrationIndex = source.indexOf(registration);
  const loadIndex = source.indexOf(load, registrationIndex);
  expect(registrationIndex).toBeGreaterThanOrEqual(0);
  expect(loadIndex).toBeGreaterThan(registrationIndex);
}

describe('utility window appearance bootstrap registration', () => {
  // Electron security §3.1(6): detached sidebar/tab roots bypass main-entry.
  // The terminal's real decode/measurement test cannot catch missing root wiring.
  // Guard tier: both hosts enter this file before createRoot and release on HMR.
  it('detached sidebar roots install the common appearance consumer before rendering', () => {
    const source = readMainSource('../renderer/sidebar-window-entry.tsx');
    expectBefore(source, 'const disposeAppearancePresenter = installAppearancePresenter(', 'createRoot(rootElement).render(');
    expect(source).toContain('import.meta.hot?.dispose(disposeAppearancePresenter)');
    expect(source).toContain('installAppearancePresenter(applyFontSettings, false, initialAppearance)');
    expect(source).toContain('onAppearanceChange={presentAppearance}');
  });

  it('权限引导的 backdrop 与 guide 在加载 renderer 前登记只读权限', () => {
    const source = readMainSource('computer-permission-guide/window.ts');
    expectBefore(
      source,
      'markAppearanceSettingsReaderWindow(backdrop)',
      'loadPermissionView(backdrop',
    );
    expectBefore(source, 'markAppearanceSettingsReaderWindow(guide)', 'loadPermissionView(guide');
  });

  it('语音浮窗与词典 toast 在加载 renderer 前登记只读权限', () => {
    const source = readMainSource('voice-input/global.ts');
    expectBefore(source, 'markAppearanceSettingsReaderWindow(window)', 'window.loadURL(');
    const toastFactory = source.slice(source.indexOf('function createDictionaryToastWindow'));
    expectBefore(toastFactory, 'markAppearanceSettingsReaderWindow(window)', 'window.loadURL(');
  });

  // Electron security §3.1(6): all utility renderers must enter the shared
  // appearance consumer before rendering. Presenter behavior tests cover live
  // settings events and cleanup; this guard checks the bootstrap wiring only.
  it('utility renderer 分流前安装公共外观消费者并保留热更新清理', () => {
    const source = readMainSource('../renderer/main-entry.tsx');
    for (const view of [
      'isComputerPermissionBackdrop',
      'isComputerPermissionGuide',
      'isVoiceInputDictionaryToast',
      'isVoiceInputOverlay',
    ]) {
      expectBefore(
        source,
        'const disposeAppearancePresenter = installAppearancePresenter(applyFontSettings,',
        `if (${view})`,
      );
    }
    expect(source).toContain('import.meta.hot?.dispose(disposeAppearancePresenter)');
    expect(source.match(/<ThemeProvider syncWindowVibrancy=\{false\}>/g)).toHaveLength(4);
  });
});
