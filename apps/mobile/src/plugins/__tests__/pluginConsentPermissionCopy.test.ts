import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 插件安装/更新确认里的权限文案合同。
 *
 * 手机端远程安装一个声明了 `wallpaper: true` 的插件时,确认页按
 * `plugins.management.permissions.<labelKey|detailKey>` 查文案;缺键时标题会退回
 * 原始 kind(显示成 "wallpaper"),详情为空。桌面端已经加了 `wallpaper` /
 * `wallpaperDetail`,手机端漏了,装包确认看起来像坏掉——这里按语言把键钉住。
 */
const localesDir = resolve(process.cwd(), 'src/i18n/locales');
const locales = readdirSync(localesDir);

const readPermissions = (locale: string): Record<string, unknown> => {
  const copy = JSON.parse(
    readFileSync(resolve(localesDir, locale, 'plugins.json'), 'utf8'),
  ) as { management?: { permissions?: Record<string, unknown> } };
  return copy.management?.permissions ?? {};
};

describe('plugin consent permission copy', () => {
  it.each(locales)('%s translates the wallpaper capability', (locale) => {
    const permissions = readPermissions(locale);
    expect(permissions.wallpaper).toEqual(expect.any(String));
    expect(permissions.wallpaperDetail).toEqual(expect.any(String));
    expect(String(permissions.wallpaper).length).toBeGreaterThan(0);
    expect(String(permissions.wallpaperDetail).length).toBeGreaterThan(0);
  });

  it('keeps the desktop permission keys aligned', () => {
    // 手机端查的是 plugins.management.permissions.*,桌面端查 settings.ghosts.perm.*;
    // 两边文案可以不同,但键必须成对存在,否则一端装包确认会退化成原始 kind。
    const desktop = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../desktop/src/renderer/i18n/locales/en/common.json'),
        'utf8',
      ),
    ) as { settings: { ghosts: { perm: Record<string, unknown> } } };
    expect(desktop.settings.ghosts.perm.wallpaper).toEqual(expect.any(String));
    expect(desktop.settings.ghosts.perm.wallpaperDetail).toEqual(expect.any(String));
  });
});
