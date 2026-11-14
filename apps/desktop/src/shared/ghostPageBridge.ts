import type { PluginModelPickerOptions, PluginModelPickerResult } from './pluginModelPicker';
import { PLUGIN_UI_STATE_BATCH_LIMIT, type PluginUiControlState, type PluginUiInterest, type PluginUiTarget } from './pluginUi';
type HostMessageListener = (payload: unknown) => void;
/** Transport only. The execution-side dispatcher checks every request. */
export function createGhostPageBridge(ports: { ping: () => Promise<{ ok: true; id: string; nativeUiConsumers?: PluginUiInterest[] }>; send: (payload: unknown) => Promise<any> }) {
  const listeners = new Set<HostMessageListener>();
  let consumerRevision = 0;
  const uiConsumers = new Map<string, Set<string>>();
  const targetKey = (target: PluginUiTarget) => JSON.stringify([target.sessionId ?? null, target.clientId ?? null]);
  function replaceUiConsumers(consumers: PluginUiInterest[]) {
    consumerRevision++;
    uiConsumers.clear();
    for (const consumer of consumers) {
      let targets = uiConsumers.get(consumer.id);
      if (!targets) { targets = new Set(); uiConsumers.set(consumer.id, targets); }
      targets.add(targetKey(consumer));
    }
  }
  const hasUiConsumers = (id: string, target?: PluginUiTarget) => {
    const targets = uiConsumers.get(id);
    return target ? targets?.has(targetKey(target)) === true : !!targets?.size;
  };
  type UiUpdate = { id: string; target?: PluginUiTarget; build(): PluginUiControlState;
    pending: Promise<{ ok: true; observed: boolean }>;
    resolve(result: { ok: true; observed: boolean }): void; reject(error: unknown): void };
  let uiUpdates = new Map<string, UiUpdate>();
  let uiSending = false, uiScheduled = false;
  function scheduleUiUpdates() {
    if (uiSending || uiScheduled) return;
    uiScheduled = true;
    queueMicrotask(() => { uiScheduled = false; void flushUiUpdates(); });
  }
  async function flushUiUpdates() {
    if (uiSending || !uiUpdates.size) return;
    const pending = uiUpdates; uiUpdates = new Map();
    const active: UiUpdate[] = [];
    const updates: Array<{ id: string; target?: PluginUiTarget; state: PluginUiControlState }> = [];
    for (const update of pending.values()) {
      if (!hasUiConsumers(update.id, update.target)) {
        update.resolve({ ok: true, observed: false });
        continue;
      }
      try { updates.push({ id: update.id, ...(update.target ? { target: update.target } : {}), state: update.build() }); active.push(update); }
      catch (error) { update.reject(error); }
    }
    if (!active.length) return;
    uiSending = true;
    try {
      for (let offset = 0; offset < updates.length; offset += PLUGIN_UI_STATE_BATCH_LIMIT) {
        const batch = updates.slice(offset, offset + PLUGIN_UI_STATE_BATCH_LIMIT);
        const result = await ports.send({ type: 'ui-state-update', updates: batch });
        batch.forEach((_, index) => active[offset + index].resolve({ ok: true, observed: result?.observed?.[index] === true }));
      }
    } catch (error) { active.forEach(update => update.reject(error)); }
    finally { uiSending = false; if (uiUpdates.size) scheduleUiUpdates(); }
  }
  const api = {
  ping: async (): Promise<{ ok: true; id: string }> => {
    const revision = consumerRevision;
    const result = await ports.ping();
    if (revision === consumerRevision) replaceUiConsumers(result.nativeUiConsumers ?? []);
    return result;
  },
  ui: {
    hasConsumers: hasUiConsumers,
    updateContribution: (id: string, build: () => PluginUiControlState, target?: PluginUiTarget): Promise<{ ok: true; observed: boolean }> => {
      if (!hasUiConsumers(id, target)) return Promise.resolve({ ok: true, observed: false });
      const key = JSON.stringify([id, target ? targetKey(target) : null]);
      let update = uiUpdates.get(key);
      if (!update) {
        let resolve!: UiUpdate['resolve'], reject!: UiUpdate['reject'];
        const pending = new Promise<{ ok: true; observed: boolean }>((done, fail) => { resolve = done; reject = fail; });
        update = { id, target, build, pending, resolve, reject }; uiUpdates.set(key, update);
      }
      update.build = build;
      scheduleUiUpdates();
      return update.pending;
    },
  },
  onHostMessage: (cb: HostMessageListener): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  send: (payload: unknown): Promise<unknown> => ports.send(payload),
  host: {
    call: (server: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> =>
      ports.send({ type: 'host-tool-request', server, tool, args }),
  },
  recommendations: (items: unknown[]): Promise<unknown> =>
    ports.send({ type: 'recommendations-update', items }),
  request: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'host-request' }),
  fetch: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'fetch-request' }),
  downloads: {
    start: (req: Record<string, unknown>): Promise<unknown> => ports.send({ ...req, type: 'download-request', kind: 'start' }),
    cancel: (req: Record<string, unknown>): Promise<unknown> => ports.send({ ...req, type: 'download-request', kind: 'cancel' }),
  },
  fs: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'fs-request' }),
  deviceSync: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'device-sync-request' }),
  // A live screen plugin's view of its own screens on the account's other computers.
  liveScreenView: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'live-screen-view-request' }),
  library: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'library-request' }),
  targets: Object.fromEntries(['capabilities', 'list', 'resolve', 'send', 'get', 'cancel'].map(kind => [kind,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ports.send({ ...req, type: 'targets-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Target request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  observe: Object.fromEntries([['projectTasks', 'project-tasks'], ['openTask', 'open-task']].map(([name, kind]) => [name,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ports.send({ ...req, type: 'observe-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Observe request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  companions: Object.fromEntries(['capabilities', 'list', 'avatar', 'reply', 'history', 'open', 'interaction', 'answer', 'watch', 'unwatch'].map(kind => [kind,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ports.send({ ...req, type: 'companions-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Companion request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  tasks: Object.fromEntries(
    ['capabilities', 'models', 'setModel', 'requestWriteAccess', 'startTeam', 'getTeam', 'setTeamPlan', 'releaseWorker', 'create', 'list', 'get', 'send', 'getRun', 'listRuns', 'cancel', 'readMessages', 'setHidden', 'archive'].map(kind => [
      kind, async (req: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await ports.send({ ...req, type: 'tasks-request', kind });
        if (result?.ok === true) return result.data;
        throw Object.assign(new Error(result?.error?.message ?? 'Task request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY', retryable: result?.error?.retryable === true });
      },
    ]),
  ),
  agent: {
    run: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({ ...req, type: 'agent-request' }),
    // 派活取件(agent.errand 加档)的便捷口:errand = 提交(kind:'run'),
    // queryErrand = 取件(kind:'query')。都是 send({type:'agent-errand-request'})
    // 的语法糖,资格审与频控在主机 errandSlot。
    errand: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({ ...req, type: 'agent-errand-request', kind: 'run' }),
    queryErrand: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({
        ...req,
        type: 'agent-errand-request',
        kind: 'query',
      }),
    // 请用户新建一条自动化(agent.schedule 加档):只能**打开预填好的创建面板**,
    // 建不建由用户在面板上选好模型后亲手保存。{ ok:true } 只表示"请求已被接受并投递",
    // 既不保证面板真开了(用户正编辑另一个表单时本次草稿会被丢弃),也不表示任务已创建
    // ——本版没有回执通道,绑定与查改由后续版本提供(语义见 GhostPipeScheduleDraftResult)。
    // 资格审 / 净化 / 频率钳制 / 限速都在主机 scheduleSlot。
    requestSchedule: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({ ...req, type: 'schedule-request' }),
  },
  routines: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({ ...req, type: 'routine-request' }),
  },
  node: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      ports.send({ ...req, type: 'node-request' }),
  },
  pick: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'pick-request' }),
  pickModel: (req: PluginModelPickerOptions = {}): Promise<PluginModelPickerResult> =>
    ports.send({ ...req, type: 'model-picker-request' }),
  preview: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'preview-request' }),
  // 在任务右侧栏打开 / 聚焦本插件的任务页(taskView);缺省落台前任务,回执带回落点任务。
  taskView: (req: Record<string, unknown> = {}): Promise<unknown> =>
    ports.send({ ...req, type: 'task-view-request' }),
  workspace: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'workspace-request' }),
  confirm: (req: Record<string, unknown>): Promise<unknown> =>
    ports.send({ ...req, type: 'confirm-request' }),
};
  return { api, deliver(payload: unknown) {
    if (payload && typeof payload === 'object' && 'type' in payload && payload.type === 'ui-consumers' && 'consumers' in payload && Array.isArray(payload.consumers))
      replaceUiConsumers(payload.consumers);
    listeners.forEach(listener => listener(payload));
  } };
}
