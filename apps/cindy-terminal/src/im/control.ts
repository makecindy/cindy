import { createImAccountBoundary } from '@cindy/im-runtime/accountBoundary';
import { createControlState } from '@cindy/im-runtime/controlState';
import { createControlProjectReader } from '@cindy/im-runtime/controlProjects';
import { startThreadControlFlow } from '@cindy/im-runtime/controlFlow';
import { looksLikeSlashCommand } from '@cindy/im-runtime/commands';
import type { ImCommandHost } from '@cindy/im-runtime/commandHost';
import type { MessageIngressHost } from '@cindy/im-runtime/ingressHost';
import { DESKTOP_TASK_LIST_SESSION_SOURCES, normalizeSessionSource } from '@cindy/maker-shared/session-source';
import type { ProviderView } from '@cindy/model-providers';
import type { Logger } from '@cindy/maker-core';
import type { TerminalTaskHost } from '../tasks/host.js';

/** Account-local commands and control state, independent of channel sockets
 * and terminal screens. Incoming callbacks retain the owner that admitted them. */
export class TerminalImControl {
  readonly account = createImAccountBoundary();
  readonly state = createControlState();
  readonly projects: ReturnType<typeof createControlProjectReader>;
  readonly commands: ImCommandHost;
  readonly ingress: MessageIngressHost;
  private closing?: Promise<void>;
  constructor(host: {
    tasks: TerminalTaskHost;
    logger: Logger;
    assertCurrent(): void;
    readDeviceProviders(deviceId: string): Promise<ProviderView[]>;
  }) {
    const tasks = host.tasks;
    this.projects = createControlProjectReader({
      isProvisional: () => false,
      readTitle: async id => { await tasks.ready; host.assertCurrent(); return (await tasks.storage.get(id))?.title ?? null; },
      listRows: async options => {
        await tasks.ready; host.assertCurrent();
        const rows = (await tasks.storage.list()).filter(row => !row.deleted && !row.archived && DESKTOP_TASK_LIST_SESSION_SOURCES.includes(normalizeSessionSource(row.source)));
        host.assertCurrent();
        if (options?.ordered) rows.sort((a, b) => (b.userSendAt ?? -Infinity) - (a.userSendAt ?? -Infinity) || b.updatedAt - a.updatedAt);
        return (options?.limit === undefined ? rows : rows.slice(0, options.limit)).map(row => ({ id: row.id, title: row.title, workingDir: row.workDir, updatedAt: row.updatedAt, userSendAt: row.userSendAt ?? null }));
      },
    });
    const createLogger = (scope: string) => host.logger.child(scope);
    this.commands = {
      createLogger,
      listProviders: async () => { await tasks.ready; host.assertCurrent(); return tasks.models.views(); },
      readDeviceProviderViews: async id => { host.assertCurrent(); const rows = await host.readDeviceProviders(id); host.assertCurrent(); return rows; },
      waitForModelVisibilityMirror: async () => { await tasks.ready; host.assertCurrent(); await tasks.models.waitForModelVisibility();host.assertCurrent(); },
      getModelVisibilityOverride: (...args) => {
        host.assertCurrent();
        return tasks.models.visibility.mirror.getModelVisibilityOverride(...args);
      },
      getSessionProvider: id => tasks.routes.provider(id),
      resetImSessionToChannelDefaults: (...args) => tasks.resetChannelTask(...args),
      ...this.projects,
      enterControl: (...args) => { host.assertCurrent(); this.state.enterControl(...args); },
      startThreadControlFlow: (...args) => startThreadControlFlow(...args, this.commands),
      bindingStore: tasks.channelBindings.store,
      executeDetach: async identity => {
        host.assertCurrent();
        const target = tasks.channelBindings.store.get(identity);
        if (!target || !await tasks.channelBindings.store.detachIfTarget(identity, target)) return { wasAttached: false, targetSessionId: null };
        return { wasAttached: true, targetSessionId: target };
      },
    };
    this.ingress = { ...this.account, createLogger, getControlScope: this.state.getControlScope, isInControl: this.state.isInControl, looksLikeSlashCommand };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const generation = this.account.captureImAccountGeneration();
    this.account.deactivateImAccountBoundary();
    return this.closing = (async () => {
      if (generation !== null) await this.account.waitForImAccountGenerationIdle(generation);
      this.state.clear();
    })();
  }
}
