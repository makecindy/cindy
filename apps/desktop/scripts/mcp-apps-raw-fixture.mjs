/** A second, unrelated MCP App. Its View uses only standard JSON-RPC, with no SDK or Cindy APIs. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ReadResourceRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

export const RAW_RESOURCE = 'ui://independent-metrics/dashboard.html';
const mime = 'text/html;profile=mcp-app';
export const RAW_APP_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>body{font:14px var(--font-sans,system-ui);margin:0;padding:16px;color:var(--color-text-primary);background:var(--color-background-primary)}button,input{padding:8px;color:inherit;background:var(--color-background-secondary)}td,th{padding:8px;text-align:left}label{display:block;margin:12px 0}</style>
</head><body><h2>Independent metrics dashboard</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody id="metrics"></tbody></table>
<label>Threshold <input id="threshold" type="number" value="50"></label>
<button id="refresh">Refresh metrics</button><button id="ask">Discuss these metrics</button><button id="mode">Change display mode</button><p id="status">Connecting</p>
<script>
(() => {
  let nextId=1;
  const pending=new Map();
  const state=window.rawApp={notifications:[],responses:[],hostContext:{},ready:false,teardown:false};
  const post=message=>window.parent.postMessage(message,'*');
  const request=(method,params={})=>new Promise((resolve,reject)=>{
    const id=nextId++;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout'));},5000);
    pending.set(id,{resolve,reject,timer});post({jsonrpc:'2.0',id,method,params});
  });
  state.request=request;
  const context=patch=>{
    Object.assign(state.hostContext,patch);
    if(patch.theme){document.documentElement.dataset.theme=patch.theme;document.documentElement.style.colorScheme=patch.theme;}
    for(const [key,value] of Object.entries(patch.styles?.variables??{}))if(value!==undefined)document.documentElement.style.setProperty(key,value);
  };
  const render=result=>{
    state.result=result;
    document.querySelector('#metrics').replaceChildren(...Object.entries(result.structuredContent?.metrics??{}).map(([name,value])=>{
      const row=document.createElement('tr');for(const text of [name,value]){const cell=document.createElement('td');cell.textContent=String(text);row.appendChild(cell);}return row;
    }));
    document.querySelector('#status').textContent='Metrics ready';
  };
  window.addEventListener('message',event=>{
    if(event.source!==window.parent)return;
    const message=event.data;if(!message||message.jsonrpc!=='2.0')return;
    if(message.method){
      if(message.method==='ui/resource-teardown'){state.teardown=true;post({jsonrpc:'2.0',id:message.id,result:{}});return;}
      if(message.id!==undefined){post({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}});return;}
      state.notifications.push(message);
      if(message.method==='ui/notifications/host-context-changed')context(message.params);
      if(message.method==='ui/notifications/tool-input'){state.input=message.params.arguments;document.querySelector('#threshold').value=String(state.input.threshold);}
      if(message.method==='ui/notifications/tool-result')render(message.params);
      if(message.method==='ui/notifications/tool-cancelled')document.querySelector('#status').textContent='Cancelled';
      return;
    }
    const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);state.responses.push(message);
    if(message.error)item.reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else item.resolve(message.result);
  });
  document.querySelector('#threshold').oninput=()=>request('ui/update-model-context',{content:[{type:'text',text:'Metrics threshold edited'}],structuredContent:{threshold:Number(document.querySelector('#threshold').value)}}).catch(error=>{state.error=String(error);});
  document.querySelector('#refresh').onclick=async()=>{try{render(await request('tools/call',{name:'refresh_metrics',arguments:{threshold:Number(document.querySelector('#threshold').value)}}));}catch(error){state.error=String(error);}};
  document.querySelector('#ask').onclick=()=>request('ui/message',{role:'user',content:{type:'text',text:'Discuss the current metrics.'}}).catch(error=>{state.error=String(error);});
  document.querySelector('#mode').onclick=()=>request('ui/request-display-mode',{mode:state.hostContext.displayMode==='fullscreen'?'inline':'fullscreen'}).then(result=>{state.mode=result.mode;});
  request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'Independent metrics dashboard',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}}).then(result=>{
    state.initialize=result;context(result.hostContext??{});state.ready=true;post({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
    post({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:640,height:420}});
  }).catch(error=>{state.error=String(error);});
})();
</script></body></html>`;

/** Manual standard metadata and paginated MCP handlers, independent of ext-apps helpers. */
export function createRawAppServer({
  encoding = 'blob',
  metadata = 'list',
  legacyUri = false,
  csp = {},
} = {}) {
  const server = new McpServer(
    { name: 'independent-metrics', version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    },
  );
  let refreshes = 0,
    cancelled = 0,
    slowStarted = 0,
    revision = 0;
  const ui = { csp, prefersBorder: false };
  const tools = () => [
    {
      name: 'open_metrics',
      title: 'Independent metrics',
      inputSchema: { type: 'object', properties: { threshold: { type: 'number' } } },
      _meta: legacyUri ? { 'ui/resourceUri': RAW_RESOURCE } : { ui: { resourceUri: RAW_RESOURCE } },
    },
    {
      name: 'refresh_metrics',
      title: 'Refresh ' + revision,
      inputSchema: { type: 'object', properties: { threshold: { type: 'number' } } },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'model_audit',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } },
    },
    {
      name: 'slow_metrics',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'notify_change',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      name: 'error_metrics',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['app'] } },
    },
  ];
  server.server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
    const page = params?.cursor === undefined ? 0 : Number(params.cursor);
    if (![0, 2, 4].includes(page))
      throw new McpError(ErrorCode.InvalidParams, 'Invalid fixture cursor');
    return {
      tools: tools().slice(page, page + 2),
      ...(page < 4 ? { nextCursor: String(page + 2) } : {}),
    };
  });
  const result = (args) => ({
    content: [
      { type: 'text', text: 'Independent metrics loaded' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1e8AAAAASUVORK5CYII=',
      },
      {
        type: 'audio',
        mimeType: 'audio/wav',
        data: 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==',
      },
      {
        type: 'resource',
        resource: {
          uri: 'metrics://independent/note',
          mimeType: 'text/plain',
          text: 'Full embedded result',
        },
      },
      {
        type: 'resource',
        resource: {
          uri: 'metrics://independent/binary',
          mimeType: 'application/octet-stream',
          blob: 'AQID',
        },
      },
      {
        type: 'resource_link',
        uri: 'metrics://independent/latest',
        name: 'Latest metrics',
        mimeType: 'application/json',
      },
    ],
    structuredContent: { metrics: { requests: 120, threshold: args.threshold ?? 50, refreshes } },
    _meta: {
      viewOnly: 'independent-view-metadata',
      clientUi: server.server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui'],
    },
  });
  server.server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    if (params.name === 'open_metrics') return result(params.arguments ?? {});
    if (params.name === 'refresh_metrics') {
      refreshes++;
      return result(params.arguments ?? {});
    }
    if (params.name === 'model_audit')
      return { content: [{ type: 'text', text: 'Model-only audit' }] };
    if (params.name === 'error_metrics')
      return {
        isError: true,
        content: [{ type: 'text', text: 'Expected fixture tool error' }],
        _meta: { viewOnly: 'error-details' },
      };
    if (params.name === 'notify_change') {
      revision++;
      await server.server.sendToolListChanged();
      await server.server.sendResourceListChanged();
      await server.server.sendPromptListChanged();
      return { content: [{ type: 'text', text: 'Lists changed' }] };
    }
    if (params.name === 'slow_metrics') {
      slowStarted++;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        extra.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            cancelled++;
            reject(new Error('Fixture cancelled'));
          },
          { once: true },
        );
      });
      return result(params.arguments ?? {});
    }
    throw new McpError(ErrorCode.InvalidParams, 'Unknown fixture tool');
  });
  server.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri === RAW_RESOURCE)
      return {
        contents: [
          {
            uri: RAW_RESOURCE,
            mimeType: mime,
            ...(encoding === 'blob'
              ? { blob: Buffer.from(RAW_APP_HTML).toString('base64') }
              : { text: RAW_APP_HTML }),
            ...(metadata === 'read' ? { _meta: { ui } } : {}),
          },
        ],
      };
    if (params.uri === 'metrics://independent/state')
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({ refreshes, cancelled, slowStarted, revision }),
          },
        ],
      };
    if (params.uri.startsWith('metrics://independent/'))
      return {
        contents: [
          { uri: params.uri, mimeType: 'text/plain', text: 'Metric resource: ' + params.uri },
        ],
      };
    throw new McpError(ErrorCode.InvalidParams, 'Unknown fixture resource');
  });
  server.server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) =>
    params?.cursor === undefined
      ? {
          resources: [{ uri: 'metrics://independent/latest', name: 'Latest metrics' }],
          nextCursor: 'ui',
        }
      : {
          resources: [
            { uri: RAW_RESOURCE, name: 'Independent dashboard', mimeType: mime, _meta: { ui } },
          ],
        },
  );
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{ uriTemplate: 'metrics://independent/{metric}', name: 'Metric' }],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'explain_metrics', description: 'Explain the selected metrics' }],
  }));
  server.server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'Explain these metrics.' } }],
  }));
  return server;
}
