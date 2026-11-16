import type { HostIpcEntry } from '../hostIpcRegistry.js';

/** Background tasks of a running task. Sorted by channel. */
export const MAKER_SESSION_BACKGROUND_TASKS_IPC: readonly HostIpcEntry[] = [
  {
    // The task view restores running background tasks after mount or reload;
    // live changes keep arriving as agent_task_update events.
    channel: 'maker:session-background-tasks:list',
    contractVersion: 1,
    audience: ['local'],
    access: 'read',
    // Embedded registration checks no sender. Every window that renders a task
    // (main, secondary, right sidebar) is a registered app renderer, so client
    // mode admits the same callers and refuses frames and foreign pages.
    sender: 'trusted-app-renderer',
    // Embedded accepts any string (only `typeof` is checked); an unknown id is an empty list.
    params: [{ type: 'string' }],
    // BackgroundTaskSnapshot (maker-core base-agent.ts) and the wake-continuation count.
    result: {
      type: 'object',
      properties: {
        pendingContinuations: { type: 'number', integer: true },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              backgroundCommandKind: { type: 'string', enum: ['service', 'work'], optional: true },
              outputFile: { type: 'string', optional: true },
              provider: { type: 'string', enum: ['claude-code', 'pi'], optional: true },
              taskId: { type: 'string' },
              taskType: { type: 'string', optional: true },
              title: { type: 'string', optional: true },
              toolUseId: { type: 'string', optional: true },
            },
          },
        },
      },
    },
  },
];
