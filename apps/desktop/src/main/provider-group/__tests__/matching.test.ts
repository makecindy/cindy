/**
 * 「是不是同一个供应商」(provider-groups.md §3)：订阅账号按品牌、自定义供应商按名称。
 */
import { describe, expect, it } from 'vitest';

import { isSameProvider, providerBrand } from '../matching';

const view = (id: string, name: string, auth?: { method?: string; native?: string }) => ({ id, name, auth });

describe('providerBrand', () => {
  it('maps built-in connections and accounts added by signing in to their brand', () => {
    expect(providerBrand(view('anthropic', 'Anthropic'))).toBe('anthropic');
    expect(providerBrand(view('anthropic-1a2b3c4d', 'Claude', { method: 'oauth', native: 'claude' }))).toBe('anthropic');
    expect(providerBrand(view('openai-0f0f0f0f', 'ChatGPT', { method: 'oauth', native: 'codex' }))).toBe('openai');
    expect(providerBrand(view('kimi-12345678', 'Kimi', { method: 'oauth' }))).toBe('oauth:kimi');
  });

  it('treats name-derived custom providers as brandless', () => {
    expect(providerBrand(view('deepseek', 'DeepSeek', { method: 'api-key' }))).toBeNull();
    // 名称恰好以 8 位十六进制结尾的自定义供应商，不是登录账号。
    expect(providerBrand(view('gateway-deadbeef', 'Gateway deadbeef', { method: 'api-key' }))).toBeNull();
  });
});

describe('isSameProvider', () => {
  it('matches subscription accounts across computers even though their ids differ', () => {
    expect(isSameProvider(
      view('anthropic', 'Anthropic', { method: 'oauth', native: 'claude' }),
      view('anthropic-1a2b3c4d', 'Claude', { method: 'oauth', native: 'claude' }),
    )).toBe(true);
    expect(isSameProvider(view('anthropic', 'Anthropic'), view('openai', 'OpenAI'))).toBe(false);
  });

  it('matches custom providers by name (case and spacing ignored) or by id', () => {
    expect(isSameProvider(view('deepseek', 'DeepSeek'), view('deepseek-2', ' deepseek '))).toBe(true);
    expect(isSameProvider(view('my-gateway', 'Renamed'), view('my-gateway', 'Old name'))).toBe(true);
    expect(isSameProvider(view('deepseek', 'DeepSeek'), view('qwen', 'Qwen'))).toBe(false);
  });

  it('never matches a custom provider to an official one', () => {
    expect(isSameProvider(view('anthropic', 'Anthropic'), view('anthropic-proxy', 'Anthropic'))).toBe(false);
  });
});
