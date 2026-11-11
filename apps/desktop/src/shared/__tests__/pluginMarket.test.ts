import { describe, expect, it } from 'vitest';

import {
  isPluginMarketCustomIconKey,
  pluginMarketCustomIconProjectionToken,
  pluginMarketCustomIconSourceToken,
} from '../pluginMarket';

describe('Plugin Market shared contract', () => {
  it('accepts generated custom icon keys and reserves a leading zero', () => {
    expect(isPluginMarketCustomIconKey(`1${'0'.repeat(63)}`)).toBe(true);
    expect(isPluginMarketCustomIconKey(`a${'f'.repeat(63)}`)).toBe(true);
    expect(isPluginMarketCustomIconKey('0'.repeat(64))).toBe(false);
    expect(isPluginMarketCustomIconKey('A'.repeat(64))).toBe(false);
    expect(isPluginMarketCustomIconKey('a'.repeat(63))).toBe(false);
    expect(isPluginMarketCustomIconKey('a'.repeat(65))).toBe(false);
  });

  it('extracts opaque source and projection tokens from the stable key layout', () => {
    const key = `2${'a'.repeat(16)}${'b'.repeat(16)}${'c'.repeat(31)}`;
    expect(pluginMarketCustomIconSourceToken(key)).toBe('a'.repeat(16));
    expect(pluginMarketCustomIconProjectionToken(key)).toBe('b'.repeat(16));
    expect(pluginMarketCustomIconSourceToken('0'.repeat(64))).toBeNull();
    expect(pluginMarketCustomIconProjectionToken('invalid')).toBeNull();
  });
});
