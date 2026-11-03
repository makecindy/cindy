import { describe, expect, it } from 'vitest';
import type { BotGroupMemberView } from '../../../../shared/botGroupChat';
import { botGroupMentionMember } from '../BotGroupMentionCard';
import en from '../../../i18n/locales/en/common.json';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import zhTW from '../../../i18n/locales/zh-TW/common.json';
import ja from '../../../i18n/locales/ja/common.json';
import ko from '../../../i18n/locales/ko/common.json';

const member = (botId: string, name: string): BotGroupMemberView =>
  ({ botId, name, avatar: '', avatarColor: 'gray', status: 'active' });

// PR #6549 review: the card must follow the message's mention ids, not the first name match.
describe('botGroupMentionMember', () => {
  const members = [member('a', 'Nova'), member('b', 'Nova'), member('c', '所有人')];

  it('opens the card of the member the message mentioned when two share a name', () => {
    expect(botGroupMentionMember('@Nova', members, { all: false, botIds: ['b'] }, '所有人')?.botId).toBe('b');
  });

  it('opens no card for the broadcast, even with a member named like it', () => {
    expect(botGroupMentionMember('@所有人', members, { all: true, botIds: [] }, '所有人')).toBeUndefined();
    expect(botGroupMentionMember('@所有人', members, { all: false, botIds: ['c'] }, '所有人')?.botId).toBe('c');
  });

  it('opens no card for a name the message did not mention', () => {
    expect(botGroupMentionMember('@Nova', members, { all: false, botIds: [] }, '所有人')).toBeUndefined();
  });

  // PR #6549 r4323705154: messageView emits empty mention ids for server snapshots.
  // Unit: the production card resolver must still return a unique member, but never
  // guess for duplicate names/broadcasts. Existing tests only exercised explicit ids.
  it('keeps unique server mentions usable after replacing the optimistic message', () => {
    const roster = [member('a', 'Aster'), member('b', 'Nova')];
    expect(botGroupMentionMember('@Nova', roster, { all: false, botIds: ['b'] }, '所有人', true)?.botId).toBe('b');
    expect(botGroupMentionMember('@Nova', roster, { all: false, botIds: [] }, '所有人', true)?.botId).toBe('b');
    expect(botGroupMentionMember('@Nova', roster, { all: false, botIds: ['a'] }, '所有人', true)).toBeUndefined();
  });

  it('does not guess an ambiguous server mention or a broadcast', () => {
    const empty = { all: false, botIds: [] };
    expect(botGroupMentionMember('@Nova', members, empty, '所有人', true)).toBeUndefined();
    expect(botGroupMentionMember('@Nova', members, { all: false, botIds: ['a', 'b'] }, '所有人', true)).toBeUndefined();
    // Cross-language server snapshots have no ids: an English reader must not
    // open a namesake's card for another sender locale's broadcast (r4324819630).
    for (const label of [en, zhCN, zhTW, ja, ko].map(locale => locale.bots.groupChat.mention.all).concat('all', 'everyone')) {
      const roster = [member('a', label)];
      expect(botGroupMentionMember(`@${label}`, roster, empty, 'Everyone', true)).toBeUndefined();
      expect(botGroupMentionMember(`@${label}`, roster, { all: true, botIds: [] }, 'Everyone', true)).toBeUndefined();
      expect(botGroupMentionMember(`@${label}`, roster, { all: false, botIds: ['a'] }, 'Everyone', true)?.botId).toBe('a');
    }
  });
});
