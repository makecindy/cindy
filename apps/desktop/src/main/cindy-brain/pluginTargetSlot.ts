import { createHash, randomUUID } from 'node:crypto';
import type {
  PluginTargetCandidate,
  PluginTargetDelivery,
  PluginTargetKind,
  PluginTargetRef,
  PluginTargetRequest,
  PluginTargetView,
} from '../../shared/pluginTargets.js';
import { isPluginTaskPermissionMode, type PluginTaskPermissionMode, type PluginTaskRoute } from '../../shared/pluginTasks.js';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';
import { pluginMessageText, validPluginMessageContext } from '../../shared/pluginMessage.js';
import { getActiveDataOwnerPushStamp, activeOwnerScopeKey } from '../appSessionState.js';
import { withParsedPluginMessageAttachments, type PluginMessageImage } from '../cindy-media/pluginMessageAttachments.js';

export interface PluginTargetTerminal {
  instanceId: string;
  generation: number;
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  outputMessageId?: string;
}
export interface PluginTargetReceipt {
  terminal?: PluginTargetTerminal;
  id: string;
  pluginId: string;
  requestKey: string;
  hash: string | null;
  taskId?: string;
  target?: PluginTargetRef;
  topicKey?: string;
  approvalRevision?: string;
  delegation?: { version: 1; task: string };
  status: 'pending' | 'accepted' | 'cancelled';
  delivery?: PluginTargetDelivery;
  invocationId?: string;
}
export interface PluginTargetStore {
  get(pluginId: string, requestKey: string): Promise<PluginTargetReceipt | undefined>;
  getById(id: string): Promise<PluginTargetReceipt | undefined>;
  reserve(receipt: PluginTargetReceipt): Promise<boolean>;
  cancel(pluginId: string, requestKey: string): Promise<PluginTargetReceipt>;
  accept(id: string, delivery: PluginTargetDelivery): Promise<void>;
}
export interface PluginTargetAdapter {
  store(): PluginTargetStore;
  approvalRevision(pluginId: string): string | null;
  delegationRevision?(pluginId: string): string | null;
  /** Set only after the live Auto review resolver is installed. */
  delegationReviewAvailable?(): boolean;
  candidates(kind: PluginTargetKind): Promise<PluginTargetCandidate[]>;
  assertCreatePermission(pluginId: string, permissionMode: PluginTaskPermissionMode): void;
  assertProjectDispatch(pluginId: string, taskId: string): Promise<void>;
  create(
    pluginId: string,
    project: string,
    taskId: string,
    title: string,
    route: PluginTaskRoute | undefined,
    guard: () => void,
    autoTitle?: boolean,
    permissionMode?: PluginTaskPermissionMode,
  ): Promise<void>;
  session(kind: 'task' | 'bot', id: string): Promise<string>;
  /** No creation during queue validation. The Host, not the plugin, owns the lane route. */
  resolveTopic?(pluginId: string, botId: string, topicKey: string,
    options: { create: boolean; title?: string; assertCurrent: () => void }): Promise<string>;
  send(
    pluginId: string,
    taskId: string,
    clientId: string,
    text: string,
    guard: () => void,
    validateTarget: () => Promise<void>,
    delivery: PluginTargetDelivery,
    images?: PluginMessageImage[],
    options?: { context?: string },
  ): Promise<PluginTargetDelivery>;
  withdraw(taskId: string, clientId: string, guard: () => void): Promise<void>;
  deliverySettled?(taskId: string, clientId: string, guard: () => void): Promise<boolean>;
  prepareInvocation?(pluginId: string, id: string, parentId?: string, operation?: string, sessionId?: string): string;
  acceptInvocation?(pluginId: string, id: string): void;
  scheduleAutoTitle?(pluginId: string, taskId: string, text: string, placeholderText: string): void;
}
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const keyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
const topicString = (value: unknown): value is string => keyString(value) && !!value.trim();
const validTaskScope = (task: unknown): task is string =>
  typeof task === 'string' && !!task.trim() && task.length <= 8000 && !task.includes('\0');
const kinds = ['project', 'task', 'bot'];
const isTarget = (value: unknown): value is PluginTargetRef => {
  const target = value as PluginTargetRef | null;
  return !!target && kinds.includes(target.kind) && typeof target.id === 'string' &&
    target.id.length > 0 && target.id.length <= 4096 && !target.id.includes('\0');
};
/** UI and fixed target configuration belong to plugins; the Host validates and delivers. */
export class PluginTargetSlot {
  adapter: PluginTargetAdapter | null = null;
  private inFlight = new Map<string, { hash: string; cancelled: boolean; result?: Promise<unknown> }>();
  supportsDelegationExecution(): boolean {
    return this.adapter?.delegationReviewAvailable?.() === true;
  }
  /** Used by the existing queue acceptance boundary, including restored snapshots. */
  async assertQueuedDelivery(taskId: string, clientId: string): Promise<void> {
    await this.assertTargetReceipt(taskId, clientId, 'dispatch');
  }
  private async assertTargetReceipt(taskId: string, clientId: string, phase: 'create' | 'dispatch'): Promise<void> {
    if (!this.adapter) fail('HOST_NOT_READY');
    const adapter = this.adapter!;
    const store = adapter.store();
    const receipt = await store.getById(clientId);
    const assertReceipt = (current: PluginTargetReceipt | undefined) => {
      if (!receipt?.target || !current || current.status === 'cancelled' || current.taskId !== taskId ||
        current.hash !== receipt.hash || !current.approvalRevision ||
        adapter.approvalRevision(current.pluginId) !== current.approvalRevision ||
        (current.delegation && (current.delegation.version !== 1 || !validTaskScope(current.delegation.task) || current.target?.kind !== 'bot' ||
          !this.supportsDelegationExecution() || adapter.delegationRevision?.(current.pluginId) !== current.approvalRevision))) fail('PERMISSION_DENIED');
    };
    assertReceipt(receipt);
    const target = receipt!.target!;
    if (!(await adapter.candidates(target.kind)).some(item => item.id === target.id)) fail('TARGET_UNAVAILABLE');
    if (receipt!.topicKey !== undefined) {
      if (target.kind !== 'bot' || !topicString(receipt!.topicKey) || !adapter.resolveTopic) fail('PERMISSION_DENIED');
      const topicSession = await adapter.resolveTopic!(receipt!.pluginId, target.id, receipt!.topicKey!, {
        create: false, assertCurrent: () => {
          if (adapter.approvalRevision(receipt!.pluginId) !== receipt!.approvalRevision) fail('PERMISSION_DENIED');
        },
      });
      if (topicSession !== taskId) fail('TARGET_UNAVAILABLE');
    } else if (target.kind !== 'project' && await adapter.session(target.kind, target.id) !== taskId) fail('TARGET_UNAVAILABLE');
    if (target.kind === 'project' && phase === 'dispatch')
      await adapter.assertProjectDispatch(receipt!.pluginId, taskId);
    assertReceipt(await store.getById(clientId));
  }
  async handle(pluginId: string, raw: unknown, authorized: () => void): Promise<unknown> {
    authorized();
    if (!this.adapter) return fail('HOST_NOT_READY');
    const adapter = this.adapter;
    const request = raw as PluginTargetRequest;
    if (!request || !['capabilities', 'list', 'resolve', 'send', 'get', 'cancel'].includes(request.kind))
      return fail('INVALID_PARAMS');
    if (request.kind === 'capabilities') return { companionTopics: !!adapter.resolveTopic,
      delegation: { version: 1, execution: this.supportsDelegationExecution(), targetKinds: ['bot'], delivery: ['queue'], receiptQuery: true, settled: true } };
    const resolve = async (target: PluginTargetRef): Promise<PluginTargetView> => {
      const candidates = await adapter.candidates(target.kind);
      authorized();
      const found = candidates.find((item) => item.id === target.id);
      if (!found) return fail('TARGET_UNAVAILABLE');
      return { kind: target.kind, id: found.id, label: found.label, detail: found.detail };
    };
    if (request.kind === 'list') {
      if (!kinds.includes(request.targetKind)) return fail('INVALID_PARAMS');
      const candidates = await adapter.candidates(request.targetKind);
      authorized();
      return { targets: candidates.map((item) => ({ ...item, kind: request.targetKind })) };
    }
    if (request.kind === 'resolve') {
      if (!isTarget(request.target)) return fail('INVALID_PARAMS');
      return resolve(request.target);
    }
    if (!keyString(request.requestKey)) return fail('INVALID_PARAMS');
    const store = adapter.store();
    const runtimeKey = JSON.stringify([
      activeOwnerScopeKey(), getActiveDataOwnerPushStamp().ownerGeneration, pluginId, request.requestKey,
    ]);
    if (request.kind === 'get') {
      const receipt = await store.get(pluginId, request.requestKey);
      authorized();
      if (!receipt) return { found: false };
      const settled = !!receipt.terminal || (receipt.status === 'cancelled' && !this.inFlight.has(runtimeKey) &&
        (!receipt.taskId || await adapter.deliverySettled?.(receipt.taskId, receipt.id, authorized) === true));
      authorized();
      return { found: true, executionId: receipt.id, requestKey: receipt.requestKey,
        target: receipt.target, taskId: receipt.taskId, status: receipt.status,
        ...(receipt.topicKey !== undefined ? { topicKey: receipt.topicKey } : {}),
        delivery: receipt.delivery, settled, ...(receipt.terminal ? { result: receipt.terminal } : {}) };
    }
    if (request.kind === 'cancel') {
      const pending = this.inFlight.get(runtimeKey);
      if (pending) pending.cancelled = true;
      const receipt = await store.cancel(pluginId, request.requestKey);
      authorized();
      if (receipt.taskId) {
        // Withdraw only this plugin input. Never stop another user's running turn.
        await adapter.withdraw(receipt.taskId, receipt.id, authorized);
        authorized();
      }
      const settled = !pending && (!receipt.taskId ||
        await adapter.deliverySettled?.(receipt.taskId, receipt.id, authorized) === true);
      authorized();
      return { cancelled: true, runningWorkMayHaveStarted: !!receipt.taskId,
        ...(settled ? { settled: true, requestKey: receipt.requestKey, clientId: receipt.id } : {}) };
    }
    if (
      !isTarget(request.target) ||
      typeof request.text !== 'string' || !request.text.trim() || request.text.length > 64000 ||
      !validPluginMessageContext(request.text, request.context) ||
      (request.topicKey !== undefined && (request.target.kind !== 'bot' || !topicString(request.topicKey))) ||
      (request.autoTitle !== undefined && typeof request.autoTitle !== 'boolean') ||
      (request.autoTitle === true && (request.target.kind !== 'project' || request.title !== undefined)) ||
      (request.permissionMode !== undefined &&
        (request.target.kind !== 'project' || !isPluginTaskPermissionMode(request.permissionMode))) ||
      (request.delivery !== undefined && !['queue', 'steer'].includes(request.delivery)) ||
      (request.invocationId !== undefined && !keyString(request.invocationId)) ||
      (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 200))
    ) return fail('INVALID_PARAMS');
    const target = request.target;
    const topicKey = request.topicKey;
    if (topicKey !== undefined && !adapter.resolveTopic) return fail('UNSUPPORTED_CAPABILITY');
    const delivery = request.delivery ?? 'queue';
    const delegation = request.delegation;
    if (delegation !== undefined) {
      if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation) ||
          Object.keys(delegation).some(key => key !== 'task') || !validTaskScope(delegation.task) ||
          target.kind !== 'bot' || delivery !== 'queue') return fail('INVALID_PARAMS');
      if (adapter.delegationReviewAvailable?.() !== true) return fail('UNSUPPORTED_CAPABILITY');
      if (!adapter.delegationRevision?.(pluginId)) return fail('PERMISSION_DENIED');
    }
    const delegationTask = delegation?.task;
    const delegationRevision = delegation ? adapter.delegationRevision?.(pluginId) : undefined;
    if (target.kind === 'project' && delivery === 'steer') return fail('INVALID_PARAMS');
    if (request.route !== undefined) {
      const route = request.route;
      if (
        target.kind !== 'project' || !route || !['cc', 'codex', 'pi'].includes(route.agentKind) ||
        !keyString(route.providerId) || typeof route.model !== 'string' || !route.model.trim() ||
        route.model.length > 256 || typeof route.effort !== 'string' || route.effort.length > 32 ||
        (typeof route.fastMode !== 'boolean' && route.fastMode !== 'ultrafast')
      ) return fail('INVALID_PARAMS');
    }
    const route = request.route && {
      agentKind: request.route.agentKind, providerId: request.route.providerId,
      model: request.route.model, effort: request.route.effort, fastMode: request.route.fastMode,
    };
    return withParsedPluginMessageAttachments(request.attachments, async images => {
      const contentIdentity = [target.kind, target.id, request.text, request.title, route, delivery,
        images.map(({ hash, name }) => [hash, name]),
        ...(topicKey !== undefined ? [{ topicKey }] : []),
        ...(request.context ? [{ context: request.context }] : []),
        ...(delegation ? [{ delegation: { task: delegationTask } }] : []),
        ...(request.autoTitle ? [{ autoTitle: true }] : []),
        ...(request.permissionMode !== undefined ? [{ permissionMode: request.permissionMode }] : [])];
      const hash = createHash('sha256')
        .update(JSON.stringify(request.invocationId === undefined ? contentIdentity : [...contentIdentity, request.invocationId]))
        .digest('hex');
      const pending = this.inFlight.get(runtimeKey);
      if (pending) {
        if (pending.cancelled) return fail('SUPERSEDED');
        if (pending.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
        return pending.result!;
      }
      const operation = { hash, cancelled: false, result: undefined as Promise<unknown> | undefined };
      const guard = () => {
        authorized();
        if (operation.cancelled) fail('SUPERSEDED');
        if (delegation && (!this.supportsDelegationExecution() || !delegationRevision ||
          adapter.delegationRevision?.(pluginId) !== delegationRevision)) fail('PERMISSION_DENIED');
      };
      const replay = (previous: PluginTargetReceipt) => {
        if (previous.status === 'cancelled') return fail('SUPERSEDED');
        if (previous.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
        if (previous.status === 'accepted')
          return { taskId: previous.taskId, accepted: true, delivery: previous.delivery,
            ...(previous.delegation ? { executionId: previous.id, requestKey: previous.requestKey, target: previous.target } : {}) };
        return fail('DELIVERY_UNCERTAIN');
      };
      const deliver = async () => {
        const existing = await store.get(pluginId, request.requestKey);
        guard();
        if (existing) return replay(existing);
        const candidate = await resolve(target);
        guard();
        const approvalRevision = adapter.approvalRevision(pluginId);
        if (!approvalRevision || (delegation && delegationRevision !== approvalRevision)) return fail('PERMISSION_DENIED');
        if (request.permissionMode !== undefined) adapter.assertCreatePermission(pluginId, request.permissionMode);
        const receipt: PluginTargetReceipt = {
          id: `plugin-target:${randomUUID()}`, pluginId, requestKey: request.requestKey,
          ...(delegation ? { delegation: { version: 1 as const, task: delegationTask! } } : {}),
          ...(topicKey !== undefined ? { topicKey } : {}),
          hash, target, approvalRevision, status: 'pending',
          taskId: topicKey !== undefined
            ? await adapter.resolveTopic!(pluginId, target.id, topicKey, { create: true,
              title: request.title || candidate.label, assertCurrent: guard })
            : target.kind === 'project' ? randomUUID() : await adapter.session(target.kind, target.id),
        };
        receipt.invocationId = adapter.prepareInvocation?.(pluginId, receipt.id.slice('plugin-target:'.length),
          request.invocationId, 'targets.send', receipt.taskId);
        guard();
        // A per-key reservation uses the existing receipt DB, never a whole-history rewrite.
        const reserved = await store.reserve(receipt);
        guard();
        if (!reserved) return replay((await store.get(pluginId, request.requestKey))!);
        const taskId = receipt.taskId!;
        const validateTarget = async () => {
          guard();
          await this.assertQueuedDelivery(taskId, receipt.id);
          guard();
        };
        if (target.kind === 'project') {
          // Validate the target before creation; task dispatch policy requires the
          // created task and is rechecked below and at queue acceptance.
          await this.assertTargetReceipt(taskId, receipt.id, 'create');
          guard();
          const title = request.autoTitle ? DEFAULT_DRAFT_SESSION_TITLE : request.title || candidate.label;
          if (request.permissionMode !== undefined)
            await adapter.create(pluginId, target.id, taskId, title, route, guard, request.autoTitle || undefined, request.permissionMode);
          else if (request.autoTitle) await adapter.create(pluginId, target.id, taskId, title, route, guard, true);
          else await adapter.create(pluginId, target.id, taskId, title, route, guard);
        }
        await validateTarget();
        const actualDelivery = await adapter.send(
          pluginId, taskId, receipt.id, request.text, guard, validateTarget, delivery, images,
          request.context ? { context: request.context } : undefined,
        );
        authorized();
        if (receipt.invocationId) {
          try { adapter.acceptInvocation?.(pluginId, receipt.invocationId); } catch { /* Statistics never retry real delivery. */ }
        }
        await store.accept(receipt.id, actualDelivery);
        authorized();
        const current = await store.getById(receipt.id);
        authorized();
        if (operation.cancelled || current?.status === 'cancelled') {
          await adapter.withdraw(taskId, receipt.id, authorized);
          return fail('SUPERSEDED');
        }
        if (request.autoTitle) {
          try { adapter.scheduleAutoTitle?.(pluginId, taskId, pluginMessageText(request.text, request.context), request.text); }
          catch { /* Naming failure never retries an accepted message. */ }
        }
        return { taskId, accepted: true, delivery: actualDelivery,
          ...(receipt.delegation ? { executionId: receipt.id, requestKey: receipt.requestKey, target: receipt.target } : {}) };
      };
      operation.result = deliver().finally(() => this.inFlight.delete(runtimeKey));
      this.inFlight.set(runtimeKey, operation);
      return operation.result;
    });
  }
}
