import { describe, it, expect } from 'vitest';
import { createFeishuScope, runInScope } from '../moduleScope.js';
import { registerQuestion, closeQuestion, forgetBoundAccount } from '../outbound.js';
import { parseCardAction } from '../cardActionParser.js';

// Production parser + per-account registry: never grant general controls to a question respondent.
describe('Feishu question ownership', () => {
  it('accepts the exact requester, rejects others, and invalidates after settlement or account replacement', () => {
    runInScope(createFeishuScope({ host: null, guests: true }), () => {
      const callback = (actor: string, id = 'aq:q:0:0:0') => parseCardAction({ raw: {
        operator: { open_id: actor }, context: { open_message_id: 'm', open_chat_id: 'group' }, action: { value: { id } },
      } });
      registerQuestion('m', 'alice');
      expect(callback('alice')).toMatchObject({ actorId: 'alice', buttonId: 'aq:q:0:0:0' });
      expect(callback('bob')).toBeNull();
      expect(callback('alice', 'permission:allow')).toBeNull();
      closeQuestion('m'); expect(callback('alice')).toBeNull();
      registerQuestion('m', 'alice'); forgetBoundAccount(); expect(callback('alice')).toBeNull();
    });
  });
  it('does not reuse another bot instance’s question registry', () => {
    const one = createFeishuScope({ host: null, guests: true });
    const two = createFeishuScope({ host: null, guests: true });
    runInScope(one, () => registerQuestion('m', 'alice'));
    expect(runInScope(two, () => parseCardAction({ raw: { operator: { open_id: 'alice' },
      context: { open_message_id: 'm', open_chat_id: 'group' }, action: { value: { id: 'aq:q:0:0:0' } } } }))).toBeNull();
  });
});
