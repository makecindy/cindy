import { describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import { providerDisplayNameById } from '../providerDisplayName';

const t = (key: string) =>
  ({
    'settings.providers.xd.title': 'Cindy AI',
    'settings.providers.anthropic.title': 'Anthropic',
  })[key] ?? key;

const catalog = [
  { id: 'my-proxy', name: '公司自建网关' },
] as unknown as ProviderView[];

describe('providerDisplayNameById', () => {
  it('内置供应商用设置页标题，而不是裸 id', () => {
    expect(providerDisplayNameById('xd', [], t)).toBe('Cindy AI');
    expect(providerDisplayNameById('anthropic', catalog, t)).toBe('Anthropic');
  });

  it('自定义供应商回退目录里的展示名', () => {
    expect(providerDisplayNameById('my-proxy', catalog, t)).toBe('公司自建网关');
  });

  it('目录里查不到时才回退裸 id（用户删过该供应商 / 目录未加载）', () => {
    expect(providerDisplayNameById('gone', catalog, t)).toBe('gone');
  });
});
