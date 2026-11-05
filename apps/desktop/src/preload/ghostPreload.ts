import { contextBridge, ipcRenderer } from 'electron';
import { exposePluginPageModelPicker } from './ghostPageModelPickerBridge';
import type { PluginModelPickerOptions, PluginModelPickerResult } from '../shared/pluginModelPicker';
import type { CindyPluginUi, PluginUiContributionHandler, PluginUiCommandHandler, PluginUiCapabilities } from '@cindy/maker-shared/plugin-ui';
import type { PluginUiHostMessage } from '@cindy/maker-shared';
import type { CindyPluginTabView, PluginUiTabViewSnapshot } from '@cindy/maker-shared/plugin-ui';
import { PLUGIN_TAB_VIEW_READ, PLUGIN_TAB_VIEW_CHANGED, PLUGIN_TAB_VIEW_RECEIVED } from '../shared/pluginUi';

/**
 * 意识电子脑的最小管子桥(脑机接口;docs/dev-rules/plugin-security-and-authoring.md)。
 *
 * 只注入**离屏逻辑页**(电子脑);面板页零桥零特权(面板与逻辑页走同源
 * BroadcastChannel,主机零中转)。身份不自报:main 侧按 sender webContents
 * 与意识 id 的绑定表验身,冒名调用直接拒(结构隔离,见 electronSandboxAdapter)。
 *
 * 暴露面刻意极小(管子三口 + network 一口):
 * - ping():握手/自检,回自己的意识 id;
 * - onHostMessage(cb):订阅主机下行(工具调用派发等,后续切片投递);
 * - send(payload):上行投递(工具结果/Host 请求等);主机按消息类型、
 *   调用上下文与插件自主能力声明守门,未开闸的类型一律拒;
 * - request(req):读取宿主公开上下文的便捷口——就是
 *   send({type:'host-request',…req}) 的语法糖;目前只支持 app-context(region),
 *   不含用户数据与凭证,也不扩张其它主机能力。
 * - fetch(req):主机代理 HTTP 的便捷口——就是 send({type:'fetch-request',
 *   …req}) 的语法糖。Agent 在途调用凭 callId 复用 Agent 授权；自主调用
 *   按 network 声明守门，托管凭证始终只按声明注入。
 * - fs(req):主机文件操作的便捷口——send({type:'fs-request', …req}) 的
 *   语法糖。workdir 写入可复用 Agent 在途授权，data 私有目录按 fs 声明守门。
 * - library(req):持久作品库的便捷口——send({type:'library-request', …req})
 *   的语法糖；资格审、binding 根解析、owner scope 复核与 SQL 语句门都在
 *   主机侧 librarySlot，失败返回结构化 errorCode。
 * - agent.errand(req) / agent.queryErrand(req):派活取件便捷口——
 *   send({type:'agent-errand-request', kind:'run'/'query', …req}) 的语法糖;
 * - agent.run(req):Agent 新回合的便捷口——send({type:'agent-request',
 *   …req}) 的语法糖；一次性用户票、后台权限和会话归属由主机校验。
 * - node.request(req):随包 Node / stdio MCP 的便捷口。Node 只能经本管子与
 *   main.js 收发 JSON-RPC，不能直接拿到 Cindy API。
 * - pick(req):pick 槽的便捷口——send({type:'pick-request', …req}) 的语法糖;
 *   系统选文件夹窗口由主机弹,用户亲选即授权,守门全在主机侧 pickSlot。
 * - preview(req):preview 槽的便捷口——send({type:'preview-request', …req})
 *   的语法糖;URL 白名单守门在主机侧 previewSlot。
 * - taskView(req):taskView 槽的便捷口——send({type:'task-view-request', …req});
 *   在任务右侧栏打开 / 聚焦本插件的任务页,回执 {ok, sessionId} 带回落点任务;
 *   {peek:true} 只回答落点、不开页签。
 * - workspace(req):workspace 槽的便捷口——send({type:'workspace-request',
 *   …req}) 的语法糖;目录授权与会话创建守门全在主机侧 workspaceSlot。
 * - confirm(req):confirm 槽的便捷口——send({type:'confirm-request', …req}) 的
 *   语法糖;主机弹自己那套确认框并把用户的真实点击回给沙箱,资格审/净化/限速/
 *   单飞/超时兜底全在主机侧 confirmSlot 与 ghostConfirmDialogBridge。
 */

type HostMessageListener = (payload: unknown) => void;
const listeners = new Set<HostMessageListener>();
ipcRenderer.on('ghost-pipe:message', (_event, payload: unknown) => {
  listeners.forEach((listener) => listener(payload));
});

// This adapter only owns callbacks and request pairing. Main owns every binding
// and permission; authors never receive transport or Host metadata requirements.
const uiHandlers = new Map<string, PluginUiContributionHandler>();
const uiCommandHandlers = new Map<string, PluginUiCommandHandler>();
const uiReads = new Map<string, PluginUiContributionHandler>();
const uiSend = (message: unknown) => { void ipcRenderer.invoke('ghost-pipe:send', message).catch(() => {}); };
const uiListener: HostMessageListener = raw => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as PluginUiHostMessage;
  if (message.type === 'ui-view-cancel') { uiReads.delete(message.requestId); return; }
  if (message.type === 'ui-view-request') {
    const handler = uiHandlers.get(message.contributionId);
    if (!handler) return;
    uiReads.set(message.requestId, handler);
    void Promise.resolve().then(() => handler.render(message.context)).then(content => {
      if (uiReads.get(message.requestId) !== handler || uiHandlers.get(message.contributionId) !== handler) return;
      uiSend({ type: 'ui-view-result', requestId: message.requestId, viewId: message.viewId, content });
    }, () => {
      if (uiReads.get(message.requestId) === handler && uiHandlers.get(message.contributionId) === handler)
        uiSend({ type: 'ui-view-result', requestId: message.requestId, viewId: message.viewId, content: null });
    }).finally(() => { if (uiReads.get(message.requestId) === handler) uiReads.delete(message.requestId); });
  } else if (message.type === 'event' && message.name === 'ui-command') {
    const handler = uiCommandHandlers.get(message.commandId);
    if (!handler) return;
    const reply = (result: unknown) => {
      if (uiCommandHandlers.get(message.commandId) === handler)
        uiSend({ type: 'ui-action-result', invocationId: message.invocationId, viewId: message.viewId, result });
    };
    void Promise.resolve().then(() => handler(message.context)).then(reply, () => reply({ status: 'outcome-unknown' }));
  } else if (message.type === 'event' && message.name === 'ui-action') {
    const handler = uiHandlers.get(message.contributionId);
    if (!handler) return;
    const reply = (result: unknown) => {
      if (uiHandlers.get(message.contributionId) === handler)
        uiSend({ type: 'ui-action-result', invocationId: message.invocationId, viewId: message.viewId, result });
    };
    void Promise.resolve().then(() => handler.onAction?.({ actionId: message.actionId, values: message.values,
      ...(message.data !== undefined ? { data: message.data } : {}), context: message.context }) ?? { status: 'rejected', reason: 'ACTION_UNAVAILABLE' })
      .then(reply, () => reply({ status: 'outcome-unknown' }));
  }
};
const ui: CindyPluginUi = {
  appearance: {
    async read() { return appearanceRequest({ kind: 'read' }); },
    async set(patch, options) { return appearanceRequest({ kind: 'set', patch, ...options }); },
    async reset(fields, options) { return appearanceRequest({ kind: 'reset', fields, ...options }); },
  },
  visibility: {
    async read() { return visibilityRequest({ kind: 'read' }); },
    async set(patch) { return visibilityRequest({ kind: 'set', patch }); },
  },
  contribute(id, handler) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !handler || typeof handler.render !== 'function' ||
        (handler.onAction !== undefined && typeof handler.onAction !== 'function')) throw new TypeError('Invalid UI contribution');
    if (uiHandlers.has(id)) throw new TypeError('UI contribution is already registered');
    uiHandlers.set(id, handler); listeners.add(uiListener);
    uiSend({ type: 'ui-register', contributionId: id });
    return () => {
      if (uiHandlers.get(id) !== handler) return;
      uiHandlers.delete(id); uiSend({ type: 'ui-unregister', contributionId: id });
      if (!uiHandlers.size && !uiCommandHandlers.size) { listeners.delete(uiListener); uiReads.clear(); }
    };
  },
  registerCommand(id, handler) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof handler !== 'function') throw new TypeError('Invalid UI command');
    if (uiCommandHandlers.has(id)) throw new TypeError('UI command is already registered');
    uiCommandHandlers.set(id, handler); listeners.add(uiListener);
    uiSend({ type: 'ui-command-register', commandId: id });
    return () => {
      if (uiCommandHandlers.get(id) !== handler) return;
      uiCommandHandlers.delete(id); uiSend({ type: 'ui-command-unregister', commandId: id });
      if (!uiHandlers.size && !uiCommandHandlers.size) { listeners.delete(uiListener); uiReads.clear(); }
    };
  },
  invalidate(input) { uiSend({ type: 'ui-update', contributionId: input.contributionId, scope: input.scope }); },
  async capabilities() {
    const requestId = crypto.randomUUID();
    const reply = await ipcRenderer.invoke('ghost-pipe:send', { type: 'ui-capabilities-request', requestId });
    if (reply?.requestId !== requestId || reply.capabilities?.version !== 1) throw new Error('UI capabilities unavailable');
    return reply.capabilities as PluginUiCapabilities;
  },
  dispose() { uiHandlers.clear(); uiCommandHandlers.clear(); uiReads.clear(); listeners.delete(uiListener); uiSend({ type: 'ui-dispose' }); },
};

async function appearanceRequest<T>(request: Record<string, unknown>): Promise<T> {
  const reply = await ipcRenderer.invoke('ghost-pipe:send', { ...request, type: 'ui-appearance-request' });
  if (reply?.ok === true) return reply.data as T;
  throw Object.assign(new Error(reply?.error?.message ?? 'Appearance unavailable'), { code: reply?.error?.code ?? 'APPEARANCE_UNAVAILABLE' });
}

async function visibilityRequest<T>(request: Record<string, unknown>): Promise<T> {
  const reply = await ipcRenderer.invoke('ghost-pipe:send', { ...request, type: 'ui-visibility-request' });
  if (reply?.ok === true) return reply.data as T;
  throw Object.assign(new Error(reply?.error?.message ?? 'Visibility unavailable'), { code: reply?.error?.code ?? 'VISIBILITY_UNAVAILABLE' });
}

if (process.argv.includes('--cindy-plugin-tab-view')) {
  exposePluginPageModelPicker();
  const changed = new Set<(snapshot: PluginUiTabViewSnapshot) => void>();
  let latest: { snapshot: PluginUiTabViewSnapshot; sequence: number } | undefined;
  const received = (value: { snapshot: PluginUiTabViewSnapshot; sequence: number }) => {
    void ipcRenderer.invoke(PLUGIN_TAB_VIEW_RECEIVED, { generation: value.snapshot.generation, sequence: value.sequence }).catch(() => {});
  };
  ipcRenderer.on(PLUGIN_TAB_VIEW_CHANGED, (_event, value: { snapshot: PluginUiTabViewSnapshot; sequence: number }) => {
    if (latest && value.sequence < latest.sequence) return;
    latest = value;
    for (const listener of changed) { try { listener(value.snapshot); } catch { /* plugin owns rendering errors */ } }
    if (changed.size) received(value);
  });
  const view: CindyPluginTabView = {
    read: async () => {
      const result = await ipcRenderer.invoke(PLUGIN_TAB_VIEW_READ) as { snapshot: PluginUiTabViewSnapshot; sequence: number };
      if (!latest || latest.sequence <= result.sequence) latest = result;
      received(latest); return latest.snapshot;
    },
    onChanged: listener => { changed.add(listener); return () => { changed.delete(listener); }; },
  };
  contextBridge.exposeInMainWorld('cindy', { ui: { view } });
} else contextBridge.exposeInMainWorld('cindy', {
  ui,
  ping: (): Promise<{ ok: true; id: string }> => ipcRenderer.invoke('ghost-pipe:ping'),
  onHostMessage: (cb: HostMessageListener): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  send: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('ghost-pipe:send', payload),
  recommendations: (items: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { type: 'recommendations-update', items }),
  request: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'host-request' }),
  fetch: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'fetch-request' }),
  downloads: {
    start: (req: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'download-request', kind: 'start' }),
    cancel: (req: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'download-request', kind: 'cancel' }),
  },
  fs: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'fs-request' }),
  deviceSync: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'device-sync-request' }),
  library: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'library-request' }),
  targets: Object.fromEntries(['capabilities', 'list', 'resolve', 'send', 'get', 'cancel'].map(kind => [kind,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'targets-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Target request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  observe: Object.fromEntries([['projectTasks', 'project-tasks'], ['openTask', 'open-task']].map(([name, kind]) => [name,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'observe-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Observe request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  companions: Object.fromEntries(['capabilities', 'list', 'avatar', 'reply', 'history', 'open', 'interaction', 'answer', 'watch', 'unwatch'].map(kind => [kind,
    async (req: Record<string, unknown> = {}): Promise<unknown> => {
      const result = await ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'companions-request', kind });
      if (result?.ok === true) return result.data;
      throw Object.assign(new Error(result?.error?.message ?? 'Companion request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY' });
    },
  ])),
  tasks: Object.fromEntries(
    ['capabilities', 'models', 'setModel', 'requestWriteAccess', 'startTeam', 'getTeam', 'setTeamPlan', 'releaseWorker', 'create', 'list', 'get', 'send', 'getRun', 'listRuns', 'cancel', 'readMessages', 'setHidden', 'archive'].map(kind => [
      kind, async (req: Record<string, unknown> = {}): Promise<unknown> => {
        const result = await ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'tasks-request', kind });
        if (result?.ok === true) return result.data;
        throw Object.assign(new Error(result?.error?.message ?? 'Task request failed'), { code: result?.error?.code ?? 'HOST_NOT_READY', retryable: result?.error?.retryable === true });
      },
    ]),
  ),
  agent: {
    run: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'agent-request' }),
    // 派活取件(agent.errand 加档)的便捷口:errand = 提交(kind:'run'),
    // queryErrand = 取件(kind:'query')。都是 send({type:'agent-errand-request'})
    // 的语法糖,资格审与频控在主机 errandSlot。
    errand: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'agent-errand-request', kind: 'run' }),
    queryErrand: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', {
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
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'schedule-request' }),
  },
  routines: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'routine-request' }),
  },
  node: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'node-request' }),
  },
  pick: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'pick-request' }),
  pickModel: (req: PluginModelPickerOptions = {}): Promise<PluginModelPickerResult> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'model-picker-request' }),
  preview: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'preview-request' }),
  // 在任务右侧栏打开 / 聚焦本插件的任务页(taskView);缺省落台前任务,回执带回落点任务。
  taskView: (req: Record<string, unknown> = {}): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'task-view-request' }),
  workspace: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'workspace-request' }),
  confirm: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'confirm-request' }),
});
