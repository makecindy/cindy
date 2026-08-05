import { contextBridge, ipcRenderer } from 'electron';

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
 * - send(payload):上行投递(工具结果/面板推送申请等;主机按 slots 白名单
 *   与消息类型路由,未开闸的类型一律拒);
 * - request(req):读取宿主公开上下文的便捷口——就是
 *   send({type:'host-request',…req}) 的语法糖;目前只支持 app-context(region),
 *   不含用户数据与凭证,也不扩张其它主机能力。
 * - fetch(req):network 槽代理 HTTP 的便捷口——就是 send({type:'fetch-request',
 *   …req}) 的语法糖,零新通道零新权限(白名单/凭证注入全在主机侧守门)。
 * - fs(req):fs 槽代写文件的便捷口——send({type:'fs-request', …req}) 的
 *   语法糖,同样零新通道零新权限(三档守门全在主机侧 fsSlot)。
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

contextBridge.exposeInMainWorld('cindy', {
  ping: (): Promise<{ ok: true; id: string }> => ipcRenderer.invoke('ghost-pipe:ping'),
  onHostMessage: (cb: HostMessageListener): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  send: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('ghost-pipe:send', payload),
  request: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'host-request' }),
  fetch: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'fetch-request' }),
  fs: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'fs-request' }),
  agent: {
    run: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'agent-request' }),
    // 派活取件(agent.errand 加档)的便捷口:errand = 提交(kind:'run'),
    // queryErrand = 取件(kind:'query')。都是 send({type:'agent-errand-request'})
    // 的语法糖,资格审与频控在主机 errandSlot。
    errand: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'agent-errand-request', kind: 'run' }),
    queryErrand: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'agent-errand-request', kind: 'query' }),
    // 请用户新建一条自动化(agent.schedule 加档):只能**打开预填好的创建面板**,
    // 建不建由用户在面板上选好模型后亲手保存。{ ok:true } 只表示"请求已被接受并投递",
    // 既不保证面板真开了(用户正编辑另一个表单时本次草稿会被丢弃),也不表示任务已创建
    // ——本版没有回执通道,绑定与查改由后续版本提供(语义见 GhostPipeScheduleDraftResult)。
    // 资格审 / 净化 / 频率钳制 / 限速都在主机 scheduleSlot。
    requestSchedule: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'schedule-request' }),
  },
  node: {
    request: (req: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'node-request' }),
  },
  pick: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'pick-request' }),
  preview: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'preview-request' }),
  workspace: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'workspace-request' }),
  confirm: (req: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('ghost-pipe:send', { ...req, type: 'confirm-request' }),
});
