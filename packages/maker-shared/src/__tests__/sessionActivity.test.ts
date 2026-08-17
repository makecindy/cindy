import { describe, expect, it } from 'vitest';

import { projectSessionActivity, sessionWorkflowFromTitle } from '../sessionActivity.js';

describe('session activity projection', () => {
  it('uses the lifecycle priority error > waiting > running > completed > idle', () => {
    expect(projectSessionActivity({ sessionId: 's', running: true })).toMatchObject({
      phase: 'running',
      currentTurnActive: true,
    });
    expect(
      projectSessionActivity({ sessionId: 's', running: true, waitingForUser: true }).phase,
    ).toBe('needs-interaction');
    expect(projectSessionActivity({
      sessionId: 's',
      running: true,
      waitingForUser: true,
      terminal: 'error',
    })).toMatchObject({
      phase: 'error',
      currentTurnActive: true,
    });
    expect(projectSessionActivity({
      sessionId: 's',
      livePhase: 'running',
      terminal: 'error',
    })).toMatchObject({
      phase: 'error',
      currentTurnActive: true,
    });
    expect(projectSessionActivity({ sessionId: 's', terminal: 'error' }).phase).toBe('error');
    expect(projectSessionActivity({ sessionId: 's', terminal: 'completed' }).phase).toBe(
      'completed',
    );
    expect(projectSessionActivity({ sessionId: 's' }).phase).toBe('idle');
    expect(projectSessionActivity({ sessionId: 's' }).currentTurnActive).toBe(false);
  });

  it('lifts known and unknown title workflow states without rewriting the title', () => {
    expect(sessionWorkflowFromTitle('🔴#2804 会话控制面 · 等拍板')).toEqual({
      key: 'awaiting-user-decision',
      label: '等拍板',
      source: 'title',
      waitingOn: 'user',
    });
    expect(sessionWorkflowFromTitle('🚧#2804 会话控制面 · 待bot')).toEqual({
      key: 'awaiting-bot',
      label: '待bot',
      source: 'title',
      waitingOn: 'automation',
    });
    expect(sessionWorkflowFromTitle('任务 · 等待外部系统')).toEqual({
      key: 'title:等待外部系统',
      label: '等待外部系统',
      source: 'title',
    });
  });

  it('preserves timing, action and graceful-stop control facets', () => {
    expect(
      projectSessionActivity({
        sessionId: 's',
        source: 'live',
        livePhase: 'running',
        startedAtMs: 10,
        lastActivityAtMs: 20,
        currentActionSummary: '  正在测试  ',
        turnGeneration: 3,
        gracefulStopState: 'waiting-for-safe-point',
      }),
    ).toMatchObject({
      phase: 'running',
      startedAtMs: 10,
      lastActivityAtMs: 20,
      currentActionSummary: '正在测试',
      turnGeneration: 3,
      gracefulStopState: 'waiting-for-safe-point',
      source: 'live',
    });
  });
});
