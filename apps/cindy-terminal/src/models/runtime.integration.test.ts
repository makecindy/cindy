import { readNativeCodexCatalog } from '@cindy/app-runtime/codexCustomContextCatalog';
/** Explicit native acceptance only: never uses a real provider or login.
 * CINDY_CODEX_TEST_BINARY=/absolute/codex vitest run src/models/runtime.integration.test.ts
 * A private fake Responses server + real exec-server prove the guest runtime
 * actually routes requests through the task host, with an isolated CODEX_HOME. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, realpath, readlink, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { TerminalSubscriptions } from './subscriptions.js';
import type { Logger, AgentSessionHandle } from '@cindy/maker-core';
import { TerminalTaskHost } from '../tasks/host.js';
import { EngineManager } from '../engines/manager.js';
import {loopbackSsh} from '../testing/loopback-ssh.js';
import { TerminalKnowledge } from '../knowledge.js';

const binary=process.env.CINDY_CODEX_TEST_BINARY;
const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return logger;}};
describe.skipIf(!binary || process.platform==='win32')('terminal real SSH Codex runtime',()=>{
  it('reads the remote native catalog and runs through its daemon and original MCP bridge',async()=>{
    const root=await mkdtemp('/tmp/cindy-cx-');
    const notes:string[]=[], requests:Array<{model:string;tools:unknown}>=[];let toolReturned=false,phase=0;
    const note=(message:string,meta?:Record<string,unknown>)=>{notes.push(`${message} ${JSON.stringify(meta??{})}`);if(notes.length>100)notes.shift();};
    const log:Logger={...logger,debug:note,info:note,warn:note,error:note,child:()=>log};
    const api=createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      if(!req.url?.endsWith('/responses')){res.writeHead(404).end('{}');return;}
      const body=JSON.parse(raw);requests.push({model:body.model,tools:body.tools});
      note('fixture API request',{keys:Object.keys(body),memoryInInput:JSON.stringify(body.input).includes('cindy_memory'),toolOutputs:body.input.filter((item:{type:string})=>item.type==='function_call_output')});
      toolReturned ||= body.input.some((item:{type:string;output?:unknown})=>item.type==='function_call_output'&&(item as {call_id?:string}).call_id===`call-ssh-${phase}`&&JSON.stringify(item.output).includes('categories'));
      const item=requests.length===1?{type:'function_call',id:`fc-ssh-${phase}`,call_id:`call-ssh-${phase}`,namespace:'mcp__cindy_memory',name:'list_tools',arguments:'{}',status:'completed'}:{type:'message',id:'msg-ssh-fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'CODEX_SSH_OK',annotations:[]}]};
      const events=[{type:'response.created',response:{id:'r-ssh-fixture',status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r-ssh-fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
      res.writeHead(200,{'content-type':'text/event-stream','connection':'close'}).end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
    const ssh=await loopbackSsh(root,process.execPath,path.resolve('dist'),log,{codexPackage:path.dirname(path.dirname(binary!))});
    const codexHome=path.join(ssh.remoteHome,'.xdt-server/v1/codex-home');
    await writeFile(path.join(codexHome,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-ssh-key'}),{mode:0o600});
    await writeFile(path.join(codexHome,'config.toml'),['model_provider="fixture"','web_search="disabled"','[model_providers.fixture]','name="Fixture"',`base_url="http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1"`,'wire_api="responses"','requires_openai_auth=false','supports_websockets=false','request_max_retries=0','stream_max_retries=0'].join('\n'));
    const secrets=new Map<string,string>();
    const host=new TerminalTaskHost({profileDir:path.join(root,'profile'),logger:log,emit(){},ssh:ssh.service,nativeStatus:async()=>({authenticated:false}),
      secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}}});
    const knowledge=new TerminalKnowledge({root:path.join(root,'profile'),logger:log,assertCurrent(){},changed(){},workingDirs:async()=>[ssh.remoteHome]});
    host.configureKnowledge(knowledge);
    try{
      await host.ready;await ssh.service.pool.connect('fixture');
      const providers=await ssh.service.invoke('list-codex-models',[{id:'fixture'}],{source:'local'}) as import('@cindy/model-providers').ProviderView[];
      const model=providers[0].models.codex?.[0]?.id;expect(model,notes.join('\n')).toBeTruthy();
      const task=await host.invoke('maker:create-session',[{agentKind:'codex',providerId:'openai',model,workingDir:ssh.remoteHome,remoteHostId:'fixture',permissionMode:'bypassPermissions'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'Reply CODEX_SSH_OK.',clientId:'ssh-codex-first'}]);
      const result=await host.invoke('terminal:tasks:wait',[task.id,'ssh-codex-first']);
      expect(result,notes.join('\n')).toMatchObject({status:'completed',finalText:'CODEX_SSH_OK'});
      expect(requests.length).toBeGreaterThan(0);expect(requests.every(request=>request.model===model)).toBe(true);
      expect(toolReturned,notes.join('\n')).toBe(true);
      await ssh.service.pool.disconnect('fixture');await ssh.service.pool.connect('fixture');
      const requestCount=requests.length;toolReturned=false;phase++;
      // A resumed native thread must reconnect its MCP transport as well as chat.
      requests.length=0;
      await host.invoke('maker:send',[task.id,{text:'List memory tool categories again, then reply CODEX_SSH_OK.',clientId:'ssh-codex-reconnect'}]);
      expect(await host.invoke('terminal:tasks:wait',[task.id,'ssh-codex-reconnect']),notes.join('\n')).toMatchObject({status:'completed',finalText:'CODEX_SSH_OK'});
      expect(requestCount).toBeGreaterThan(1);expect(requests.length).toBeGreaterThan(1);expect(toolReturned,notes.join('\n')).toBe(true);
      expect((await host.storage.get(task.id))?.remoteHostId).toBe('fixture');
      const config=await readFile(path.join(codexHome,'config.toml'),'utf8');expect(config).toContain('cindy-remote-mcp');expect(config).not.toContain('synthetic-ssh-key');
    }catch(error){throw new Error(`${String(error)}\n${notes.join('\n')}`,{cause:error});}
    finally{await host.close();await knowledge.close();await ssh.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
  },90_000);
});
// Original cc-manager + actual native Claude CLI; only synthetic API traffic.
describe.skipIf(!process.env.CINDY_CLAUDE_TEST_BINARY || process.platform==='win32')('terminal real SSH Claude runtime',()=>{
  it('uses the selected API route and calls the original account MCP through SSH',async()=>{
    const address=Object.values(os.networkInterfaces()).flat().find(entry=>entry?.family==='IPv4'&&!entry.internal)?.address;
    if(!address)throw new Error('NATIVE_SSH_TEST_REQUIRES_LOCAL_INTERFACE');
    const root=await mkdtemp('/tmp/cindy-cc-');
    const notes:string[]=[], calls:Array<{model:string;auth:string}>=[];
    let toolRequested=false,toolReturned=false,phase=0;
    const note=(message:string,meta?:Record<string,unknown>)=>{notes.push(`${message} ${JSON.stringify(meta??{})}`);if(notes.length>120)notes.shift();};
    const log:Logger={...logger,debug:note,info:note,warn:note,error:note,child:()=>log};
    const api=createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=chunk;
      if(req.url?.startsWith('/v1/messages/count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":1}');return;}
      if(!req.url?.startsWith('/v1/messages')){res.writeHead(404).end('{}');return;}
      const body=JSON.parse(raw);calls.push({model:body.model,auth:String(req.headers['x-api-key']??req.headers.authorization)});
      const result=body.messages?.flatMap((message:{content:unknown})=>Array.isArray(message.content)?message.content:[]).find((item:{type?:string;tool_use_id?:string})=>item.type==='tool_result'&&item.tool_use_id===`ssh-memory-call-${phase}`);
      if(result){toolReturned=JSON.stringify(result).includes('categories');note('fixture Claude tool result',{result});}
      const tool=body.tools?.find((tool:{name:string})=>tool.name==='mcp__cindy_memory__list_tools');
      note('fixture Claude API',{model:body.model,tools:body.tools?.map((tool:{name:string})=>tool.name),result:!!result});
      const useTool=!!tool&&!toolRequested; if(useTool)toolRequested=true;
      const content=useTool?{type:'tool_use',id:`ssh-memory-call-${phase}`,name:tool.name,input:{}}:{type:'text',text:''};
      const events=[
        {type:'message_start',message:{id:'msg-cc-ssh',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}},
        {type:'content_block_start',index:0,content_block:content},
        {type:'content_block_delta',index:0,delta:useTool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:'CLAUDE_SSH_OK'}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:useTool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}},
        {type:'message_stop'},
      ];
      res.writeHead(200,{'content-type':'text/event-stream','connection':'close'}).end(events.map(event=>`event: ${event.type}
data: ${JSON.stringify(event)}

`).join(''));
    });
    await new Promise<void>(resolve=>api.listen(0,address,resolve));
    const ssh=await loopbackSsh(root,process.execPath,path.resolve('dist'),log,{claudeBinary:process.env.CINDY_CLAUDE_TEST_BINARY!});
    const secrets=new Map<string,string>();
    const host=new TerminalTaskHost({profileDir:path.join(root,'profile'),logger:log,emit(){},ssh:ssh.service,nativeStatus:async()=>({authenticated:false}),
      secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}}});
    const knowledge=new TerminalKnowledge({root:path.join(root,'profile'),logger:log,assertCurrent(){},changed(){},workingDirs:async()=>[ssh.remoteHome]});
    host.configureKnowledge(knowledge);
    try{
      await host.ready;await ssh.service.pool.connect('fixture');
      await host.invoke('maker:provider:custom:create',[{id:'ssh-fixture',name:'SSH fixture',auth:{method:'apiKey'},runtimes:{'claude-code':{baseUrl:`http://${address}:${(api.address() as net.AddressInfo).port}`,wireProtocol:'anthropic-messages',models:[{id:'claude-sonnet-4-6',name:'Claude fixture'}]}}},{'claude-code':'synthetic-claude-ssh-key'}]);
      const task=await host.invoke('maker:create-session',[{agentKind:'claude-code',providerId:'ssh-fixture',model:'claude-sonnet-4-6',workingDir:ssh.remoteHome,remoteHostId:'fixture',permissionMode:'bypassPermissions'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'List the memory tool categories, then reply CLAUDE_SSH_OK.',clientId:'ssh-claude-first'}]);
      expect(await host.invoke('terminal:tasks:wait',[task.id,'ssh-claude-first']),notes.join('\n')).toMatchObject({status:'completed',finalText:'CLAUDE_SSH_OK'});
      expect(toolRequested,notes.join('\n')).toBe(true);expect(toolReturned,notes.join('\n')).toBe(true);
      expect(calls.length).toBeGreaterThan(1);expect(calls.every(call=>call.model==='claude-sonnet-4-6'&&call.auth==='synthetic-claude-ssh-key')).toBe(true);
      await ssh.service.pool.disconnect('fixture');await ssh.service.pool.connect('fixture');phase++;toolRequested=false;toolReturned=false;
      await host.invoke('maker:send',[task.id,{text:'List memory tool categories again, then reply CLAUDE_SSH_OK.',clientId:'ssh-claude-reconnect'}]);
      expect(await host.invoke('terminal:tasks:wait',[task.id,'ssh-claude-reconnect']),notes.join(String.fromCharCode(10))).toMatchObject({status:'completed',finalText:'CLAUDE_SSH_OK'});
      expect(toolRequested).toBe(true);expect(toolReturned,notes.join(String.fromCharCode(10))).toBe(true);

      expect((await host.storage.get(task.id))?.remoteHostId).toBe('fixture');
    }catch(error){throw new Error(`${String(error)}
${notes.join('\n')}`,{cause:error});}
    finally{await host.close();await knowledge.close();await ssh.close();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
  },90_000);
});
describe.skipIf(!binary)('terminal real Codex guest runtime',()=>{
  // Native integration: the synthetic host fixture cannot prove process exit or
  // thread continuity in Codex. Minimal input: complete, reclaim, send again.
  // Linux /proc measurements are observational, never a timing/memory threshold.
  it.skipIf(process.platform !== 'linux').each(['idle-reclaim','explicit-close'] as const)('reclaims a real idle Codex process via %s and resumes its persisted thread', async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-idle-'));
    const tracked=new Map<number,string>();
    const snapshot = async () => {
      const entries = await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, 'utf8');
          const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
          return {pid:Number(name),ppid:Number(fields[1]),state:fields[0],name:stat.slice(stat.indexOf('(')+1,stat.lastIndexOf(')')),
            startTicks:fields[19],cpuTicks:Number(fields[11])+Number(fields[12])};
        } catch { return null; }
      }));
      const owned = new Set([process.pid]);
      for(const entry of entries)if(entry&&tracked.get(entry.pid)===entry.startTicks)owned.add(entry.pid);
      for (let changed = true; changed;) {
        changed = false;
        for (const entry of entries) if (entry && owned.has(entry.ppid) && !owned.has(entry.pid)) {owned.add(entry.pid);changed=true;}
      }
      const processes = await Promise.all(entries.filter(entry => entry && owned.has(entry.pid)).map(async entry => {
        tracked.set(entry!.pid,entry!.startTicks);
        const memory = await readFile(`/proc/${entry!.pid}/smaps_rollup`, 'utf8').catch(() => '');
        const args=entry!.name.startsWith('git')?(await readFile(`/proc/${entry!.pid}/cmdline`,'utf8').catch(()=>'' )).split('\0'):[];
        const cwd=await readlink(`/proc/${entry!.pid}/cwd`).catch(()=>null);
        return {...entry!,pssKiB:Number(memory.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0),
          ...(args.length?{gitAction:args.find(arg=>['clone','fetch','remote-http','remote-https','index-pack'].includes(arg)),
            fixturePaths:args.filter(arg=>arg.startsWith(root+path.sep)).map(arg=>arg.slice(root.length)),
            fixtureCwd:cwd?.startsWith(root+path.sep)?cwd.slice(root.length):null}:{} )};
      }));
      return {at:performance.now(),processes,pssKiB:processes.reduce((sum,item)=>sum+item.pssKiB,0)};
    };
    const idleWindow = async () => {
      const start=await snapshot();
      // Native performance integration: a real 1s interval measures CPU ticks;
      // fake timers cannot measure Linux scheduling or process resource usage.
      await new Promise(resolve=>setTimeout(resolve,1000));
      const end=await snapshot();
      const survivingCpuTicks=end.processes.reduce((sum,item)=>{
        const old=start.processes.find(previous=>previous.pid===item.pid&&previous.startTicks===item.startTicks);
        return sum+(old?item.cpuTicks-old.cpuTicks:0);
      },0);
      return {start,end,survivingCpuTicks,durationMs:end.at-start.at};
    };
    let calls = 0;
    const requests: string[] = [];
    const api = createServer(async (req,res) => {
      let raw='';for await(const chunk of req)raw+=chunk;
      if (!req.url?.endsWith('/responses')) {res.writeHead(404).end('{}');return;}
      calls++;requests.push(raw);
      const item={type:'message',id:`msg-${calls}`,role:'assistant',status:'completed',content:[{type:'output_text',text:'IDLE_OK',annotations:[]}]};
      const events=[{type:'response.created',response:{id:`r-${calls}`,status:'in_progress',output:[]}},
        {type:'response.output_item.done',output_index:0,item},
        {type:'response.completed',response:{id:`r-${calls}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
      res.writeHead(200,{'content-type':'text/event-stream',connection:'close'}).end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
    const secrets=new Map<string,string>();
    const host=new TerminalTaskHost({profileDir:path.join(root,'profile'),logger,emit(){},binaryPaths:{codex:binary},
      nativeStatus:async()=>({authenticated:false}),secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}}});
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create',[{id:'idle-fixture',name:'Idle fixture',auth:{method:'apiKey'},
        runtimes:{codex:{baseUrl:`http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1`,models:[{id:'fixture-model',name:'Fixture'}]}}},{codex:'invalid-idle-fixture-key'}]);
      const task=await host.invoke('maker:create-session',[{agentKind:'codex',providerId:'idle-fixture',model:'fixture-model',workingDir:root}]) as {id:string};
      const send=async(clientId:string,text:string)=>{
        await host.invoke('maker:send',[task.id,{text,clientId}]);
        expect(await host.invoke('terminal:tasks:wait',[task.id,clientId])).toMatchObject({status:'completed',finalText:'IDLE_OK'});
      };
      await send('idle-first','First idle probe. Reply IDLE_OK. Do not call tools.');
      const original=(await host.storage.get(task.id))!;
      const idleBefore=await idleWindow(),before=idleBefore.end;
      const engines=before.processes.filter(item=>item.name==='codex');
      expect(engines.length).toBeGreaterThan(0);
      const started=performance.now();
      if(mode==='idle-reclaim')expect(await host.reclaimIdleCodexTask(task.id)).toBe(true);
      else expect(await host.invoke('maker:close-session',[task.id])).toMatchObject({success:true});
      const reclaimMs=performance.now()-started;
      const reclaimed=await snapshot();
      expect(reclaimed.processes.filter(item=>item.name==='codex')).toHaveLength(0);
      expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
      const idleAfter=await idleWindow();
      const resumeStarted=performance.now();
      await send('idle-second','Second idle probe. Reply IDLE_OK. Do not call tools.');
      const resumeMs=performance.now()-resumeStarted;
      const resumed=await snapshot();
      expect(resumed.processes.some(item=>item.name==='codex')).toBe(true);
      expect((await host.storage.get(task.id))).toMatchObject({sdkSessionId:original.sdkSessionId,workDir:original.workDir});
      expect(calls).toBe(2);
      expect(requests[1]).toContain('First idle probe');
      expect(requests[1]).toContain('Second idle probe');
      const report={mode,node:process.version,platform:process.platform,realEngine:true,modelEndpoint:'loopback-fixture',calls,reclaimMs,resumeMs,before,reclaimed,resumed,idleBefore,idleAfter};
      if(process.env.CINDY_IDLE_REPORT)await writeFile(`${process.env.CINDY_IDLE_REPORT}.${mode}.json`,JSON.stringify(report,null,2));
      console.log('IDLE_RECLAIM_RESULT',JSON.stringify(report));
      // Keep tracking former descendants after reparenting; report any residual
      // process before failing, so the measurement never silently drops it.
      expect(idleAfter.end.processes.filter(item=>item.pid!==process.pid)).toHaveLength(0);
    } finally {
      await host.close();
      // Clean up only descendants observed by this test, even if the production
      // close failed to reap them. This does not change the earlier assertion.
      const remaining=await snapshot();
      for(const item of remaining.processes.filter(item=>item.pid!==process.pid).reverse()) {
        const stat=await readFile(`/proc/${item.pid}/stat`,'utf8').catch(()=>null);
        if(stat?.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19]===item.startTicks) {
          try {process.kill(item.pid,'SIGTERM');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
        }
      }
      api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));
      await rm(root,{recursive:true,force:true});
    }
  },60_000);
  // Native integration: GUI lifecycle writes previously left Codex storage
  // unchanged. Exercise public task APIs, a real CLI and private native history;
  // only the model HTTP endpoint is synthetic. Restart must resume the same ID.
  it('archives and restores the same native thread through GUI commands and a host restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-archive-'));
    const profileDir = path.join(root, 'profile');
    const notes: string[] = [];
    const note = (message: string) => { notes.push(message); if (notes.length > 80) notes.shift(); };
    const log: Logger = { ...logger, debug: note, info: note, warn: note, error: note, child: () => log };
    let calls = 0;
    const api = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (!req.url?.endsWith('/responses')) { res.writeHead(404).end('{}'); return; }
      calls++;
      const item = { type: 'message', id: `msg-${calls}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ARCHIVE_OK', annotations: [] }] };
      const events = [{ type: 'response.created', response: { id: `r-${calls}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `r-${calls}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' }).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const secrets = new Map<string, string>();
    const create = () => new TerminalTaskHost({ profileDir, logger: log, emit() {}, binaryPaths: { codex: binary },
      nativeStatus: async () => ({ authenticated: false }), secretStore: {
        get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); },
      } });
    let host = create();
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create', [{ id: 'archive-fixture', name: 'Archive fixture', auth: { method: 'apiKey' },
        runtimes: { codex: { baseUrl: `http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1`, models: [{ id: 'fixture-model', name: 'Fixture' }] } } }, { codex: 'synthetic-archive-key' }]);
      const task = await host.invoke('maker:create-session', [{ agentKind: 'codex', providerId: 'archive-fixture', model: 'fixture-model', workingDir: root }]) as { id: string };
      await host.invoke('maker:send', [task.id, { text: 'Reply ARCHIVE_OK. Do not call tools.', clientId: 'archive-first' }]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'archive-first']), notes.join('\n')).toMatchObject({ status: 'completed', finalText: 'ARCHIVE_OK' });
      const sdk = (await host.storage.get(task.id))!.sdkSessionId!;
      const index = path.join(profileDir, 'engines', 'codex', 'thread-index', 'locations', `${sdk}.json`);
      const location = async () => JSON.parse(await readFile(index, 'utf8')) as { path: string; sqliteHome: string };
      const initial = await location();
      expect(initial.path).toContain(`${path.sep}sessions${path.sep}`);
      expect(initial.sqliteHome).toBe(await realpath(path.join(profileDir, 'engines', 'codex', task.id)));
      await host.invoke('local-db:sessions:update', [task.id, { status: 'archived' }]);
      await vi.waitFor(async () => {
        const archived = await location();
        expect(archived.path, notes.join('\n')).toContain(`${path.sep}archived_sessions${path.sep}`);
        expect((await readFile(archived.path, 'utf8')).length).toBeGreaterThan(0);
      }, { timeout: 15_000, interval: 10 });
      await host.close(); host = create(); await host.ready;
      await host.invoke('local-db:sessions:update', [task.id, { status: 'active' }]);
      await vi.waitFor(async () => expect((await location()).path, notes.join('\n')).toContain(`${path.sep}sessions${path.sep}`), { timeout: 15_000, interval: 10 });
      await host.invoke('maker:send', [task.id, { text: 'Reply ARCHIVE_OK again. Do not call tools.', clientId: 'archive-second' }]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'archive-second']), notes.join('\n')).toMatchObject({ status: 'completed', finalText: 'ARCHIVE_OK' });
      expect((await host.storage.get(task.id))!.sdkSessionId).toBe(sdk);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await host.close(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // Native integration: a saved budget must reach the real Codex app-server's
  // own catalog and thread configuration, including lazy rebuild and restart.
  // A fake handle cannot prove that the CLI accepts/applies the configured window.
  it('applies saved context budgets to native Codex and resumes the original thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-context-'));
    const profileDir = path.join(root, 'profile');
    const calls: string[] = [];
    const nativeCatalog = await readNativeCodexCatalog(binary!, path.join(profileDir, 'catalog'));
    const model = nativeCatalog.models.find(model => typeof model.context_window === 'number')!.slug;
    const api = createServer(async (req, res) => {
      for await (const _ of req) { /* synthetic request only */ }
      calls.push(String(req.headers.authorization));
      if (req.headers.authorization !== 'Bearer synthetic-budget-key') {res.writeHead(401).end('{}'); return;}
      const id = `budget-response-${calls.length}`;
      const item = {type: 'message', id: `item-${id}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: 'BUDGET_OK', annotations: []}]};
      const events = [{type: 'response.created', response: {id, status: 'in_progress', output: []}},
        {type: 'response.output_item.done', output_index: 0, item},
        {type: 'response.completed', response: {id, status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}}];
      res.writeHead(200, {'content-type': 'text/event-stream', connection: 'close'}).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const secrets = new Map<string, string>();
    const create = () => new TerminalTaskHost({profileDir, logger, emit() {}, binaryPaths: {codex: binary},
      nativeStatus: async () => ({authenticated: false}), secretStore: {get: async key => secrets.get(key) ?? null,
        set: async (key, value) => {secrets.set(key, value);}, delete: async key => {secrets.delete(key);}}});
    let host = create();
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create', [{id: 'budget-fixture', name: 'Budget fixture', auth: {method: 'apiKey'},
        runtimes: {codex: {baseUrl: `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`, models: [{id: model, name: model}]}}}, {codex: 'synthetic-budget-key'}]);
      const target = {agent: 'codex', providerId: 'budget-fixture', modelId: model};
      const owner = await host.invoke('terminal:models:context-owner', []);
      await host.invoke('maker:model-context-limit:set', [target, 200000, owner]);
      const task = await host.invoke('maker:create-session', [{agentKind: 'codex', providerId: 'budget-fixture', model, workingDir: root}]) as {id: string};
      const send = async (clientId: string, window: number) => {
        await host.invoke('maker:send', [task.id, {text: 'Reply briefly. Do not use tools.', clientId}]);
        expect(await host.invoke('terminal:tasks:wait', [task.id, clientId])).toMatchObject({status: 'completed', finalText: 'BUDGET_OK'});
        expect(await host.invoke('maker:model-context-limit:get', [{...target, sessionId: task.id}])).toMatchObject({
          limit: window, isCustomized: true, codexContext: {contextWindow: window}});
        const facts = await host.channelRuntime().getSession(task.id)!.getCodexContextWindowInfo();
        expect(facts!.modelMaxContextWindow).toBeGreaterThanOrEqual(window);
      };
      await send('budget-first', 200000);
      const sdk = (await host.storage.get(task.id))!.sdkSessionId;
      await host.invoke('maker:model-context-limit:set', [target, 1000000, owner]);
      expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
      await send('budget-larger', 1000000);
      expect((await host.storage.get(task.id))!.sdkSessionId).toBe(sdk);
      await host.close(); host = create(); await host.ready;
      await send('budget-restart', 1000000);
      expect((await host.storage.get(task.id))!.sdkSessionId).toBe(sdk);
      expect(calls).toEqual(Array(3).fill('Bearer synthetic-budget-key'));
    } finally {await host.close(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(root, {recursive: true, force: true});}
  }, 60000);

  // Native integration: the original model transaction must replace a process
  // whose proxy credentials belong to another provider, and preserve its history.
  it('switches native Codex providers without sending the old credentials or losing history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-model-route-'));
    const profileDir = path.join(root, 'profile');
    const requests: Array<{path: string; authorization: string}> = [];
    const notes: string[] = [];
    const note = (message: string) => {notes.push(message); if (notes.length > 80) notes.shift();};
    const log: Logger = {...logger, debug: note, info: note, warn: note, error: note, child: () => log};
    const api = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the synthetic request */ }
      const route = req.url?.startsWith('/b/') ? 'b' : 'a';
      requests.push({path: req.url!, authorization: String(req.headers.authorization)});
      if (req.headers.authorization !== `Bearer synthetic-${route}`) {res.writeHead(401).end('{}'); return;}
      const id = `response-${requests.length}`;
      const item = {type: 'message', id: `message-${id}`, role: 'assistant', status: 'completed',
        content: [{type: 'output_text', text: `PROVIDER_${route.toUpperCase()}`, annotations: []}]};
      const events = [{type: 'response.created', response: {id, status: 'in_progress', output: []}},
        {type: 'response.output_item.done', output_index: 0, item},
        {type: 'response.completed', response: {id, status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}}];
      res.writeHead(200, {'content-type': 'text/event-stream', connection: 'close'}).end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const secrets = new Map<string, string>();
    const create = () => new TerminalTaskHost({profileDir, logger: log, emit() {}, binaryPaths: {codex: binary},
      nativeStatus: async () => ({authenticated: false}), secretStore: {
        get: async key => secrets.get(key) ?? null, set: async (key, value) => {secrets.set(key, value);}, delete: async key => {secrets.delete(key);},
      }});
    let host = create();
    try {
      await host.ready;
      for (const route of ['a', 'b']) await host.invoke('maker:provider:custom:create', [{id: `fixture-${route}`, name: `Fixture ${route}`, auth: {method: 'apiKey'},
        runtimes: {codex: {baseUrl: `http://127.0.0.1:${(api.address() as net.AddressInfo).port}/${route}`, models: [{id: 'fixture-model', name: 'Fixture', efforts: ['high'], defaultEffort: 'high'}]}}}, {codex: `synthetic-${route}`}]);
      const task = await host.invoke('maker:create-session', [{agentKind: 'codex', providerId: 'fixture-a', model: 'fixture-model', workingDir: root}]) as {id: string};
      await host.invoke('maker:send', [task.id, {text: 'Reply briefly. Do not call tools.', clientId: 'route-a'}]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'route-a']), notes.join('\n')).toMatchObject({status: 'completed', finalText: 'PROVIDER_A'});
      const sourceSdk = (await host.storage.get(task.id))!.sdkSessionId!;
      await host.invoke('maker:set-model', [task.id, 'fixture-model', 'fixture-b']);
      await host.invoke('maker:send', [task.id, {text: 'Continue the same history. Do not call tools.', clientId: 'route-b'}]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'route-b']), notes.join('\n')).toMatchObject({status: 'completed', finalText: 'PROVIDER_B'});
      const targetSdk = (await host.storage.get(task.id))!.sdkSessionId!;
      expect(sourceSdk).toBeTruthy(); expect(targetSdk).toBeTruthy();
      expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({providerId: 'fixture-b', model: 'fixture-model'});
      await host.close(); host = create(); await host.ready;
      await host.invoke('maker:send', [task.id, {text: 'Continue again. Do not call tools.', clientId: 'route-restart'}]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'route-restart']), notes.join('\n')).toMatchObject({status: 'completed', finalText: 'PROVIDER_B'});
      expect((await host.storage.get(task.id))!.sdkSessionId).toBe(targetSdk);
      const messages = await host.invoke('local-db:messages:list', [task.id]) as Array<{role: string; clientId: string}>;
      expect(messages.filter(row => row.role === 'user').map(row => row.clientId).sort()).toEqual(['route-a', 'route-b', 'route-restart']);
      expect(requests.map(row => [row.path, row.authorization])).toEqual([
        ['/a/responses', 'Bearer synthetic-a'], ['/b/responses', 'Bearer synthetic-b'], ['/b/responses', 'Bearer synthetic-b'],
      ]);
    } finally {
      await host.close(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
      await rm(root, {recursive: true, force: true});
    }
  }, 60_000);

  it('uses the selected provider and guest-only runtime directory',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-guest-probe-'));
    const guestHome=path.join(root,'guest'),shadow=path.join(root,'shadow'),work=path.join(root,'work');
    await Promise.all([guestHome,shadow,work,path.join(root,'exec-home')].map(dir=>mkdir(dir,{recursive:true})));
    let requests=0,validAuth=true;const bodies:string[]=[];
    const api=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      if(!req.url?.endsWith('/responses')){res.writeHead(404).end('{}');return;}
      requests++;validAuth&&=req.headers.authorization==='Bearer fake-guest-upstream-key';bodies.push(body);
      const item={type:'message',id:'msg-fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'GUEST_ROUTE_OK',annotations:[]}]};
      const events=[{type:'response.created',response:{id:'r-fixture',status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r-fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
      res.writeHead(200,{'content-type':'text/event-stream','connection':'close'}).end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });});
    await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
    const reserve=net.createServer();await new Promise<void>(resolve=>reserve.listen(0,'127.0.0.1',resolve));
    const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(resolve=>reserve.close(()=>resolve()));
    const child=spawn(binary!,['exec-server','--listen',`ws://127.0.0.1:${port}`],{env:{...process.env,CODEX_HOME:path.join(root,'exec-home')},stdio:'ignore'});
    const secrets=new Map<string,string>();let granted=true;
    const host=new TerminalTaskHost({profileDir:path.join(root,'profile'),secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}},logger,emit(){},binaryPaths:{codex:binary},nativeStatus:async()=>({authenticated:false}),authorizeGuestRequest:async()=>granted});
    let handle:AgentSessionHandle|undefined;
    try {
      const until=Date.now()+10_000;
      for(;;){if(await new Promise<boolean>(resolve=>{const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>{socket.destroy();resolve(false);});}))break;if(Date.now()>until)throw new Error('EXEC_SERVER_START_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,25));}
      await host.invoke('maker:provider:custom:create',[{id:'fixture',name:'Fixture',auth:{method:'apiKey'},runtimes:{codex:{baseUrl:`http://127.0.0.1:${(api.address() as net.AddressInfo).port}/v1`,models:[{id:'fixture-model',name:'Fixture model'}]}}},{codex:'fake-guest-upstream-key'}]);
      handle=await host.startHosted({kind:'codex',hostSessionId:'native_guest_probe',shadowDir:shadow,mirrorRoot:root,options:{model:'fixture-model',providerId:'fixture',permissionMode:'bypassPermissions'},workspace:{workingDir:work,extraDirs:[],writableDirs:[],platform:process.platform,shell:process.platform==='win32'?'powershell':'zsh',isGitRepo:false},tunnel:{url:`http://127.0.0.1:${port}`,token:'fixture-exec'},mcpServers:[],guest:true,guestHome,guestProvider:{providerId:'fixture',modelIds:['fixture-model'],routeToken:'fixture-route'}});
      let reply='';let failed=false;
      const complete=(async()=>{for await(const event of handle!.events()){if(event.type==='text')reply+=typeof event.data==='string'?event.data:String((event.data as {text?:string})?.text??'');if(event.type==='error')failed=true;if(event.type==='done')break;}})();
      await handle.send({type:'user',content:'Reply with GUEST_ROUTE_OK. Do not call tools.'});await complete;
      expect(failed).toBe(false);expect(reply).toContain('GUEST_ROUTE_OK');expect(requests).toBeGreaterThan(0);expect(validAuth).toBe(true);
      const config=await readFile(path.join(guestHome,'config.toml'),'utf8').catch(()=> '');expect(config.includes('fake-guest-upstream-key')).toBe(false);
      expect((await readdir(guestHome,{recursive:true})).some(file=>String(file).endsWith('.jsonl'))).toBe(true);
      expect(await readdir(path.join(root,'profile','engines','codex')).catch(()=>[])).toEqual([]);
      expect(bodies.every(body=>JSON.parse(body).model==='fixture-model')).toBe(true);
      granted=false;
      await expect(host.startHosted({kind:'codex',hostSessionId:'revoked_guest_probe',shadowDir:shadow,mirrorRoot:root,options:{model:'fixture-model',providerId:'fixture'},workspace:{workingDir:work,extraDirs:[],writableDirs:[],platform:process.platform,shell:'zsh',isGitRepo:false},tunnel:{url:`http://127.0.0.1:${port}`,token:'fixture-exec'},mcpServers:[],guest:true,guestHome,guestProvider:{providerId:'fixture',modelIds:['fixture-model'],routeToken:'fixture-route'}})).rejects.toThrow('GUEST_PROVIDER_UNAUTHORIZED');
    }finally{await handle?.close().catch(()=>{});await host.close();child.kill();api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
  },90_000);
});

// Native regression: a per-model endpoint must remain behind the private
// credential proxy, and switching a mixed-protocol provider must use the new
// model's API. No real account or external network is used.
describe.skipIf(!process.env.CINDY_PI_TEST_BINARY && process.env.CINDY_TEST_MANAGED_PI !== '1')('terminal real Pi model routes', () => {
  // Integration: a per-task Maker used to dispose the agent and its proxy while
  // an original durable Pi child still owned them. Exercise native tool launch,
  // navigation and actual upstream completion; no mocked agent/process methods.
  it.skipIf(!process.env.CINDY_PI_TEST_BINARY)('keeps a real Pi child alive after parent navigation and closes it at the account boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-pi-child-'));
    const notes: string[] = [];
    const note = (message: string, meta?: Record<string, unknown>) => { notes.push(`${message} ${JSON.stringify(meta ?? {})}`); if (notes.length > 80) notes.shift(); };
    const log: Logger = {...logger, debug: note, info: note, warn: note, error: note, child: () => log};
    let parentCalls = 0;
    let finishChild: (() => void) | undefined;
    let childDisconnected = false;
    let childAuthorized = false;
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const finish = (text: string) => {
        res.setHeader('content-type', 'text/event-stream');
        res.end([
          {id:'native-child',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]},
          {id:'native-child',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}},
        ].map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n');
      };
      if (body.model === 'child-model') {
        childAuthorized = req.headers.authorization === 'Bearer synthetic-child-key';
        res.once('close', () => { childDisconnected = true; });
        finishChild = () => finish('CHILD_FINISHED');
        return;
      }
      if (++parentCalls === 1) {
        res.setHeader('content-type', 'text/event-stream');
        const args = {agent:'worker',task:'Reply CHILD_FINISHED.',model:'child-model',async:true,notify:false};
        const chunks = [
          {id:'launch-child',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'native-child-call',type:'function',function:{name:'subagent',arguments:JSON.stringify(args)}}]},finish_reason:null}]},
          {id:'launch-child',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
        ];
        res.end(chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n');
      } else finish('PARENT_FINISHED');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const secrets = new Map<string, string>();
    const profileDir = path.join(root, 'profile');
    const host = new TerminalTaskHost({profileDir, logger:log, emit(){}, binaryPaths:{pi:process.env.CINDY_PI_TEST_BINARY},
      nativeStatus:async()=>({authenticated:false}), secretStore:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}}});
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create', [{id:'child-fixture',name:'Child fixture',auth:{method:'apiKey'},runtimes:{pi:{
        baseUrl:`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`,wireProtocol:'openai-chat',
        models:['parent-model','child-model'].map(id=>({id,name:id,contextWindow:128000,piApi:'openai-completions'})),
      }}}, {pi:'synthetic-child-key'}]);
      const task = await host.invoke('maker:create-session', [{agentKind:'pi',providerId:'child-fixture',model:'parent-model',workingDir:root,permissionMode:'bypassPermissions'}]) as {id:string};
      const runRoot = path.join(profileDir, 'engines', 'pi', task.id, 'runtime', 'pi-subagent-runs', task.id);
      const readRun = async () => {
        const [id] = await readdir(runRoot);
        return JSON.parse(await readFile(path.join(runRoot, id, 'status.json'), 'utf8')) as {state:string;resultPath?:string;runnerPid?:number};
      };
      await host.invoke('maker:send', [task.id,{text:'Delegate to the child model in the background, then reply PARENT_FINISHED.',clientId:'parent-first'}]);
      expect(await host.invoke('terminal:tasks:wait',[task.id,'parent-first']),notes.join('\n')).toMatchObject({status:'completed',finalText:'PARENT_FINISHED'});
      await vi.waitFor(()=>expect(finishChild,notes.join('\n')).toBeTypeOf('function'),{timeout:10000,interval:20});
      expect(childAuthorized).toBe(true);
      await host.invoke('maker:close-session',[task.id]);
      expect(childDisconnected,notes.join('\n')).toBe(false);
      finishChild!();
      await vi.waitFor(async()=>expect((await readRun()).state,notes.join('\n')).toBe('completed'),{timeout:10000,interval:20});
      const run = await readRun();
      expect(await readFile(run.resultPath!, 'utf8')).toContain('CHILD_FINISHED');
      // A second detached child is still running when the owner logs out.
      parentCalls = 0; finishChild = undefined; childDisconnected = false;
      await host.invoke('maker:send',[task.id,{text:'Launch one more background child.',clientId:'parent-second'}]);
      expect(await host.invoke('terminal:tasks:wait',[task.id,'parent-second']),notes.join('\n')).toMatchObject({status:'completed'});
      await vi.waitFor(()=>expect(finishChild,notes.join('\n')).toBeTypeOf('function'),{timeout:10000,interval:20});
      await host.invoke('maker:close-session',[task.id]);
      await host.close({reason:'account-boundary'});
      await vi.waitFor(()=>expect(childDisconnected).toBe(true),{timeout:10000,interval:20});
    } catch (error) { throw new Error(`${String(error)}\n${notes.join('\n')}`, {cause:error}); }
    finally {await host.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:50});}
  }, 30000);
  it.each(process.platform==='win32'?['local'] as const:['local','ssh'] as const)('keeps endpoint overrides private and switches between native APIs over %s', async target => {
    const root = await mkdtemp(path.join(target==='ssh'?'/tmp':os.tmpdir(), 'cindy-pi-'));
    let piBinary = process.env.CINDY_PI_TEST_BINARY;
    if (!piBinary) {
      try { piBinary = (await new EngineManager({ profileDir: path.join(root, 'managed') }).install('pi')).binary ?? undefined; }
      catch (error) { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); throw error; }
      if (!piBinary) { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); throw new Error('MANAGED_PI_UNAVAILABLE'); }
    }
    const requests: Array<{ path: string; model: string; authorization: string }> = [];
    let toolSteps=0,toolReturned=false;const advertisedTools:string[]=[];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ path: req.url!, model: body.model, authorization: String(req.headers.authorization) });
      if (req.headers.authorization !== (body.model === 'responses-b' ? 'Bearer fake-pi-second-key' : 'Bearer fake-pi-upstream-key')) { res.writeHead(401).end('{}'); return; }
      res.setHeader('content-type', 'text/event-stream');
      if (req.url === '/chat-tenant/chat/completions') {
        advertisedTools.push(...(body.tools??[]).map((entry:{function?:{name?:string}})=>entry.function?.name??''));
        const toolPlan=toolSteps===0?{name:'cindy_mcp_list_tools',args:{server:'cindy_helper',tool:'list_tools'}}:{name:'cindy_mcp_call_tool',args:{server:'cindy_helper',tool:'list_tools',args:{}}};
        const tool=body.tools?.find((entry:{function?:{name?:string}})=>entry.function?.name===toolPlan.name);
        if(target==='ssh'&&toolSteps<2&&tool){
          toolSteps++;
          const chunks=[
            {id:'tool-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:`ssh-helper-${toolSteps}`,type:'function',function:{name:tool.function.name,arguments:JSON.stringify(toolPlan.args)}}]},finish_reason:null}]},
            {id:'tool-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
          ];
          res.end(chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+'data: [DONE]\n\n');return;
        }
        if(target==='ssh')toolReturned=body.messages?.some((message:{role?:string;content?:unknown})=>message.role==='tool'&&JSON.stringify(message.content).includes('categories'))??false;
        const chunks = [
          { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'PI_CHAT_OK' }, finish_reason: null }] },
          { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        res.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
      } else if (req.url === '/responses-tenant/responses') {
        const item = { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PI_RESPONSES_OK', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'r-fixture', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'r-fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else res.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const secrets = new Map<string, string>();
    const runtimeNotes:string[]=[];
    const note=(message:string,meta?:Record<string,unknown>)=>{runtimeNotes.push(`${message} ${JSON.stringify(meta??{})}`);if(runtimeNotes.length>100)runtimeNotes.shift();};
    const taskLogger:Logger={...logger,debug:note,info:note,warn:note,error:note,child:()=>taskLogger};
    const ssh=target==='ssh'?await loopbackSsh(root,piBinary,path.resolve('dist'),taskLogger):undefined;
    const host = new TerminalTaskHost({ profileDir: path.join(root, 'profile'), logger:taskLogger, emit() {}, binaryPaths: { pi: piBinary },ssh:ssh?.service,
      secretStore: { get: async key => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); } },
      nativeStatus: async () => ({ authenticated: false }),
    });
    try {
      await host.ready;
      await host.invoke('maker:provider:custom:create', [{ id: 'mixed-apis', name: 'Mixed APIs', auth: { method: 'apiKey' }, runtimes: { pi: {
        baseUrl: base + '/unused', wireProtocol: 'openai-chat', models: [
          { id: 'chat', name: 'Chat', contextWindow: 128000, piApi: 'openai-completions', route: { baseUrl: base + '/chat-tenant', wireProtocol: 'openai-chat' } },
          { id: 'responses', name: 'Responses', contextWindow: 128000, piApi: 'openai-responses', route: { baseUrl: base + '/responses-tenant', wireProtocol: 'openai-responses' } },
        ],
      } } }, { pi: 'fake-pi-upstream-key' }]);
      await host.invoke('maker:provider:custom:create', [{id: 'mixed_apis', name: 'Second provider', auth: {method: 'apiKey'}, runtimes: {pi: {
        baseUrl: base + '/responses-tenant', wireProtocol: 'openai-responses',
        models: [{id: 'responses-b', name: 'Second Responses', contextWindow: 128000, piApi: 'openai-responses'}],
      }}}, {pi: 'fake-pi-second-key'}]);
      const task = await host.invoke('maker:create-session', [{ agentKind: 'pi', providerId: 'mixed-apis', model: 'chat', workingDir: ssh?.remoteHome??root,...(ssh?{remoteHostId:'fixture'}:{}) }]) as { id: string };
      if(ssh)expect((await host.storage.get(task.id))?.remoteHostId).toBe('fixture');
      await host.invoke('maker:send', [task.id, { text: target==='ssh'?'List the Cindy helper tool categories, then reply briefly.':'Reply briefly. Do not call tools.', clientId: 'chat-input' }]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'chat-input'])).toMatchObject({ status: 'completed', finalText: 'PI_CHAT_OK' });
      if(ssh){expect(toolSteps,JSON.stringify(advertisedTools)).toBe(2);expect(toolReturned).toBe(true);await ssh.service.pool.disconnect('fixture');await ssh.service.pool.connect('fixture');
        // Same as opening the usage view in GUI: restore the native runtime so
        // the original remote-Pi window guard can verify the new model.
        await host.invoke('maker:get-context-usage', [task.id]);
      }
      await host.invoke('maker:set-model', [task.id, 'responses', 'mixed-apis']);
      await host.invoke('maker:send', [task.id, { text: 'Reply again. Do not call tools.', clientId: 'responses-input' }]);
      const second=await host.invoke('terminal:tasks:wait', [task.id, 'responses-input']);
      expect(second,runtimeNotes.join('\n')).toMatchObject({ status: 'completed', finalText: 'PI_RESPONSES_OK' });
      const originalSdk = (await host.storage.get(task.id))!.sdkSessionId;
      await host.invoke('maker:set-model', [task.id, 'responses-b', 'mixed_apis']);
      await host.invoke('maker:send', [task.id, {text: 'Continue on the second provider. Do not call tools.', clientId: 'other-provider'}]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'other-provider']), runtimeNotes.join('\n')).toMatchObject({status: 'completed', finalText: 'PI_RESPONSES_OK'});
      expect((await host.storage.get(task.id))!.sdkSessionId).toBe(originalSdk);
      expect(requests).toEqual([
        { path: '/chat-tenant/chat/completions', model: 'chat', authorization: 'Bearer fake-pi-upstream-key' },
        ...(ssh?Array.from({length:2},()=>({path:'/chat-tenant/chat/completions',model:'chat',authorization:'Bearer fake-pi-upstream-key'})):[]),
        { path: '/responses-tenant/responses', model: 'responses', authorization: 'Bearer fake-pi-upstream-key' },
        { path: '/responses-tenant/responses', model: 'responses-b', authorization: 'Bearer fake-pi-second-key' },
      ]);
      const home=ssh?path.join(ssh.remoteHome,'.xdt-server/v1/pi-agent-home'):path.join(root, 'profile', 'engines', 'pi');
      const files = await readdir(home, { recursive: true });
      for (const file of files.filter(file => String(file).endsWith('models.json'))) {
        const raw = await readFile(path.join(home, String(file)), 'utf8');
        expect(raw).not.toContain('fake-pi-upstream-key'); expect(raw).not.toContain('fake-pi-second-key');
        expect(raw).not.toContain('/chat-tenant'); expect(raw).not.toContain('/responses-tenant');
      }
      if(ssh){
        expect(ssh.forwardPorts.length).toBeGreaterThanOrEqual(2);
        expect((await host.storage.get(task.id))?.remoteHostId).toBe('fixture');
        await expect(readdir(path.join(root,'profile','engines','pi'))).rejects.toMatchObject({code:'ENOENT'});
      }
    } finally {
      await host.close();await ssh?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, process.env.CINDY_TEST_MANAGED_PI === '1' ? 180_000 : 30_000);
});

// Real native clients exercise the subscription protocol, while the account
// and HTTP server are synthetic. No system credential is read or changed.
for (const [kind, envKey] of [['pi', 'CINDY_PI_TEST_BINARY'], ['codex', 'CINDY_CODEX_TEST_BINARY'], ['claude-code', 'CINDY_CLAUDE_TEST_BINARY']] as const) {
  for (const subscription of ['openai', 'xai'] as const) it.skipIf(!process.env[envKey] && process.env.CINDY_TEST_NATIVE_SUBSCRIPTIONS !== '1')(`routes ${subscription === 'xai' ? 'SuperGrok' : 'ChatGPT'} through real ${kind} with an owner-private proxy`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-subscription-'));
    let nativeBinary = process.env[envKey];
    if (!nativeBinary) {
      try { nativeBinary = (await new EngineManager({ profileDir: path.join(root, 'managed') }).install(kind)).binary ?? undefined; }
      catch (error) { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); throw error; }
      if (!nativeBinary) throw new Error('MANAGED_ENGINE_UNAVAILABLE');
    }
    const calls: Array<{ authorization: string; account: string; model: string; tools?: Array<{ type: string }>; effort?: string; tier?: string }> = [];
    const api = createServer(async (req, res) => {
      if (req.url?.startsWith('/user')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ userId: 'synthetic-owner' })); return; }
      if (req.url?.startsWith('/models') && subscription === 'xai') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'grok-fixture', name: 'Grok fixture', context_window: 128000, max_completion_tokens: 4096 }] })); return; }
      if (req.url?.startsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({models:[{slug:'gpt-5.4-mini',display_name:'GPT fixture',visibility:'list',supported_in_api:true,context_window:128000,supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high',service_tiers:[{id:'priority'}]}]})); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls.push({ authorization: String(req.headers.authorization), account: String(req.headers['chatgpt-account-id']), model: body.model, tools: body.tools, effort: body.reasoning?.effort, tier: body.service_tier });
      const item = { type: 'message', id: 'msg-fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SUBSCRIPTION_NATIVE_OK', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg-fixture', part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg-fixture', delta: 'SUBSCRIPTION_NATIVE_OK' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.setHeader('content-type', 'text/event-stream'); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', ((url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const target = String(url);
      if (target.startsWith('https://chatgpt.com/backend-api/codex/')) return originalFetch(target.replace('https://chatgpt.com/backend-api/codex', base), init);
      if (target.startsWith('https://api.x.ai/v1/')) return originalFetch(target.replace('https://api.x.ai/v1', base), init);
      if (target.startsWith('https://cli-chat-proxy.grok.com/v1/')) return originalFetch(target.replace('https://cli-chat-proxy.grok.com/v1', base), init);
      return originalFetch(url, init);
    }) as typeof fetch);
    const secrets = new Map<string, string>([['terminal:native:openai', JSON.stringify({ tokens: { access_token: 'synthetic-native-subscription', account_id: 'synthetic-owner' } })]]);
    const store = { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
    const errors: unknown[] = [];
    const host = new TerminalTaskHost({ profileDir: path.join(root, 'profile'), logger, emit(channel, args) { if (channel === 'maker:event' && (args[0] as {event?:{type?:string}})?.event?.type === 'error') errors.push(args[0]); }, binaryPaths: { [kind]: nativeBinary }, secretStore: store, nativeStatus: async () => ({ authenticated: false }) });
    const ownerStore = { getSync: (key: string) => secrets.get(key) ?? null, setSync: (key: string,value: string) => { secrets.set(key,value); }, deleteSync: (key: string) => { secrets.delete(key); } };
    if (subscription === 'xai') { secrets.set('terminal:native:xai', JSON.stringify({ access_token: 'synthetic-native-subscription' })); secrets.set('terminal:native:xai:bound', '1'); }
    const accounts = new TerminalSubscriptions({ root, models: host.models, secrets: ownerStore, binary: async () => null, assertCurrent() {}, changed() {} });
    try {
      await host.ready;
      const model = subscription === 'xai' ? (await host.models.views()).find(p => p.id === 'xai')!.models[kind]!.find(m => m.id.endsWith('grok-fixture'))!.id : kind === 'codex' ? 'gpt-5.4-mini' : 'chatgpt/gpt-5.4-mini';
      const task = await host.invoke('maker:create-session', [{ agentKind: kind, providerId: subscription, model, workingDir: root, ...(subscription==='openai'?{effort:'low',fastMode:true}:{}) }]) as { id: string };
      await host.invoke('maker:send', [task.id, { text: 'Reply briefly. Do not call tools.', clientId: 'native-subscription-input' }]);
      const receipt = await host.invoke('terminal:tasks:wait', [task.id, 'native-subscription-input']);
      expect(receipt, JSON.stringify({receipt,errors,calls})).toMatchObject({ status: 'completed', finalText: 'SUBSCRIPTION_NATIVE_OK' });
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(call => call.authorization === 'Bearer synthetic-native-subscription' && (subscription === 'xai' ? call.account === 'undefined' && call.model === 'grok-fixture' && call.tools?.some(tool => tool.type === 'x_search') : call.account === 'synthetic-owner' && call.model === 'gpt-5.4-mini'))).toBe(true);
      if(subscription==='openai'){
        expect(calls.at(-1)).toMatchObject({effort:'low',tier:'priority'});
        await host.invoke('maker:set-fast-mode',[task.id,false]);
        await host.invoke('maker:set-effort',[task.id,'high']);
        await host.invoke('maker:send',[task.id,{text:'Reply briefly again.',clientId:'native-prefs-updated'}]);
        expect(await host.invoke('terminal:tasks:wait',[task.id,'native-prefs-updated'])).toMatchObject({status:'completed',finalText:'SUBSCRIPTION_NATIVE_OK'});
        expect(calls.at(-1)?.effort).toBe('high');expect(calls.at(-1)?.tier).not.toBe('priority');
      }
      const providerId = `${subscription}-independent`;
      await host.models.saveProvider({ id: providerId, name: 'Independent account', auth: { method: 'oauth', native: subscription === 'openai' ? 'codex' : 'xai' },
        runtimes: { codex: { baseUrl: subscription === 'openai' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.x.ai/v1', wireProtocol: 'openai-responses', models: [] } },
      }, {}, true);
      const secretKey = `terminal:subscription:${providerId}:terminal:native:${subscription}`;
      secrets.set(secretKey, JSON.stringify(subscription === 'openai' ? { tokens: { access_token: 'independent-subscription', account_id: 'independent-owner' } } : { access_token: 'independent-subscription' }));
      if (subscription === 'xai') secrets.set(`${secretKey}:bound`, '1');
      const independent = await host.invoke('maker:create-session', [{ agentKind: kind, providerId, model, workingDir: root }]) as { id: string };
      await host.invoke('maker:send', [independent.id, { text: 'Reply briefly.', clientId: 'independent-input' }]);
      expect(await host.invoke('terminal:tasks:wait', [independent.id, 'independent-input'])).toMatchObject({ status: 'completed', finalText: 'SUBSCRIPTION_NATIVE_OK' });
      expect(calls.at(-1)?.authorization).toBe('Bearer independent-subscription');
      if (subscription === 'openai') expect(calls.at(-1)?.account).toBe('independent-owner');
    } finally {
      await host.close(); await accounts.close(); vi.unstubAllGlobals(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  }, process.env.CINDY_TEST_NATIVE_SUBSCRIPTIONS === '1' ? 180_000 : 30_000);
}
