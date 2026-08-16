import { describe, expect, it } from 'vitest';

import {
  BOT_DURABLE_NOTE_NAMESPACE_MAX_CHARS,
  normalizeBotDurableNoteNamespace,
  parseBotAutomationExecutionPlan,
} from '../botAutomation';

describe('Bot automation durable-note namespace', () => {
  it('normalizes the same safe names accepted by the runtime', () => {
    expect(normalizeBotDurableNoteNamespace('  daily-report/v2  ')).toBe('daily-report/v2');
    expect(normalizeBotDurableNoteNamespace('日报:游标_2')).toBe('日报:游标_2');
  });

  it('rejects values that cannot be used by the runtime', () => {
    expect(normalizeBotDurableNoteNamespace('../escape')).toBeNull();
    expect(normalizeBotDurableNoteNamespace('-leading-dash')).toBeNull();
    expect(normalizeBotDurableNoteNamespace('contains space')).toBeNull();
    expect(normalizeBotDurableNoteNamespace('x'.repeat(BOT_DURABLE_NOTE_NAMESPACE_MAX_CHARS + 1)))
      .toBeNull();
  });

  it('preserves the frozen namespace in an Automation execution plan', () => {
    expect(parseBotAutomationExecutionPlan({
      version: 1,
      createdAt: 1,
      deadlineAt: 2,
      botId: 'bot-a',
      durableNoteNamespace: 'automation:daily',
      profile: {},
      workspace: null,
      delivery: {},
      limits: {},
      delegation: { targets: [] },
    })?.durableNoteNamespace).toBe('automation:daily');
  });
});
