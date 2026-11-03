import { describe, expect, it } from 'vitest';
import { assertPluginTaskResult } from '../pluginTaskService.js';
import { handlePluginTaskRequest } from '../../cindy-brain/taskSlot.js';
import type { InstalledGhost } from '../../../shared/ghost.js';

describe('collaboration results across the plugin task pipe', () => {
  it.each(['startTeam', 'releaseWorker'] as const)(
    '%s rejects service failures without leaking diagnostics',
    async (kind) => {
      for (const code of ['PERMISSION_DENIED', 'CONFIRMATION_TIMEOUT', 'WORKER_BUSY', 'INTERNAL']) {
        const result = await handlePluginTaskRequest(
          'plugin',
          kind === 'startTeam'
            ? { type: 'tasks-request', kind, taskId: 'task' }
            : { type: 'tasks-request', kind, taskId: 'task', workerId: 'worker', completedAt: 100 },
          {
            getGhost: () =>
              ({
                enabled: true,
                taskCapabilityApproved: true,
                approval: { state: 'approved', revision: 'r' },
                manifest: { agent: { tasks: true } },
              }) as InstalledGhost,
            isCurrent: () => true,
            handler: async () => {
              const serviceResult = {
                ok: false,
                errorCode: code,
                message: '/private/internal-diagnostic',
              };
              assertPluginTaskResult(serviceResult, 'Collaboration operation failed');
              return serviceResult;
            },
          },
        );
        expect(result).toEqual({
          ok: false,
          error: { code, message: 'Collaboration operation failed', retryable: false },
        });
      }
    },
  );
  it('keeps successful result payloads unchanged and supplies a fallback failure code', () => {
    expect(() => assertPluginTaskResult({ ok: true }, 'unused')).not.toThrow();
    expect(() => assertPluginTaskResult({ ok: false }, 'Unavailable')).toThrow('Unavailable');
    try {
      assertPluginTaskResult({ ok: false }, 'Unavailable');
    } catch (e) {
      expect(e).toMatchObject({ name: 'PluginTaskError', code: 'HOST_NOT_READY' });
    }
  });
});
