import type { forkSessionAtMessage, forkSessionStripEncrypted } from '../maker-orchestration/fork.js';
import { createSessionController, sessionOperation } from './controller.js';
import { requireSessionCaller } from './callerContext.js';
import { localSessionHost } from './localHost.js';

const controller = createSessionController(localSessionHost, {
  previewRewind: sessionOperation({ operation: 'inspectHistory', targets: (id: string, _clientId: string) => [id],
    execute: async (_scope, id: string, clientId: string) => (await import('./rewind.js')).previewSessionRewind(id, clientId) }),
  rewind: sessionOperation({ operation: 'rewind', targets: (id: string, _clientId: string, _options?: { requireLatestUser?: boolean; stopIfRunning?: boolean; allowFileRestore?: boolean }) => [id],
    execute: async (_scope, id: string, clientId: string, options?: { requireLatestUser?: boolean; stopIfRunning?: boolean; allowFileRestore?: boolean }) =>
      (await import('./rewind.js')).commitSessionRewind(id, clientId, options) }),
  fork: sessionOperation({
    operation: 'fork', targets: (...args: Parameters<typeof forkSessionAtMessage>) => [args[0]],
    execute: async (_scope, ...args: Parameters<typeof forkSessionAtMessage>) => (await import('../maker-orchestration/fork.js')).forkSessionAtMessage(...args),
  }),
  forkStripEncrypted: sessionOperation({
    operation: 'fork', targets: (...args: Parameters<typeof forkSessionStripEncrypted>) => [args[0]],
    execute: async (_scope, ...args: Parameters<typeof forkSessionStripEncrypted>) => (await import('../maker-orchestration/fork.js')).forkSessionStripEncrypted(...args),
  }),
});

export const sessionHistory = {
  previewRewind: (id: string, clientId: string) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'previewRewind', id, clientId),
  rewind: (id: string, clientId: string, options?: { requireLatestUser?: boolean; stopIfRunning?: boolean; allowFileRestore?: boolean }) =>
    controller.invoke(controller.issueCaller(requireSessionCaller()), 'rewind', id, clientId, options),
  fork: (...args: Parameters<typeof forkSessionAtMessage>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'fork', ...args),
  forkStripEncrypted: (...args: Parameters<typeof forkSessionStripEncrypted>) => controller.invoke(controller.issueCaller(requireSessionCaller()), 'forkStripEncrypted', ...args),
};
