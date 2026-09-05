import { describe, expect, it } from 'vitest';

import {
  projectAgentIslandInteractionForOrcaWorker,
  shouldClearAgentIslandSessionForOrcaWorker,
  shouldNotifyAgentIslandForInteraction,
  shouldNotifyAgentIslandForSession,
} from '../notificationPolicy.js';

describe('Agent Island notification policy', () => {
  it('suppresses Orca worker sessions by default', () => {
    const config = { notifyOrcaWorkerSessions: false };

    expect(shouldNotifyAgentIslandForSession(config, true)).toBe(false);
    expect(shouldNotifyAgentIslandForSession(config, false)).toBe(true);
    expect(shouldClearAgentIslandSessionForOrcaWorker(config)).toBe(true);
  });

  it('can opt Orca worker sessions back into Agent Island notifications internally', () => {
    const config = { notifyOrcaWorkerSessions: true };

    expect(shouldNotifyAgentIslandForSession(config, true)).toBe(true);
    expect(shouldNotifyAgentIslandForSession(config, false)).toBe(true);
    expect(shouldClearAgentIslandSessionForOrcaWorker(config)).toBe(false);
  });

  it('allows only permission interactions through the default Orca Worker noise gate', () => {
    const config = { notifyOrcaWorkerSessions: false };

    expect(shouldNotifyAgentIslandForInteraction(config, true, 'permission')).toBe(true);
    expect(shouldNotifyAgentIslandForInteraction(config, true, 'ask_user_question')).toBe(false);
    expect(shouldNotifyAgentIslandForInteraction(config, true, 'plan_review')).toBe(false);
    expect(shouldNotifyAgentIslandForInteraction(config, true, 'plugin_setup')).toBe(false);
    expect(shouldNotifyAgentIslandForInteraction(config, false, 'ask_user_question')).toBe(true);
  });

  it('projects Worker permissions to focus-only identity without provider-authored fields', () => {
    const request = {
      kind: 'permission' as const,
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'echo WORKER_PERMISSION_SECRET' },
      title: 'Allow WORKER_PERMISSION_SECRET?',
      displayName: 'Run WORKER_PERMISSION_SECRET',
      description: 'echo WORKER_PERMISSION_SECRET',
      metadata: { raw: 'WORKER_PERMISSION_SECRET' },
      suggestions: [{ destination: 'session', command: 'WORKER_PERMISSION_SECRET' }],
    };

    expect(projectAgentIslandInteractionForOrcaWorker(request, false)).toBe(request);
    expect(projectAgentIslandInteractionForOrcaWorker(request, true)).toEqual({
      kind: 'permission',
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: {},
    });
  });
});
