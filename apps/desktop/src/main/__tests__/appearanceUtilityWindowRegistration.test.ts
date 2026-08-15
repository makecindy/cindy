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

  it('utility renderer 订阅运行期外观变化并直接更新 CSS 字体变量', () => {
    const source = readMainSource('../renderer/main-entry.tsx');
    expect(source).toContain('isAppearanceUtilityView');
    expect(source).toContain('appearanceSettings?.onChanged?.(applyFontSettings)');
    expect(source).toContain('import.meta.hot?.dispose(disposeUtilityAppearanceSettingsSync)');
  });
});
