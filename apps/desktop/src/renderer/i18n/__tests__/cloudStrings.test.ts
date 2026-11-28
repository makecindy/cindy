import { afterEach, describe, expect, it } from 'vitest';

import i18n, { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../index';
import { mergeCloudStrings } from '../cloudStrings';

type Bundle = Record<string, unknown>;

const commons = import.meta.glob<Bundle>('../locales/*/common.json', { eager: true, import: 'default' });
const clouds = import.meta.glob<Bundle>('../locales/*/cloud.json', { eager: true, import: 'default' });

function leaves(bundle: Bundle, prefix = ''): Array<[string, unknown]> {
  return Object.entries(bundle).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? leaves(value as Bundle, path)
      : [[path, value] as [string, unknown]];
  });
}

function lookup(bundle: Bundle, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Bundle)[key] : undefined),
    bundle,
  );
}

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE);
});

describe('cloud copy kept out of common.json', () => {
  it('adds nested keys, keeps existing ones and leaves both inputs untouched', () => {
    const common = { settings: { title: 'Settings' }, keep: 'upstream' };
    const cloud = { settings: { cloud: 'Cloud' }, keep: 'cloud', cloudSettings: { title: 'Cloud Cindy' } };
    const merged = mergeCloudStrings(common, cloud);

    expect(merged).toEqual({ settings: { title: 'Settings', cloud: 'Cloud' }, keep: 'upstream', cloudSettings: { title: 'Cloud Cindy' } });
    expect(common).toEqual({ settings: { title: 'Settings' }, keep: 'upstream' });
    expect(cloud.settings).toEqual({ cloud: 'Cloud' });
  });

  it.each(SUPPORTED_LOCALES)('%s has cloud copy that common.json does not also define', (locale) => {
    const common = commons[`../locales/${locale}/common.json`];
    const cloud = clouds[`../locales/${locale}/cloud.json`];
    expect(common).toBeDefined();
    expect(cloud).toBeDefined();
    // common.json would silently win on a shared key; decide such a collision explicitly.
    const collisions = leaves(cloud!).filter(([path]) => lookup(common!, path) !== undefined);
    expect(collisions).toEqual([]);
  });

  it('serves cloud copy from the bundled English and a lazily loaded language', async () => {
    const enCloud = clouds['../locales/en/cloud.json']!;
    expect(i18n.t('cloudSettings.title', { lng: 'en' })).toBe(lookup(enCloud, 'cloudSettings.title'));

    await i18n.changeLanguage('zh-CN');
    const zhCloud = clouds['../locales/zh-CN/cloud.json']!;
    expect(i18n.t('cloudSettings.title')).toBe(lookup(zhCloud, 'cloudSettings.title'));
    // Existing copy in the same namespace is still there.
    expect(i18n.t('chatgptAuthRecovery.devWriteBlocked')).toContain('pnpm restart:desktop:remote');
  });
});
