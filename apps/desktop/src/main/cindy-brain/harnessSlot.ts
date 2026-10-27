import { randomUUID } from 'node:crypto';
import { GHOST_HARNESS_CAPABILITIES } from '@cindy/plugin-protocol';
import type { AgentEvent, HarnessHookRequest, HarnessHookResult, Session } from '@cindy/maker-core';
import type {
  GhostHarnessHistoryPage,
  GhostHarnessMetadata,
  GhostPipeHarnessEvent,
} from '@cindy/plugin-protocol';
import { projectHarnessContent } from './harnessContent.js';
import {
  ghostInstallApprovalToken,
  hasGhostHarnessPermission,
  GHOST_HOOK_FUSE_THRESHOLD,
  type GhostPipeEventPush,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import {
  ghostActivityId,
  normalizeTurnUsage,
  type GhostSubscriptionGateway,
} from './subscriptionGateway.js';
import { isGhostOwnerScopeUsable, type GhostOwnerScope } from './ghostOwnerScope.js';

const HOOK_TIMEOUT_MS = 1500;
const CONTINUE: HarnessHookResult = { action: 'continue' };
const EVENT_DESCRIPTORS: Partial<
  Record<
    AgentEvent['type'],
    readonly [GhostPipeHarnessEvent['topic'], GhostPipeHarnessEvent['name']]
  >
> = {
  tool_use: ['tool', 'tool.started'],
  tool_result_full: ['tool', 'tool.completed'],
  compact_boundary: ['compaction', 'compaction.boundary'],
  agent_task_update: ['task', 'task.updated'],
  status: ['status', 'status.updated'],
  done: ['usage', 'usage.updated'],
  text: ['message', 'message.updated'],
};

interface Binding {
  session: Session;
  runtimeId: string;
  nativeIdentity: string;
  current(): boolean;
  eligibility: Promise<boolean> | null;
  eligibilityState: 'unknown' | 'eligible' | 'ineligible';
  buffered: Array<Omit<GhostPipeHarnessEvent, 'seq' | 'ts'>>;
  dropped: number;
  hooks: Map<string, boolean>;
  actions: Map<string, { name: string; generation: number; result: Promise<unknown> }>;
  lastUsage: Record<string, number>;
}

interface PendingHook {
  ghostId: string;
  deadline: number;
  current(): boolean;
  settle(result: HarnessHookResult | null): void;
}

export interface GhostHarnessSlotDeps {
  listGhosts(): InstalledGhost[];
  ownerScope: GhostOwnerScope;
  eligible(sessionId: string): Promise<'eligible' | 'ineligible' | 'retry'>;
  isRunning(ghostId: string): boolean;
  captureSource(ghostId: string): () => boolean;
  allowed(ghostId: string, session: Session): boolean;
  send(ghostId: string, payload: GhostPipeEventPush): boolean;
  gateway(): Pick<GhostSubscriptionGateway, 'publishHarness'>;
  redactToolInput(toolName: string, input: unknown): unknown;
  readHistory?(
    sessionId: string,
    name: 'messages' | 'tool-content',
    runtimeId: string,
    limit: number,
    cursor?: string,
  ): Promise<GhostHarnessHistoryPage>;
}

/** Main owns identity/approval; Session and its adapters own native execution. No second agent loop. */
export class GhostHarnessSlot {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Map<string, PendingHook>();
  private readonly failures = new Map<string, { revision: string; count: number }>();

  constructor(private readonly deps: GhostHarnessSlotDeps) {}

  bind(session: Session, isCurrent: () => boolean): () => void {
    // This bridge covers local execution only; remote sessions use separate authority.
    if (session.remoteHostId || session.agentDeviceId) return () => {};
    const owner = this.deps.ownerScope.capture();
    const binding: Binding = {
      session,
      runtimeId: randomUUID(),
      nativeIdentity: this.nativeIdentity(session),
      eligibility: null,
      eligibilityState: 'unknown',
      buffered: [],
      dropped: 0,
      hooks: new Map(),
      actions: new Map(),
      lastUsage: {},
      // Native terminal signals can arrive before abort acknowledgement.
      // Requests and Hook decisions still require active status below.
      current: () =>
        this.bindings.get(session.id) === binding &&
        isCurrent() &&
        (session.getStatus() === 'active' || session.getStatus() === 'aborting') &&
        isGhostOwnerScopeUsable(this.deps.ownerScope, owner),
    };
    this.bindings.set(session.id, binding);
    const unhook = session.setHarnessHookHandler((request) => this.screen(binding, request));
    const unsubscribe = session.onEvent((event) => this.observe(binding, event));
    return () => {
      if (this.bindings.get(session.id) === binding) this.bindings.delete(session.id);
      unhook();
      unsubscribe();
      binding.buffered.length = 0;
      // Release waits immediately; a late verdict cannot affect a replacement runtime.
      for (const hook of this.pending.values()) if (!hook.current()) hook.settle(null);
    };
  }

  private nativeIdentity(session: Session): string {
    return JSON.stringify([
      session.requestSessionId,
      session.model,
      session.permissionModeState.generation,
      session.getHarnessRevision(),
    ]);
  }

  private sync(binding: Binding): void {
    const identity = this.nativeIdentity(binding.session);
    if (binding.nativeIdentity !== identity) {
      binding.nativeIdentity = identity;
      binding.runtimeId = randomUUID();
      binding.hooks.clear();
      binding.actions.clear();
      binding.lastUsage = {};
    }
  }

  private metadata(binding: Binding): GhostHarnessMetadata {
    this.sync(binding);
    return {
      revision: 1,
      sessionId: binding.session.id,
      runtimeId: binding.runtimeId,
      turnGeneration: binding.session.getTurnGeneration(),
      agent: binding.session.agentKind,
    };
  }

  private eligibility(binding: Binding): Promise<boolean> {
    if (binding.eligibilityState !== 'unknown')
      return Promise.resolve(binding.eligibilityState === 'eligible');
    if (!binding.eligibility) {
      binding.eligibility = this.deps
        .eligible(binding.session.id)
        .then((outcome) => {
          if (!binding.current()) return false;
          binding.eligibilityState = outcome === 'retry' ? 'unknown' : outcome;
          if (binding.eligibilityState === 'eligible') {
            for (const queued of binding.buffered.splice(0)) this.publish(binding, queued);
          } else if (binding.eligibilityState === 'ineligible') binding.buffered.length = 0;
          return binding.eligibilityState === 'eligible';
        })
        .catch(() => false)
        .finally(() => {
          binding.eligibility = null;
        });
    }
    return binding.eligibility;
  }

  private pluginCurrent(
    ghost: InstalledGhost,
    group: 'read' | 'events' | 'hooks' | 'actions',
    name: string,
  ): boolean {
    const id = installedGhostStoragePart(ghost);
    const current = this.deps.listGhosts().find((item) => installedGhostStoragePart(item) === id);
    return (
      !!current &&
      ghostInstallApprovalToken(current.approval) === ghostInstallApprovalToken(ghost.approval) &&
      hasGhostHarnessPermission(current, group, name)
    );
  }

  async handleRequest(
    ghostId: string,
    payload: unknown,
    sourceCurrent: () => boolean,
  ): Promise<unknown> {
    if (!payload || typeof payload !== 'object') return { ok: false, errorCode: 'INVALID_PARAMS' };
    const p = payload as Record<string, unknown>;
    if (
      !['read', 'action', 'hook'].includes(p.kind as string) ||
      typeof p.name !== 'string' ||
      typeof p.sessionId !== 'string' ||
      p.sessionId.length === 0 ||
      p.sessionId.length > 128
    )
      return { ok: false, errorCode: 'UNSUPPORTED' };
    const group = p.kind === 'action' ? 'actions' : p.kind === 'hook' ? 'hooks' : 'read';
    if (!(GHOST_HARNESS_CAPABILITIES[group] as readonly string[]).includes(p.name))
      return { ok: false, errorCode: 'UNSUPPORTED' };
    if (p.kind !== 'read' && (typeof p.runtimeId !== 'string' || p.runtimeId.length > 128))
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    if (
      p.kind === 'action' &&
      (typeof p.requestId !== 'string' ||
        !p.requestId ||
        p.requestId.length > 128 ||
        !Number.isSafeInteger(p.turnGeneration) ||
        (p.turnGeneration as number) < 0)
    )
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    if (p.kind === 'hook' && typeof p.enabled !== 'boolean')
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    if (
      p.kind === 'read' &&
      ((p.limit !== undefined &&
        (!Number.isSafeInteger(p.limit) || (p.limit as number) < 1 || (p.limit as number) > 50)) ||
        (p.cursor !== undefined && (typeof p.cursor !== 'string' || p.cursor.length > 4096)))
    )
      return { ok: false, errorCode: 'INVALID_PARAMS' };
    const ghost = this.deps
      .listGhosts()
      .find((item) => installedGhostStoragePart(item) === ghostId);
    if (!ghost || !hasGhostHarnessPermission(ghost, group, p.name))
      return { ok: false, errorCode: 'DENIED' };
    const binding = this.bindings.get(p.sessionId);
    if (!binding?.current() || binding.session.getStatus() !== 'active')
      return { ok: false, errorCode: 'SESSION_UNAVAILABLE' };
    this.sync(binding);
    const runtimeId = binding.runtimeId;
    const current = () => {
      this.sync(binding);
      return (
        sourceCurrent() &&
        binding.current() &&
        binding.session.getStatus() === 'active' &&
        binding.runtimeId === runtimeId &&
        this.deps.allowed(ghostId, binding.session) &&
        this.pluginCurrent(ghost, group, p.name as string)
      );
    };
    if (p.runtimeId !== undefined && p.runtimeId !== runtimeId)
      return { ok: false, errorCode: 'STALE_RUNTIME' };
    if (!current()) return { ok: false, errorCode: 'DENIED' };
    if (!(await this.eligibility(binding)) || !current()) return { ok: false, errorCode: 'DENIED' };
    const session = binding.session;
    const envelope = this.metadata(binding);
    if (p.kind === 'hook') {
      const hook = session.getHarnessCapabilities().hooks.find((item) => item.name === p.name);
      if (p.enabled && (!hook || hook.connected === false))
        return { ok: false, errorCode: 'UNAVAILABLE' };
      binding.hooks.set(`${ghostId}:${p.name}`, p.enabled as boolean);
      if (!p.enabled) {
        for (const hook of this.pending.values()) if (!hook.current()) hook.settle(null);
      }
      return { ok: true, ...envelope, value: { enabled: p.enabled } };
    }
    if (p.kind === 'action') {
      if (session.getTurnGeneration() !== p.turnGeneration)
        return { ok: false, errorCode: 'STALE_RUNTIME' };
      if ([...this.pending.values()].some((hook) => hook.ghostId === ghostId))
        return { ok: false, errorCode: 'BUSY' };
      for (const [id, old] of binding.actions)
        if (old.generation !== p.turnGeneration) binding.actions.delete(id);
      const key = JSON.stringify([ghostId, ghostInstallApprovalToken(ghost.approval), p.requestId]);
      let operation = binding.actions.get(key);
      if (operation && (operation.name !== p.name || operation.generation !== p.turnGeneration))
        return { ok: false, errorCode: 'INVALID_PARAMS' };
      if (!operation) {
        if (binding.actions.size >= 128) return { ok: false, errorCode: 'BUSY' };
        const result = session
          .runHarnessAction(
            p.name as 'context.compact' | 'turn.interrupt',
            p.turnGeneration as number,
          )
          .catch(() => ({ ok: false, errorCode: 'UNAVAILABLE', outcome: 'unknown' }));
        operation = { name: p.name, generation: p.turnGeneration as number, result };
        binding.actions.set(key, operation);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          operation.result,
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ ok: false, errorCode: 'TIMEOUT', outcome: 'unknown' }),
              10_000,
            );
          }),
        ]);
        if (!current()) return { ok: false, errorCode: 'STALE_RUNTIME', outcome: 'unknown' };
        return { ...envelope, ...(result as object) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (p.name === 'runtime') {
      const catalog = session.getHarnessCapabilities();
      const failure = this.failures.get(ghostId);
      const fused =
        failure?.revision === ghostInstallApprovalToken(ghost.approval) &&
        failure.count >= GHOST_HOOK_FUSE_THRESHOLD;
      return {
        ok: true,
        ...envelope,
        value: {
          ...catalog,
          read: [
            ...new Set([
              ...catalog.read,
              ...(this.deps.readHistory ? ['messages', 'tool-content'] : []),
            ]),
          ],
          capabilityStates: Object.entries(GHOST_HARNESS_CAPABILITIES).flatMap(([group, names]) =>
            names.map((name) => {
              const kind = group as keyof typeof GHOST_HARNESS_CAPABILITIES;
              const connected =
                kind === 'read' && ['messages', 'tool-content'].includes(name)
                  ? !!this.deps.readHistory
                  : kind === 'hooks'
                    ? catalog.hooks.some((hook) => hook.name === name && hook.connected !== false)
                    : (catalog[kind] as readonly string[]).includes(name);
              return {
                group,
                name,
                connected,
                declared: ghost.manifest.harness?.[kind]?.includes(name) === true,
                approved: hasGhostHarnessPermission(ghost, kind, name),
              };
            }),
          ),
          hookSubscriptions: catalog.hooks.map((hook) => ({
            name: hook.name,
            state:
              hook.connected === false
                ? 'not-ready'
                : !ghost.manifest.harness?.hooks?.includes(hook.name)
                  ? 'not-declared'
                  : !hasGhostHarnessPermission(ghost, 'hooks', hook.name)
                    ? 'denied'
                    : fused
                      ? 'fused'
                      : binding.hooks.get(`${ghostId}:${hook.name}`) === false
                        ? 'disabled'
                        : !this.deps.isRunning(ghostId) || !this.deps.captureSource(ghostId)()
                          ? 'not-running'
                          : 'ready',
          })),
        },
      };
    }
    if (p.name === 'usage')
      return {
        ok: true,
        ...envelope,
        value: {
          ...binding.lastUsage,
          ...projectNumbers(session.getUsageSnapshot(), [
            'tokenUsage',
            'contextTokens',
            'contextWindow',
            'costUsd',
            'outputTokens',
          ]),
        },
      };
    if (p.name === 'status')
      return { ok: true, ...envelope, value: { running: session.isTurnRunning() } };
    if (p.name === 'messages' || p.name === 'tool-content') {
      if (!this.deps.readHistory) return { ok: false, errorCode: 'UNAVAILABLE' };
      try {
        const value = await this.deps.readHistory(
          session.id,
          p.name,
          runtimeId,
          (p.limit as number | undefined) ?? 25,
          p.cursor as string | undefined,
        );
        if (!current()) return { ok: false, errorCode: 'STALE_RUNTIME' };
        return { ok: true, ...envelope, value };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        return {
          ok: false,
          errorCode: ['STALE_RUNTIME', 'INVALID_PARAMS'].includes(code ?? '')
            ? code
            : 'UNAVAILABLE',
        };
      }
    }
    return { ok: false, errorCode: 'UNSUPPORTED' };
  }

  private observe(binding: Binding, event: AgentEvent): void {
    const raw =
      event.data && typeof event.data === 'object' ? (event.data as Record<string, unknown>) : {};
    if (
      binding.eligibilityState === 'ineligible' ||
      !binding.current() ||
      (event.sessionTurnGeneration !== undefined &&
        event.sessionTurnGeneration !== binding.session.getTurnGeneration()) ||
      // Pi marks idle manual compaction as background work within this task.
      (event.turnScope === 'background' && !(event.type === 'compact_boundary' && raw.trigger === 'manual')) ||
      event.runtimeRecovery ||
      (event.turnOrigin?.kind && event.turnOrigin.kind !== 'user') ||
      event.turnOrigin?.surface === 'im'
    )
      return;
    if (event.type === 'done') {
      binding.lastUsage = projectNumbers(normalizeTurnUsage(raw.usage) ?? {}, [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheCreationTokens',
      ]);
    }
    const descriptor = EVENT_DESCRIPTORS[event.type];
    if (!descriptor) return;
    const [topic, name] = descriptor;
    const interested = this.deps
      .listGhosts()
      .some(
        (ghost) =>
          this.deps.allowed(installedGhostStoragePart(ghost), binding.session) &&
          hasGhostHarnessPermission(ghost, 'events', topic),
      );
    if (!interested) return;
    const data = this.metadata(binding);
    switch (event.type) {
      case 'tool_use':
      case 'tool_result_full':
        // Summary-only tool_result frames can cover multiple calls; never fabricate a completion id.
        if (typeof raw.toolUseId !== 'string') return;
        data.toolId = ghostActivityId(binding.runtimeId, raw.toolUseId);
        if (typeof raw.toolName === 'string') data.toolName = raw.toolName.slice(0, 128);
        if (typeof raw.isError === 'boolean') data.isError = raw.isError;
        data.role = event.type === 'tool_use' ? 'tool_use' : 'tool_result';
        Object.assign(
          data,
          projectHarnessContent(data.role, event.type === 'tool_use' ? {
            toolName: raw.toolName,
            input: this.deps.redactToolInput(
              typeof raw.toolName === 'string' ? raw.toolName : '', raw.input,
            ),
          } : raw.fullText),
        );
        break;
      case 'text':
        data.role = 'assistant';
        Object.assign(data, projectHarnessContent('assistant', raw.text));
        if (typeof raw.isFullText === 'boolean') data.isFullText = raw.isFullText;
        if (typeof raw.isFinal === 'boolean') data.isFinal = raw.isFinal;
        break;
      case 'compact_boundary':
        break;
      case 'agent_task_update':
        if (typeof raw.taskId !== 'string') return;
        data.taskId = ghostActivityId(binding.runtimeId, raw.taskId);
        if (['running', 'completed', 'failed', 'stopped'].includes(raw.status as string)) {
          data.taskStatus = raw.status as GhostHarnessMetadata['taskStatus'];
        }
        break;
      case 'status':
        data.status = (typeof raw.isRunning === 'boolean' ? raw.isRunning : binding.session.isTurnRunning())
          ? 'running' : 'idle';
        break;
      case 'done':
        break;
      default:
        return;
    }
    if (event.type === 'done') {
      data.usage = projectNumbers(binding.session.getUsageSnapshot(), [
        'tokenUsage',
        'contextTokens',
        'contextWindow',
        'costUsd',
        'outputTokens',
      ]);
      Object.assign(
        data.usage,
        projectNumbers(normalizeTurnUsage(raw.usage) ?? {}, [
          'inputTokens',
          'outputTokens',
          'cacheReadTokens',
          'cacheCreationTokens',
        ]),
      );
    } else if (event.type === 'compact_boundary') {
      data.usage = projectNumbers(raw, ['preTokens', 'postTokens', 'durationMs']);
    }
    const envelope = { type: 'harness-event' as const, name, topic, data };
    if (binding.eligibilityState === 'eligible') {
      this.publish(binding, envelope);
      return;
    }
    // One DB lookup and a bounded prefix queue. Promise completion cannot reorder tool pairs.
    if (binding.buffered.length >= 32) {
      binding.buffered.shift();
      binding.dropped += 1;
    }
    binding.buffered.push(envelope);
    if (binding.eligibility) return;
    void this.eligibility(binding);
  }

  private publish(binding: Binding, event: Omit<GhostPipeHarnessEvent, 'seq' | 'ts'>): void {
    const runtimeId = event.data.runtimeId;
    const current = () => {
      this.sync(binding);
      return binding.current() && binding.runtimeId === runtimeId;
    };
    if (binding.dropped) {
      event.dropped = binding.dropped;
      binding.dropped = 0;
    }
    this.deps
      .gateway()
      .publishHarness(event, current, (ghost) =>
        this.deps.allowed(installedGhostStoragePart(ghost), binding.session),
      );
  }

  private async screen(binding: Binding, request: HarnessHookRequest): Promise<HarnessHookResult> {
    this.sync(binding);
    const ghosts = this.deps
      .listGhosts()
      .filter(
        (ghost) =>
          hasGhostHarnessPermission(ghost, 'hooks', request.name) &&
          binding.hooks.get(`${installedGhostStoragePart(ghost)}:${request.name}`) !== false &&
          this.deps.allowed(installedGhostStoragePart(ghost), binding.session),
      )
      .sort((a, b) =>
        installedGhostStoragePart(a).localeCompare(installedGhostStoragePart(b), 'en'),
      );
    if (!ghosts.length || !binding.current() || binding.session.getStatus() !== 'active') return CONTINUE;
    const data = this.metadata(binding);
    if (request.toolName) data.toolName = request.toolName.slice(0, 128);
    if (request.toolUseId) data.toolId = ghostActivityId(data.runtimeId, request.toolUseId);
    const deadline = Date.now() + HOOK_TIMEOUT_MS; // One bounded budget across all plugins.
    const generation = data.turnGeneration;
    let eligibilityTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const eligible = await Promise.race([
        this.eligibility(binding),
        new Promise<boolean>((resolve) => {
          eligibilityTimer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (!eligible) return CONTINUE;
    } finally {
      if (eligibilityTimer) clearTimeout(eligibilityTimer);
    }
    for (const ghost of ghosts) {
      const ghostId = installedGhostStoragePart(ghost);
      const revision = ghostInstallApprovalToken(ghost.approval);
      const failure = this.failures.get(ghostId);
      if (failure?.revision === revision && failure.count >= GHOST_HOOK_FUSE_THRESHOLD) continue;
      if (!this.deps.isRunning(ghostId) || !this.pluginCurrent(ghost, 'hooks', request.name))
        continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const sourceCurrent = this.deps.captureSource(ghostId);
      const current = () => {
        this.sync(binding);
        return (
          sourceCurrent() &&
          this.deps.allowed(ghostId, binding.session) &&
          binding.current() &&
          binding.session.getStatus() === 'active' &&
          binding.runtimeId === data.runtimeId &&
          binding.session.getTurnGeneration() === generation &&
          binding.hooks.get(`${ghostId}:${request.name}`) !== false &&
          this.pluginCurrent(ghost, 'hooks', request.name)
        );
      };
      if (!current()) continue;
      const hookId = randomUUID();
      const result = await new Promise<HarnessHookResult | null>((resolve) => {
        const timer = setTimeout(() => settle(null), remaining);
        const settle = (value: HarnessHookResult | null) => {
          if (!this.pending.delete(hookId)) return;
          clearTimeout(timer);
          resolve(value);
        };
        this.pending.set(hookId, { ghostId, deadline, current, settle });
        try {
          if (
            !this.deps.send(ghostId, {
              type: 'harness-hook',
              hookId,
              name: request.name,
              deadline,
              data:
                request.input !== undefined &&
                hasGhostHarnessPermission(ghost, 'read', 'tool-content')
                  ? {
                      ...data,
                      ...projectHarnessContent('tool_use', {
                        toolName: request.toolName,
                        input: this.deps.redactToolInput(request.toolName ?? '', request.input),
                      }),
                    }
                  : data,
            })
          )
            settle(null);
        } catch {
          settle(null);
        }
      });
      if (!current()) continue;
      if (!result) {
        this.failures.set(ghostId, {
          revision,
          count: failure?.revision === revision ? failure.count + 1 : 1,
        });
        continue; // Native/Cindy policy is still authoritative, including all denies.
      }
      this.failures.delete(ghostId);
      if (result.action === 'block')
        return {
          action: 'block',
          // Native denials can enter model context. Keep plugin-controlled text out.
          reason: 'Blocked by a Cindy plugin.',
        };
    }
    return CONTINUE;
  }

  handleVerdict(ghostId: string, value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const p = value as Record<string, unknown>;
    if (typeof p.hookId !== 'string' || (p.action !== 'continue' && p.action !== 'block')) return;
    const pending = this.pending.get(p.hookId);
    if (!pending || pending.ghostId !== ghostId) return;
    // A busy Main can delay the timer callback; elapsed deadlines still reject replies.
    pending.settle(
      Date.now() < pending.deadline && pending.current() ? { action: p.action } : null,
    );
  }

  dropGhost(ghostId: string): void {
    for (const hook of this.pending.values()) if (hook.ghostId === ghostId) hook.settle(null);
    this.failures.delete(ghostId);
    for (const binding of this.bindings.values()) {
      for (const key of binding.hooks.keys())
        if (key.startsWith(`${ghostId}:`)) binding.hooks.delete(key);
    }
  }

  clear(): void {
    for (const hook of this.pending.values()) hook.settle(null);
    this.failures.clear();
    for (const binding of this.bindings.values()) binding.buffered.length = 0;
  }
}

function projectNumbers(value: object, keys: readonly string[]): Record<string, number> {
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.flatMap((key) =>
      typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0
        ? [[key, raw[key]]]
        : [],
    ),
  );
}
