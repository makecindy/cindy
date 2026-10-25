import { createHash, randomUUID } from 'node:crypto';
import type {
  PluginTargetCandidate,
  PluginTargetDelivery,
  PluginTargetKind,
  PluginTargetRef,
  PluginTargetRequest,
  PluginTargetView,
} from '../../shared/pluginTargets.js';
import type { PluginTaskRoute } from '../../shared/pluginTasks.js';
import { getActiveDataOwnerPushStamp, activeOwnerScopeKey } from '../appSessionState.js';
import { withParsedPluginMessageAttachments, type PluginMessageImage } from '../cindy-media/pluginMessageAttachments.js';

export interface PluginTargetReceipt {
  id: string;
  pluginId: string;
  requestKey: string;
  hash: string | null;
  taskId?: string;
  target?: PluginTargetRef;
  approvalRevision?: string;
  status: 'pending' | 'accepted' | 'cancelled';
  delivery?: PluginTargetDelivery;
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
  candidates(kind: PluginTargetKind): Promise<PluginTargetCandidate[]>;
  create(
    pluginId: string,
    project: string,
    taskId: string,
    title: string,
    route: PluginTaskRoute | undefined,
    guard: () => void,
  ): Promise<void>;
  session(kind: 'task' | 'bot', id: string): Promise<string>;
  send(
    pluginId: string,
    taskId: string,
    clientId: string,
    text: string,
    guard: () => void,
    validateTarget: () => Promise<void>,
    delivery: PluginTargetDelivery,
    images?: PluginMessageImage[],
  ): Promise<PluginTargetDelivery>;
  withdraw(taskId: string, clientId: string, guard: () => void): Promise<void>;
}
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const keyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
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
  /** Used by the existing queue acceptance boundary, including restored snapshots. */
  async assertQueuedDelivery(taskId: string, clientId: string): Promise<void> {
    if (!this.adapter) fail('HOST_NOT_READY');
    const adapter = this.adapter!;
    const store = adapter.store();
    const receipt = await store.getById(clientId);
    const assertReceipt = (current: PluginTargetReceipt | undefined) => {
      if (!receipt?.target || !current || current.status === 'cancelled' || current.taskId !== taskId ||
        current.hash !== receipt.hash || !current.approvalRevision ||
        adapter.approvalRevision(current.pluginId) !== current.approvalRevision) fail('PERMISSION_DENIED');
    };
    assertReceipt(receipt);
    const target = receipt!.target!;
    if (!(await adapter.candidates(target.kind)).some(item => item.id === target.id)) fail('TARGET_UNAVAILABLE');
    if (target.kind !== 'project' && await adapter.session(target.kind, target.id) !== taskId) fail('TARGET_UNAVAILABLE');
    assertReceipt(await store.getById(clientId));
  }
  async handle(pluginId: string, raw: unknown, authorized: () => void): Promise<unknown> {
    authorized();
    if (!this.adapter) return fail('HOST_NOT_READY');
    const adapter = this.adapter;
    const request = raw as PluginTargetRequest;
    if (!request || !['list', 'resolve', 'send', 'cancel'].includes(request.kind))
      return fail('INVALID_PARAMS');
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
      return { cancelled: true, runningWorkMayHaveStarted: !!receipt.taskId };
    }
    if (
      !isTarget(request.target) ||
      typeof request.text !== 'string' || !request.text.trim() || request.text.length > 64000 ||
      (request.delivery !== undefined && !['queue', 'steer'].includes(request.delivery)) ||
      (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 200))
    ) return fail('INVALID_PARAMS');
    const target = request.target;
    const delivery = request.delivery ?? 'queue';
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
      const hash = createHash('sha256')
        .update(JSON.stringify([target.kind, target.id, request.text, request.title, route, delivery,
          images.map(({ hash, name }) => [hash, name])]))
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
      };
      const replay = (previous: PluginTargetReceipt) => {
        if (previous.status === 'cancelled') return fail('SUPERSEDED');
        if (previous.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
        if (previous.status === 'accepted')
          return { taskId: previous.taskId, accepted: true, delivery: previous.delivery };
        return fail('DELIVERY_UNCERTAIN');
      };
      const deliver = async () => {
        const existing = await store.get(pluginId, request.requestKey);
        guard();
        if (existing) return replay(existing);
        const candidate = await resolve(target);
        guard();
        const approvalRevision = adapter.approvalRevision(pluginId);
        if (!approvalRevision) return fail('PERMISSION_DENIED');
        const receipt: PluginTargetReceipt = {
          id: `plugin-target:${randomUUID()}`, pluginId, requestKey: request.requestKey,
          hash, target, approvalRevision, status: 'pending',
          taskId: target.kind === 'project' ? randomUUID() : await adapter.session(target.kind, target.id),
        };
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
        await validateTarget();
        if (target.kind === 'project')
          await adapter.create(pluginId, target.id, taskId, request.title || candidate.label, route, guard);
        guard();
        const actualDelivery = await adapter.send(
          pluginId, taskId, receipt.id, request.text, guard, validateTarget, delivery, images,
        );
        authorized();
        await store.accept(receipt.id, actualDelivery);
        authorized();
        const current = await store.getById(receipt.id);
        authorized();
        if (operation.cancelled || current?.status === 'cancelled') {
          await adapter.withdraw(taskId, receipt.id, authorized);
          return fail('SUPERSEDED');
        }
        return { taskId, accepted: true, delivery: actualDelivery };
      };
      operation.result = deliver().finally(() => this.inFlight.delete(runtimeKey));
      this.inFlight.set(runtimeKey, operation);
      return operation.result;
    });
  }
}
