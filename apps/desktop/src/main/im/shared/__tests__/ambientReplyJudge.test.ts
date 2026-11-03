/**
 * 全响应(ambient)群消息的「该不该插话」判定: 辅助模型答 REPLY / SKIP, 其它一律
 * unknown(调用方按原路径起轮次, 判定器只省钱不吞话)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AMBIENT_JUDGE_SYSTEM_PROMPT,
  buildAmbientJudgePrompt,
  createAmbientReplyJudge,
  parseAmbientJudgeVerdict,
} from '../ambientReplyJudge';

const input = {
  botName: 'Mia',
  botDescription: 'Helps the team with release notes.',
  groupContext: '<group_chat_context>\n[Tom] lunch?\n</group_chat_context>\n',
  speaker: '[speaker] Tom (@tom)',
  text: 'Mia, is the changelog for 2.3 ready?',
};

describe('parseAmbientJudgeVerdict', () => {
  it('accepts the two verdicts with stray punctuation or case, rejects anything else', () => {
    expect(parseAmbientJudgeVerdict('REPLY')).toBe('reply');
    expect(parseAmbientJudgeVerdict(' skip.')).toBe('skip');
    expect(parseAmbientJudgeVerdict('"Reply"')).toBe('reply');
    expect(parseAmbientJudgeVerdict('')).toBeNull();
    expect(parseAmbientJudgeVerdict('maybe')).toBeNull();
    expect(parseAmbientJudgeVerdict('I think the assistant should REPLY because the message asks a question')).toBeNull();
  });
});

describe('buildAmbientJudgePrompt', () => {
  it('keeps identity, background, speaker and the new message in separate fenced blocks', () => {
    const prompt = buildAmbientJudgePrompt({ ...input, replyTo: { author: 'Ann', text: 'see above' } });
    expect(prompt).toContain('<assistant name="Mia">');
    expect(prompt).toContain('Helps the team with release notes.');
    expect(prompt).toContain('<recent_group_messages>');
    expect(prompt).toContain('[Tom] lunch?');
    expect(prompt).toContain('(replying to Ann: see above)');
    expect(prompt).toContain('[speaker] Tom (@tom)');
    expect(prompt).toContain('Mia, is the changelog for 2.3 ready?');
    expect(prompt.indexOf('<recent_group_messages>')).toBeLessThan(prompt.indexOf('<new_message>'));
  });

  it('omits empty background and clips oversized text', () => {
    const prompt = buildAmbientJudgePrompt({ ...input, groupContext: '', botDescription: '', text: 'x'.repeat(5000) });
    expect(prompt).not.toContain('<recent_group_messages>');
    expect(prompt).toContain('x'.repeat(2000) + '…');
    expect(prompt).not.toContain('x'.repeat(2001));
  });
});

describe('createAmbientReplyJudge', () => {
  it('asks the auxiliary chain for one word with a tight budget and maps the answer', async () => {
    const requestText = vi.fn(async () => ({ ok: true as const, text: 'SKIP', providerId: 'p', model: 'm', transport: 't' }));
    const judge = createAmbientReplyJudge(requestText as never);
    await expect(judge(input)).resolves.toBe('skip');
    const [prompt, opts] = requestText.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(prompt).toContain('<new_message>');
    expect(opts.systemPrompt).toBe(AMBIENT_JUDGE_SYSTEM_PROMPT);
    expect(opts.maxTokens).toBeLessThanOrEqual(16);
    expect(opts.timeoutMs).toBe(5_000);
    expect(opts.disableReasoning).toBe(true);
    expect((opts.validateResponse as (t: string) => boolean)('REPLY')).toBe(true);
    expect((opts.validateResponse as (t: string) => boolean)('hmm')).toBe(false);
  });

  it('returns unknown when the chain has no candidate, fails, throws or answers nonsense', async () => {
    const noCandidate = createAmbientReplyJudge(async () => ({ ok: false, reason: 'no_candidate', attempts: [] }) as never);
    await expect(noCandidate(input)).resolves.toBe('unknown');
    const throws = createAmbientReplyJudge(async () => {
      throw new Error('boom');
    });
    await expect(throws(input)).resolves.toBe('unknown');
    const nonsense = createAmbientReplyJudge(
      async () => ({ ok: true, text: 'maybe', providerId: 'p', model: 'm', transport: 't' }) as never,
    );
    await expect(nonsense(input)).resolves.toBe('unknown');
  });

  it('treats an already-aborted caller as unknown without dispatching', async () => {
    const requestText = vi.fn(async (_prompt: string, opts: { beforeDispatch?: () => Promise<boolean> }) => {
      if (opts.beforeDispatch && !(await opts.beforeDispatch())) {
        return { ok: false, reason: 'no_candidate', attempts: [] };
      }
      return { ok: true, text: 'REPLY', providerId: 'p', model: 'm', transport: 't' };
    });
    const judge = createAmbientReplyJudge(requestText as never);
    const controller = new AbortController();
    controller.abort();
    await expect(judge(input, controller.signal)).resolves.toBe('unknown');
  });
});
