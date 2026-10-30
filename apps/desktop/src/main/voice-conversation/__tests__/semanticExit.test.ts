import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UtilityTextRequestOptions } from '../../utility-model/oneShotCandidates.js';
import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';

const h = vi.hoisted(() => ({
  enabled: true,
  query: vi.fn(),
  request: vi.fn<(prompt: string, opts: UtilityTextRequestOptions) => Promise<UtilityTextResult>>(),
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../semanticExitConfig.js', () => ({
  SEMANTIC_VOICE_EXIT_MAX_CHARACTERS: 512,
  get SEMANTIC_VOICE_EXIT_ENABLED() {
    return h.enabled;
  },
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ queryOne: h.query }) }));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestExplicitUtilityText: h.request,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => h.log }));

import { classifyVoiceExit } from '../semanticExit.js';

const row = {
  hiddenAt: null,
  botStatus: 'active',
  role: 'canonical',
  archivedAt: null,
  source: 'bot',
  providerId: 'chosen-provider',
  agentKind: 'codex',
  model: 'chosen-model',
};
const result = (text = 'EXIT'): UtilityTextResult => ({
  ok: true,
  text,
  providerId: 'chosen-provider',
  model: 'chosen-model',
  transport: 'codex-responses',
});
const input = () => ({
  callId: 'call',
  botId: 'bot',
  sessionId: 'canonical',
  text: '今天先聊到这里吧',
  signal: new AbortController().signal,
  isCurrent: () => true,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  h.enabled = true;
  h.query.mockResolvedValue(row);
  h.request.mockResolvedValue(result());
});
afterEach(() => vi.useRealTimers());

// Production entry: the call-local classifier, with only DB reads and the HTTP
// utility seam mocked. Contract: companion-voice-mode.md. Existing local-rule
// tests cannot detect route fallback or accidental Agent/history use here.
// Unit tier; fake clock, no credentials, DB, microphone or paid model calls.
// Minimal failure: a natural farewell calls an unrelated model or accepts a
// stale EXIT. Standalone vitest run: 0.33s wall time (32 cases).
describe('ephemeral semantic voice exit', () => {
  it('uses the exact companion route, only the current utterance, and no Agent/history context', async () => {
    const request = input();
    expect(await classifyVoiceExit(request)).toBe(true);
    expect(h.request).toHaveBeenCalledOnce();
    const [prompt, opts] = h.request.mock.calls[0]!;
    expect(prompt).toContain(JSON.stringify(request.text));
    expect(opts).toMatchObject({
      providerId: row.providerId,
      model: row.model,
      agentKind: 'codex',
      disableReasoning: true,
      timeoutMs: 2_000,
    });
    expect(opts).not.toHaveProperty('sessionId');
    expect(opts).not.toHaveProperty('systemPrompt');
    expect(opts.beforeDispatch).toBeTypeOf('function');
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain(request.text);
    expect(h.query).toHaveBeenCalledWith(expect.any(String), ['bot', 'canonical']);
    // The only DB capability supplied by this fixture is read-only queryOne.
    // Its projection must stay out of the content/history/memory tables.
    expect(h.query.mock.calls[0]![0]).not.toMatch(/messages|memory|identity|INSERT|UPDATE|DELETE/i);
  });

  it.each([
    'CONTINUE',
    'maybe EXIT',
    'SUBMIT_THEN_EXIT because',
    '```SUBMIT_THEN_EXIT```',
    '```EXIT```',
    '',
    '{"exit":true}',
  ])('fails open on %j', async (text) => {
    h.request.mockResolvedValue(result(text));
    expect(await classifyVoiceExit(input())).toBe(false);
  });

  it('distinguishes submit-then-exit without extracting or rewriting the work request', async () => {
    const request = { ...input(), text: '帮我查资料，然后退出语音模式' };
    h.request.mockResolvedValue(result('SUBMIT_THEN_EXIT'));
    expect(await classifyVoiceExit(request)).toBe('submit_then_exit');
    const prompt = h.request.mock.calls[0]![0];
    expect(prompt).toContain(JSON.stringify(request.text));
    expect(prompt).toContain('Never return EXIT for an utterance containing work');
    expect(prompt).toContain('conditional on finishing the work');
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain(request.text);
  });

  it('disables all semantic work with the internal switch', async () => {
    h.enabled = false;
    expect(await classifyVoiceExit(input())).toBe(false);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(513)])(
    'never truncates and classifies an incomplete utterance',
    async (text) => {
      expect(await classifyVoiceExit({ ...input(), text })).toBe(false);
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { ...row, providerId: null },
    { ...row, model: '' },
    { ...row, source: 'user' },
    { ...row, agentKind: 'unknown' },
    { ...row, remoteHostId: 'ssh' },
    { ...row, agentDeviceId: 'other-device' },
  ])('does not invent or substitute an unavailable route: %j', async (session) => {
    h.query.mockResolvedValue(session);
    expect(await classifyVoiceExit(input())).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(['cc', 'pi'])('keeps the selected %s harness', async (agentKind) => {
    h.query.mockResolvedValue({ ...row, agentKind });
    expect(await classifyVoiceExit(input())).toBe(true);
    expect(h.request.mock.calls[0]![1].agentKind).toBe(agentKind === 'cc' ? 'claude-code' : 'pi');
  });

  it.each([
    { ...row, hiddenAt: 1 },
    { ...row, role: 'history' },
    { ...row, archivedAt: 1 },
    { ...row, botStatus: 'archived' },
    { ...row, botStatus: 'deleting' },
  ])('does not call a hidden/replaced companion: %j', async (metadata) => {
    h.query.mockResolvedValue(metadata);
    expect(await classifyVoiceExit(input())).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('revalidates companion, route and call ownership before dispatch and after a result', async () => {
    let current = true;
    h.request.mockImplementation(async (_prompt, opts) => {
      h.query.mockResolvedValue({ ...row, model: 'new-model' });
      expect(
        await opts.beforeDispatch!({
          providerId: row.providerId,
          model: row.model,
          agentKind: 'codex',
        }),
      ).toBe(false);
      current = false;
      return result();
    });
    expect(await classifyVoiceExit({ ...input(), isCurrent: () => current })).toBe(false);
  });

  it('rejects a route changed while the result was in flight', async () => {
    h.request.mockImplementation(async () => {
      h.query.mockResolvedValue({ ...row, providerId: 'other-account' });
      return result();
    });
    expect(await classifyVoiceExit(input())).toBe(false);
  });

  it('bounds route/credential resolution and aborts without waiting for a late provider', async () => {
    let finish!: (value: UtilityTextResult) => void;
    h.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = classifyVoiceExit(input());
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.request.mock.calls[0]![1].signal!;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(false);
    expect(signal.aborted).toBe(true);
    expect(h.log.info).toHaveBeenCalledWith('semantic exit judged', {
      callId: 'call',
      outcome: 'timeout',
      elapsedMs: 2_000,
    });
    finish(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes a stuck DB read in the two-second budget', async () => {
    h.query.mockImplementation(() => new Promise(() => {}));
    const pending = classifyVoiceExit(input());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores cancellation before/after starting a DB read', async () => {
    h.query.mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = classifyVoiceExit({ ...input(), signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await pending).toBe(false);
    expect(await classifyVoiceExit({ ...input(), signal: abort.signal })).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['no_candidate', 'timeout', 'all_candidates_failed'] as const)(
    'continues on %s, without fallback',
    async (reason) => {
      h.request.mockResolvedValue({ ok: false, reason, attempts: [] });
      expect(await classifyVoiceExit(input())).toBe(false);
      expect(h.request).toHaveBeenCalledOnce();
    },
  );

  it('keeps errors and model output out of diagnostic logs', async () => {
    h.request.mockRejectedValue(new Error('private utterance / secret provider error'));
    expect(await classifyVoiceExit(input())).toBe(false);
    expect(JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls])).not.toContain(
      'private utterance',
    );
  });
});
