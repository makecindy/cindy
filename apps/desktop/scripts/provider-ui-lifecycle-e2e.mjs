import { assertProviderE2EProfile } from './provider-e2e-profile.mjs';
// Real Desktop UI, IPC, SQLite and loopback server; fake keys only.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url);
assert.ok(/CindyGlobal-dev2-provider-auto-detection-[^/]+\/cindy-local-v1\.db$/.test(process.env.E2E_DB??''));
const db=new (require('better-sqlite3'))(process.env.E2E_DB,{readonly:true});
const out=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-provider-ui-lifecycle-'));
const wires=['openai-chat','openai-responses','anthropic-messages','google-generative-ai'];
const model='e2e-lifecycle-model';
const records=[],created=[],requests=[],held=[];
let desired=wires[0],hold=false,reject=false;
function frames(wire) {
  const events = wire === 'openai-responses' ? [
    { type: 'response.created', response: { id: 'reply' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.completed', response: { id: 'reply', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  ] : wire === 'anthropic-messages' ? [
    { type: 'message_start', message: { id: 'reply', model, role: 'assistant', type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : wire === 'google-generative-ai' ? [{ candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }] : [{ id: 'reply', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] },
    { id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }];
  return events;
}
const encode = events => events.map(e => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');

const server=http.createServer(async(req,res)=>{
 const parts=[];for await(const p of req)parts.push(p);
 const url=new URL(req.url,'http://fixture');
 const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))};
 if(req.method==='GET')return url.pathname.endsWith('/models')?json({data:[{id:model}]}):json({error:'not found'},404);
 const wire=url.pathname.endsWith('/chat/completions')?wires[0]:url.pathname.endsWith('/responses')?wires[1]:url.pathname.endsWith('/messages')?wires[2]:wires[3];
 const requestModel=JSON.parse(Buffer.concat(parts).toString()||'{}').model??decodeURIComponent(url.pathname.split('/models/')[1]?.split(':')[0]??'');
 if(requestModel!==model)return json({error:'unexpected model'},400);
 const row={path:url.pathname,wire,model:requestModel,engine:req.headers['x-e2e-engine'],closed:false,key:req.headers.authorization??req.headers['x-api-key']??req.headers['x-goog-api-key']};
 requests.push(row);res.on('close',()=>{row.closed=true});
 const respond=()=>{if(res.destroyed)return;if(reject||wire!==desired)return json({error:{code:'unsupported_protocol',message:'protocol not supported'}},400);res.writeHead(200,{'content-type':'text/event-stream'});res.end(encode(frames(wire)))};
 if(hold)held.push(respond);else respond();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser,page;
const row=id=>db.prepare('SELECT * FROM custom_providers WHERE id=?').get(id.replace(/^custom:/,''));
const persist=async()=>fs.writeFile(path.join(out,'results.json'),JSON.stringify({records,created,requests},null,2));
async function record(name,details={}){records.push({name,pass:true,...details});await persist();if(await page.getByRole('dialog').count())await page.getByRole('dialog').screenshot({path:path.join(out,name+'.png')});console.log('PASS',name)}
async function closeDialog(){if(await page.getByRole('dialog').count()){await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'})}}
async function open(name,base=origin+'/team/v1'){
 await closeDialog();await page.getByRole('button',{name:'添加供应商',exact:true}).click();await page.getByText('自定义端点',{exact:true}).click();
 await page.getByPlaceholder('我的 AI 供应商').fill(name);await page.getByPlaceholder('API 密钥',{exact:true}).fill('fake-lifecycle-key');await page.getByPlaceholder('https://api.myprovider.com/v1').fill(base);
 await page.getByText(model+' 自动识别',{exact:true}).waitFor();
}
async function success(){await page.getByText(/^连接成功（/).waitFor()}
async function test(){await page.getByRole('dialog').getByRole('button',{name:'测试连接',exact:true}).click()}
async function save(name){await page.getByRole('button',{name:'保存供应商',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const provider=await page.evaluate(async name=>(await window.electronAPI.maker.listProviders()).providers.find(p=>p.name===name),name);assert.ok(provider);created.push(provider.id);await persist();return provider}
async function edit(name){await page.getByRole('button').filter({hasText:name}).first().click();await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.getByRole('menuitem',{name:'编辑连接设置',exact:true}).click();await page.getByPlaceholder('我的 AI 供应商').waitFor()}
try{
 browser=await chromium.connectOverCDP(process.env.E2E_CDP_URL ?? 'http://127.0.0.1:19427');await assertProviderE2EProfile(browser,process.env.E2E_DB);page=browser.contexts()[0].pages().find(p=>p.url().includes('/#/settings'));assert.ok(page);page.setDefaultTimeout(15000);
 for(const action of ['legacy','id'].includes(process.env.E2E_ONLY)?[]:['stop','close','address','key']){
  await open('E2E lifecycle '+action);desired=wires[0];hold=true;const start=requests.length;await test();
  while(requests.length===start)await page.waitForTimeout(20);
  if(action==='stop')await page.getByRole('button',{name:'停止测试',exact:true}).click();
  if(action==='close')await closeDialog();
  if(action==='address')await page.getByPlaceholder('https://api.myprovider.com/v1').fill(origin+'/new/v1');
  if(action==='key')await page.getByPlaceholder('API 密钥',{exact:true}).fill('fake-new-key');
  await page.waitForTimeout(250);assert.equal(requests[start].closed,true,'old request must be aborted');
  hold=false;
  if(action==='close')await open('E2E lifecycle reopen');
  await test();await success();const before=await page.getByPlaceholder('https://api.myprovider.com/v1').inputValue();
  for(const release of held.splice(0))release();await page.waitForTimeout(300);
  assert.equal(await page.getByPlaceholder('https://api.myprovider.com/v1').inputValue(),before);await success();
  assert.equal(requests.length-start,2);if(action==='key')assert.equal(requests.at(-1).key,'Bearer fake-new-key');if(action==='address')assert.equal(requests.at(-1).path,'/new/v1/chat/completions');await record('cancel-'+action,{requests:requests.slice(start)});
 }
 for(const wire of ['legacy','id'].includes(process.env.E2E_ONLY)?[]:wires){
  desired=wire;const name='E2E auto '+wires.indexOf(wire)+' '+Date.now();await open(name);const start=requests.length;await test();await success();
  assert.deepEqual(requests.slice(start).map(r=>r.wire),wires.slice(0,wires.indexOf(wire)+1));
  const base=await page.getByPlaceholder('https://api.myprovider.com/v1').inputValue();const again=requests.length;await test();await success();assert.equal(requests.length-again,1);assert.equal(requests.at(-1).wire,wire);
  const p=await save(name);const stored=JSON.parse(row(p.id).runtimes);assert.equal(stored.pi.wireProtocol,wire);assert.equal(stored.pi.baseUrl,base);assert.equal(stored.pi.models[0].route.wireProtocol,wire);
  await page.reload();await page.getByRole('button',{name:'添加供应商',exact:true}).waitFor();await edit(name);assert.equal(await page.getByPlaceholder('https://api.myprovider.com/v1').inputValue(),base);
  const last=requests.length;await test();await success();assert.equal(requests.length-last,1);assert.equal(requests.at(-1).wire,wire);await closeDialog();
  const result=await page.evaluate(id=>window.electronAPI.maker.testProviderConnection({kind:'saved',providerId:id,agent:'pi'}),p.id);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(requests.at(-1).wire,wire);
  await record('auto-save-reopen-call-'+wire,{base,stored});
 }
 if(!['legacy','id'].includes(process.env.E2E_ONLY)){desired=wires[0];const manual='E2E manual '+Date.now();await open(manual);const count=requests.length;const manualProvider=await save(manual);assert.equal(requests.length,count);assert.equal(JSON.parse(row(manualProvider.id).runtimes).pi.wireProtocol,wires[0]);await record('manual-save-without-probe');}
 if(!process.env.E2E_ONLY||process.env.E2E_ONLY==='id'){
  desired=wires[0];
  const prefix=('E2E long '+Date.now()+' ').padEnd(40,'a');
  for(const ending of ['', ' first', ' second']){
   const name=prefix+ending;await open(name);const p=await save(name);
   assert.ok(p.id.length<=40);assert.equal(row(p.id).name,name);
   await page.reload();await page.getByRole('button',{name:'添加供应商',exact:true}).waitFor();await edit(name);
   assert.equal(await page.getByPlaceholder('我的 AI 供应商').inputValue(),name);
   await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.equal(row(p.id).name,name,'editing preserves the ID and display name');
   const result=await page.evaluate(id=>window.electronAPI.maker.testProviderConnection({kind:'saved',providerId:id,agent:'pi'}),p.id);assert.equal(result.ok,true);
   await record('long-id-save-'+(ending.trim()||'boundary'),{id:p.id,name});
  }
  assert.equal(new Set(created).size,created.length);
 }
 if(process.env.E2E_ONLY!=='id'){
 // Existing multi-engine connection is seeded through the real create IPC.
 const id='e2e-independent-'+Date.now(),name='E2E independent '+Date.now();
 const config={id,name,auth:{method:'apiKey'},runtimes:Object.fromEntries(['claude-code','codex','pi'].map(agent=>[agent,{baseUrl:origin+'/'+agent+'/v1',wireProtocol:'openai-chat',headers:{'X-E2E-Engine':agent},models:[{id:model,name:model}]}]))};
 await page.evaluate(({config})=>window.electronAPI.maker.createCustomProvider(config,{'claude-code':'fake-claude','codex':'fake-codex','pi':'fake-pi'}),{config});created.push(id);await persist();
 await page.reload();await page.getByRole('button',{name:'添加供应商',exact:true}).waitFor();await edit(name);
 await page.getByRole('tab',{name:'Pi',exact:true}).click();
 const before=JSON.parse(row(id).runtimes);reject=true;const prior=requests.length;await test();await page.getByRole('button',{name:'测试连接',exact:true}).waitFor();await page.waitForTimeout(300);assert.equal(requests.length-prior,1,'legacy edit probe must not enumerate protocols');reject=false;
 await page.getByPlaceholder('https://api.myprovider.com/v1').fill(origin+'/changed-pi/v1');await page.getByPlaceholder('API 密钥',{exact:true}).fill('fake-pi-edited');
 await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
 const after=JSON.parse(row(id).runtimes);assert.deepEqual(after['claude-code'],before['claude-code']);assert.deepEqual(after.codex,before.codex);assert.equal(after.pi.baseUrl,origin+'/changed-pi/v1');
 for(const agent of ['claude-code','codex','pi']){const result=await page.evaluate(({id,agent})=>window.electronAPI.maker.testProviderConnection({kind:'saved',providerId:id,agent}),{id,agent});assert.equal(result.ok,true);assert.equal(requests.at(-1).engine,agent==='pi'?undefined:agent);assert.equal(requests.at(-1).path,'/'+(agent==='pi'?'changed-pi':agent)+'/v1/chat/completions');assert.equal(requests.at(-1).key,'Bearer '+(agent==='pi'?'fake-pi-edited':agent==='codex'?'fake-codex':'fake-claude'))}
 await record('edit-old-connection-preserves-independent-engines',{before,after});
 }
}catch(e){console.error(e);records.push({error:e.message});process.exitCode=1;if(page)console.error(await page.getByRole('dialog').innerText().catch(()=>''))}
finally{
 if(page){await closeDialog().catch(()=>{});for(const id of created){await page.evaluate(async id=>{const {dataOwnerId,ownerGeneration}=await window.electronAPI.maker.listProviders();await window.electronAPI.maker.deleteCustomProvider(id.replace(/^custom:/,''),{dataOwnerId,ownerGeneration})},id).catch(e=>{records.push({cleanupError:e.message});process.exitCode=1})}}
 await persist();db.close();await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log('REPORT='+out);
}
