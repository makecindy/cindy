import { describe, expect, it, vi } from 'vitest';

import { createBotGroupPlanDecider } from '../botGroupPlanDecider.js';
import type { PlanDecisionInput } from '../botGroupDivision.js';

const input: PlanDecisionInput = {
  mode: 'auto',
  groupName: '官网',
  organizerName: '咪咪',
  members: [
    { botId: 'mimi', name: '咪咪', description: '' },
    { botId: 'abu', name: '阿布', description: '' },
  ],
  recent: [],
  request: '做个页面',
};

describe('createBotGroupPlanDecider', () => {
  it('lets the model chain skip unusable answers and returns the validated plan', async () => {
    const requestText = vi.fn(async (_prompt: string, opts: { validateResponse?: (text: string) => boolean }) => {
      expect(opts.validateResponse!('{"needsPlan":true,"steps":[{"botId":"ghost","task":"x"}]}')).toBe(false);
      return { ok: true as const, text: '{"needsPlan":true,"steps":[{"botId":"mimi","task":"策划"},{"botId":"abu","task":"写代码"}]}', providerId: 'p', model: 'm', transport: 'x' };
    });
    const decide = createBotGroupPlanDecider(requestText as never);
    expect(await decide(input, new AbortController().signal)).toEqual({
      needsPlan: true,
      steps: [{ botId: 'mimi', task: '策划' }, { botId: 'abu', task: '写代码' }],
    });
    expect(requestText.mock.calls[0]![1]).toMatchObject({ disableReasoning: true, timeoutMs: 20_000 });
  });

  it('returns null when no candidate answered usably', async () => {
    const decide = createBotGroupPlanDecider((async () => ({ ok: false, reason: 'all_candidates_failed', attempts: [] })) as never);
    expect(await decide(input, new AbortController().signal)).toBeNull();
  });
});
