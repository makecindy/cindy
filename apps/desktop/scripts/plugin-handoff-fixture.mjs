/** Integration-only plugin for chat file handoff: references on open, bytes only on click. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const HANDOFF_UPLOAD_URL = 'https://upload.example.com/import';

export async function handoffFixture() {
  const tools = [
    { name: 'open_import', description: 'Open the import page. 用户在对话里发的文件，用 ghost_call 的 attachments 交给本工具。',
      parameters: { type: 'object', properties: { cindy_handoff_files: { type: 'array' } } } },
    { name: 'confirm_import', description: 'Upload the confirmed file',
      parameters: { type: 'object', properties: { file: { type: 'string' } } } },
  ];
  const manifest = { schemaVersion: 3, minCindyVersion: '0.1.123-beta', id: 'handoff-import', name: 'Handoff import',
    version: '1.0.0', kind: 'chip', entry: 'main.js', network: { hosts: [new URL(HANDOFF_UPLOAD_URL).hostname] }, tools,
    mcpApps: { ui: { resources: [{ uri: 'ui://import', file: 'ui/import.html' }],
      tools: { open_import: { resourceUri: 'ui://import' }, confirm_import: { visibility: ['app'] } } } } };
  // The page parses the signed read URL locally and uploads only after the click.
  const main = `cindy.onHostMessage(async message=>{if(message.type!=='tool-call')return;
    if(message.tool==='open_import'){cindy.send({type:'tool-result',callId:message.callId,ok:true,result:{content:[{type:'text',text:'Import page ready'}]}});return;}
    const reply=await cindy.fetch({url:${JSON.stringify(HANDOFF_UPLOAD_URL)},method:'POST',upload:{handoff:[message.args.file]}});
    cindy.send({type:'tool-result',callId:message.callId,ok:true,result:{content:[{type:'text',text:reply.ok?'uploaded '+reply.status:'failed '+(reply.errorCode||reply.message)}]}});});`;
  const page = await build({ bundle: true, write: false, format: 'iife', minify: true, stdin: {
    resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    contents: `
      import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
      const app = new App({ name: 'Handoff import', version: '1.0.0' });
      window.handoffState = {};
      let live;
      app.ontoolresult = async () => {
        const items = app.getHostContext()?.toolInfo?.tool?._meta?.['cindy/attachments'] ?? [];
        window.handoffState.names = items.map(item => item.name);
        window.handoffState.urls = items.map(item => item._meta?.['cindy/file']?.url ?? null);
        live = items.find(item => item._meta?.['cindy/file']?.url);
        const text = await (await fetch(live._meta['cindy/file'].url)).text();
        window.handoffState.rows = text.trim().split('\\n').length - 1;
        document.querySelector('#name').textContent = live.name + ' · ' + live.size + ' B';
        window.handoffState.ready = true;
      };
      document.querySelector('#confirm').addEventListener('click', async () => {
        const result = await app.callServerTool({ name: 'confirm_import', arguments: { file: live.uri } });
        window.handoffState.result = result.content[0].text;
      });
      app.connect();
    ` } });
  const html = '<!doctype html><html><body><p id="name">Loading</p><button id="confirm">确认导入</button><script>' +
    page.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
  return { manifest, main, html };
}
