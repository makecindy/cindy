import { createImSessionRepository } from '@cindy/app-runtime/imSessionRepository';
import type { SessionRouteLock } from '@cindy/app-runtime/sessionRouteLock';
import type { ImSessionRepo, ImSessionRow } from '@cindy/im-runtime/sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '@cindy/im-runtime/types';
import type { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import type { TerminalTaskStorage, TerminalTaskMeta, NewTerminalTaskMeta } from '../tasks/storage.js';
import type { TerminalImBindings } from './bindings.js';
import type { NodeDatabase } from '../database.js';
import type { DbLogger } from '@cindy/runtime-db/logging';

export interface TerminalImRepositoryHost {
  ready: Promise<void>;
  database: Promise<NodeDatabase>;
  profileDir: string;
  logger: DbLogger;
  storage: TerminalTaskStorage;
  bindings: TerminalImBindings;
  defaults: ReturnType<typeof createImSessionDefaults>;
  withSessionRouteLock: SessionRouteLock;
  assertCurrent(): void;
  retireDeletedPiSubagentState(sessionId: string): Promise<void>;
  admit(row: ImSessionRow, title: string): Promise<NewTerminalTaskMeta>;
  changed(row: TerminalTaskMeta, kind: 'created' | 'patched'): void;
}

/** Transport/lifetime adapter; routing, revival and /new use the original repository. */
export function createTerminalImSessionRepo(host: TerminalImRepositoryHost,
  config: ImOrchestratorConfig, ns: ImSessionNamespace,
  options: { projectSwitching?: boolean } = {},
): ImSessionRepo {
  const repository = Promise.all([host.ready, host.database]).then(([, database]) => {
    host.assertCurrent();
    const captureChannelAccount = () => {
      const owner = database.getCurrentDbClientSnapshot();
      return () => {
        host.assertCurrent();
        if (!owner || database.getCurrentDbClientSnapshot() !== owner) throw new Error('TASK_OWNER_CHANGED');
      };
    };
    const changed = (id: string, kind: 'created' | 'patched') => {
      void host.storage.get(id).then(row => {
        host.assertCurrent();
        if (row) host.changed(row, kind);
      }).catch(error => host.logger.warn('Channel task notification failed', { error: String(error) }));
    };
    return createImSessionRepository({
      ...host.defaults,
      getDbClient: () => { host.assertCurrent(); return database.getDbClient(); },
      createLogger: () => host.logger,
      maskPath: () => '<private>',
      withSessionRouteLock: host.withSessionRouteLock,
      retireDeletedPiSubagentState: host.retireDeletedPiSubagentState,
      setSessionProvider: (id, provider) => host.storage.noteProvider(id, provider),
      broadcastSessionCreated: id => changed(id, 'created'),
      broadcastSessionPatched: id => changed(id, 'patched'),
      captureChannelAccount,
      async openChannelSession(id, route, commit, assertAccount) {
        const assertCurrent = assertAccount ?? captureChannelAccount();
        assertCurrent();
        const admitted = await host.admit({ ...route, id, effort: route.effort ?? 'high', fastMode: route.fastMode ?? false, sdkSessionId: null }, route.title ?? ns.defaultTitle(id));
        assertCurrent();
        return commit({ model: admitted.model, providerId: admitted.providerId ?? null,
          ...(route.effort !== undefined ? { effort: admitted.effort } : {}),
          ...(route.fastMode !== undefined ? { fastMode: admitted.fastMode } : {}),
        }, assertCurrent);
      },
    }).createImSessionRepo(config, ns, options);
  });
  // Keep synchronous routing/default queries synchronous; all DB operations
  // wait for the same owner startup barrier as the original host.
  return {
    sessionIdFor: (...args) => ns.sessionIdFor(...args),
    getDefaultEffortFor: (model, kind = config.agentKind) => host.defaults.getImDefaultEffortFor(kind, model, config.effortOverrides),
    peekSession: (...args) => repository.then(repo => repo.peekSession(...args)),
    peekSessionById: (...args) => repository.then(repo => repo.peekSessionById(...args)),
    findActiveSession: (...args) => repository.then(repo => repo.findActiveSession(...args)),
    prepareNewSession: (...args) => repository.then(repo => repo.prepareNewSession(...args)),
    createSession: (...args) => repository.then(repo => repo.createSession(...args)),
    createFreshSession: async (bot, user, scope, prepared, detach) => {
      const repo = await repository;
      return host.bindings.commitTaskRotation(detach ?? null,
        detached => repo.createFreshSession!(bot, user, scope, prepared, detached ? detach : null));
    },
  };
}
