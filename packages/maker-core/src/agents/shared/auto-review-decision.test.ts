import { describe, expect, it } from 'vitest';

import {
  extractAutoReviewUserIntent,
  resolveAutoReviewDecision,
  type AutoReviewRequest,
} from './auto-review-decision.js';

const roots = ['/repo', '/extra'];

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

  it('silently blocks when the reviewer is absent, throws, or returns invalid output', async () => {
    const gray = request({ kind: 'other' });
    await expect(resolveAutoReviewDecision(gray, undefined)).resolves.toMatchObject({ verdict: 'block' });
    await expect(resolveAutoReviewDecision(gray, async () => {
      throw new Error('offline');
    })).resolves.toMatchObject({ verdict: 'block' });
    await expect(resolveAutoReviewDecision(
      gray,
      async () => ({ verdict: 'unknown' } as never),
    )).resolves.toMatchObject({ verdict: 'block' });
  });
});

describe('extractAutoReviewUserIntent', () => {
  it('keeps only current-message text and caps its length', () => {
    expect(extractAutoReviewUserIntent([
      { type: 'text', text: 'Fix the type error' },
      { type: 'image', path: '/tmp/screenshot.png', mimeType: 'image/png' },
      { type: 'text', text: 'Then run tests' },
    ])).toBe('Fix the type error\nThen run tests');
    expect(extractAutoReviewUserIntent('x'.repeat(2_100))).toHaveLength(2_000);
  });
});
