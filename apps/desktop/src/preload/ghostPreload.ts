import { contextBridge, ipcRenderer } from 'electron';
import { createGhostBridge } from '@cindy/plugin-runtime/bridge';

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

contextBridge.exposeInMainWorld('cindy', createGhostBridge({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  subscribe: listener => { ipcRenderer.on('ghost-pipe:message', (_event, payload: unknown) => listener(payload)); },
}));
