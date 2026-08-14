import { describe, expect, it } from 'vitest';

import { groupHistoryAccessForExternalKey } from '../groupHistoryScope';

describe('official Telegram group history scope', () => {
  it('derives a lane-only scope from group and topic external keys', () => {
    expect(groupHistoryAccessForExternalKey('telegram:group:bot-1:-100:owner:g3')).toEqual({
      access: 'lane',
      provider: 'telegram:owner',
      lane: { provider: 'telegram:owner', chatId: '-100', threadId: '' },
    });
    expect(groupHistoryAccessForExternalKey('telegram:topic:bot-1:-100:77:owner:g3')).toEqual({
      access: 'lane',
      provider: 'telegram:owner',
      lane: { provider: 'telegram:owner', chatId: '-100', threadId: '77' },
    });
  });

  it('does not create a scope for Telegram DM or unrelated hook keys', () => {
    expect(groupHistoryAccessForExternalKey('telegram:dm:bot-1:owner:g3')).toBeUndefined();
    expect(groupHistoryAccessForExternalKey('slack:dm:C123:U123')).toBeUndefined();
  });
});
