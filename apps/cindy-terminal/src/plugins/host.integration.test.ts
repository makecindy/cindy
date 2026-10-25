import {openStandaloneNodeDatabase} from '../database.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TerminalPluginAccount } from './account.js';
import { TerminalPluginPublisher } from './publisher.js';
import { TerminalPluginPreferences } from './preferences.js';
import { createTerminalPluginForge } from './forge.js';
import { createTerminalPluginTask } from './mcp.js';
import { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import { TerminalPluginSetup } from './setup.js';
import { TerminalPluginPages } from './pages.js';
import { parsePluginSecretForm } from './secret-form.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from '@cindy/plugin-runtime/shared/ghost';
import { TerminalProtectedInput } from '../protected-input.js';
import { createPluginSecretPresentation } from '@cindy/plugin-runtime/shared/pluginOauth';
import type { GhostSetupInteractionSnapshot } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
/** Native integration tier: exercises the product's real consent, encrypted
 * vault, installed receipt and browser→Node route. Source-byte/owner changes
 * must revoke a pending approval; keys must never appear in resource responses. */
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,copyFile,rm,readdir,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import JSZip from 'jszip';
import {installedGhostStoragePart} from '@cindy/plugin-runtime/shared/pluginIdentity';
import {RemoteResourceRegistry} from '@cindy/device-link';
import {TerminalPlugins} from './host.js';
import {registerPluginResources} from './resources.js';
import {registerLibraryResources} from './library-resources.js';
import {TerminalSecretStore} from '../secrets.js';
import {TerminalTaskMedia} from '../tasks/media.js';
import {scaffoldGhostDir,packGhostDir} from '@cindy/plugin-runtime/forge';
import {createNativeScaffoldWriter} from '@cindy/plugin-runtime/nativeScaffold';
import {createUtilityFixture} from '../models/utility.fixture.js';

let directory:string,runtime:string;
beforeAll(async()=>{
  directory=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-plugins-'));runtime=path.join(directory,'runtime');
  const source=fileURLToPath(new URL('../../../../packages/plugin-runtime/src/',import.meta.url));
  for(const [entry,out] of [['nativeWorkerEntry.ts','plugin-node-worker.cjs'],['nativeSnapshotWorker.ts','plugin-snapshot-worker.cjs'],['forgeScaffoldWorkerProcess.ts','plugin-scaffold-worker.cjs']])await build({entryPoints:[path.join(source,entry)],outfile:path.join(runtime,out),bundle:true,platform:'node',target:'node22',format:'cjs',logLevel:'silent'});
  await build({entryPoints:[path.join(source,'library/libraryDbWorker.ts')],outfile:path.join(runtime,'plugin-library-worker.mjs'),bundle:true,platform:'node',target:'node22',format:'esm',logLevel:'silent'});
  await copyFile(path.join(source,'mailComposeRuntime.js'),path.join(runtime,'plugin-mail-runtime.js'));
});
afterAll(async()=>{await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

/** Integration/security: an older installed receipt may predate independent
 * task/target approval. Owner resource actions must confirm the exact revision,
 * retain both approvals across restart, and reject a stale controller. */
it('grants legacy task and target capabilities only through revision-bound owner actions',async()=>{
  const root=path.join(directory,'legacy-target-owner');
  const archive=new JSZip();
  archive.file('ghost.json',JSON.stringify({schemaVersion:2,id:'legacy-target-fixture',name:'Legacy target fixture',version:'1.0.0',kind:'chip',entry:'main.js',slots:['agent'],agent:{tasks:true,targets:true}}));
  archive.file('main.js','');const file=path.join(directory,'legacy-target.cindy');await writeFile(file,await archive.generateAsync({type:'nodebuffer'}));
  let active=true;
  const secrets={get:async()=>null,set:async()=>{},delete:async()=>{},getSync:()=>null,setSync:()=>{},deleteSync:()=>{},setManySync:()=>{}};
  const options={root,deferStart:true,runtimeDirectory:runtime,executablePath:'unused',secrets,assertCurrent:()=>{if(!active)throw new Error('OWNER_CHANGED');},locale:()=> 'en',changed:()=>{},receive:async()=>({}),cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false as const,reason:'cancelled' as const}),writeSaveDeposit:async()=>null}};
  let host=new TerminalPlugins(options);
  try {
    await host.ready;
    const installed=await host.native.manager.install(file);
    if('rejection' in installed)throw new Error('FIXTURE_INSTALL_REJECTED');
    const id=installedGhostStoragePart(installed.ghost);
    const registry=new RemoteResourceRegistry();registerPluginResources(registry,host);
    const context={controllerDeviceId:'owner',assertCurrent:options.assertCurrent};const client={protocolVersion:1,primitives:['text','actions'],locale:'en'};
    const ref={collectionId:'plugins',kind:'plugin',id};
    const resource=await registry.get(context,{client,ref});
    const task=resource.actions!.find(action=>action.id.startsWith('approve-capability:tasks:'))!;
    expect(task.confirmation?.body).toBeDefined();expect(resource.actions!.some(action=>action.id.startsWith('approve-capability:targets:'))).toBe(false);
    await registry.invoke(context,{client,collectionId:'plugins',resourceRef:ref,actionId:task.id});
    const target=(await registry.get(context,{client,ref})).actions!.find(action=>action.id.startsWith('approve-capability:targets:'))!;
    expect(host.installed(id)).toMatchObject({taskCapabilityApproved:true});
    await expect(registry.invoke(context,{client,collectionId:'plugins',resourceRef:ref,actionId:'approve-capability:targets:stale'})).rejects.toThrow('PLUGIN_CHANGED');
    active=false;await expect(registry.invoke(context,{client,collectionId:'plugins',resourceRef:ref,actionId:target.id})).rejects.toThrow('OWNER_CHANGED');active=true;
    expect(host.installed(id)?.targetCapabilityApproved).toBeUndefined();
    await registry.invoke(context,{client,collectionId:'plugins',resourceRef:ref,actionId:target.id});
    await host.close();host=new TerminalPlugins(options);await host.ready;
    expect(host.installed(id)).toMatchObject({taskCapabilityApproved:true,targetCapabilityApproved:true});
  } finally {await host.close();}
});

it('creates and packs a real plugin using the cwd-bound Node scaffold worker without replacing files',async()=>{
  const input={dir:path.join(directory,'author'),template:'node-json-rpc' as const,id:'terminal-authored',name:'Terminal authored',minCindyVersion:'0.1.0'};
  const options={sessionWorkdir:directory,writeScaffold:createNativeScaffoldWriter({nodePath:process.execPath,workerPath:path.join(runtime,'plugin-scaffold-worker.cjs')})};
  expect(await scaffoldGhostDir(input,options)).toMatchObject({ok:true});
  const manifest=await readFile(path.join(input.dir,'ghost.json'));
  expect(await scaffoldGhostDir({...input,name:'Must not replace'},options)).toMatchObject({ok:false,errorCode:'TARGET_EXISTS'});
  expect(await readFile(path.join(input.dir,'ghost.json'))).toEqual(manifest);
  expect(await packGhostDir(input.dir,{sessionWorkdir:directory})).toMatchObject({ok:true,manifest:{id:'terminal-authored'}});
});

it('requires confirmation of exact bytes and keeps native credentials private across restart',async()=>{
  const modelCleanup:Array<()=>Promise<unknown>>=[],modelFixture=await createUtilityFixture(modelCleanup),utility=modelFixture.create();
  await utility.update({models:[modelFixture.pin('first'),modelFixture.pin('second')]});
  const artifact='terminal-verified-download',artifactHash=createHash('sha256').update(artifact).digest('hex');
  const archive=new JSZip();
  archive.file('ghost.json',JSON.stringify({schemaVersion:2,id:'terminal-fixture',name:'Terminal fixture',version:'1.0.0',kind:'chip',entry:'main.js',settingsHtml:'settings.html',slots:['tool','node','card'],fs:true,tools:[{name:'check',description:'Verify fixture'}],node:{entry:'worker.cjs',protocol:'json-rpc-stdio',secretBindings:[{key:'key',label:'Fixture key',methods:['check']}]}}));
  const withNetwork=JSON.parse(await archive.file('ghost.json')!.async('string'));
  withNetwork.slots.push('network','library');
  withNetwork.slots.push('cindy');withNetwork.cindy={text:['oneshot']};
  withNetwork.setup={requires:[{anyOf:['secret:key']}]};
  withNetwork.network={hosts:['accounts.example.com','api.example.com'],secrets:[{key:'oauth',label:'Fixture account',source:'oauth',inject:{header:'Authorization',format:'Bearer {value}',hosts:['api.example.com']},oauth:{authorizeUrl:'https://accounts.example.com/authorize',tokenUrl:'https://accounts.example.com/token',clientId:'fixture-client',scopes:['read']}}],connections:[{key:'instances',label:'Fixture instance',inject:{header:'Authorization',format:'Bearer {value}'}}]};
  archive.file('ghost.json',JSON.stringify(withNetwork));
  archive.file('main.js',`cindy.onHostMessage(async request=>{
    if(request.type!=='tool-call')return;
    const answer=await cindy.send({type:'cindy-request',kind:'oneshot_text',prompt:'A plugin quick answer'});
    const downloaded=await cindy.send({type:'download-request',kind:'start',id:'browser-artifact',url:'https://api.example.com/artifact',sha256:'${artifactHash}',bytes:${artifact.length}});
    const reply=await cindy.node.request({method:'check',downloadTokens:{artifact:downloaded.token},callId:request.callId,cancelWithCall:true});
    const saved=await cindy.send({type:'fs-request',op:'write',root:'workdir',path:'plugin-result.txt',content:'terminal-plugin-files',callId:request.callId});
    const library=await cindy.send({type:'library-request',op:'write',path:'works/browser.txt',content:'terminal-plugin-library',encoding:'utf8'});
    await cindy.send({type:'card-update',callId:request.callId,html:'<p>Plugin result</p><script>bad()</script>'});
    await fetch('/kv',{method:'PUT',body:JSON.stringify({visited:true})});
    await cindy.send({type:'tool-result',callId:request.callId,ok:true,result:{reply,saved,library,answer,callId:request.callId}});
  });`);
  archive.file('settings.html','<!doctype html><html><body>Fixture</body></html>');
  archive.file('worker.cjs',String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',raw=>{const r=JSON.parse(raw);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{configured:r.cindy?.secrets?.key==='synthetic-acceptance-key',...(r.params?.downloads?{downloaded:require('node:fs').readFileSync(r.params.downloads.artifact,'utf8')}:{})}})+'\n');});`);
  const file=path.join(directory,'fixture.cindy'),bytes=await archive.generateAsync({type:'nodebuffer'});await writeFile(file,bytes);
  const vault=new TerminalSecretStore(path.join(directory,'vault'));await vault.open();await vault.initialize('machine');
  let failCleanup=false;
  const secrets={setManySync:(entries:Record<string,string|null>)=>vault.setManySync(entries),getSync:(key:string)=>vault.getSync(key),setSync:(key:string,value:string)=>vault.setSync(key,value),deleteSync:(key:string)=>vault.deleteSync(key),get:(key:string)=>vault.get(key),set:(key:string,value:string)=>vault.set(key,value),delete:async(key:string)=>{if(failCleanup&&key.includes(':oauth:'))throw new Error('Synthetic vault write interruption');await vault.delete(key);}};
  let active=true;const mediaDb=await openStandaloneNodeDatabase(path.join(directory,'media'),{debug(){},info(){},warn(){},error(){}});
  const media=new TerminalTaskMedia(path.join(directory,'media'),{database:mediaDb,logger:{debug(){},info(){},warn(){},error(){}},isCurrent:()=>active});
  const cardPushes:unknown[]=[];
  const runtimeDiagnostics:string[]=[];
  const options={log:{info(){},warn(message:string,meta?:Record<string,unknown>){runtimeDiagnostics.push(`${message}: ${String(meta?.error??'')}`);}},downloadRequest:async(url:string,_init:RequestInit,beforeDispatch:()=>void)=>{beforeDispatch();expect(url).toBe('https://api.example.com/artifact');return {response:new Response(artifact)};},credentials:{
    getLoginEmail:()=>null,confirmAddHost:async()=>true,
    openExternal:async(url:string)=>{const authorization=new URL(url);const callback=new URL(authorization.searchParams.get('redirect_uri')!);callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('code','synthetic-code');await fetch(callback);},
    fetchImpl:async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{expect(String(input)).toBe('https://accounts.example.com/token');expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('fixture-client');return Response.json({access_token:'synthetic-oauth-access',refresh_token:'synthetic-oauth-refresh',expires_in:3600,scope:'read'});},
  },root:path.join(directory,'owner'),runtimeDirectory:runtime,secrets,assertCurrent:()=>{if(!active)throw new Error('OWNER_CHANGED');},locale:()=> 'en',changed:()=>{},cards:{persist:(row:import('@cindy/plugin-runtime/cardService').GhostCardRow)=>media.savePluginCard(row,()=>{}),broadcast:(payload:unknown)=>{cardPushes.push(payload);}},fs:{getSessionSnapshot:async()=>({workingDir:directory,permissionMode:'bypassPermissions',planModeEnabled:false,remoteHostId:null,isCurrent:()=>active}),requestWriteConfirm:async()=>({confirmed:false as const,reason:'cancelled' as const}),writeSaveDeposit:async()=>null},executablePath:process.env.CINDY_TEST_CHROMIUM??'unused',receive:async()=>{throw new Error('Fixture does not use other slots');}};
  const host=new TerminalPlugins({...options,models:{models:modelFixture.models,utility}});
  const pages=new TerminalPluginPages(host,{assertCurrent:options.assertCurrent,translate:key=>key});
  const wire:unknown[]=[];
  const registry=new RemoteResourceRegistry();registerPluginResources(registry,host,pages);
  const makeAuthorization=(id:string):TerminalProtectedInput=>new TerminalProtectedInput({root:path.join(directory,id),secrets,scope:()=>({realm:'global',membershipId:'fixture-owner',deviceId:id}),assertCurrent:options.assertCurrent,remoteEnabled:()=>true,taskExists:async()=>true,emit:()=>{},
    invoke:async(_device,channel,args)=>{wire.push({channel,args});try{return {ok:true,result:channel==='maker:remote-resources:invoke'?await registry.invoke({controllerDeviceId:id,assertCurrent:options.assertCurrent},args[0] as import('@cindy/device-link').RemoteActionInvokeRequest):await hostAuthorization.request(id,args[0])};}catch{return {ok:false,error:{code:'IPC_ERROR',message:'Synthetic exchange rejected'}};}},
  });
  const hostAuthorization=makeAuthorization('host-device'),controllerAuthorization=makeAuthorization('controller-a');
  hostAuthorization.configurePlugins({bind:async action=>pages.pages.settingsBinding(action),run:()=>false,settingsRequest:(peer,request)=>pages.pages.settingsRequest(peer,request)});
  try{
    const context={controllerDeviceId:'controller-a',assertCurrent:options.assertCurrent},client={protocolVersion:1 as const,primitives:['text','actions'],locale:'en'};
    const prepared=await host.prepareInstall(file,'controller-a');
    expect(await host.list()).toEqual([]);
    await expect(host.confirmInstall(prepared.id,'controller-b')).rejects.toThrow('PLUGIN_CONFIRMATION_EXPIRED');
    await writeFile(file,Buffer.concat([bytes,Buffer.from('changed')]));
    await expect(host.confirmInstall(prepared.id,'controller-a')).rejects.toThrow('PLUGIN_INSTALL_REJECTED');
    expect(await host.list()).toEqual([]);
    await writeFile(file,bytes);
    const valid=await host.prepareInstall(file,'controller-a');const ghost=await host.confirmInstall(valid.id,'controller-a');const instance=installedGhostStoragePart(ghost);
    const resource=await registry.get(context,{client,ref:{collectionId:'plugins',kind:'plugin',id:instance}});
    // Public remote settings must control the model used by the browser pipe.
    expect(resource.actions?.find(action=>action.id==='model')).toBeDefined();
    await registry.invoke(context,{client,collectionId:'plugins',resourceRef:resource.ref,actionId:'model',input:{model:modelFixture.pin('second')}});
    expect((await registry.get(context,{client,ref:resource.ref})).blocks?.find(block=>block.id==='model')?.data).toMatchObject({values:{model:modelFixture.pin('second')}});
    const binding=resource.actions?.find(action=>action.id==='credentials')?.fields?.find(field=>field.id==='key')?.options?.[0].value;
    expect(binding).toBeTruthy();
    const saveRequest={client,collectionId:'plugins',resourceRef:resource.ref,actionId:'credentials',input:{key:binding,value:'synthetic-acceptance-key'}};
    await expect(registry.invoke(context,saveRequest)).rejects.toThrow('PROTECTED_INPUT_REQUIRED');
    // Integration: the public controller entry pins the installed revision and
    // commits through the signed settings exchange. Generic resource traffic
    // must never carry the entered value, including local controller wrappers.
    const form=parsePluginSecretForm({pluginId:instance,...saveRequest.input});
    await controllerAuthorization.saveRemotePluginSecret('host-device',instance,form.key,form.approval,form.value);
    expect(host.readSecretSync(instance,'key')).toBe('synthetic-acceptance-key');
    const oversized='x'.repeat(GHOST_SECRET_VALUE_MAX_CHARS+1);
    expect(()=>parsePluginSecretForm({pluginId:instance,key:binding,value:oversized})).toThrow('PLUGIN_SECRET_INVALID');
    await expect(host.saveSecret(instance,form.key,oversized,form.approval)).rejects.toThrow('PLUGIN_SECRET_INVALID');
    expect(host.readSecretSync(instance,'key')).toBe('synthetic-acceptance-key');
    expect(JSON.stringify(wire)).not.toContain('synthetic-acceptance-key');
    // Integration tier: the public terminal pipe downloads real bytes through
    // the shared verifier, then leases the receipt to the real Node worker.
    const download=await host.receive(instance,{type:'download-request',kind:'start',id:'native-artifact',url:'https://api.example.com/artifact',sha256:artifactHash,bytes:artifact.length}) as {ok:boolean;token:string};
    expect(download).toMatchObject({ok:true,bytes:artifact.length,sha256:artifactHash});
    expect(await host.native.handleNodeRequest(instance,{type:'node-request',method:'check',downloadTokens:{artifact:download.token}})).toMatchObject({ok:true,result:{downloaded:artifact}});
    expect(await host.receive(instance,{type:'download-request',kind:'start',id:'forbidden',url:'https://undeclared.example.com/artifact',sha256:artifactHash,bytes:artifact.length})).toMatchObject({ok:false});

    // The same production settings endpoints feed browser settings and terminal
    // forms. Synthetic provider HTTP still exercises real PKCE/loopback and vault.
    const settings=async(route:string,method='GET',body?:unknown)=>{
      const response=await host.credentials.request(instance,new Request(`https://plugin.invalid${route}`,{method,...(body===undefined?{}:{body:JSON.stringify(body)})}),()=>active);
      expect(response).not.toBeNull();return response!;
    };
    const connected=await settings('/oauth/oauth/connect','POST',{});
    expect(await connected.json()).toMatchObject({ok:true,account:{status:'connected'}});
    expect(await host.credentials.resolveOauthSecret(instance,'oauth')).toMatchObject({ok:true,accessToken:'synthetic-oauth-access'});
    const connection=await settings('/connections/instances','POST',{host:'private.example.com',token:'synthetic-instance-key',label:'Private instance'});
    expect(await connection.json()).toMatchObject({ok:true,connection:{host:'private.example.com'}});
    expect(host.credentials.tokenFor(instance,'PRIVATE.example.com')).toMatchObject({value:'synthetic-instance-key',header:'Authorization'});
    const publicSettings=JSON.stringify([await (await settings('/oauth')).json(),await (await settings('/connections')).json(),await (await settings('/secrets')).json()]);
    expect(publicSettings).not.toMatch(/synthetic-oauth|synthetic-instance-key|synthetic-acceptance-key/);
    expect(JSON.stringify(resource)).not.toContain('synthetic-acceptance-key');
    expect((await readFile(path.join(directory,'vault','secrets.enc'),'utf8'))).not.toContain('synthetic-acceptance-key');
    // Integration tier: the real pending setup card and encrypted controller
    // exchange resume the blocked tool without carrying the entered value in
    // generic interactions, discovery, or task events. Replayed cards must fail.
    const setupEvents:unknown[]=[];
    let onCard!:(card:GhostSetupInteractionSnapshot)=>void;
    const cardReady=new Promise<GhostSetupInteractionSnapshot>(resolve=>{onCard=resolve;});
    const setup=new TerminalPluginSetup(host,{visibility:{translate:key=>key,listGhosts:()=>host.native.list(),isAvailableForActiveSession:()=>true,isDisabledForWorkdir:()=>false},owner:()=>directory,remoteAvailable:()=>true,assertCurrent:options.assertCurrent,translate:key=>key,navigate:()=>{},emit:(_channel,payload)=>{setupEvents.push(payload);const card=(payload as {request?:GhostSetupInteractionSnapshot}).request;if(card?.steps.some(step=>step.action?.kind==='inline_form'&&step.phase==='pending'))onCard(card);}});
    const protectedInput=new TerminalProtectedInput({root:path.join(directory,'protected'),secrets,scope:()=>null,assertCurrent:options.assertCurrent,remoteEnabled:()=>false,taskExists:async()=>true,emit:()=>{},invoke:async()=>({ok:false,error:{code:'IPC_ERROR',message:'No remote peer in this fixture'}})});
    protectedInput.configurePlugins(setup.authorization);
    try{
      host.writeSecretSync(instance,'key',null);host.credentialsChanged(instance);
      expect(host.assessment(instance).state).not.toBe('ready');
      const ready=setup.coordinator.ensureReady({sessionId:'fixture-task',ghostId:instance,workingDir:directory});
      const card=await cardReady,step=card.steps.find(step=>step.action?.kind==='inline_form'&&step.phase==='pending')!;
      if(step.action?.kind!=='inline_form')throw new Error('Inline card missing');
      const submission={kind:'secret',ghostId:instance,action:{requestId:card.requestId,actionId:step.action.id,expectedRevision:card.revision},presentation:createPluginSecretPresentation(card,step,step.action.form.fields[0]),value:'synthetic-acceptance-key'};
      expect(await protectedInput.assistPlugin(submission,{openExternal:async()=>{throw new Error('Secret submission must not open a URL');}})).toEqual({accepted:true});
      expect(await ready).toMatchObject({ok:true});
      expect(host.readSecretSync(instance,'key')).toBe('synthetic-acceptance-key');
      expect(JSON.stringify(setupEvents)).not.toContain('synthetic-acceptance-key');
      await expect(protectedInput.assistPlugin(submission,{openExternal:async()=>{}})).rejects.toThrow('PLUGIN_AUTHORIZATION_STALE');
    }finally{setup.close();await protectedInput.close();}
    if(process.env.CINDY_TEST_CHROMIUM){
      const preferences=new TerminalPluginPreferences(options.root,options.assertCurrent);await preferences.refresh();
      const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.com',pluginApiBaseUrl:'https://plugins.example.com'}),membership:()=>null,token:()=>null,refresh:async()=>{},assertCurrent:options.assertCurrent});
      const publisher=new TerminalPluginPublisher({stagingDirectory:path.join(directory,'publish'),host,account,owner:()=>({mode:'local',dataOwnerId:'fixture',generation:1}),assertCurrent:options.assertCurrent});
      const visibility={translate:(key:string)=>key,listGhosts:()=>host.native.list(),isAvailableForActiveSession:()=>true,isDisabledForWorkdir:(id:string,dir:string|null)=>preferences.disabled(id,dir)};
      const setup=new TerminalPluginSetup(host,{visibility,owner:()=>directory,remoteAvailable:()=>true,assertCurrent:options.assertCurrent,translate:key=>key,navigate:()=>{},emit:()=>{}});
      let readOnly=false;
      const taskContext={sessionId:'fixture-task',workingDir:directory,instanceId:()=> 'fixture-incarnation',assertCurrent:options.assertCurrent,snapshot:async()=>({...await options.fs.getSessionSnapshot(),planModeEnabled:readOnly}),confirm:options.fs.requestWriteConfirm};
      const pluginTask=createTerminalPluginTask({host,setup,preferences,visibility,context:taskContext,media,deposits:new DirDepositVault(),saves:new SaveDepositVault(),forge:createTerminalPluginForge({root:options.root,runtimeDirectory:runtime,host,account,publisher,context:taskContext,media,requestPermission:async()=>null,translate:key=>key})});
      const server=pluginTask.factories.cindy(),client=new McpClient({name:'terminal-native-acceptance',version:'1.0.0'});
      const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
      const payload=(result:Awaited<ReturnType<McpClient['callTool']>>)=>JSON.parse((result.content as Array<{text:string}>)[0].text);
      let called:unknown;
      try{
        await server.connect(serverTransport);await client.connect(clientTransport);
        expect(pluginTask.getGhostRosterPrompt()).toContain('terminal-fixture');
        expect(payload(await client.callTool({name:'ghost_info',arguments:{ghost_id:'terminal-fixture'}}))).toMatchObject({ok:true,ghost:{id:'terminal-fixture'}});
        await preferences.set(directory,instance,true);
        expect(payload(await client.callTool({name:'ghost_info',arguments:{ghost_id:'terminal-fixture'}}))).toMatchObject({ok:false,errorCode:'GHOST_DISABLED_IN_WORKDIR'});
        await preferences.set(directory,instance,false);
        // Native integration regression: the MCP consumer must distinguish bad
        // file input, actual denial and worker failure. The previous catch-all
        // reported every exception as permission denial (and suggested the
        // wrong recovery). No existing successful worker test covers this.
        expect(payload(await client.callTool({name:'ghost_call',arguments:{ghost_id:'terminal-fixture',tool:'check',args:{},dir:file}}))).toMatchObject({ok:false,errorCode:'DIRECTORY_REQUIRED'});
        readOnly=true;
        expect(payload(await client.callTool({name:'ghost_call',arguments:{ghost_id:'terminal-fixture',tool:'check',args:{},save_dir:directory}}))).toMatchObject({ok:false,errorCode:'PERMISSION_DENIED'});
        readOnly=false;
        const failedWorker=vi.spyOn(host,'callTool').mockRejectedValueOnce(new Error('Network failure with synthetic-private-details'));
        try{
          const failure=payload(await client.callTool({name:'ghost_call',arguments:{ghost_id:'terminal-fixture',tool:'check',args:{}}}));
          expect(failure).toMatchObject({ok:false,errorCode:'PLUGIN_CALL_FAILED'});
          expect(JSON.stringify(failure)).not.toContain('synthetic-private-details');
        }finally{failedWorker.mockRestore();}
        called=payload(await client.callTool({name:'ghost_call',arguments:{ghost_id:'terminal-fixture',tool:'check',args:{}}}));
        expect(called, runtimeDiagnostics.join('\n')).toMatchObject({ok:true,result:{reply:{ok:true,result:{configured:true,downloaded:artifact}},saved:{ok:true},library:{ok:true},answer:{ok:true,text:'UTILITY_OK'}}});
        expect(modelFixture.requests).toEqual(['second']);
      }finally{await client.close();await server.close();pluginTask.close();setup.close();publisher.close();account.close();}

      expect(await readFile(path.join(directory,'plugin-result.txt'),'utf8')).toBe('terminal-plugin-files');
      expect(cardPushes).toHaveLength(1);
      await host.cards.flushWrites();
      const cards=await media.listPluginCards('fixture-task');expect(cards).toHaveLength(1);expect(cards[0].html).toBe('<p>Plugin result</p>');
      expect(called).toMatchObject({ok:true,result:{xdt_card_id:cards[0].callId}});
      expect(await host.fs.handleFsRequest(instance,{type:'fs-request',op:'write',root:'workdir',path:'late-write.txt',content:'late',callId:cards[0].callId})).toMatchObject({ok:false});
      expect(host.kv.read(instance)).toEqual({visited:true});
    }
    // Integration regression: an old remote form cannot bind new bytes to the
    // previous package's credential request, even when the secret key is reused.
    const updated=JSON.parse(await archive.file('ghost.json')!.async('string'));updated.version='1.0.1';updated.network.secrets[0].oauth.clientId='fixture-client-v2';
    archive.file('ghost.json',JSON.stringify(updated));await writeFile(file,await archive.generateAsync({type:'nodebuffer'}));
    const update=await host.prepareInstall(file,'controller-a');await host.confirmInstall(update.id,'controller-a');
    expect(await (await settings('/oauth')).json()).toMatchObject([{key:'oauth',accounts:[{status:'expired'}]}]);
    await expect(controllerAuthorization.saveRemotePluginSecret('host-device',instance,form.key,form.approval,'stale-secret')).rejects.toThrow('PLUGIN_SECRET_FORM_STALE');
    expect(host.readSecretSync(instance,'key')).toBe('synthetic-acceptance-key');
    expect(JSON.stringify(wire)).not.toContain('stale-secret');
    // Integration: switching authoring provenance must isolate credentials/KV
    // instead of silently handing the old account to the new package source.
    host.kv.write(instance,{preserve:'source-owned-value'});
    const switchSource=await host.prepareInstall(file,'controller-a',{installOrigin:'agent-forge'});
    expect(switchSource.target.sourceChanged).toBe(true);
    await host.confirmInstall(switchSource.id,'controller-a');
    expect(host.readSecretSync(instance,'key')).toBeNull();expect(host.kv.read(instance)).toEqual({});
    const archiveName=(await readdir(path.join(options.root,'plugin-kv'))).find(name=>name.startsWith('arch_'))!;
    expect(archiveName).toBeTruthy();
    expect(JSON.parse(await readFile(path.join(options.root,'plugin-kv',archiveName),'utf8'))).toEqual({preserve:'source-owned-value'});
    expect(vault.getSync(`plugin:${archiveName.slice(0,-5)}:key`)).toBe('synthetic-acceptance-key');
    await host.writeSecret(instance,'oauth:fixture:refresh','synthetic-refresh-value');
    const approval=(await host.list())[0].approval;await host.close();
    const next=new TerminalPlugins(options);
    try{
      expect((await next.list())[0].approval).toEqual(approval);await next.setEnabled(instance,false);expect((await next.list())[0].enabled).toBe(false);
      // Integration regression: a failed vault delete after package removal
      // used to lose the only retry opportunity, including derived OAuth keys.
      failCleanup=true;await expect(next.uninstall(instance)).rejects.toThrow('PLUGIN_REMOVE_CLEANUP_FAILED');
      expect(await next.list()).toEqual([]);expect(await vault.get(`plugin:${instance}:oauth:fixture:refresh`)).toBe('synthetic-refresh-value');
    }finally{await next.close();}
    failCleanup=false;const recovered=new TerminalPlugins(options);
    try{
      expect(await recovered.list()).toEqual([]);
      expect(await vault.get(`plugin:${instance}:oauth:fixture:refresh`)).toBeNull();
      expect(await vault.get(`plugin:${instance}:key`)).toBeNull();
      expect(recovered.kv.read(instance)).toEqual({});
      active=false;await expect(recovered.list()).rejects.toThrow('OWNER_CHANGED');
    }finally{await recovered.close();}
  }finally{pages.close();await controllerAuthorization.close();await hostAuthorization.close();await host.close();vault.lock();await media.close();await mediaDb.close();for(const close of modelCleanup.reverse())await close();}
  // Native Windows vault ACL commands run for each durable mutation. Preserve
  // the local 5s budget while allowing that real OS work on the CI runner.
},30_000);

// Native integration: Library was absent from the terminal pipe. Exercise real
// package approval, the Node SQLite worker, source archival and uninstall, so
// success cannot come from an in-process SQL fake or a second storage engine.
it('persists plugin works through restart and uninstall while isolating a changed source',async()=>{
  const root=path.join(directory,'library-profile','owners','owner'),values=new Map<string,string>();
  const secrets={get:async(key:string)=>values.get(key)??null,set:async(key:string,value:string)=>{values.set(key,value);},delete:async(key:string)=>{values.delete(key);},getSync:(key:string)=>values.get(key)??null,setSync:(key:string,value:string)=>{values.set(key,value);},deleteSync:(key:string)=>{values.delete(key);},setManySync:(entries:Record<string,string|null>)=>{for(const [key,value]of Object.entries(entries))if(value===null)values.delete(key);else values.set(key,value);}};
  const options={root,runtimeDirectory:runtime,secrets,assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},
    cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false as const,reason:'cancelled' as const}),writeSaveDeposit:async()=>null},executablePath:'unused',receive:async()=>{throw new Error('Unexpected slot');}};
  const zip=new JSZip();zip.file('ghost.json',JSON.stringify({schemaVersion:2,id:'terminal-library',name:'Terminal library',version:'1.0.0',kind:'chip',entry:'main.js',slots:['tool','library'],tools:[{name:'save',description:'Save work'}]}));zip.file('main.js','cindy.onHostMessage(()=>{});');
  const file=path.join(directory,'library.cindy');await writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  let host=new TerminalPlugins(options);
  const install=async(origin:'manual'|'agent-forge'='manual')=>{const pending=await host.prepareInstall(file,'test-controller',origin==='agent-forge'?{installOrigin:origin}:{});return installedGhostStoragePart(await host.confirmInstall(pending.id,'test-controller'));};
  const request=(id:string,op:string,rest:Record<string,unknown>={})=>host.receive(id,{type:'library-request',op,...rest});
  try{
    const id=await install();
    expect(await request(id,'write',{path:'works/note.txt',content:'retained work',encoding:'utf8'})).toMatchObject({ok:true,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(await request(id,'db.open',{dbPath:'works/index.sqlite'})).toMatchObject({ok:true});
    expect(await request(id,'db.exec',{dbPath:'works/index.sqlite',sql:'CREATE TABLE works(name TEXT)'})).toMatchObject({ok:true});
    expect(await request(id,'db.exec',{dbPath:'works/index.sqlite',sql:'INSERT INTO works(name) VALUES (?)',params:['retained work']})).toMatchObject({ok:true});
    expect(await request(id,'db.exec',{dbPath:'works/index.sqlite',sql:"ATTACH DATABASE '/tmp/outside.sqlite' AS outside"})).toMatchObject({ok:false,errorCode:'DB_STATEMENT_REJECTED'});
    expect(await request(id,'write',{path:'../escape.txt',content:'outside',encoding:'utf8'})).toMatchObject({ok:false,errorCode:'PATH_INVALID'});
    await host.close();host=new TerminalPlugins(options);await host.ready;
    expect(await request(id,'read',{path:'works/note.txt',encoding:'utf8'})).toMatchObject({ok:true,content:'retained work'});
    expect(await request(id,'db.open',{dbPath:'works/index.sqlite'})).toMatchObject({ok:true});
    expect(await request(id,'db.exec',{dbPath:'works/index.sqlite',sql:'SELECT name FROM works'})).toMatchObject({ok:true,rows:[{name:'retained work'}]});
    const registry=new RemoteResourceRegistry();registerLibraryResources(registry,host);
    const context={controllerDeviceId:'controller'},client={protocolVersion:1 as const,primitives:['text','actions'],locale:'en'};
    const ref={collectionId:'plugin-libraries',kind:'plugin-library',id};
    const initial=await registry.get(context,{client,ref});
    const destination=path.join(directory,'custom-libraries');await mkdir(destination);
    const relocation={client,collectionId:ref.collectionId,resourceRef:ref,actionId:initial.actions!.find(action=>action.id.startsWith('relocate:'))!.id,input:{directory:destination}};
    await registry.invoke(context,relocation);
    expect(await request(id,'read',{path:'works/note.txt',encoding:'utf8'})).toMatchObject({ok:true,content:'retained work'});
    expect(await request(id,'db.open',{dbPath:'works/index.sqlite'})).toMatchObject({ok:true});
    expect(await request(id,'db.exec',{dbPath:'works/index.sqlite',sql:'SELECT name FROM works'})).toMatchObject({ok:true,rows:[{name:'retained work'}]});
    await expect(registry.invoke(context,relocation)).rejects.toThrow('PLUGIN_LIBRARY_CHANGED');
    // A broken custom-root registry must not create a second, apparently empty
    // default library. Only this synthetic fixture's registry is corrupted.
    const bindingFile=path.join(root,'libraries-binding.json'),binding=await readFile(bindingFile);
    try{
      await writeFile(bindingFile,'{broken');
      expect(await request(id,'write',{path:'works/must-not-appear.txt',content:'split library',encoding:'utf8'})).toMatchObject({ok:false});
      await expect(host.library.overview(id)).rejects.toThrow();
      await expect(readFile(path.join(root,'libraries',id,'works/must-not-appear.txt'))).rejects.toMatchObject({code:'ENOENT'});
    }finally{await writeFile(bindingFile,binding);}
    const relocated=await registry.get(context,{client,ref});
    await registry.invoke(context,{client,collectionId:ref.collectionId,resourceRef:ref,actionId:relocated.actions!.find(action=>action.id.startsWith('default:'))!.id});
    expect(await request(id,'read',{path:'works/note.txt',encoding:'utf8'})).toMatchObject({ok:true,content:'retained work'});
    await host.uninstall(id);
    expect(await readFile(path.join(root,'libraries',id,'works/note.txt'),'utf8')).toBe('retained work');
    expect(JSON.parse(await readFile(path.join(root,'libraries',id,'.cindy-library/meta.json'),'utf8'))).toMatchObject({orphaned:{name:'Terminal library'}});
    expect(await install()).toBe(id);
    expect(await request(id,'read',{path:'works/note.txt',encoding:'utf8'})).toMatchObject({ok:true,content:'retained work'});
    expect(JSON.parse(await readFile(path.join(root,'libraries',id,'.cindy-library/meta.json'),'utf8'))).not.toHaveProperty('orphaned');
    await install('agent-forge');
    expect(await request(id,'read',{path:'works/note.txt',encoding:'utf8'})).toMatchObject({ok:false,errorCode:'NOT_FOUND'});
    const archived=(await readdir(path.join(root,'libraries'))).find(name=>name.startsWith('arch_'))!;
    expect(await readFile(path.join(root,'libraries',archived,'works/note.txt'),'utf8')).toBe('retained work');
    expect(JSON.parse(await readFile(path.join(root,'libraries',archived,'.cindy-library/meta.json'),'utf8'))).toMatchObject({ghostId:archived});
    const archivedRef={...ref,id:archived},archivedResource=await registry.get(context,{client,ref:archivedRef});
    const trashAction=archivedResource.actions!.find(action=>action.id.startsWith('trash:'))!;
    expect(trashAction.confirmation).toBeTruthy();
    await registry.invoke(context,{client,collectionId:ref.collectionId,resourceRef:archivedRef,actionId:trashAction.id});
    const trashed=(await readdir(path.join(root,'libraries-trash'))).find(name=>name.startsWith(archived))!;
    expect(await readFile(path.join(root,'libraries-trash',trashed,'works/note.txt'),'utf8')).toBe('retained work');
  }finally{await host.close();}
},30_000);
