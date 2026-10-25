/** The published plugin bridge; only its authenticated transport differs by host. */
export interface GhostBridgeTransport {
  invoke(channel: 'ghost-pipe:ping' | 'ghost-pipe:send', payload?: unknown): Promise<any>;
  subscribe(listener: (payload: unknown) => void): void;
}
export function createGhostBridge(transport: GhostBridgeTransport) {
type HostMessageListener = (payload: unknown) => void;
const listeners = new Set<HostMessageListener>();
transport.subscribe((payload: unknown) => {
  listeners.forEach((listener) => listener(payload));
});

return {
  ping: (): Promise<{ ok: true; id: string }> => transport.invoke('ghost-pipe:ping'),
  onHostMessage: (cb: HostMessageListener): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  send: (payload: unknown): Promise<unknown> => transport.invoke('ghost-pipe:send', payload),
  recommendations: (items: unknown[]): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { type: 'recommendations-update', items }),
  request: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'host-request' }),
  fetch: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'fetch-request' }),
  downloads: {
    start: (req: Record<string, unknown>): Promise<unknown> => transport.invoke('ghost-pipe:send', { ...req, type: 'download-request', kind: 'start' }),
    cancel: (req: Record<string, unknown>): Promise<unknown> => transport.invoke('ghost-pipe:send', { ...req, type: 'download-request', kind: 'cancel' }),
  },
  fs: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'fs-request' }),
  deviceSync: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'device-sync-request' }),
  library: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'library-request' }),
  targets: Object.fromEntries(['list', 'resolve', 'send', 'cancel'].map(kind => [kind,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await transport.invoke('ghost-pipe:send', { ...req, type: 'targets-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Target request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  tasks: Object.fromEntries(
    ['capabilities', 'models', 'setModel', 'requestWriteAccess', 'startTeam', 'getTeam', 'setTeamPlan', 'releaseWorker', 'create', 'list', 'get', 'send', 'getRun', 'listRuns', 'cancel', 'readMessages', 'setHidden'].map(kind => [
      kind, async (req: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await transport.invoke('ghost-pipe:send', { ...req, type: 'tasks-request', kind });
        if (result?.ok === true) return result.data;
        throw Object.assign(new Error(result?.error?.message ?? 'Task request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY', retryable: result?.error?.retryable === true });
      },
    ]),
  ),
  agent: {
    run: (req: Record<string, unknown>): Promise<unknown> =>
      transport.invoke('ghost-pipe:send', { ...req, type: 'agent-request' }),
    // 派活取件(agent.errand 加档)的便捷口:errand = 提交(kind:'run'),
    // queryErrand = 取件(kind:'query')。都是 send({type:'agent-errand-request'})
    // 的语法糖,资格审与频控在主机 errandSlot。
    errand: (req: Record<string, unknown>): Promise<unknown> =>
      transport.invoke('ghost-pipe:send', { ...req, type: 'agent-errand-request', kind: 'run' }),
    queryErrand: (req: Record<string, unknown>): Promise<unknown> =>
      transport.invoke('ghost-pipe:send', {
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
      transport.invoke('ghost-pipe:send', { ...req, type: 'schedule-request' }),
  },
  routines: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      transport.invoke('ghost-pipe:send', { ...req, type: 'routine-request' }),
  },
  node: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      transport.invoke('ghost-pipe:send', { ...req, type: 'node-request' }),
  },
  pick: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'pick-request' }),
  preview: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'preview-request' }),
  // 在任务右侧栏打开 / 聚焦本插件的任务页(taskView);缺省落台前任务,回执带回落点任务。
  taskView: (req: Record<string, unknown> = {}): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'task-view-request' }),
  workspace: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'workspace-request' }),
  confirm: (req: Record<string, unknown>): Promise<unknown> =>
    transport.invoke('ghost-pipe:send', { ...req, type: 'confirm-request' }),
};
}
