import { describe, expect, it } from 'vitest';

import { botComposerPlaceholderKey, isLatinBotName } from '../botChatPresentation';

describe('伙伴对话的输入框占位符', () => {
  it('西文名字两侧留空格,中文名不留', () => {
    // 「跟 Melody 说点什么…」 vs 「跟小柴说点什么…」——排版规则跟着名字走,
    // 不跟着语言走,所以目录里备了两种句型。
    expect(botComposerPlaceholderKey('Melody')).toBe('bots.chat.composerPlaceholderLatin');
    expect(botComposerPlaceholderKey('小柴')).toBe('bots.chat.composerPlaceholder');
    expect(botComposerPlaceholderKey('アーシュー')).toBe('bots.chat.composerPlaceholder');
    expect(botComposerPlaceholderKey('아수')).toBe('bots.chat.composerPlaceholder');
  });

  it('把带空格与标点的西文名也算西文', () => {
    expect(isLatinBotName('Ops buddy')).toBe(true);
    expect(isLatinBotName('R2-D2')).toBe(true);
  });

  it('混排与空名字走中文句型(不留空格更保险)', () => {
    expect(isLatinBotName('小柴 Shiba')).toBe(false);
    expect(isLatinBotName('   ')).toBe(false);
    expect(isLatinBotName('')).toBe(false);
  });
});
