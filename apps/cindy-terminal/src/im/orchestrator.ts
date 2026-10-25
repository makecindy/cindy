import { createCardBuilders } from '@cindy/im-runtime/cardBuilders';
import { createCardActionHandler } from '@cindy/im-runtime/cardActionHandler';
import { createMessageHandler } from '@cindy/im-runtime/messageHandler';
import { createSlashHandlers } from '@cindy/im-runtime/slashCommands';
import { createTurnRunner, type ImTurnRunner, type ImTurnRunnerDeps } from '@cindy/im-runtime/turnRunner';
import type { ImChannelAdapter } from '@cindy/im-runtime/types';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { IdentityKey } from '@cindy/im';

/** One registry per signed-in task owner. Sockets are supplied by channel
 * transports; commands, interactions and turns use the released shared runtime. */
export class TerminalImOrchestrators {
  private readonly instances = new Map<string, { adapter: ImChannelAdapter; runner: ImTurnRunner; unsubscribe: Array<() => void> }>();
  private readonly unsubscribe: Array<() => void>;
  private closing?: Promise<void>;

  constructor(private readonly tasks: TerminalTaskHost) {
    const account = tasks.channelControl.account;
    this.unsubscribe = [
      tasks.channelBindings.store.onChange(event => {
        if (event.prevValue && event.prevValue !== event.value) {
          for (const { adapter, runner } of this.instances.values()) {
            if (adapter.channel === event.identity.channel) runner.detachFromSession(event.prevValue);
          }
        }
      }),
      tasks.channelSignals.onChannelTurn(async (session, phase, source) => {
        if (phase !== 'starting') return;
        const generation = account.captureImAccountGeneration();
        if (generation === null) return;
        if (source === 'provider-wake') {
          // Provider wakes publish synchronously before their first output.
          for (const { adapter, runner } of this.instances.values()) {
            if (adapter.im.getStatus().kind === 'connected') runner.noteChannelTurnSource(session, source);
          }
          return;
        }
        if (![...this.instances.values()].some(({ adapter }) => adapter.im.getStatus().kind === 'connected')) return;
        const row = await tasks.storage.get(session.id);
        if (!row || row.deleted || row.archived || !account.isImAccountGenerationCurrent(generation)) return;
        if (row.source === 'bot') {
          for (const { adapter, runner } of this.instances.values()) {
            if (adapter.im.getStatus().kind === 'connected') runner.noteChannelTurnSource(session, source);
          }
          return;
        }
        const binding = tasks.channelBindings.store.findByTarget(session.id);
        const instance = this.instances.get(binding?.channel ?? row.source ?? '');
        if (!instance) return;
        const { adapter, runner } = instance;
        const status = adapter.im.getStatus();
        if (status.kind !== 'connected') return;
        const botId = binding?.botContextId ?? (row.source === 'feishu' ? row.feishuBotAppId : row.imBotContextId);
        if (!botId || (adapter.getBotContextId?.() ?? status.appId) !== botId) return;
        const userId = binding?.userId ?? (row.source === 'feishu' ? row.feishuOpenId : row.imUserId);
        if (userId) runner.attachSessionOutput(session, userId, { attached: binding !== null, scopeKey: binding?.scopeKey }, source);
      }),
    ];
  }

  attach(adapter: ImChannelAdapter, options: { instanceKey?: string; companion?: ImTurnRunnerDeps['companion'] } = {}) {
    const key = options.instanceKey ?? adapter.channel;
    if (this.closing || this.tasks.channelControl.account.captureImAccountGeneration() === null) throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
    if (this.instances.has(key)) throw new Error(`IM_CHANNEL_ALREADY_ATTACHED: ${key}`);
    if (options.companion && !adapter.companionLane) throw new Error('IM_COMPANION_LANE_REQUIRED');
    if (adapter.threadScoped && (adapter.output.kind !== 'rich-card' || !adapter.ui.thread || !adapter.output.im.threadKeyForMessage)) throw new Error('IM_THREAD_CAPABILITIES_REQUIRED');
    if (adapter.projectSwitching && !adapter.ui.cards.project) throw new Error('IM_PROJECT_CARD_REQUIRED');
    const repo = this.tasks.channelRepository(adapter.config, adapter.sessions, { projectSwitching: adapter.projectSwitching === true });
    const cards = createCardBuilders(adapter.ui, repo.getDefaultEffortFor);
    const runner: ImTurnRunner = createTurnRunner(adapter, repo, cards, {
      ...this.tasks.channelTurnDependencies({ source: adapter.sessions.source, config: adapter.config, isRouteUsable: route => runner.hasAuthForRoute(route) }),
      ...(options.companion ? { companion: options.companion } : {}),
    }, this.tasks.channelTurnHost());
    const slash = createSlashHandlers(adapter, repo, cards, runner, this.tasks.channelControl.commands);
    const unsubscribe = [createMessageHandler(adapter, slash, runner, this.tasks.channelControl.ingress)(adapter.im)];
    try {
      if (adapter.output.kind === 'rich-card') unsubscribe.push(createCardActionHandler(adapter, cards, runner, this.tasks.channelCardHost())(adapter.output.im));
    } catch (error) {
      for (const stop of unsubscribe) stop();
      throw error;
    }
    const instance = { adapter, runner, unsubscribe };
    this.instances.set(key, instance);
    let disposal: Promise<void> | undefined;
    const unregister=()=>{
      for (const stop of unsubscribe.splice(0)) stop();
      if (this.instances.get(key) === instance) this.instances.delete(key);
    };
    return { channel:adapter.channel,adapter,repo,cards,runner,turnRunner:runner,
      detachFromSession:(id:string)=>runner.detachFromSession(id),
      disposeAllSessions:()=>runner.disposeAllSessions(),unregister,
      close: () => disposal ??= (async () => {
      unregister();
      await runner.disposeAllSessions();
    })() };
  }

  vendorOptionsForSession(id: string): Record<string, unknown> | undefined {
    for (const { runner } of this.instances.values()) {
      const options = runner.vendorOptionsForSession(id);
      if (options) return options;
    }
    return undefined;
  }

  async notifyRevoked(identity: IdentityKey): Promise<void> {
    const instance = this.instances.get(identity.channel);
    if (!instance) return;
    const status = instance.adapter.im.getStatus();
    if (status.kind !== 'connected' || (instance.adapter.getBotContextId?.() ?? status.appId) !== identity.botContextId) return;
    await instance.adapter.im.sendText(identity.userId, instance.adapter.ui.slash.detachedByRevoke, { threadTs: identity.scopeKey });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    for (const stop of this.unsubscribe.splice(0)) stop();
    const current = [...this.instances.values()];
    this.instances.clear();
    for (const { unsubscribe } of current) for (const stop of unsubscribe.splice(0)) stop();
    return this.closing = Promise.all(current.map(({ runner }) => runner.disposeAllSessions())).then(() => {});
  }
}
