import { describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import { providerDisplayName, providerDisplayNameById } from '../providerDisplayName';

const t = (key: string) =>
  ({
    'settings.providers.xd.title': 'Cindy AI',
    'settings.providers.anthropic.title': 'Anthropic',
  })[key] ?? key;

const catalog = [
  { id: 'my-proxy', name: '公司自建网关' },
] as unknown as ProviderView[];

describe('providerDisplayNameById', () => {
  it.each(['Cindy AI · 个人', 'Cindy AI · 心动', 'Cindy AI · Example Studio'])(
    'preserves the source computer name %s in selectors and usage history', (name) => {
      const provider = { id: 'xd', name } as ProviderView;
      expect(providerDisplayName(provider, t)).toBe(name);
      expect(providerDisplayNameById('xd', [provider], t)).toBe(name);
    },
  );
  it('keeps an older host generic instead of guessing its account identity', () => {
    expect(providerDisplayName({ id: 'xd', name: 'XD Gateway' }, t)).toBe('Cindy AI');
  });
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

it('uses the renamed connection in both selector and history display', () => {
  const provider = { id: 'openai', name: 'Personal ChatGPT' } as ProviderView;
  expect(providerDisplayName(provider, t)).toBe('Personal ChatGPT');
  expect(providerDisplayNameById('openai', [provider], t)).toBe('Personal ChatGPT');
});
