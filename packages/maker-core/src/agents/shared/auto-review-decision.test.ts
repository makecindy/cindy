import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyLocalAutoReviewTier,
  extractAutoReviewUserIntent,
  resolveAutoReviewDecision,
  type AutoReviewRequest,
} from './auto-review-decision.js';

const roots = ['/repo', '/extra'];

afterEach(() => {
  vi.useRealTimers();
});

function request(action: AutoReviewRequest['action']): AutoReviewRequest {
  return {
    sessionId: 'session-1',
    agentKind: 'codex',
    providerId: 'provider-1',
    model: 'current-model',
    userIntent: 'Fix the type error',
    action,
    workspaceRoots: roots,
    platform: 'linux',
  };
}

describe('resolveAutoReviewDecision', () => {
  it('names the legacy prompt result as an internal needs-review tier, not a UI prompt', () => {
    expect(classifyLocalAutoReviewTier(request({ kind: 'other' }))).toBe('needs-review');
    expect(classifyLocalAutoReviewTier(request({ kind: 'read' }))).toBe('auto-approve');
  });

  it('does not call the model for deterministic allow or ask decisions', async () => {
    let called = false;
    const delegate = async () => {
      called = true;
      return { verdict: 'block' as const };
    };

    await expect(resolveAutoReviewDecision(request({ kind: 'read' }), delegate))
      .resolves.toEqual({ verdict: 'allow' });
    await expect(resolveAutoReviewDecision(
      request({ kind: 'exec', command: 'sudo rm -rf /' }),
      delegate,
    )).resolves.toEqual({ verdict: 'ask' });
    expect(called).toBe(false);
  });

  it.each(['allow', 'block', 'ask'] as const)(
    'uses the current-model reviewer %s decision for gray actions',
    async (verdict) => {
      await expect(resolveAutoReviewDecision(
        request({ kind: 'exec', command: 'npx tsc --noEmit' }),
        async () => ({ verdict, reason: 'reviewed' }),
      )).resolves.toEqual({ verdict, reason: 'reviewed' });
    },
  );

  it.each([
    { kind: 'file-write', path: undefined } as const,
    { kind: 'exec', command: '   ' } as const,
    { kind: 'network' } as const,
    { kind: 'other' } as const,
  ])('silently blocks under-specified action $kind before calling the model', async (action) => {
    let called = false;
    await expect(resolveAutoReviewDecision(
      request(action),
      async () => {
        called = true;
        return { verdict: 'allow' };
      },
    )).resolves.toMatchObject({ verdict: 'block' });
    expect(called).toBe(false);
  });

  it('silently blocks oversized gray actions instead of reviewing a truncated sample', async () => {
    let called = false;
    await expect(resolveAutoReviewDecision(
      request({ kind: 'exec', command: `npm run build -- ${'x'.repeat(4_100)}` }),
      async () => {
        called = true;
        return { verdict: 'allow' };
      },
    )).resolves.toMatchObject({
      verdict: 'block',
      reason: expect.stringContaining('at most 4096 characters'),
    });
    expect(called).toBe(false);
  });

  it('silently blocks when the reviewer is absent, throws, or returns invalid output', async () => {
    const gray = request({ kind: 'exec', command: 'npx tsc --noEmit' });
    await expect(resolveAutoReviewDecision(gray, undefined)).resolves.toMatchObject({ verdict: 'block' });
    await expect(resolveAutoReviewDecision(gray, async () => {
      throw new Error('offline');
    })).resolves.toMatchObject({ verdict: 'block' });
    await expect(resolveAutoReviewDecision(
      gray,
      async () => ({ verdict: 'unknown' } as never),
    )).resolves.toMatchObject({ verdict: 'block' });
  });

  it('silently blocks when the reviewer never settles', async () => {
    vi.useFakeTimers();
    const pending = resolveAutoReviewDecision(
      request({ kind: 'exec', command: 'npx tsc --noEmit' }),
      async () => new Promise<never>(() => {}),
    );

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toMatchObject({
      verdict: 'block',
      reason: expect.stringContaining('could not complete'),
    });
  });
});

describe('extractAutoReviewUserIntent', () => {
  it('keeps only current-message text and caps its length', () => {
    expect(extractAutoReviewUserIntent([
      { type: 'text', text: 'Fix the type error' },
      { type: 'image', path: '/tmp/screenshot.png', mimeType: 'image/png' },
      { type: 'text', text: 'Then run tests' },
    ])).toBe('Fix the type error\nThen run tests');
    const longIntent = `initial context-${'x'.repeat(2_100)}-FINAL: do not push`;
    const compacted = extractAutoReviewUserIntent(longIntent);
    expect(compacted).toHaveLength(2_000);
    expect(compacted).toMatch(/^initial context-/);
    expect(compacted).toContain('…[middle omitted]…');
    expect(compacted).toMatch(/-FINAL: do not push$/);
  });
});
