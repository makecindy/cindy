import { afterEach, describe, expect, it } from 'vitest';
import { applyCindyMakeCardAttention } from '../cindyMakeAttention';
import {
  addSessionAttention,
  clearSessionAttention,
  getSessionAttentionKind,
} from '../sessionAttentionStore';

const sessionId = 'make-attention-test';
const card = (state: Record<string, unknown>, action = 'build') => ({
  systemCardType: 'cindy-make-complete',
  systemCardData: {
    reportedAt: 100,
    lastAction: action,
    [action === 'test' ? 'test' : 'personal']: state,
  },
});
afterEach(() => clearSessionAttention(sessionId, { intent: 'explicit' }));

describe('native Cindy Make result attention', () => {
  it('marks a build failure even while viewed, survives navigation, and clears on retry', () => {
    const failed = card({ status: 'failed', error: 'buildFailed' });
    applyCindyMakeCardAttention(sessionId, undefined, failed, true);
    expect(getSessionAttentionKind(sessionId)).toBe('error');
    clearSessionAttention(sessionId);
    expect(getSessionAttentionKind(sessionId)).toBe('error');
    applyCindyMakeCardAttention(sessionId, failed, card({ status: 'waiting' }), true);
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
  });

  it.each(['test', 'build'])(
    'marks an unseen %s success once and leaves a viewed result read',
    (action) => {
      const running = card({ status: action === 'test' ? 'starting' : 'packaging' }, action);
      const ready = card({ status: 'ready' }, action);
      applyCindyMakeCardAttention(sessionId, running, ready, false);
      expect(getSessionAttentionKind(sessionId)).toBe('done');
      clearSessionAttention(sessionId);
      applyCindyMakeCardAttention(sessionId, ready, ready, false);
      expect(getSessionAttentionKind(sessionId)).toBeUndefined();
      applyCindyMakeCardAttention(sessionId, running, ready, true);
      expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    },
  );

  it('does not notify cancellation or normal test closure, but retains interruption errors', () => {
    applyCindyMakeCardAttention(
      sessionId,
      undefined,
      card({ status: 'failed', error: 'cancelled' }),
      false,
    );
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    applyCindyMakeCardAttention(sessionId, undefined, card({ status: 'stopped' }, 'test'), false);
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    applyCindyMakeCardAttention(
      sessionId,
      undefined,
      card({ status: 'stopped', error: 'interrupted' }, 'test'),
      false,
    );
    expect(getSessionAttentionKind(sessionId)).toBe('error');
  });

  it('clears a handled failure on Continue and does not let stale build failure override a new test', () => {
    const failed = card({ status: 'failed' });
    applyCindyMakeCardAttention(sessionId, undefined, failed, false);
    applyCindyMakeCardAttention(
      sessionId,
      failed,
      { ...failed, systemCardData: { ...failed.systemCardData, continuedAt: 200 } },
      false,
    );
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    const nextTest = card({ status: 'ready' }, 'test');
    nextTest.systemCardData.personal = { status: 'failed' };
    applyCindyMakeCardAttention(sessionId, undefined, nextTest, false);
    expect(getSessionAttentionKind(sessionId)).toBe('done');
  });

  it('preserves another unresolved error instead of replacing it with a success dot', () => {
    addSessionAttention(sessionId, 'error');
    applyCindyMakeCardAttention(
      sessionId,
      card({ status: 'packaging' }),
      card({ status: 'ready' }),
      false,
    );
    expect(getSessionAttentionKind(sessionId)).toBe('error');
  });

  it('also marks task preparation failures before an Agent turn exists', () => {
    const preparation = (status: string) => ({
      systemCardType: 'cindy-make',
      systemCardData: { report: { runId: 'run', status, task: { sessionId } } },
    });
    applyCindyMakeCardAttention(sessionId, preparation('running'), preparation('failed'), false);
    expect(getSessionAttentionKind(sessionId)).toBe('error');
    applyCindyMakeCardAttention(sessionId, preparation('failed'), preparation('running'), false);
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
  });

  it('does not mistake a completed environment check with missing tools for success', () => {
    applyCindyMakeCardAttention(
      sessionId,
      undefined,
      {
        systemCardType: 'cindy-make-doctor',
        systemCardData: {
          report: {
            runId: 'doctor',
            status: 'completed',
            checks: [{ id: 'git', status: 'missing' }],
          },
        },
      },
      false,
    );
    expect(getSessionAttentionKind(sessionId)).toBe('error');
  });
});
