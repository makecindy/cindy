/** Offline MCP Apps fixture. No account, production API or real message delivery. */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  registerAppTool,
  registerAppResource,
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

export const MOCK_RESOURCE = 'ui://cindy-mcp-apps-mock/application.html';
let htmlPromise;
export function mockAppHtml() {
  htmlPromise ??= build({
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    stdin: {
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      contents: `
      import { App, applyHostStyleVariables, applyDocumentTheme } from '@modelcontextprotocol/ext-apps/app-with-deps';
      void (async () => {
      const app = new App({name:'Cindy form example',version:'1.0.0'},{availableDisplayModes:['inline','fullscreen']});
      const title = document.querySelector('#title');
      const body = document.querySelector('#body');
      const status = document.querySelector('#status');
      const theme = context => { if(context.theme) applyDocumentTheme(context.theme); if(context.styles?.variables) applyHostStyleVariables(context.styles.variables); };
      app.onhostcontextchanged = theme;
      app.ontoolinput = ({arguments:args}) => { title.value=args?.title??''; body.value=args?.body??''; };
      app.ontoolresult = () => { status.textContent='核对并修改后可创建模拟申请'; };
      app.ontoolcancelled = () => { status.textContent='已取消'; };
      app.onteardown = async () => ({});
      const update = () => app.updateModelContext({structuredContent:{title:title.value,body:body.value}}).catch(() => {});
      title.addEventListener('input',update);body.addEventListener('input',update);
      document.querySelector('#submit').onclick=async()=>{
        const button=document.querySelector('#submit');button.disabled=true;
        try {const result=await app.callServerTool({name:'create_application',arguments:{title:title.value,body:body.value}});status.textContent=result.content.filter(item=>item.type==='text').map(item=>item.text).join(' ');}
        catch {status.textContent='申请结果未确认，请先核对状态。';}
        finally {button.disabled=false;}
      };
      document.querySelector('#ask').onclick=()=>app.sendMessage({role:'user',content:[{type:'text',text:'请根据表单当前内容继续修改。'}]}).catch(()=>{status.textContent='消息未发送，请检查连接。';});
      document.querySelector('#mode').onclick=async()=>{const result=await app.requestDisplayMode({mode:app.getHostContext()?.displayMode==='fullscreen'?'inline':'fullscreen'});status.textContent='显示模式：'+result.mode;};
      await app.connect();theme(app.getHostContext()??{});
      })();
    `,
    },
  }).then((result) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{color-scheme:light dark}body{font:14px var(--font-sans,system-ui);margin:0;padding:16px;color:var(--color-text-primary);background:var(--color-background-primary)}
    label{display:block;margin-bottom:12px}input,textarea{display:block;box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--color-border-primary);border-radius:8px;color:inherit;background:var(--color-background-secondary)}
    textarea{min-height:96px}button{padding:8px 12px;min-height:36px;margin:0 8px 8px 0;color:inherit;background:var(--color-background-secondary);border:1px solid var(--color-border-primary);border-radius:8px}p{color:var(--color-text-secondary)}
    </style></head><body><label>标题<input id="title"></label><label>内容<textarea id="body"></textarea></label>
    <button id="submit">创建模拟申请</button><button id="ask">请 AI 继续修改</button><button id="mode">切换全屏</button>
    <p id="status">正在加载…</p><p>仅创建本地内存中的模拟申请，不发送真实站内信。</p>
    <script>__BUNDLE__</script></body></html>`.replace('__BUNDLE__', () =>
      result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'),
    ),
  );
  return htmlPromise;
}

/** Browser integration fixture: official SDK parses initialization before the first render. */
export async function viewStateAppHtml() {
  const bundle = await build({
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    stdin: {
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
      contents: `
      import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
      import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
      const app = new App({name:'View state browser fixture',version:'1.0.0'},{});
      const output = document.querySelector('output');
      const renders = [];
      const render = state => { output.textContent=JSON.stringify(state);renders.push(output.textContent); };
      app.onteardown = async () => ({});
      window.stateProbe = {
        renders,
        ready: (async () => {
          await app.connect();
          const context=app.getHostContext();
          const capabilities=app.getHostCapabilities();
          const saved=context?.['cindy/view-state'];
          render(saved?.version===1?saved:{version:1,page:1,filter:''});
          return {context,capabilities};
        })(),
        save: async state => {
          const result=await app.request({method:'cindy/view-state/set',params:{state}},EmptyResultSchema);
          render(state);
          return result;
        },
      };
      `,
    },
  });
  return '<!doctype html><html><body><output></output><script>' +
    bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
}

export function createMockAppServer({ instructions } = {}) {
  const server = new McpServer({ name: 'cindy-mcp-apps-mock', version: '1.0.0' }, { instructions });
  let count = 0;
  registerAppTool(
    server,
    'draft_form',
    {
      title: '模拟申请表',
      description: 'Display an editable application draft. Only the user can submit it.',
      inputSchema: { title: z.string(), body: z.string() },
      _meta: { ui: { resourceUri: MOCK_RESOURCE } },
    },
    async (args) => ({
      content: [{ type: 'text', text: 'Draft: ' + args.title }],
      structuredContent: args,
      _meta: {
        viewOnly: 'metadata-for-the-view',
        hostUi: getUiCapability(server.server.getClientCapabilities()),
      },
    }),
  );
  registerAppTool(
    server,
    'create_application',
    {
      description: 'Create an in-memory simulated application. Does not send a message.',
      inputSchema: { title: z.string().min(1), body: z.string() },
      _meta: { ui: { visibility: ['app'] } },
    },
    async () => ({
      content: [{ type: 'text', text: '已创建模拟申请 ' + ++count + '，未发送站内信。' }],
      structuredContent: { applicationId: count, sent: false },
    }),
  );
  server.registerTool(
    'model_only',
    { inputSchema: {}, _meta: { ui: { visibility: ['model'] } } },
    async () => ({ content: [{ type: 'text', text: 'model only' }] }),
  );
  registerAppResource(
    server,
    'application',
    MOCK_RESOURCE,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: MOCK_RESOURCE,
          mimeType: RESOURCE_MIME_TYPE,
          text: await mockAppHtml(),
          _meta: { ui: { csp: {}, prefersBorder: true } },
        },
      ],
    }),
  );
  return server;
}

/** Both HTTP and legacy SSE, allocated loopback port, independently disposable. */
export async function startMockAppServer({ createServer = createMockAppServer } = {}) {
  const transports = new Map();
  const servers = new Set();
  const listener = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        const server = createServer();
        servers.add(server);
        transports.set(transport.sessionId, transport);
        await server.connect(transport);
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        const transport = transports.get(url.searchParams.get('sessionId'));
        if (!(transport instanceof SSEServerTransport)) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
      const id = req.headers['mcp-session-id'];
      let transport = typeof id === 'string' ? transports.get(id) : undefined;
      if (!transport && !id && body?.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport),
        });
        const server = createServer();
        servers.add(server);
        await server.connect(transport);
      }
      if (!(transport instanceof StreamableHTTPServerTransport)) {
        res.writeHead(404).end();
        return;
      }
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + listener.address().port;
  return {
    url: base + '/mcp',
    sseUrl: base + '/sse',
    async close() {
      await Promise.allSettled([...servers].map((server) => server.close()));
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const createServer = process.argv.includes('--raw')
    ? (await import('./mcp-apps-raw-fixture.mjs')).createRawAppServer
    : createMockAppServer;
  const instance = await startMockAppServer({ createServer });
  console.log('MCP Apps mock HTTP: ' + instance.url + '\nMCP Apps mock SSE: ' + instance.sseUrl);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void instance.close().then(() => process.exit(0));
    });
}

/** E2E: page-authored React instance, actual built-in modules and official SDK. */
export async function viewStateHelperHtml(kind) {
  const react = kind === 'react';
  const bundle = await build({ bundle: true, write: false, format: 'esm', minify: true,
    external: ['@modelcontextprotocol/ext-apps', '@cindy/ext-apps', '@cindy/ext-apps/react'],
    stdin: { resolveDir: path.dirname(fileURLToPath(import.meta.url)), contents: `
      import { App } from '@modelcontextprotocol/ext-apps';
      ${react ? "import * as React from 'react'; import {createRoot} from 'react-dom/client';" : ''}
      const app = new App({name:'State helper fixture',version:'1'}, {}, {autoResize:false});
      const initial = {version:1,page:1,filter:''};
      const renders=[];
      let set, flush, save, dispose=()=>{};
      const probe=window.stateProbe={renders};
      probe.ready=(async()=>{
        await app.connect();
        const core=await import('@cindy/ext-apps').catch(()=>null);
        ${react ? `
          const module=await import('@cindy/ext-apps/react').catch(()=>null);
          const useViewState=module ? module.createViewStateHooks(React).useViewState : (_app,initial)=>React.useState(initial);
          let mounted;
          const mountReady=new Promise(resolve=>{mounted=resolve;});
          flush=()=>core ? core.flushViewState(app) : Promise.reject(new Error('VIEW_STATE_UNSUPPORTED'));
          function Editor(){
            const [value,update]=useViewState(app,initial);
            renders.push(JSON.stringify(value)); set=update;
            React.useEffect(()=>{mounted();},[]);
            return React.createElement('div',null,
              React.createElement('output',null,JSON.stringify(value)),
              React.createElement('button',{id:'save-state',onClick:async()=>{
                const action=probe.action;
                if(action.state)update(action.state);
                else {update(v=>({...v,page:v.page+1}));update(v=>({...v,page:v.page+1}));}
                try {await flush();action.resolve({});} catch(error){action.reject(error);}
              }},'Edit and save'));
          }
          const root=createRoot(document.querySelector('#root'));
          root.render(React.createElement(React.StrictMode,null,React.createElement(Editor)));
          await mountReady;
          save=state=>new Promise((resolve,reject)=>{
            probe.action={state,resolve,reject};document.querySelector('#save-state').click();
          });
          probe.sameEvent=()=>save();
          dispose=()=>root.unmount();
        ` : `
          let local=initial;
          const state=core ? core.createViewState(app,initial) : {get:()=>local,set:next=>{local=next;},flush:()=>Promise.reject(new Error('VIEW_STATE_UNSUPPORTED')),dispose(){}};
          const render=()=>{const text=JSON.stringify(state.get());document.querySelector('output').textContent=text;renders.push(text);};
          set=next=>{state.set(next);render();}; flush=()=>state.flush();dispose=()=>state.dispose();render();
          save=async next=>{set(next);await flush();return {};};
        `}
        return {context:app.getHostContext(),capabilities:app.getHostCapabilities(),loaded:!!core};
      })();
      probe.local=state=>{set(state);};
      probe.save=state=>save(state);
      app.onteardown=async()=>{dispose();return {};};
    ` } });
  return '<!doctype html><html><body><div id="root"><output></output></div><script type="module">' +
    bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
}
