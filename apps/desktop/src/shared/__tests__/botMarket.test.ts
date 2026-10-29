import { describe, expect, it } from 'vitest';
import { botMarketLocale, botOpeningGreeting, localizedBotMarketEntry, type BotMarketCopy, type BotMarketEntry } from '../botMarket';

const copy = (name: string): BotMarketCopy => ({ name, description: name, welcome: name, bubble: name, capabilities: [], skills: [], knowledge: [], remembers: [], routines: [], tools: [], itemNames: {} });
const entry: BotMarketEntry = { ...copy('base'), packageId: 'p', packageVersion: '0.5.0', packageHash: 'a'.repeat(64), avatar: 'data:', requiredInputs: [],
  locales: { en: copy('en'), ja: copy('ja'), ko: copy('ko'), 'zh-TW': copy('zh-TW') } };

describe('botMarketLocale', () => {
  it.each([
    ['zh-CN', 'zh-CN'], ['zh', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-SG', 'zh-CN'],
    ['zh-TW', 'zh-TW'], ['zh_TW', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-HK', 'zh-TW'],
    ['en', 'en'], ['en-US', 'en'], ['ja', 'ja'], ['ja-JP', 'ja'], ['ko', 'ko'], ['ko-KR', 'ko'],
    ['fr', 'en'], ['', 'en'], [undefined, 'en'], [null, 'en'],
  ])('maps %s to %s', (language, expected) => { expect(botMarketLocale(language)).toBe(expected); });
});

describe('botOpeningGreeting', () => {
  it('drops the closing question of the welcome and keeps a single sentence as is', () => {
    expect(botOpeningGreeting('你好，我能盯住主题。你想关注什么？')).toBe('你好，我能盯住主题。');
    expect(botOpeningGreeting('Hi, I can watch a topic. What do you want to follow?')).toBe('Hi, I can watch a topic.');
    expect(botOpeningGreeting('只有一句话')).toBe('只有一句话');
  });
});

describe('localizedBotMarketEntry', () => {
  it('uses the Chinese base for Simplified Chinese and the matching copy otherwise, carrying its own bubble', () => {
    expect(localizedBotMarketEntry(entry, 'zh-CN')).toBe(entry);
    expect(localizedBotMarketEntry(entry, 'ja').name).toBe('ja');
    expect(localizedBotMarketEntry(entry, 'en-GB').bubble).toBe('en');
    expect(localizedBotMarketEntry(entry, 'zh-HK').name).toBe('zh-TW');
    expect(localizedBotMarketEntry(entry, 'fr').name).toBe('en');
  });
  it('keeps the identity and install state', () => {
    const installed = { ...entry, installation: { requestId: 'r' } as never };
    const view = localizedBotMarketEntry(installed, 'ja');
    expect(view).toMatchObject({ packageId: 'p', packageHash: 'a'.repeat(64), avatar: 'data:', installation: { requestId: 'r' } });
  });
});
