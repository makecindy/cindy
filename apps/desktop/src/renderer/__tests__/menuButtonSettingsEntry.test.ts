/**
 * menuButtonSettingsEntry.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for Issue #1881: Windows / Linux 缺少清晰可发现的「设置」入口。
 *
 * 契约:标题栏左上角应用内菜单(MenuButton)必须常驻「设置」菜单项——
 * 非 darwin 平台没有原生应用菜单(installApplicationMenu 置 null),macOS
 * 的「设置…」菜单项在这些平台不可见,此处是唯一的菜单型设置入口。
 *
 * 这份测试做静态源码扫描,确保以下契约不被未来的提交悄悄回退:
 * 1. 菜单包含 settings 菜单项,文案走 i18n key `titleBar.menuItems.settings`。
 * 2. 点击导航 `/settings`,且已在设置页时不重复导航(与 MainLayout
 *    'open-settings' 命令、侧栏用户卡片同一行为)。
 * 3. 四语言 locale 都提供 `titleBar.menuItems.settings` 文案。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath = resolve(__dirname, '..', 'components', 'title-bar', 'MenuButton.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('MenuButton — settings menu item (#1881)', () => {
  it('renders a settings item backed by the i18n key', () => {
    expect(source).toContain("t('titleBar.menuItems.settings')");
  });

  it('navigates to /settings with the open-settings same-path guard (pathname + search)', () => {
    // 与 MainLayout 'open-settings' 相同判定(currentPathRef = pathname + search):
    // 已在设置默认页不重复导航;在 /settings?tab=xxx 子页回到设置默认页。
    expect(source).toMatch(
      /if \(`\$\{location\.pathname\}\$\{location\.search\}` !== '\/settings'\) \{\s*\n\s*navigate\('\/settings'\);/,
    );
    expect(source).toContain("import { useLocation, useNavigate } from 'react-router-dom';");
  });

  it('keeps the existing help / issues / check-for-updates items', () => {
    expect(source).toContain("t('titleBar.menuItems.help')");
    expect(source).toContain("t('titleBar.menuItems.issues')");
    expect(source).toContain("t('titleBar.menuItems.checkForUpdates')");
  });
});

describe('MenuButton — locale coverage for the settings item', () => {
  const locales = ['zh-CN', 'en', 'ja', 'ko'] as const;

  for (const lng of locales) {
    it(`${lng} provides titleBar.menuItems.settings`, () => {
      const localePath = resolve(__dirname, '..', 'i18n', 'locales', lng, 'common.json');
      const locale = JSON.parse(readFileSync(localePath, 'utf8')) as {
        titleBar: { menuItems: { settings?: string } };
      };
      const label = locale.titleBar.menuItems.settings;
      expect(label, `${lng} 缺少 titleBar.menuItems.settings`).toBeTruthy();
      expect(label).not.toContain('?');
    });
  }
});
