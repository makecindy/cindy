import {
  computeAllowlistHash,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  REMOTE_INVOKE_ALLOWLIST,
  topicForPush,
  type Envelope,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkOpenPayload,
  type Topic,
} from '@cindy/device-link';
import type { HeadlessControlService } from './control-service.js';
import type { HeadlessHistoryMessage, HeadlessHistoryStorage, HeadlessSessionEvent, HeadlessSessionEventSource, HeadlessSessionEventStorage, HeadlessSessionMeta, HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessInputQueue } from './input-queue.js';
import type { HeadlessMediaService } from './media-service.js';

type BridgeStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & Partial<HeadlessHistoryStorage>;

/** Small host-facing subset of DeviceLinkClient, deliberately easy to fake in tests. */
export interface HeadlessDeviceLinkClient {
  onFrame(listener: (frame: Envelope) => void): () => void;
  sendInvokeResult(dst: string, requestId: string, payload: InvokeResultPayload): void;
  sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void;
  sendPush(dst: string, channel: string, payload: unknown): void;
}

export interface HeadlessDeviceLinkBridgeOptions {
  client: HeadlessDeviceLinkClient;
  control: HeadlessControlService;
  storage: BridgeStorage & Partial<HeadlessSessionEventSource>;
  /** The daemon's config is the authoritative opt-in gate, even if relay state is stale. */
  remoteControlEnabled: () => Promise<boolean>;
  /** Required before a phone may choose a project workdir. Empty dialogue workspaces are host-owned. */
  isWorkdirAllowed?: (workdir: string) => Promise<boolean>;
  appVersion?: string;
  /** Durable input queue shared by all Device Link bridge lifecycles. */
  inputQueue?: HeadlessInputQueue;
  /** Host-owned content-addressed chat media; served only through the allowlisted fetch channel. */
  media?: HeadlessMediaService;
}

type Subscription = { name: string; topics: Set<Topic | '*'> };

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Maximum', ultra: 'Ultra',
};

/**
 * Translates the established Desktop-compatible Device Link control surface to
 * the daemon's local control service.  It never exposes config mutation or
 * credential methods: the shared remote allowlist is necessary but not
 * sufficient; this bridge implements only operations a headless host owns.
 */
export class HeadlessDeviceLinkBridge {
  private readonly subscriptions = new Map<string, Subscription>();
  private stopFrames: (() => void) | null = null;
  private stopEvents: (() => void) | null = null;
  private stopInputQueue: (() => void) | null = null;

  constructor(private readonly options: HeadlessDeviceLinkBridgeOptions) {}

  start(): void {
    if (this.stopFrames) return;
    this.stopFrames = this.options.client.onFrame((frame) => {
      void this.handleFrame(frame).catch(() => undefined);
    });
    if (this.options.storage.onEvent) {
      this.stopEvents = this.options.storage.onEvent((event) => this.publishPersistedEvent(event));
    }
    this.stopInputQueue = this.options.inputQueue?.onProjection((projection) => {
      this.publish('maker:input:projection', projection);
    }) ?? null;
  }

  stop(): void {
    this.stopFrames?.();
    this.stopFrames = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.stopInputQueue?.();
    this.stopInputQueue = null;
    this.subscriptions.clear();
  }

  /** Exposed for adapters that use a storage implementation without onEvent. */
  publishPersistedEvent(event: HeadlessSessionEvent): void {
    switch (event.type) {
      case 'session_created':
        this.publish('local-db:sessions:created', { sessionId: event.sessionId });
        return;
      case 'session_configured':
        this.publish('local-db:sessions:patched', {
          sessionId: event.sessionId,
          patch: toRemoteMetaPatch(record(event.data)?.patch),
        });
        return;
      case 'agent_event':
        // Mobile releases predating the current live-event reducer can render
        // system cards (such as compact_boundary) but do not materialize a
        // structured final text event.  Give every presentable agent event a
        // stable persistence identity, then mirror final assistant text on the
        // established local-db message channel.  New clients deduplicate the
        // two paths by that identity; old clients still receive the reply.
        {
          const message = eventToMessage(event);
          this.publish('maker:event', {
            sessionId: event.sessionId,
            event: event.data,
            ...(message ? { persistId: message.clientId } : {}),
          });
          if (message && isFinalAgentText(event.data)) {
            this.publish('local-db:messages:created', { sessionId: event.sessionId, message });
          }
        }
        return;
      case 'session_status':
        this.publish('maker:status-changed', { sessionId: event.sessionId, ...(record(event.data) ?? {}) });
        return;
      case 'interaction_request':
        this.publish('maker:interaction-request', { sessionId: event.sessionId, request: event.data });
        return;
      case 'interaction_resolved':
        this.publish('maker:interaction-dismissed', { sessionId: event.sessionId, ...(record(event.data) ?? {}) });
        return;
      case 'goal_status':
        this.publish('maker:goal:status-changed', { sessionId: event.sessionId, ...(record(event.data) ?? {}) });
        return;
      case 'history_deleted':
      case 'history_rewound': {
        const data = record(event.data) ?? {};
        const clientIds = Array.isArray(data.clientIds) ? data.clientIds.filter((value): value is string => typeof value === 'string') : [];
        this.publish('local-db:messages:deleted', { sessionId: event.sessionId, clientId: data.clientId, clientIds });
        return;
      }
      case 'orca_worker_changed':
        this.publish('maker:orca:worker-changed', record(event.data) ?? { leadSessionId: event.sessionId });
        return;
      case 'user_message':
        this.publish('local-db:messages:created', { sessionId: event.sessionId, message: eventToMessage(event) });
        return;
      default:
        return;
    }
  }

  private async handleFrame(frame: Envelope): Promise<void> {
    if (!frame.src) return;
    if (frame.kind === 'link-open' && frame.id) {
      await this.handleLinkOpen(frame.src, frame.id, frame.payload as LinkOpenPayload | undefined);
      return;
    }
    if (frame.kind === 'link-close') {
      this.subscriptions.delete(frame.src);
      return;
    }
    if (frame.kind === 'invoke' && frame.id) {
      const result = await this.handleInvoke(frame.src, frame.payload as InvokePayload | undefined);
      this.options.client.sendInvokeResult(frame.src, frame.id, result);
    }
  }

  private async handleLinkOpen(src: string, requestId: string, payload: LinkOpenPayload | undefined): Promise<void> {
    if (!await this.options.remoteControlEnabled()) return;
    const name = typeof payload?.controllerName === 'string' && payload.controllerName.trim()
      ? payload.controllerName.trim().slice(0, 64)
      : src.slice(0, 8);
    // Old mobile clients cannot subscribe by topic. Keep their documented
    // legacy behavior without granting any new invoke capability.
    this.subscriptions.set(src, { name, topics: new Set(['*']) });
    this.options.client.sendLinkAccept(src, requestId, {
      appVersion: this.options.appVersion ?? 'headless',
      allowlistHash: computeAllowlistHash(),
    });
  }

  private async handleInvoke(src: string, payload: InvokePayload | undefined): Promise<InvokeResultPayload> {
    if (!payload || typeof payload.channel !== 'string' || !Array.isArray(payload.args)) {
      return error('IPC_ERROR', 'malformed invoke payload');
    }
    if (!await this.options.remoteControlEnabled()) return error('IPC_ERROR', 'remote control disabled');
    if (!REMOTE_INVOKE_ALLOWLIST.has(payload.channel)) {
      return error('CHANNEL_NOT_ALLOWED', `channel '${payload.channel}' not allowed remotely`);
    }
    try {
      if (payload.channel === DL_SUBSCRIBE_CHANNEL || payload.channel === DL_UNSUBSCRIBE_CHANNEL) {
        return this.handleSubscription(src, payload);
      }
      return { ok: true, result: await this.dispatch(src, payload.channel, payload.args) };
    } catch (cause) {
      return error('IPC_ERROR', cause instanceof Error ? cause.message : String(cause));
    }
  }

  private handleSubscription(src: string, payload: InvokePayload): InvokeResultPayload {
    const value = record(payload.args[0]) ?? {};
    const topics = Array.isArray(value.topics)
      ? value.topics.filter(isTopic)
      : [];
    const name = typeof value.controllerName === 'string' && value.controllerName.trim()
      ? value.controllerName.trim().slice(0, 64)
      : src.slice(0, 8);
    const current = this.subscriptions.get(src) ?? { name, topics: new Set<Topic | '*'>() };
    current.name = name;
    if (payload.channel === DL_SUBSCRIBE_CHANNEL) {
      for (const topic of topics) current.topics.add(topic);
      if (current.topics.size > 0) this.subscriptions.set(src, current);
    } else {
      for (const topic of topics) current.topics.delete(topic);
      if (current.topics.size === 0) this.subscriptions.delete(src);
    }
    return { ok: true, result: { ok: true } };
  }

  private async dispatch(controllerId: string, channel: string, args: unknown[]): Promise<unknown> {
    switch (channel) {
      case 'device-link:media:fetch':
        if (!this.options.media) throw new Error('remote media is unavailable on this host');
        return this.options.media.fetchForRemote(args[0]);
      case 'maker:create-session': {
        const input = record(args[0]) ?? {};
        const requestedWorkdir = typeof input.workingDir === 'string'
          ? input.workingDir
          : typeof input.workDir === 'string' ? input.workDir : '';
        if (requestedWorkdir && this.options.isWorkdirAllowed && !await this.options.isWorkdirAllowed(requestedWorkdir)) {
          throw new Error('workdir is not within an allowed remote project root');
        }
        const created = await this.control('session.create', {
          ...input,
          workDir: requestedWorkdir,
        }) as HeadlessSessionMeta;
        return { sessionId: created.id, agentKind: created.agentKind, workDir: created.workDir };
      }
      case 'maker:send':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.send(stringArg(args, 0, 'sessionId'), messageArg(args[1]));
      case 'maker:steer':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.steer(stringArg(args, 0, 'sessionId'), messageArg(args[1]));
      case 'maker:close-session':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.close(stringArg(args, 0, 'sessionId'));
      case 'maker:set-model':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.configureSession(stringArg(args, 0, 'sessionId'), {
          model: stringArg(args, 1, 'model'),
          ...(typeof args[2] === 'string' && args[2].trim() ? { providerId: args[2] } : {}),
        });
      case 'maker:switch-session-agent':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.configureSession(stringArg(args, 0, 'sessionId'), {
          agentKind: agentKindArg(args[1]),
          model: stringArg(args, 2, 'model'),
          providerId: nullableProviderArg(args[3]),
          effort: effortArg(args[4]),
          ...(typeof args[5] === 'boolean' ? { fastMode: args[5] } : {}),
        });
      case 'maker:get-session-agent-switch-intent':
        // Unlike desktop's deferred renderer handoff, Headless applies an
        // idle switch atomically before acknowledging it.  There is therefore
        // never a pending intent to recover after reconnect.
        return null;
      case 'maker:set-effort':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.configureSession(stringArg(args, 0, 'sessionId'), { effort: effortArg(args[1]) });
      case 'maker:set-permission-mode':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.configureSession(stringArg(args, 0, 'sessionId'), { permissionMode: permissionArg(args[1]) });
      case 'maker:set-fast-mode':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.configureSession(stringArg(args, 0, 'sessionId'), { fastMode: booleanArg(args[1], 'enabled') });
      case 'maker:set-extra-dirs':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.setExtraDirs(stringArg(args, 0, 'sessionId'), args[1]);
      case 'maker:set-session-model-pref': {
        const pref = record(args[0]) ?? {};
        this.assertWrite(controllerId, stringArg([pref.sessionId], 0, 'sessionId'));
        return this.control('model.set-session-preference', pref);
      }
      case 'maker:apply-new-maker-draft-pref':
        return this.control('model.apply-draft-preference', record(args[0]) ?? {});
      case 'maker:abort-session':
      case 'maker:input:stop':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.stopSession(stringArg(args, 0, 'sessionId'), record(args[1]) ?? {})
          : (await this.abort(stringArg(args, 0, 'sessionId')), this.publishInputProjection(stringArg(args, 0, 'sessionId')));
      case 'maker:input:get-projection':
        return this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:enqueue': {
        const sessionId = stringArg(args, 0, 'sessionId');
        this.assertWrite(controllerId, sessionId);
        if (this.options.inputQueue) return this.options.inputQueue.enqueue(sessionId, args[1]);
        await this.send(sessionId, queuedTextArg(args[1]));
        return this.publishInputProjection(sessionId);
      }
      case 'maker:input:steer': {
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        if (this.options.inputQueue) {
          return this.options.inputQueue.steer(
            stringArg(args, 0, 'sessionId'), args[1], record(args[2])?.removeFromQueue === true,
          );
        }
        await this.steer(stringArg(args, 0, 'sessionId'), queuedTextArg(args[1]));
        return true;
      }
      case 'maker:input:compact':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:resume':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.resume(stringArg(args, 0, 'sessionId'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:retry-last-error':
      case 'maker:input:clear-error':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:remove':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.remove(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:update-text':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.updateText(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'), stringArg(args, 2, 'newText'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:update-content':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.updateContent(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'), args[2])
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:move':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.move(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'), numberArg(args[2], 'targetIndex'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:set-expanded':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.setExpanded(stringArg(args, 0, 'sessionId'), booleanArg(args[1], 'expanded'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:set-interaction-lock':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.setInteractionLock(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'lockId'), booleanArg(args[2], 'locked'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:set-edit-lock':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.setEditLock(stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'), booleanArg(args[2], 'locked'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:input:clear-session':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.options.inputQueue
          ? this.options.inputQueue.clearSession(stringArg(args, 0, 'sessionId'))
          : this.inputProjection(stringArg(args, 0, 'sessionId'));
      case 'maker:list-active':
        return Promise.all((await this.control('session.list') as HeadlessSessionMeta[])
          .filter((session) => (session.status ?? 'active') === 'active')
          .map((session) => this.toRemoteSession(session)));
      case 'local-db:sessions:list':
        return Promise.all((await this.control('session.list') as HeadlessSessionMeta[])
          .filter((session) => sessionMatchesStatus(session, args[1]))
          .map((session) => this.toRemoteSession(session)));
      case 'local-db:sessions:get': {
        const session = await this.control('session.get', { sessionId: stringArg(args, 0, 'sessionId') }) as HeadlessSessionMeta | null;
        return session ? await this.toRemoteSession(session) : null;
      }
      case 'local-db:sessions:patch-meta': {
        this.claimMetadataWrite(controllerId, stringArg(args, 0, 'sessionId'));
        const updated = await this.control('session.patch-meta', {
          sessionId: stringArg(args, 0, 'sessionId'),
          patch: record(args[1]) ?? {},
        }) as HeadlessSessionMeta;
        return this.toRemoteSession(updated);
      }
      case 'local-db:messages:dismiss-error':
        return this.dismissError(controllerId, stringArg(args, 0, 'sessionId'), stringArg(args, 1, 'clientId'));
      case 'local-db:sessions:ack-interrupted':
        return this.ackInterruptedTurn(controllerId, stringArg(args, 0, 'sessionId'));
      case 'maker:regenerate-title':
        return this.control('session.regenerate-title', { sessionId: stringArg([record(args[0])?.sessionId], 0, 'sessionId') });
      case 'local-db:messages:list':
      case 'local-db:history:messages':
        return this.listMessages(stringArg(args, 0, 'sessionId'), record(args[1]) ?? {});
      case 'local-db:messages:around':
        return this.messagesAround(stringArg(args, 0, 'sessionId'), 'id', stringArg(args, 1, 'messageId'), record(args[2]) ?? {});
      case 'local-db:messages:around-client-id':
        return this.messagesAround(stringArg(args, 0, 'sessionId'), 'clientId', stringArg(args, 1, 'clientId'), record(args[2]) ?? {});
      case 'maker:get-pending-interactions':
        return this.pendingInteractions(typeof args[0] === 'string' ? args[0] : undefined);
      case 'maker:get-context-usage':
        return this.contextUsage(stringArg(args, 0, 'sessionId'));
      case 'maker:goal:set': {
        const input = record(args[0]) ?? {};
        this.assertWrite(controllerId, stringArg([input.sessionId], 0, 'sessionId'));
        return this.control('goal.set', input);
      }
      case 'maker:goal:clear':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.control('goal.clear', { sessionId: stringArg(args, 0, 'sessionId') });
      case 'maker:goal:get-status':
        return this.control('goal.status', { sessionId: stringArg(args, 0, 'sessionId') });
      case 'maker:goal:pause':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.control('goal.pause', { sessionId: stringArg(args, 0, 'sessionId') });
      case 'maker:goal:resume':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.control('goal.resume', { sessionId: stringArg(args, 0, 'sessionId') });
      case 'maker:goal:update': {
        const input = record(args[0]) ?? {};
        this.assertWrite(controllerId, stringArg([input.sessionId], 0, 'sessionId'));
        return this.control('goal.update', input);
      }
      case 'maker:message:delete':
        this.assertWrite(controllerId, stringArg(args, 0, 'sessionId'));
        return this.control('history.delete', { sessionId: stringArg(args, 0, 'sessionId'), clientId: stringArg(args, 1, 'clientId') });
      case 'maker:fork': {
        const sourceSessionId = stringArg(args, 0, 'sourceSessionId');
        this.assertWrite(controllerId, sourceSessionId);
        const forked = await this.control('history.fork', { sessionId: sourceSessionId, clientId: stringArg(args, 1, 'messageClientId') }) as HeadlessSessionMeta;
        return this.toRemoteSession(forked);
      }
      case 'maker:rewind:preview':
        return this.control('history.rewind.preview', { sessionId: stringArg(args, 0, 'sessionId'), clientId: stringArg(args, 1, 'clientId') });
      case 'maker:rewind:commit': {
        const sessionId = stringArg(args, 0, 'sessionId');
        this.assertWrite(controllerId, sessionId);
        const rewound = await this.control('history.rewind.commit', { sessionId, clientId: stringArg(args, 1, 'clientId') }) as HeadlessSessionMeta;
        return this.toRemoteSession(rewound);
      }
      case 'maker:resolve-interaction':
        return this.resolveInteraction(controllerId, stringArg(args, 0, 'requestId'), args[1]);
      case 'maker:provider:list':
        return this.control('catalog.providers.display');
      case 'maker:get-capabilities':
        return this.capabilities(stringArg(args, 0, 'agentKind'));
      case 'maker:any-session-in-turn':
        return (await this.control('runtime.any-session-in-turn') as { busy: boolean }).busy;
      case 'maker:session-in-turn':
        return (await this.control('session.is-busy', { sessionId: stringArg(args, 0, 'sessionId') }) as { busy: boolean }).busy;
      case 'file-browser:remote-op':
        return this.control('file.remote-op', args[0]);
      case 'text-file:read-preview':
        return this.control('file.preview', { path: filePathArg(args[0]) });
      case 'fs:list-dir':
        return this.control('file.list-dir', { path: filePathArg(args[0]) });
      case 'fs:stat-path':
        return this.control('file.stat-path', { path: filePathArg(args[0]) });
      case 'fs:mkdir-p':
        return this.control('file.mkdir-p', { path: filePathArg(args[0]) });
      case 'maker:schedule:list':
        return this.control('schedule.list');
      case 'maker:schedule:get':
        return this.control('schedule.get', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:create':
        return this.control('schedule.create', record(args[0]) ?? {});
      case 'maker:schedule:update':
        return this.control('schedule.update', { scheduleId: stringArg(args, 0, 'scheduleId'), ...(record(args[1]) ?? {}) });
      case 'maker:schedule:delete':
        return this.control('schedule.delete', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:pause':
        return this.control('schedule.pause', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:resume':
        return this.control('schedule.resume', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:run-now':
        return this.control('schedule.run-now', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:list-runs':
        return this.control('schedule.runs', { scheduleId: stringArg(args, 0, 'scheduleId'), ...(typeof args[1] === 'number' ? { limit: args[1] } : {}) });
      case 'maker:schedule:delete-run':
        return this.control('schedule.delete-run', { runId: stringArg(args, 0, 'runId') });
      case 'maker:schedule:list-templates':
        return this.control('schedule.list-templates');
      case 'maker:schedule:create-from-template':
        return this.control('schedule.create-from-template', record(args[0]) ?? {});
      case 'maker:schedule:get-inflight-count':
        return this.control('schedule.inflight-count', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:mark-run-read':
        return this.control('schedule.mark-run-read', { runId: stringArg(args, 0, 'runId') });
      case 'maker:schedule:mark-schedule-runs-read':
        return this.control('schedule.mark-schedule-runs-read', { scheduleId: stringArg(args, 0, 'scheduleId') });
      case 'maker:schedule:get-runtime-state':
        return this.control('schedule.runtime-state');
      case 'maker:list-agent-commands':
        return this.control('agent.list-commands', { agentKind: stringArg(args, 0, 'agentKind') });
      case 'maker:list-agent-skills':
        return this.control('agent.list-skills', { agentKind: stringArg(args, 0, 'agentKind'), ...(record(args[1]) ?? {}) });
      case 'maker:scan-at-resources':
        return this.control('agent.scan-at-resources', { agentKind: stringArg(args, 0, 'agentKind'), ...(record(args[1]) ?? {}) });
      case 'maker:api-key:present':
        return this.control('account.api-key-present');
      case 'maker:usage:model-pricing':
        return this.control('usage.model-pricing');
      case 'notification:clear-session-attention':
        return this.clearSessionAttention(controllerId, stringArg(args, 0, 'sessionId'));
      case 'maker:project-automation:remove-schedule':
        return this.control('schedule.project-remove', {
          workingDir: stringArg([record(args[0])?.workingDir], 0, 'workingDir'),
          scheduleId: stringArg([record(args[0])?.id], 0, 'id'),
        });
      case 'maker:session:enable-orca':
        return this.orcaStart(stringArg(args, 0, 'sessionId'));
      case 'maker:session:disable-orca':
      case 'maker:team:end':
        return this.orcaEnd(stringArg(args, 0, 'sessionId'));
      case 'maker:worker:list':
      case 'local-db:orca-workflows:list-workers-by-lead':
        return this.control('orca.worker.list', { leadSessionId: stringArg(args, 0, 'leadSessionId') });
      case 'local-db:orca-workflows:get-by-lead':
        return this.control('orca.team.get', { leadSessionId: stringArg(args, 0, 'leadSessionId') });
      case 'maker:worker:create':
        return this.orcaCreateWorker(record(args[0]) ?? {});
      case 'maker:worker:idle':
        return this.orcaWorkerAction('orca.worker.idle', stringArg(args, 0, 'leadSessionId'), stringArg(args, 1, 'workerRef'));
      case 'maker:worker:archive':
        return this.orcaWorkerAction('orca.worker.archive', stringArg(args, 0, 'leadSessionId'), stringArg(args, 1, 'workerRef'));
      case 'maker:worker:switch-focus':
        return this.orcaWorkerAction('orca.worker.focus', stringArg(args, 0, 'leadSessionId'), stringArg(args, 1, 'workerRef'));
      default:
        throw new Error(`channel '${channel}' is not implemented by the Linux headless host`);
    }
  }

  /**
   * Keep the established Device Link write semantics: any linked client may
   * submit an allowed mutation. Ordering remains the daemon's normal arrival
   * order, exactly as on the existing Mac and mobile hosts.
   */
  private assertWrite(_controllerId: string, _sessionId: string): void {}

  private claimMetadataWrite(_controllerId: string, _sessionId: string): void {}

  private async send(sessionId: string, content: unknown): Promise<{ accepted: true }> {
    return this.control('session.send', { sessionId, content }) as Promise<{ accepted: true }>;
  }

  private async setExtraDirs(sessionId: string, dirs: unknown): Promise<unknown> {
    return this.control('session.set-extra-dirs', { sessionId, dirs });
  }

  private async abort(sessionId: string): Promise<{ aborted: true }> {
    return this.control('session.abort', { sessionId }) as Promise<{ aborted: true }>;
  }

  private async steer(sessionId: string, content: unknown): Promise<{ steered: true }> {
    return this.control('session.steer', { sessionId, content }) as Promise<{ steered: true }>;
  }

  private async close(sessionId: string): Promise<{ closed: true }> {
    return this.control('session.close', { sessionId }) as Promise<{ closed: true }>;
  }

  private async configureSession(sessionId: string, patch: Record<string, unknown>): Promise<HeadlessSessionMeta> {
    return this.control('session.configure', { sessionId, ...patch }) as Promise<HeadlessSessionMeta>;
  }

  private async inputProjection(sessionId: string): Promise<Record<string, unknown>> {
    if (!await this.options.storage.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    if (this.options.inputQueue) return this.options.inputQueue.projection(sessionId);
    return emptyInputProjection(sessionId);
  }

  private async publishInputProjection(sessionId: string): Promise<Record<string, unknown>> {
    const projection = await this.inputProjection(sessionId);
    this.publish('maker:input:projection', projection);
    return projection;
  }

  private async orcaStart(leadSessionId: string): Promise<unknown> {
    return this.control('orca.team.start', { leadSessionId });
  }

  private async orcaEnd(leadSessionId: string): Promise<unknown> {
    return this.control('orca.team.end', { leadSessionId });
  }

  private async orcaCreateWorker(input: Record<string, unknown>): Promise<unknown> {
    const leadSessionId = typeof input.leadSessionId === 'string' ? input.leadSessionId
      : typeof input.sessionId === 'string' ? input.sessionId : '';
    return this.control('orca.worker.create', { ...input, leadSessionId });
  }

  private async orcaWorkerAction(method: string, leadSessionId: string, workerRef: string): Promise<unknown> {
    return this.control(method, { leadSessionId, workerRef });
  }

  private async resolveInteraction(controllerId: string, requestId: string, decision: unknown): Promise<{ resolved: boolean }> {
    const pending = await this.pendingInteractions();
    const match = pending.find((item) => item.requestId === requestId);
    if (!match) throw new Error(`Unknown pending interaction: ${requestId}`);
    this.assertWrite(controllerId, match.sessionId);
    return this.control('session.interaction.resolve', {
      sessionId: match.sessionId,
      requestId,
      decision,
    }) as Promise<{ resolved: boolean }>;
  }

  private async pendingInteractions(sessionId?: string): Promise<Array<Record<string, unknown> & { sessionId: string; requestId: string }>> {
    const sessions = sessionId
      ? [await this.options.storage.get(sessionId)].filter((item): item is HeadlessSessionMeta => !!item)
      : await this.options.storage.list();
    const pending = new Map<string, Record<string, unknown> & { sessionId: string; requestId: string }>();
    for (const session of sessions) {
      const events = await this.options.storage.listEvents(session.id, 0, 1_000);
      for (const event of events) {
        const data = record(event.data);
        if (event.type === 'interaction_request' && data && typeof data.requestId === 'string') {
          pending.set(data.requestId, { ...data, sessionId: session.id, requestId: data.requestId });
        }
        if (event.type === 'interaction_resolved' && data && typeof data.requestId === 'string') pending.delete(data.requestId);
      }
    }
    return [...pending.values()];
  }

  private async listMessages(sessionId: string, options: Record<string, unknown>): Promise<unknown[]> {
    const events = await this.options.storage.listEvents(sessionId, 0, 1_000);
    const dismissed = new Set(events
      .filter((event) => event.type === 'message_dismissed')
      .map((event) => record(event.data)?.clientId)
      .filter((clientId): clientId is string => typeof clientId === 'string' && clientId.length > 0));
    const messages = (await this.listMessagesChronological(sessionId))
      .filter((message) => message.role !== 'error' || !dismissed.has(String(message.clientId ?? '')));
    const before = typeof options.before === 'string' ? options.before : null;
    const beforeTs = typeof options.beforeTs === 'number' && Number.isFinite(options.beforeTs) ? options.beforeTs : null;
    let visible = messages;
    if (before) {
      const index = messages.findIndex((message) => message.id === before);
      if (index >= 0) visible = messages.slice(0, index);
    } else if (beforeTs !== null) {
      visible = messages.filter((message) => Date.parse(String(message.createdAt)) < beforeTs);
    }
    const limit = boundedMessageLimit(options.limit);
    // Desktop returns newest-first pages; keep the same cursor semantics so the
    // Mobile paging helper can merge Linux and macOS histories identically.
    return visible.slice(-limit).reverse();
  }

  private async messagesAround(
    sessionId: string,
    key: 'id' | 'clientId',
    anchor: string,
    options: Record<string, unknown>,
  ): Promise<unknown[]> {
    const messages = await this.listMessagesChronological(sessionId);
    const index = messages.findIndex((message) => message[key] === anchor);
    if (index < 0) throw new Error('Message not found');
    const radius = boundedAroundRadius(options.radius);
    return messages.slice(Math.max(0, index - radius), index + radius + 1);
  }

  private async listMessagesChronological(sessionId: string): Promise<Array<Record<string, unknown>>> {
    if (this.options.storage.listHistoryMessages) {
      const rows = await this.options.storage.listHistoryMessages(sessionId);
      return rows.map(historyMessageToRemote);
    }
    const events = await this.options.storage.listEvents(sessionId, 0, 1_000);
    return messagesFromEvents(events);
  }

  /** Persist the user's dismissal so an error tail does not return after a reconnect. */
  private async dismissError(controllerId: string, sessionId: string, clientId: string): Promise<{ dismissed: true }> {
    this.assertWrite(controllerId, sessionId);
    const messages = await this.listMessagesChronological(sessionId);
    const target = messages.find((message) => message.clientId === clientId);
    if (!target || target.role !== 'error') throw new Error('only an existing error message can be dismissed');
    await this.options.storage.appendEvent(sessionId, 'message_dismissed', { clientId });
    return { dismissed: true };
  }

  /** The headless host has no separate unread/interrupted UI state, but stores the acknowledgement for replay. */
  private async ackInterruptedTurn(controllerId: string, sessionId: string): Promise<{ acknowledged: true }> {
    this.assertWrite(controllerId, sessionId);
    await this.options.storage.appendEvent(sessionId, 'session_interrupted_acknowledged', {});
    return { acknowledged: true };
  }

  /** Headless has no Dock/desktop badge; retain the acknowledgement for clients and reconnects. */
  private async clearSessionAttention(controllerId: string, sessionId: string): Promise<{ cleared: true }> {
    this.assertWrite(controllerId, sessionId);
    if (!await this.options.storage.get(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
    await this.options.storage.appendEvent(sessionId, 'session_attention_cleared', {});
    return { cleared: true };
  }

  private async capabilities(agentKind: string): Promise<unknown> {
    if (agentKind !== 'claude-code' && agentKind !== 'codex') throw new Error('agentKind must be claude-code or codex');
    const models = await this.control('catalog.models', { agentKind }) as Array<Record<string, unknown>>;
    const deduped = new Map<string, Record<string, unknown>>();
    for (const model of models) if (typeof model.id === 'string' && !deduped.has(model.id)) deduped.set(model.id, model);
    const permissionModes = agentKind === 'codex'
      ? ['ask', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
      : ['ask', 'default', 'acceptEdits', 'auto'];
    return {
      availableModels: [...deduped.values()].map((model) => ({
        id: model.id,
        displayName: model.name ?? model.id,
        description: model.description,
        contextWindow: model.contextWindow,
        efforts: model.efforts ?? [],
        defaultEffort: model.defaultEffort ?? null,
        supportsFastMode: model.supportsFastMode === true,
        effortDisplayNames: {},
      })),
      effortLevels: Object.entries(EFFORT_LABELS).map(([id, displayName]) => ({ id, displayName })),
      permissionModes: permissionModes.map((id) => ({ id, displayName: id })),
      hasFastMode: true,
      // Headless has no Goal/plan-mode controller yet. Reporting true here
      // would make Mobile send a mutation the host cannot execute.
      planMode: { supported: false },
      supportsSessionAgentSwitch: false,
    };
  }

  /**
   * Headless persists the unified agent status stream, including Codex's
   * context snapshot and per-turn token totals.  Reconstruct a compact
   * session-level view from that durable stream so reopening the mobile app
   * (or restarting the daemon) does not make usage disappear.
   */
  private async sessionUsage(sessionId: string): Promise<{
    contextTokens?: number;
    contextWindow?: number;
    totalTokenUsage?: number;
  }> {
    let afterSequence = 0;
    let pageCount = 0;
    let contextTokens: number | undefined;
    let contextWindow: number | undefined;
    let totalTokenUsage = 0;
    let hasTokenUsage = false;

    // Events are paged by the storage contract.  The cap bounds a corrupted
    // or unexpectedly huge history while covering normal long-lived chats.
    while (pageCount++ < 32) {
      const events = await this.options.storage.listEvents(sessionId, afterSequence, 1_000);
      if (events.length === 0) break;
      for (const event of events) {
        afterSequence = event.sequence;
        if (event.type !== 'agent_event') continue;
        const agentEvent = record(event.data);
        const type = typeof agentEvent?.type === 'string' ? agentEvent.type : '';
        const data = record(agentEvent?.data);
        if (type === 'status') {
          const tokens = nonNegativeFiniteNumber(data?.contextTokens);
          const window = nonNegativeFiniteNumber(data?.contextWindow);
          // Initialising a resumed session emits zeroes before the upstream
          // sends its real snapshot.  Preserve the last usable snapshot.
          if (tokens !== undefined && window !== undefined && window > 0) {
            contextTokens = tokens;
            contextWindow = window;
          }
        }
        if (type === 'done') {
          const usage = record(data?.usage);
          const values = [
            usage?.promptTokens,
            usage?.completionTokens,
            usage?.reasoningTokens,
            usage?.cachedTokens,
          ];
          for (const value of values) {
            const tokens = nonNegativeFiniteNumber(value);
            if (tokens === undefined) continue;
            totalTokenUsage += tokens;
            hasTokenUsage = true;
          }
        }
      }
      if (events.length < 1_000) break;
    }
    return {
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(hasTokenUsage ? { totalTokenUsage } : {}),
    };
  }

  private async toRemoteSession(session: HeadlessSessionMeta): Promise<Record<string, unknown>> {
    const [usage, activity] = await Promise.all([
      this.sessionUsage(session.id),
      this.sessionActivity(session.id),
    ]);
    return { ...toRemoteSession(session, activity), ...usage };
  }

  /**
   * Desktop uses these existing session fields to distinguish an actual chat
   * from an untouched draft before it groups project sessions.  Headless owns
   * an equivalent durable history projection, so expose its visible rows
   * instead of advertising every remote session as an empty draft.
   */
  private async sessionActivity(sessionId: string): Promise<{ userSendAt: string | null; messageCount: number }> {
    const messages = this.options.storage.listHistoryMessages
      ? await this.options.storage.listHistoryMessages(sessionId)
      : messagesFromEvents(await this.options.storage.listEvents(sessionId, 0, 1_000));
    let lastUserSentAt: number | null = null;
    for (const message of messages) {
      if (message.role !== 'user') continue;
      const createdAt = message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.parse(String(message.createdAt));
      if (Number.isFinite(createdAt) && (lastUserSentAt === null || createdAt > lastUserSentAt)) {
        lastUserSentAt = createdAt;
      }
    }
    return {
      userSendAt: lastUserSentAt === null ? null : new Date(lastUserSentAt).toISOString(),
      messageCount: messages.length,
    };
  }

  private async contextUsage(sessionId: string): Promise<Record<string, unknown>> {
    const usage = await this.sessionUsage(sessionId);
    if (usage.contextTokens === undefined || usage.contextWindow === undefined) {
      return { totalTokens: 0, rawMaxTokens: 0, percentage: 0 };
    }
    return {
      totalTokens: usage.contextTokens,
      rawMaxTokens: usage.contextWindow,
      percentage: usage.contextWindow > 0 ? usage.contextTokens / usage.contextWindow : 0,
      ...(usage.totalTokenUsage === undefined ? {} : { totalTokenUsage: usage.totalTokenUsage }),
    };
  }

  private async control(method: string, params?: unknown): Promise<unknown> {
    const response = await this.options.control.handle({ id: `device-link:${method}`, method, params });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }

  private publish(channel: string, payload: unknown): void {
    const topic = topicForPush(channel, payload);
    if (!topic) return;
    for (const [deviceId, subscription] of this.subscriptions) {
      if (subscription.topics.has('*') || subscription.topics.has(topic)) {
        this.options.client.sendPush(deviceId, channel, payload);
      }
    }
  }
}

function error(code: 'CHANNEL_NOT_ALLOWED' | 'IPC_ERROR', message: string): InvokeResultPayload {
  return { ok: false, error: { code, message } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isTopic(value: unknown): value is Topic {
  return typeof value === 'string' && (value === 'sessions' || (value.startsWith('session:') && value.length > 'session:'.length));
}

function stringArg(args: unknown[], index: number, name: string): string {
  const value = args[index];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function messageArg(value: unknown): unknown {
  if (typeof value === 'string' && value.trim()) return value;
  const recordValue = record(value);
  if (typeof recordValue?.content === 'string' && recordValue.content.trim()) return recordValue.content;
  if (recordValue?.content !== undefined && recordValue.content !== null) return recordValue.content;
  throw new Error('message must be a non-empty string');
}

function filePathArg(value: unknown): string {
  if (typeof value === 'string') return value;
  const input = record(value);
  if (typeof input?.path === 'string') return input.path;
  if (typeof input?.filePath === 'string') return input.filePath;
  throw new Error('path must be a non-empty string');
}

function boundedMessageLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 80;
  return Math.max(1, Math.min(value, 1_000));
}

function boundedAroundRadius(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 40;
  return Math.max(1, Math.min(value, 200));
}

function agentKindArg(value: unknown): 'claude-code' | 'codex' {
  if (value === 'claude-code' || value === 'codex') return value;
  throw new Error('agentKind must be claude-code or codex');
}

function nullableProviderArg(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error('providerId must be a string or null');
}

function effortArg(value: unknown): string {
  if (typeof value === 'string' && ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) return value;
  throw new Error('effort is invalid');
}

function permissionArg(value: unknown): string {
  if (typeof value === 'string' && ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(value)) return value;
  throw new Error('permissionMode is invalid');
}

function booleanArg(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function numberArg(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function toRemoteSession(
  session: HeadlessSessionMeta,
  activity: { userSendAt: string | null; messageCount: number },
): Record<string, unknown> {
  // Headless runs dialogue sessions in the service account's home directory
  // when no project was selected. Older mobile clients require a non-empty
  // workingDir before sending, so mirror the actual runtime directory rather
  // than exposing an empty placeholder. This is derived from the environment,
  // never hard-coded, and project sessions keep their explicit directory.
  const workingDir = session.workDir || (session.workspaceKind === 'dialogue'
    ? process.env.HOME?.trim() || null
    : null);
  return {
    id: session.id,
    userId: 'headless',
    title: session.title,
    status: session.status ?? 'active',
    workingDir,
    workspaceKind: session.workspaceKind ?? 'project',
    extraDirs: session.extraDirs ?? [],
    model: session.model,
    providerId: session.providerId ?? null,
    effort: session.effort ?? '',
    permissionMode: session.permissionMode ?? 'ask',
    fastMode: session.fastMode === true,
    agentKind: session.agentKind === 'claude-code' ? 'cc' : 'codex',
    orcaRole: session.orcaRole ?? null,
    pinnedAt: session.pinnedAt == null ? null : new Date(session.pinnedAt).toISOString(),
    userSendAt: activity.userSendAt,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    _count: { messages: activity.messageCount },
  };
}

function messagesFromEvents(events: HeadlessSessionEvent[]): Array<Record<string, unknown>> {
  const dismissed = new Set<string>();
  for (const event of events) {
    if (event.type !== 'message_dismissed') continue;
    const clientId = record(event.data)?.clientId;
    if (typeof clientId === 'string' && clientId) dismissed.add(clientId);
  }
  return events
    .map(eventToMessage)
    .filter((event): event is Record<string, unknown> => !!event)
    .filter((event) => event.role !== 'error' || !dismissed.has(String(event.clientId ?? '')));
}

function eventToMessage(event: HeadlessSessionEvent): Record<string, unknown> | null {
  const base = {
    id: `headless-event-${event.sequence}`,
    clientId: `headless-event-${event.sequence}`,
    sessionId: event.sessionId,
    toolUseId: null,
    agentMeta: null,
    createdAt: new Date(event.createdAt).toISOString(),
  };
  if (event.type === 'user_message') {
    const data = record(event.data);
    const clientId = typeof data?.clientId === 'string' && data.clientId.trim()
      ? data.clientId
      : base.clientId;
    return { ...base, id: clientId, clientId, role: 'user', content: data?.content ?? '' };
  }
  if (event.type !== 'agent_event') return null;
  const agentEvent = record(event.data);
  const type = typeof agentEvent?.type === 'string' ? agentEvent.type : '';
  // Agent events are a live protocol, not a message schema.  In particular,
  // `status`, `done`, `session_id` and account usage are transport state.  If
  // persisted as a history row Mobile renders their raw JSON as a chat message.
  // Only retain event kinds that have a real message presentation.
  const role = type === 'text' ? 'assistant'
    : type === 'thinking' ? 'thinking'
      : type === 'tool_use' ? 'tool_use'
        : type === 'tool_result' || type === 'tool_result_full' ? 'tool_result'
          : type === 'error' ? 'error'
            : null;
  if (!role) return null;
  return {
    ...base,
    role,
    content: agentEventContent(type, agentEvent?.data),
    agentMeta: agentEvent?.agentMeta ?? null,
  };
}

function historyMessageToRemote(message: HeadlessHistoryMessage): Record<string, unknown> {
  return {
    id: message.id,
    clientId: message.clientId,
    sessionId: message.sessionId,
    role: message.role,
    content: message.content,
    agentMeta: message.agentMeta,
    toolUseId: null,
    createdAt: new Date(message.createdAt).toISOString(),
  };
}

function isFinalAgentText(value: unknown): boolean {
  const event = record(value);
  if (event?.type !== 'text') return false;
  const data = record(event.data);
  return typeof data?.text === 'string' && data.text.length > 0 && data.isFinal === true;
}

/** AgentEvent payloads and persisted message bodies have distinct shapes. */
function agentEventContent(type: string, data: unknown): unknown {
  if (type === 'text') {
    const text = record(data)?.text;
    return typeof text === 'string' ? text : '';
  }
  return data ?? null;
}

function emptyInputProjection(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function queuedTextArg(value: unknown): string {
  const queued = record(value);
  if (!queued) throw new Error('queued message must be an object');
  if (typeof queued.text === 'string' && queued.text.trim()) return queued.text;
  const message = record(queued.chatMessage);
  if (typeof message?.content === 'string' && message.content.trim()) return message.content;
  throw new Error('queued message text must be a non-empty string');
}

function sessionMatchesStatus(session: HeadlessSessionMeta, value: unknown): boolean {
  const status = session.status ?? 'active';
  if (value === 'archived') return status === 'archived';
  if (value === 'all') return status !== 'deleted';
  return status === 'active';
}

function toRemoteMetaPatch(value: unknown): Record<string, unknown> {
  const patch = record(value) ?? {};
  if (typeof patch.pinnedAt !== 'number') return patch;
  return { ...patch, pinnedAt: new Date(patch.pinnedAt).toISOString() };
}
