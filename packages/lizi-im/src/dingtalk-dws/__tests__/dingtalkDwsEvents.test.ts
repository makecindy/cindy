import { describe, expect, it } from 'vitest';

import { stripSelfMention } from '../events.js';

describe('stripSelfMention', () => {
  it('strips the mobile form "@name"', () => {
    expect(stripSelfMention('@智能机器人 帮我看下', '智能机器人')).toBe('帮我看下');
  });

  it('strips the desktop form with a parenthesised name, half- and full-width', () => {
    expect(stripSelfMention('@智能机器人(智能机器人)  帮我看下', '智能机器人')).toBe('帮我看下');
    expect(stripSelfMention('@智能机器人（智能机器人） 帮我看下', '智能机器人')).toBe('帮我看下');
    expect(stripSelfMention('@智能机器人(研发部)帮我看下', '智能机器人')).toBe('帮我看下');
  });

  it('strips a remark name when the account name is in the parentheses', () => {
    expect(stripSelfMention('@小助手(智能机器人) 帮我看下', '智能机器人')).toBe('帮我看下');
  });

  it('keeps mentions of other people and ordinary parentheses', () => {
    expect(stripSelfMention('@智能机器人(智能机器人) 问下 @张三(研发) 的意见（明天前）', '智能机器人')).toBe(
      '问下 @张三(研发) 的意见（明天前）',
    );
  });

  it('handles the special spaces DingTalk inserts after a mention', () => {
    expect(stripSelfMention('@智能机器人 帮我看下', '智能机器人')).toBe('帮我看下');
  });

  it('leaves the text alone without a known name', () => {
    expect(stripSelfMention('  @智能机器人(智能机器人) hi ', '')).toBe('@智能机器人(智能机器人) hi');
  });
});
