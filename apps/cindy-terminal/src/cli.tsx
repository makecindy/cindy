#!/usr/bin/env node
import { runProviderTerminal } from './provider-terminal.js';
import { readModelConfiguration, saveModelProvider, invokeModelConfiguration } from './models/client.js';
import { inputHandoffPresentation, INPUT_HANDOFF_LOCAL_CHANNEL, INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL, type InputHandoffSnapshot } from '@cindy/device-link';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { setDefaultModel, waitForTurn, unwrap, enqueueMessage, connectedModels } from './client-operations.js';
import { EngineManager, runNativeLogin, nativeLoginStatus, type EngineKind } from './engines/index.js';
import { listEngines, operateEngine } from './engines/client.js';
import { profilePath, privateDirectory, VERSION } from './platform.js';
import { REGION } from './version.js';
import { connectTerminal, reconnectingClient } from './transport.js';
import { TerminalServiceManager } from './service-manager.js';
import { terminalText } from './terminal-text.js';
import { runShell } from './shell-client.js';
import { REMOTE_TERMINAL_CHANNEL } from '@cindy/terminal-core';
import { doctor,backupProfile,restoreProfile,verifyProfileBackup,recoverProfileRestore,shellCompletion,installTerminalPackage,checkTerminalUpdate,terminalInstallationStatus,rollbackTerminalPackage,profileStorage,listTerminalProfiles } from './maintenance.js';
import { SettingsStore } from './settings.js';
import { resourceCollections,runResourceCommand,invokeResourceAction } from './resource-commands.js';
import { resolveLocale, getMessages } from './ui/i18n.js';
import type { TerminalClient } from './contracts.js';
import { desktopHostCommand } from './desktop-host.js';

async function runTui(...args: Parameters<typeof import('./ui/tui.js').runTui>) {
  return (await import('./ui/tui.js')).runTui(...args);
}

let json = false;
let locale = resolveLocale();
let desktopRequested = false;
function print(value: unknown) {
  process.stdout.write((json ? JSON.stringify(value) : typeof value === 'string' ? terminalText(value) : JSON.stringify(value,null,2))+'\n');
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE');
  const result=value as Record<string,unknown>;
  if (result.ok===false) throw new Error(String((result.error as Record<string,unknown>)?.code || 'OPERATION_FAILED'));
  return result.ok===true&&result.data&&typeof result.data==='object'?result.data as Record<string,unknown>:result;
}
async function claudeAuthorization(client: TerminalClient, binary: string, operation: 'login' | 'logout') {
  if (operation === 'logout') { await client.invoke('terminal:native-claude',['disconnect']); return 0; }
  const ticket = await client.invoke<{ id: string; needsLogin: boolean }>('terminal:native-claude',['begin']);
  const code = ticket.needsLogin ? await runNativeLogin('claude-code', binary, 'login') : 0;
  if (code === 0) await client.invoke('terminal:native-claude',['finish',ticket.id]);
  return code;
}
async function stdin(limit = 1024 * 1024) {
  const chunks: Buffer[]=[];let size=0;
  for await(const chunk of process.stdin){const data=Buffer.from(chunk);size+=data.length;if(size>limit)throw new Error('INPUT_TOO_LARGE');chunks.push(data);}
  return Buffer.concat(chunks).toString('utf8');
}
function required(value: string | undefined, code='ARGUMENT_REQUIRED'): string { if(!value)throw new Error(code);return value; }

async function waitForStopped(directory:string) {
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    try{await fs.access(path.join(directory,'service.json'));}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      // Removing IPC precedes process exit. Every native manager must observe
      // that exit before activation: systemd start, launchd kickstart and a
      // scheduled task can otherwise reuse the still-stopping instance.
      const service=await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).inspect();
      if(service.installation&&!service.managerAvailable)throw new Error('SERVICE_MANAGER_UNAVAILABLE');
      if(!service.running)return;
    }
    await pause(100);
  }
  throw new Error('SERVICE_STOP_TIMEOUT');
}
async function activateService(directory:string,client:TerminalClient,stopTasks=false) {
  const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
  const before=await manager.inspect();
  if(!before.installation)throw new Error('SERVICE_NOT_INSTALLED');
  if(!before.running){
    await client.invoke('terminal:service:stop',[{stopTasks}]);client.close();
    await waitForStopped(directory);await manager.activate();
  }
  return startBackground(directory);
}
async function enableBootService(directory:string,stopTasks=false) {
  // Elevation and OS password prompts belong to the foreground terminal.
  const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
  if((await manager.status())?.desktop)throw new Error('DESKTOP_SERVICE_REQUIRES_LOGIN');
  let client:TerminalClient|undefined;
  try{client=await connectTerminal(directory);}catch(error){if(!(error instanceof Error)||error.message!=='SERVICE_NOT_RUNNING')throw error;}
  if(client){try{await client.invoke('terminal:service:stop',[{stopTasks}]);}finally{client.close();}await waitForStopped(directory);}
  await manager.enableBoot();
  return startBackground(directory);
}
async function startBackground(directory: string): Promise<TerminalClient> {
  try {
    const client=await connectTerminal(directory);
    if(desktopRequested){
      const status=await client.invoke<{desktopAvailable?:boolean}>('terminal:status');
      if(!status.desktopAvailable){client.close();throw new Error('DESKTOP_REQUIRES_SERVICE_RESTART');}
    }
    return client;
  } catch(error) {
    if(error instanceof Error&&!['SERVICE_NOT_RUNNING','SERVICE_CONNECT_TIMEOUT'].includes(error.message))throw error;
  }
  await privateDirectory(directory);
  const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
  const installation=await manager.status();
  if(installation){
    if(desktopRequested&&!installation.desktop)throw new Error('DESKTOP_REQUIRES_SERVICE_REINSTALL');
    if(installation.uninstalling)throw new Error('SERVICE_UNINSTALL_PENDING');
    await manager.activate();
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){try{return await connectTerminal(directory);}catch(error){if(error instanceof Error&&!['SERVICE_NOT_RUNNING','SERVICE_CONNECT_TIMEOUT'].includes(error.message))throw error;}await pause(100);}
    throw new Error('SERVICE_START_TIMEOUT');
  }
  const command=desktopRequested?await desktopHostCommand():{executable:process.execPath,args:[...process.execArgv,fileURLToPath(import.meta.url),'serve']};
  const log=await fs.open(path.join(directory,'service.log'),'a',0o600);
  const child=spawn(command.executable,[...command.args,'--state-dir',directory],{
    detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true,env:process.env,
  });
  let failed=false;
  child.once('error',()=>{failed=true;});child.unref();await log.close();
  const deadline=Date.now()+15_000;
  while(Date.now()<deadline){
    if(failed)throw new Error('SERVICE_START_FAILED');
    await pause(100);
    try{return await connectTerminal(directory);}catch(error){if(error instanceof Error&&error.message==='SERVICE_ENDPOINT_INVALID')throw error;}
  }
  throw new Error('SERVICE_START_TIMEOUT');
}

async function main() {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed=parseArgs({allowPositionals:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},profile:{type:'string'},'state-dir':{type:'string'},desktop:{type:'boolean'},
    lang:{type:'string'},device:{type:'string'},json:{type:'boolean'},once:{type:'boolean'},stdin:{type:'boolean'},
    wait:{type:'boolean'},detach:{type:'boolean'},model:{type:'string'},provider:{type:'string'},engine:{type:'string'},
    cwd:{type:'string'},timeout:{type:'string'},collection:{type:'string'},action:{type:'string'},'no-input':{type:'boolean'},sso:{type:'boolean'},all:{type:'boolean'},
    name:{type:'string'},url:{type:'string'},hostname:{type:'string'},user:{type:'string'},port:{type:'string'},'auth-method':{type:'string'},'key-file':{type:'string'},protocol:{type:'string'},'key-stdin':{type:'boolean'},
    'request-id':{type:'string'},allow:{type:'boolean'},deny:{type:'boolean'},'machine-key':{type:'boolean'},'passphrase-stdin':{type:'boolean'},
    file:{type:'string',multiple:true},sha256:{type:'string'},prefix:{type:'string'},effort:{type:'string'},mode:{type:'string'},shell:{type:'string'},
    'stop-tasks':{type:'boolean'},query:{type:'string'},generate:{type:'boolean'},cursor:{type:'string'},limit:{type:'string'},output:{type:'string'},manifest:{type:'string'},follow:{type:'boolean'},
  }}); } catch { throw new Error('INVALID_COMMAND_ARGUMENTS'); }
  const values=parsed.values as Record<string,string|boolean|string[]|undefined>;
  const positionals=parsed.positionals;
  const str=(key:string)=>typeof values[key]==='string'?values[key] as string:undefined;
  json=values.json===true;locale=resolveLocale(str('lang'));
  desktopRequested=values.desktop===true;
  let t=getMessages(locale);
  const [requestedCommand,subcommand,...rest]=positionals;
  let command=requestedCommand;
  const directory=requestedCommand==='profiles'&&subcommand==='use'?profilePath(required(rest[0])):str('state-dir')?path.resolve(str('state-dir')!):profilePath(str('profile'));
  if(command==='profiles'&&subcommand==='use')command='';
  const limit=str('limit')===undefined?undefined:Number(str('limit'));
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>1000))throw new Error('INVALID_LIMIT');
  const inputFiles=(Array.isArray(values.file)?values.file:typeof values.file==='string'?[values.file]:[]).map(file=>({path:path.resolve(file),name:path.basename(file)}));
  if(values.wait&&values.detach)throw new Error('CONFLICTING_WAIT_OPTIONS');
  const timeoutMs=str('timeout')===undefined?undefined:Number(str('timeout'))*1000;
  if(timeoutMs!==undefined&&(!Number.isFinite(timeoutMs)||timeoutMs<=0))throw new Error('INVALID_TIMEOUT');
  if(str('device')&&['service','desktop','status','auth','vault','login','logs'].includes(command))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
  if(values.help||command==='help'){
    print(`Cindy ${VERSION}\n\n  cindy                         ${t.tasks}\n  cindy login [--sso]            ${t.login}\n  cindy auth status|accounts|logout|switch|refresh\n  cindy auth begin|cancel|memberships|authorization\n  cindy auth email|organization|select|membership|binding-code <id>\n  cindy auth realm accept|cancel\n  cindy auth request-code|captcha-start email|phone <identifier>\n  cindy auth verify|binding-verify|sso-verify --stdin\n  cindy auth captcha-complete <challengeId> --stdin\n  cindy auth authorize sso|social <provider>\n  cindy vault status|setup|unlock      --machine-key | --passphrase-stdin\n  cindy engines list|install|update|repair\n  cindy models [list|show|use|refresh|enable|disable|reset]        ${t.models}\n  cindy models context get|set|reset <model> [tokens] --provider <id> --engine <engine>\n  cindy providers [list|presets|add|edit|test|discover|login|logout|status|disconnect|remove]\n  cindy devices list|state|connect|disconnect|enable|disable|revoke|restore|rename|remove\n  cindy chat [message] --once [--detach]\n  cindy attach <id>              ${t.history}\n  cindy tasks list|get|search|history|export|stop|resume|send|rename|archive|restore|delete\n  cindy tasks model|effort|permission|plan|fast|compact|clear|queue|cancel-queued <id>\n  cindy tasks plugin-permission <id> [retry]\n  cindy tasks import-scan | import --stdin\n  cindy ssh list|connect|disconnect|add|edit|remove|terminal\n  cindy terminal [open|attach|list|close] --cwd <path>\n  cindy files list|read|write|create|stat|mkdir|remove|rename --cwd <path>\n  cindy files download <url> --device <id> --output <path>\n  cindy resources [list|get|action]\n  cindy teammates|schedules|projects|worktrees|plugins|skills|mcp\n  cindy plugin-market|libraries\n  cindy local-models [list|get|start|install|download|pause|resume|cancel|enable|disable|delete] [ollama|model] [--stdin]\n  cindy teammate-models [list|get|edit|reset] [defaults|id] [--stdin]\n  cindy auxiliary-models [list|get|edit|reset] [chain] [--stdin]\n  cindy channels|memory|contacts|shares|provider-groups\n      [list|get|<advertised-action>] [id] [--stdin]\n  cindy channels connect feishu --stdin\n  cindy channels authorization|cancel <request-id>\n  cindy requests list|show|approve|deny|resolve|answer|fill\n  cindy requests answer <taskId> <requestId> --stdin\n  cindy config [get|set|reset]\n  cindy service start|status|stop|restart|install|activate|boot|uninstall|logs\n  cindy logs [--follow]\n  cindy browser status|install|check|sandbox-profile\n  cindy doctor\n  cindy backup create|verify|restore <file> --passphrase-stdin\n  cindy restore <file> --passphrase-stdin\n  cindy completion bash|zsh|fish|powershell\n  cindy update check --manifest <url> --prefix <dir>\n  cindy update apply <archive> --sha256 <hash> --prefix <dir>\n  cindy update status|rollback --prefix <dir>\n  cindy storage status\n  cindy profiles list|create|use\n  cindy serve [--desktop]\n  cindy desktop status|enable|disable|permissions|stop\n  cindy status\n\n  --profile <name>   --device <id>   --lang <locale>   --json\n  --model <id>   --provider <id>   --engine <pi|codex|claude-code>\n  --stdin   --no-input   --request-id <id>\n  --file <path>   --desktop\n  providers test --generate: may incur a charge\n  tasks export --output <file>: NDJSON, newest first`);return;
  }
  if(values.version||command==='version'){print(VERSION);return;}
  if(command==='browser'){
    if(str('device'))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
    const { TerminalBrowserRuntime } = await import('./plugins/browser.js');
    const runtime=new TerminalBrowserRuntime({root:path.join(directory,'browser-runtime')});
    try{
      if(subcommand==='sandbox-profile'){print(await runtime.sandboxProfile());return;}
      if(subcommand==='install')await runtime.resolve();
      else if(subcommand&&subcommand!=='check'&&subcommand!=='status')throw new Error('UNKNOWN_COMMAND');
      if(!subcommand||subcommand==='status'){print({executable:await runtime.installed()});return;}
      const result=await runtime.check();print(result);if(!result.ok)process.exitCode=1;
    }finally{await runtime.close();}
    return;
  }
  if(command==='profiles'){
    if(str('device'))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
    if(!subcommand||subcommand==='list'){print(await listTerminalProfiles());return;}
    if(subcommand==='create'){
      const target=profilePath(required(rest[0]));await privateDirectory(path.dirname(target));
      await fs.mkdir(target,{mode:0o700});await privateDirectory(target);await new SettingsStore(target).open();
      print({name:rest[0],path:target});return;
    }
    throw new Error('UNKNOWN_COMMAND');
  }
  if(['doctor','backup','restore','completion','update','storage'].includes(command)){
    if(str('device'))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
    if(command==='storage'){if(subcommand&&subcommand!=='status')throw new Error('UNKNOWN_COMMAND');print(await profileStorage(directory));return;}
    if(command==='doctor'){const result=await doctor(directory);print(result);if(result.some(item=>item.status==='error'))process.exitCode=1;return;}
    if(command==='completion'){print(shellCompletion(required(subcommand) as 'bash'|'zsh'|'fish'|'powershell'));return;}
    if(command==='update'){
      const prefix=path.resolve(required(str('prefix')));
      if(subcommand==='apply')print(await installTerminalPackage(path.resolve(required(rest[0])),required(str('sha256')),prefix));
      else if(subcommand==='status')print(await terminalInstallationStatus(prefix));
      else if(subcommand==='check')print(await checkTerminalUpdate(prefix,required(str('manifest'))));
      else if(subcommand==='rollback')print(await rollbackTerminalPackage(prefix,rest[0]));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='restore'&&subcommand==='recover'){print(await recoverProfileRestore(directory));return;}
    if(!values['passphrase-stdin'])throw new Error('BACKUP_PASSPHRASE_STDIN_REQUIRED');
    const passphrase=(await stdin(16*1024)).replace(/\r?\n$/,'');
    if(command==='backup'&&!['create','verify','restore'].includes(subcommand))throw new Error('UNKNOWN_COMMAND');
    const file=path.resolve(required(command==='backup'?rest[0]:subcommand));
    print(command==='backup'&&subcommand==='create'?await backupProfile(directory,file,passphrase):command==='backup'&&subcommand==='verify'?await verifyProfileBackup(file,passphrase):await restoreProfile(directory,file,passphrase));return;
  }
  if(command==='service'&&subcommand==='boot'){
    const bootClient=await enableBootService(directory,values['stop-tasks']===true);
    try{print({status:await bootClient.invoke('terminal:status'),service:await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).inspect()});}finally{bootClient.close();}return;
  }
  if(command==='serve'){
    if(desktopRequested){
      const command=await desktopHostCommand();
      const child=spawn(command.executable,[...command.args,'--state-dir',directory],{stdio:['inherit','inherit','inherit','ipc'],shell:false});
      const stop=()=>{if(child.connected)child.send({type:'cindy:service-stop'},()=>{});};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{process.exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',()=>reject(new Error('DESKTOP_START_FAILED')));child.once('exit',code=>resolve(code??1));});}
      finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
      return;
    }
    const { TerminalService } = await import('./service.js');
    const service=new TerminalService(directory, REGION);
    try { await service.start(); } catch(error) { if(error instanceof Error&&error.message==='SERVICE_ALREADY_RUNNING')return;throw error; }
    const stop=()=>{void service.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const supervised=process.env.CINDY_SERVICE_SUPERVISED==='1'&&!!process.send;
    const supervisorMessage=(message:unknown)=>{if((message as {type?:unknown}|null)?.type==='cindy:service-stop')stop();};
    if(supervised){
      process.on('message',supervisorMessage);
      process.once('disconnect',stop);
      if(!process.connected)stop();
    }
    await service.stopped;
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    if(supervised){process.off('message',supervisorMessage);process.off('disconnect',stop);if(process.connected)process.disconnect();}
    return;
  }
  if(command==='logs'||command==='service'&&subcommand==='logs'){
    const file=path.join(directory,'service.log');
    const controller=new AbortController();const stop=()=>controller.abort();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    let offset:number|undefined,identity:unknown;let decoder=new StringDecoder('utf8');
    try{
      do{
        const handle=await fs.open(file,'r');
        try{
          const info=await handle.stat();
          if(offset===undefined)offset=Math.max(0,info.size-64*1024);
          else if(identity!==info.ino||info.size<offset){offset=0;decoder=new StringDecoder('utf8');}
          identity=info.ino;
          while(offset<info.size){
            const data=Buffer.alloc(Math.min(info.size-offset,64*1024));const {bytesRead}=await handle.read(data,0,data.length,offset);if(!bytesRead)break;offset+=bytesRead;
            const text=decoder.write(data.subarray(0,bytesRead));
            if(json)print({text});else if(!process.stdout.write(terminalText(text)))await once(process.stdout,'drain');
          }
        }finally{await handle.close();}
        if(values.follow)await pause(300,undefined,{signal:controller.signal}).catch(()=>{});
      }while(values.follow&&!controller.signal.aborted);
    }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
    return;
  }
  const nativeProviderAlias: Record<string,string> = { codex: 'openai', 'claude-code': 'anthropic' };
  const providerLoginId = str('provider') ?? (command==='providers' ? nativeProviderAlias[str('engine')??rest[0]??''] : undefined);
  if(command==='engines'&&!str('device')||command==='providers'&&['login','logout','status'].includes(subcommand)&&(!str('device')||!providerLoginId)&&(!str('provider')||Boolean(str('engine'))||rest.length>0)){
    if(str('device'))throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
    const manager=new EngineManager({profileDir:directory});
    if(command==='engines'&&(!subcommand||subcommand==='list')){print(await manager.allStatus());return;}
    const kind=required(str('engine')??rest[0],'ENGINE_REQUIRED') as EngineKind;
    if(!['claude-code','codex','pi'].includes(kind))throw new Error('INVALID_ENGINE');
    if(command==='engines'){
      if(!['install','update','repair'].includes(subcommand))throw new Error('UNKNOWN_COMMAND');
      const result=subcommand==='update'?await manager.update(kind):subcommand==='repair'?await manager.repair(kind):await manager.install(kind);
      let running:TerminalClient|undefined;
      try { running=await connectTerminal(directory);await running.invoke('terminal:engines:refresh'); }
      catch(error){if(!(error instanceof Error)||error.message!=='SERVICE_NOT_RUNNING')throw error;}
      finally { running?.close(); }
      print(result);return;
    }
    const resolved=await manager.resolve(kind);if(!resolved)throw new Error('ENGINE_NOT_INSTALLED');
    if(kind==='claude-code') {
      const authClient = await startBackground(directory);
      try {
        if (subcommand === 'status') print(await authClient.invoke('terminal:native-claude',['status']));
        else {
          if(json||values['no-input'])throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
          process.exitCode = await claudeAuthorization(authClient, resolved.binary, subcommand as 'login' | 'logout');
        }
      } finally { authClient.close(); }
      return;
    }
    if(kind==='codex') {
      let authClient = await startBackground(directory);
      try {
        if(subcommand==='login') {
          if(json||values['no-input'])throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
          authClient=reconnectingClient(directory,authClient);
          await runTui(authClient,{locale,page:'models',providerLogin:'openai'});
        } else if(subcommand==='logout') print(await invokeModelConfiguration(authClient,'disconnect',{providerId:'openai'}));
        else {
          const providers=await authClient.invoke<unknown[]>('maker:provider:list');
          print({engine:kind,status:providers.some(value=>{const provider=value as Record<string,unknown>;return provider.id==='openai'&&provider.connected;})?'authenticated':'signed-out'});
        }
      } finally { authClient.close(); }
      return;
    }
    if(subcommand==='status'){print({engine:kind,status:await nativeLoginStatus(kind,resolved.binary,str('provider'))});return;}
    if(json||values['no-input'])throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
    process.exitCode=await runNativeLogin(kind,resolved.binary,subcommand as 'login'|'logout',{onInstruction:instruction=>print(instruction==='pi-login'?'/login':'/logout')});return;
  }
  if(command&&!resourceCollections[command]&&!['status','desktop','service','auth','vault','config','devices','models','providers','engines','tasks','requests','resources','files','ssh','terminal','chat','attach','login'].includes(command))throw new Error('UNKNOWN_COMMAND');
  const passive=command==='status'||command==='service'&&['status','stop','restart','uninstall'].includes(subcommand);
  let client:TerminalClient;
  try { client=passive?await connectTerminal(directory):await startBackground(directory); }
  catch(error){
    if(passive&&error instanceof Error&&error.message==='SERVICE_NOT_RUNNING'){
      if(subcommand==='restart'){client=await startBackground(directory);try{print(await client.invoke('terminal:status'));}finally{client.close();}return;}
      else if(subcommand==='uninstall'){
        const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
        await manager.stopIdleSupervisor();
        let result=await manager.uninstall();
        if(result.requiresLocalCompletion)result=await manager.completeUninstall();
        print(result);return;
      }else{
        const manager=new TerminalServiceManager(directory,fileURLToPath(import.meta.url));
        if(command==='service'&&subcommand==='stop')await manager.stopIdleSupervisor();
        print({running:false,...(command==='service'?{service:await manager.inspect()}: {})});return;
      }
    }else throw error;
  }
  const device=str('device');
  const call=(channel:string,args:unknown[]=[],remote=true)=>client.invoke(channel,args,remote?device:undefined);
  async function finishTurn(id:string,requestId:string,accepted:unknown,wait:boolean){
    const result=unwrap(accepted);
    if(!wait){print({sessionId:id,requestId,result});return;}
    const abort=new AbortController();const detach=()=>abort.abort();
    process.once('SIGINT',detach);process.once('SIGTERM',detach);
    try{
      const outcome=await waitForTurn(client,id,requestId,{device,timeoutMs,signal:abort.signal});
      const view={sessionId:id,requestId,status:outcome.status,finalText:outcome.finalText,errorCode:outcome.errorCode,pendingRequests:outcome.pendingRequests};
      print(json?view:outcome.status==='completed'?outcome.finalText??'':view);
      if(outcome.status==='waiting')process.exitCode=2;
      else if(outcome.status==='detached')process.exitCode=abort.signal.aborted?130:3;
      else if(outcome.status!=='completed')process.exitCode=1;
    }finally{process.removeListener('SIGINT',detach);process.removeListener('SIGTERM',detach);}
  }
  try{
    if(!str('lang')){
      const settings=object(await call('terminal:settings:get',[],false));
      const effective=object(settings.effective);
      if(typeof effective.language==='string'){locale=resolveLocale(effective.language);t=getMessages(locale);}
    }
    if(command==='status'||command==='service'&&subcommand==='status'){const status=object(await call('terminal:status',[],false));print(command==='service'?{...status,service:await call('terminal:service:inspect',[],false)}:status);return;}
    if(command==='desktop'){
      if(device)throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
      if(!subcommand||subcommand==='status')print(await call('terminal:desktop',['status'],false));
      else if(subcommand==='enable'||subcommand==='disable')print(await call('terminal:desktop',['enable',subcommand==='enable'],false));
      else if(subcommand==='permissions'){if(rest[0]&&!['check','guide'].includes(rest[0]))throw new Error('UNKNOWN_COMMAND');print(await call('terminal:desktop',['permissions',rest[0]??'check'],false));}
      else if(subcommand==='stop')print(await call('terminal:desktop',['stop'],false));
      else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='service'){
      if(subcommand==='activate'){client=await activateService(directory,client,values['stop-tasks']===true);print({status:await call('terminal:status',[],false),service:await call('terminal:service:inspect',[],false)});return;}
      if(subcommand==='start'){print(await call('terminal:status',[],false));return;}
      if(['install','uninstall','stop'].includes(subcommand)){
        const result=object(await call(`terminal:service:${subcommand}`,subcommand==='stop'?[{stopTasks:values['stop-tasks']===true}]:[],false));
        if(result.requiresLocalCompletion){client.close();print(await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).completeUninstall());}
        else print(result);
        return;
      }
      if(subcommand==='restart'){
        if(object(await call('terminal:status',[],false)).desktopAvailable)desktopRequested=true;
        if(desktopRequested)await desktopHostCommand();
        await call('terminal:service:stop',[{stopTasks:values['stop-tasks']===true}],false);client.close();
        await waitForStopped(directory);
        client=await startBackground(directory);print(await call('terminal:status',[],false));return;
      }
      throw new Error('UNKNOWN_COMMAND');
    }
    if(command==='auth'){
      if(subcommand==='status'||subcommand==='accounts'){const state=object(await call('terminal:auth:status',[],false));print(subcommand==='accounts'?state.accounts:state);}
      else if(['begin','cancel','refresh','memberships','authorization','sso-code'].includes(subcommand))print(await call(`terminal:auth:${subcommand}`,[],false));
      else if(['email','organization','select','membership','binding-code'].includes(subcommand))print(await call(`terminal:auth:${subcommand}`,[required(rest[0])],false));
      else if(subcommand==='realm'){
        if(!['accept','cancel'].includes(rest[0]))throw new Error('ACCEPT_OR_CANCEL_REQUIRED');
        print(await call('terminal:auth:realm',[rest[0]==='accept'],false));
      }
      else if(subcommand==='request-code'||subcommand==='captcha-start'){
        if(!['email','phone'].includes(rest[0]))throw new Error('EMAIL_OR_PHONE_REQUIRED');
        print(await call(`terminal:auth:${subcommand}`,[rest[0],required(rest[1])],false));
      }
      else if(['verify','binding-verify','sso-verify','captcha-complete'].includes(subcommand)){
        if(!values.stdin)throw new Error('VERIFICATION_STDIN_REQUIRED');
        const value=(await stdin(16*1024)).replace(/\r?\n$/,'');
        print(await call(`terminal:auth:${subcommand}`,subcommand==='captcha-complete'?[required(rest[0]),value]:[value],false));
      }
      else if(subcommand==='authorize'){
        if(!['sso','social'].includes(rest[0]))throw new Error('SSO_OR_SOCIAL_REQUIRED');
        print(await call('terminal:auth:authorize',[rest[0],required(rest[1])],false));
      }
      else if(subcommand==='logout')print(await call('terminal:auth:logout',[values.all===true],false));
      else if(subcommand==='switch')print(await call('terminal:auth:switch',[required(rest[0])],false));
      else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='vault'){
      if(subcommand==='status'){print(object(await call('terminal:status',[],false)).vault);return;}
      if(subcommand==='setup'){
        if(values['machine-key'])print(await call('terminal:vault:initialize',['machine'],false));
        else if(values['passphrase-stdin'])print(await call('terminal:vault:initialize',['passphrase',(await stdin(16*1024)).replace(/\r?\n$/,'')],false));
        else throw new Error('VAULT_MODE_REQUIRED');
      }else if(subcommand==='unlock'&&values['passphrase-stdin'])print(await call('terminal:vault:unlock',[(await stdin(16*1024)).replace(/\r?\n$/,'')],false));
      else throw new Error('VAULT_MODE_REQUIRED');
      return;
    }
    if(command==='config'&&subcommand){
      if(device)throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
      if(subcommand==='get')print(await call('terminal:settings:get',[],false));
      else if(subcommand==='reset')print(await call('terminal:settings:reset',[rest],false));
      else if(subcommand==='set'){
        const key=required(rest[0]);const raw=required(rest[1]);
        const value=key==='remoteEnabled'?(raw==='true'?true:raw==='false'?false:undefined):raw;
        if(value===undefined)throw new Error('INVALID_SETTING');
        print(await call('terminal:settings:update',[{[key]:value}],false));
      }else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='devices'&&subcommand){
      if(subcommand==='list')print(await call('terminal:devices:list',[],false));
      else if(['state','disconnect-all'].includes(subcommand))print(await call(`terminal:devices:${subcommand}`,[],false));
      else if(['connect','disconnect','enable','disable','revoke','restore','remove'].includes(subcommand))print(await call(`terminal:devices:${subcommand}`,[required(rest[0])],false));
      else if(subcommand==='rename')print(await call('terminal:devices:rename',[required(rest[0]),required(rest[1])],false));
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='models'&&subcommand){
      if(subcommand==='list')print(await call('maker:provider:list'));
      else if(subcommand==='use'||subcommand==='default')print(await setDefaultModel(client,{model:required(rest[0]),providerId:required(str('provider')),agentKind:str('engine')??'pi'},device));
      else if(subcommand==='refresh')print(await invokeModelConfiguration(client,'refresh',{providerId:required(str('provider')??rest[0])},device));
      else if(subcommand==='context'){
        const action=required(rest[0]);
        if(!['get','set','reset'].includes(action))throw new Error('UNKNOWN_COMMAND');
        const target={modelId:required(rest[1]),providerId:required(str('provider')),agent:str('engine')??'pi'};
        const current=object(await invokeModelConfiguration(client,'context:get',{target},device));
        if(action==='get')print(current);
        else {const limit=action==='set'?Number(required(rest[2])):null;
          if(action==='set'&&(!Number.isSafeInteger(limit)||Number(limit)<1000||Number(limit)>100000000))throw new Error('INVALID_CONTEXT_WINDOW');
          print(await invokeModelConfiguration(client,`context:${action}`,{target,owner:current.owner,limit},device));}
      }
      else if(subcommand==='show'){
        const raw=unwrap(await call('maker:provider:list'));
        const providers=Array.isArray(raw)?raw:object(raw).providers;
        if(!Array.isArray(providers))throw new Error('INVALID_RESPONSE');
        print(providers.filter(p=>!str('provider')||p.id===str('provider')).flatMap(p=>Object.entries(p.models??{}).flatMap(([engine,models])=>Array.isArray(models)?models.filter(m=>m.id===required(rest[0])&&(!str('engine')||engine===str('engine'))).map(model=>({providerId:p.id,engine,...model})):[])));
      }else if(['enable','disable','reset'].includes(subcommand)){
        print(await invokeModelConfiguration(client,'disabled',{providerId:required(str('provider')),kind:subcommand==='reset'?'reset':'model',modelIds:rest,disabled:subcommand==='disable'},device));
      }
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='engines'){
      if(!subcommand||subcommand==='list')print(await listEngines(client,locale,device));
      else {
        const kind=required(str('engine')??rest[0],'ENGINE_REQUIRED') as EngineKind;
        if(!['claude-code','codex','pi'].includes(kind))throw new Error('INVALID_ENGINE');
        if(subcommand!=='install'&&subcommand!=='update'&&subcommand!=='repair')throw new Error('UNKNOWN_COMMAND');
        print(await operateEngine(client,kind,subcommand,locale,device));
      }
      return;
    }
    if(command==='providers'&&providerLoginId&&['login','logout','status'].includes(subcommand)){
      const id=providerLoginId;
      if(subcommand==='logout'){print(await invokeModelConfiguration(client,'disconnect',{providerId:id},device));return;}
      if(subcommand==='status'){const raw=unwrap(await call('maker:provider:list'));const providers=(Array.isArray(raw)?raw:object(raw).providers??[]) as Array<Record<string,unknown>>;const provider=providers.find(p=>p.id===id);if(!provider)throw new Error('PROVIDER_NOT_FOUND');print({providerId:id,connected:provider.connected===true});return;}
      if(json||values['no-input']||!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
      const external=await runTui(reconnectingClient(directory,client),{locale,page:'models',device,providerLogin:id});
      if(external?.type==='provider-terminal'){client=await startBackground(directory);process.exitCode=await runProviderTerminal(client,external.loginId);}
      return;
    }
    if(command==='providers'&&subcommand){
      if(subcommand==='list')print(await call('maker:provider:list'));
      else if(subcommand==='presets')print({presets:(await readModelConfiguration(client,device)).presets});
      else if(subcommand==='add'){
        const id=str('provider')??`custom-${randomUUID()}`;const engine=str('engine')??'pi';
        const key=values['key-stdin']?(await stdin(64*1024)).replace(/\r?\n$/,''):'';
        print(await saveModelProvider(client,{id,name:required(str('name')),auth:{method:key?'apiKey':'none'},runtimes:{[engine]:{baseUrl:required(str('url')),wireProtocol:str('protocol')??'openai-chat',models:[{id:required(str('model')),name:str('model')}]}}},{[engine]:key},false,device));
      }else if(subcommand==='remove')print(await invokeModelConfiguration(client,'remove',{providerId:required(rest[0])},device));
      else if(subcommand==='disconnect')print(await invokeModelConfiguration(client,'disconnect',{providerId:required(rest[0])},device));
      else if(subcommand==='edit'||subcommand==='test'||subcommand==='discover'){
        const id=required(rest[0]);const state=await readModelConfiguration(client,device);
        const provider=(state.providers as Array<Record<string,any>>).find(p=>p.id===id);if(!provider)throw new Error('PROVIDER_NOT_FOUND');
        const engine=str('engine')??Object.keys(provider.runtimes)[0];const runtime=provider.runtimes[engine];if(!runtime)throw new Error('PROVIDER_RUNTIME_REQUIRED');
        if(subcommand==='edit'){
          const key=values['key-stdin']?(await stdin(64*1024)).replace(/\r?\n$/,''):undefined;
          print(await saveModelProvider(client,{...provider,name:str('name')??provider.name,runtimes:{...provider.runtimes,[engine]:{...runtime,baseUrl:str('url')??runtime.baseUrl,wireProtocol:str('protocol')??runtime.wireProtocol}}},key===undefined?{}:{[engine]:key},true,device));
        }else print(await invokeModelConfiguration(client,subcommand==='test'&&values.generate?'test':'discover',{providerId:id,agentKind:engine},device));
      }
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='tasks'){
      const id=()=>required(rest[0],'TASK_ID_REQUIRED');
      if(subcommand==='list')print(await call('local-db:sessions:list',[str('limit')?Number(str('limit')):100,values.all?undefined:'active']));
      else if(subcommand==='import-scan'||subcommand==='import'){
        if(device)throw new Error('LOCAL_CONFIGURATION_REQUIRED');
        if(subcommand==='import-scan')print(await call('local-db:session-import:scan',[],false));
        else {
          if(!values.stdin)throw new Error('STDIN_REQUIRED');
          let input:unknown;try{input=JSON.parse(await stdin());}catch{throw new Error('INVALID_JSON_INPUT');}
          print(await call('local-db:session-import:import',[input],false));
        }
      }
      else if(subcommand==='get')print(await call('local-db:sessions:get',[id()]));
      else if(subcommand==='history')print(await call('local-db:messages:list',[id(),{limit:str('limit')?Number(str('limit')):200,...(str('cursor')?{before:str('cursor')}:{})}]));
      else if(subcommand==='export'){
        const handle=str('output')?await fs.open(path.resolve(str('output')!),'wx',0o600):undefined;
        const write=async(value:unknown)=>{const line=JSON.stringify(value)+'\n';if(handle)await handle.writeFile(line);else if(!process.stdout.write(line))await once(process.stdout,'drain');};
        try{
          await write({type:'session',order:'newest-first',session:unwrap(await call('local-db:sessions:get',[id()]))});
          let before:string|undefined;
          const cursors=new Set<string>();
          for(;;){
            const raw=unwrap(await call('local-db:messages:list',[id(),{limit:200,...(before?{before}:{})}]));
            const rows=Array.isArray(raw)?raw:object(raw).messages;
            if(!Array.isArray(rows))throw new Error('INVALID_RESPONSE');
            if(!rows.length)break;
            for(const message of rows)await write({type:'message',message});
            const next=rows.at(-1)?.id;
            if(typeof next!=='string'||cursors.has(next))throw new Error('INVALID_HISTORY_CURSOR');
            cursors.add(next);before=next;
          }
        }finally{await handle?.close();}
      }
      else if(subcommand==='search')print(await call('local-db:history:query',[{tool:'search_chat_history',args:{query:required(rest.join(' ')),...(str('cwd')?{workdir:str('cwd')}:{}),...(str('cursor')?{cursor:str('cursor')}:{}),...(str('limit')?{limit:Number(str('limit'))}:{})}}]));
      else if(subcommand==='stop')print(await call('maker:abort-session',[id()]));
      else if(subcommand==='clear')print(await call('maker:input:clear-session',[id()]));
      else if(subcommand==='resume')print(await call('maker:input:resume',[id()]));
      else if(subcommand==='cancel-queued')print(await call('maker:input:remove',[id(),required(rest[1],'REQUEST_ID_REQUIRED')]));
      else if(subcommand==='delete'){if(device)throw new Error('LOCAL_CONFIGURATION_REQUIRED');print(await call('terminal:tasks:delete',[id()],false));}
      else if(subcommand==='send'){
        const requestId=str('request-id')??randomUUID();
        const message=values.stdin?await stdin():rest.slice(1).join(' ');if(!message.trim()&&!inputFiles.length)throw new Error('MESSAGE_REQUIRED');
        const result=await enqueueMessage(client,id(),message,requestId,device,{files:inputFiles});
        await finishTurn(id(),requestId,result,values.wait===true);
      }
      else if(subcommand==='rename')print(await call('local-db:sessions:patch-meta',[id(),{title:required(rest.slice(1).join(' '))}]));
      else if(subcommand==='archive'||subcommand==='restore')print(await call('local-db:sessions:patch-meta',[id(),{status:subcommand==='archive'?'archived':'active'}]));
      else if(subcommand==='compact')print(await call('maker:compact-session',[id(),rest.slice(1).join(' ')||undefined]));
      else if(subcommand==='queue')print(await call('maker:input:get-projection',[id()]));
      else if(subcommand==='model') {
        const model=required(str('model')??rest[1]);
        print(str('engine') ? await call('maker:switch-session-agent',[id(),str('engine'),model,...(str('provider')?[str('provider')]:[])]) : await call('maker:set-model',[id(),model,...(str('provider')?[str('provider')]:[])]));
      }
      else if(subcommand==='effort')print(await call('maker:set-effort',[id(),required(str('effort')??rest[1])]));
      else if(subcommand==='plugin-permission'){
        if(device)throw new Error('LOCAL_CONFIGURATION_REQUIRED');
        if(rest[1]&&rest[1]!=='retry')throw new Error('UNKNOWN_COMMAND');
        print(await call(rest[1]==='retry'?'maker:retry-plugin-write-access':'maker:get-plugin-write-access-recovery',[id()],false));
      }
      else if(subcommand==='permission')print(await call('maker:set-permission-mode',[id(),required(str('mode')??rest[1])]));
      else if(subcommand==='plan'||subcommand==='fast'){if(!['on','off'].includes(rest[1]))throw new Error('ON_OR_OFF_REQUIRED');print(await call(`maker:set-${subcommand==='plan'?'plan':'fast'}-mode`,[id(),rest[1]==='on']));}
      else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='requests'){
      if(subcommand==='list')print(await call('maker:get-pending-interactions',[required(rest[0],'TASK_ID_REQUIRED')]));
      else if(['approve','deny','show','answer','fill'].includes(subcommand)){
        const taskId=required(rest[0],'TASK_ID_REQUIRED'),requestId=required(rest[1],'REQUEST_ID_REQUIRED');
        const pending=unwrap(await call('maker:get-pending-interactions',[taskId]));
        if(!Array.isArray(pending))throw new Error('INVALID_RESPONSE');
        const request=pending.map(p=>p.request??p).find(p=>p.requestId===requestId);
        if(!request)throw new Error('REQUEST_ALREADY_RESOLVED');
        if(subcommand==='show')print(request);
        else if(subcommand==='fill'){
          if(request.kind!=='input_handoff')throw new Error('REQUEST_IS_NOT_PROTECTED_INPUT');
          if(!values.stdin)throw new Error('PROTECTED_INPUT_STDIN_REQUIRED');
          let input:unknown;try{input=JSON.parse(await stdin(64*1024));}catch{throw new Error('INVALID_INPUT_HANDOFF');}
          const submission={expectedRevision:request.revision,values:input,action:{kind:'submit'}};
          print(await client.invoke(device?INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL:INPUT_HANDOFF_LOCAL_CHANNEL,[device?{deviceId:device,presentation:inputHandoffPresentation(request as InputHandoffSnapshot),submission}:{requestId:request.requestId,submission}]));
        }
        else if(subcommand==='answer'){
          if(request.kind!=='ask_user_question')throw new Error('REQUEST_IS_NOT_A_QUESTION');
          if(!values.stdin)throw new Error('ANSWER_STDIN_REQUIRED');
          let answers:unknown;try{answers=JSON.parse(await stdin(64*1024));}catch{throw new Error('INVALID_ANSWERS');}
          if(!answers||typeof answers!=='object'||Array.isArray(answers)||!request.questions.every((question:{question:string})=>typeof (answers as Record<string,unknown>)[question.question]==='string'))throw new Error('INVALID_ANSWERS');
          print(await call('maker:resolve-interaction',[request.requestId,{kind:'ask_user_question',answers}]));
        }
        else{if(request.kind==='input_handoff')throw new Error('PROTECTED_INPUT_REQUIRED');if(request.kind==='ask_user_question')throw new Error('QUESTION_REQUIRES_ANSWER');print(await call('maker:resolve-interaction',[request.requestId,{kind:request.kind,behavior:subcommand==='approve'?'allow':'deny'}]));}
      }
      else if(subcommand==='resolve'){
        if(!values.stdin)throw new Error('DECISION_STDIN_REQUIRED');
        let decision:unknown;try{decision=JSON.parse(await stdin(64*1024));}catch{throw new Error('INVALID_DECISION');}
        print(await call('maker:resolve-interaction',[required(rest[0]),decision]));
      }else throw new Error('UNKNOWN_COMMAND');return;
    }
    if(command==='terminal'){
      if(subcommand==='list'||subcommand==='close')print(unwrap(await call(REMOTE_TERMINAL_CHANNEL,[{version:1,op:subcommand,id:subcommand==='close'?required(rest[0]):undefined}])));
      else if(!subcommand||subcommand==='open'||subcommand==='attach'){
        if(json||values['no-input'])throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
        process.exitCode=await runShell(client,{device,id:subcommand==='attach'?required(rest[0]):undefined,cwd:str('cwd'),shell:str('shell'),locale});
      }else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='ssh'){
      if(device)throw new Error('LOCAL_COMMAND_REQUIRES_LOCAL_TARGET');
      const alias=()=>required(rest[0],'SSH_ALIAS_REQUIRED');
      if(subcommand==='list')print(await call('terminal:ssh:list',[],false));
      else if(['connect','disconnect','remove'].includes(subcommand))print(await call(`terminal:ssh:${subcommand}`,[alias()],false));
      else if(subcommand==='add'||subcommand==='edit'){
        const input={id:alias(),...(str('hostname')?{hostname:str('hostname')}:{}),...(str('user')?{user:str('user')}:{}),...(str('port')?{port:Number(str('port'))}:{}),...(str('auth-method')?{authMethod:str('auth-method')}:{}),...(str('key-file')?{identityFile:str('key-file')}:{})};
        print(await call(subcommand==='add'?'terminal:ssh:add':'terminal:ssh:update',subcommand==='add'?[input]:[alias(),input],false));
      }else if(subcommand==='terminal'){
        const host=alias();if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(host))throw new Error('INVALID_SSH_ALIAS');
        if(json||values['no-input']||!process.stdin.isTTY)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
        const child=spawn('ssh',[host],{stdio:'inherit',shell:false});
        process.exitCode=await new Promise<number>((resolve,reject)=>{child.once('error',()=>reject(new Error('SSH_NOT_INSTALLED')));child.once('exit',code=>resolve(code??1));});
      }else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='files'){
      if(subcommand==='download'){
        print(await client.invoke('terminal:files:download',[required(device,'REMOTE_DEVICE_REQUIRED'),required(rest[0],'REMOTE_FILE_URL_REQUIRED'),path.resolve(required(str('output')??rest[1],'OUTPUT_PATH_REQUIRED'))]));return;
      }
      const workdir=required(str('cwd'),'WORKING_DIRECTORY_REQUIRED');
      const base={workdir:device?workdir:path.resolve(workdir),relPath:rest[0]??''};
      const fileCall=async(op:string,extra:Record<string,unknown>={})=>unwrap(await call('file-browser:remote-op',[{...base,...extra,op}]));
      if(subcommand==='list')print(await fileCall('listDir'));
      else if(subcommand==='create')print(await fileCall('createFile'));
      else if(subcommand==='read')print(await fileCall('readFile'));
      else if(subcommand==='stat')print(await fileCall('stat'));
      else if(subcommand==='write'){
        if(!values.stdin)throw new Error('FILE_CONTENT_STDIN_REQUIRED');
        print(await fileCall('writeFile',{content:await stdin()}));
      }else if(subcommand==='mkdir')print(await fileCall('createFolder'));
      else if(subcommand==='remove')print(await fileCall('deleteEntry'));
      else if(subcommand==='rename')print(await fileCall('renameEntry',{fromRel:required(rest[0]),toRel:required(rest[1])}));
      else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='resources'&&subcommand){
      const descriptor={protocolVersion:1,primitives:['text','actions','session-controls'],locale};
      const collectionId=str('collection')??rest[0];
      if(subcommand==='list')print(await call(collectionId?'maker:remote-resources:list':'maker:remote-resources:manifest',[{client:descriptor,...(collectionId?{collectionId,limit:100}:{})}]));
      else if(subcommand==='get'){
        const ref={collectionId:required(collectionId),kind:required(rest[1]),id:required(rest[2])};
        print(await call('maker:remote-resources:get',[{client:descriptor,ref}]));
      }else if(subcommand==='action'){
        let input:unknown={};if(values.stdin){try{input=JSON.parse(await stdin());}catch{throw new Error('INVALID_JSON_INPUT');}}
        const resourceRef=rest[1]?{collectionId:required(collectionId),kind:rest[1],id:required(rest[2])}:undefined;
        print(await invokeResourceAction(client,{client:descriptor,collectionId:required(collectionId),actionId:required(str('action')),input,...(resourceRef?{resourceRef}:{})},device));
      }else throw new Error('UNKNOWN_COMMAND');
      return;
    }
    if(command==='channels'&&(subcommand==='authorization'||subcommand==='cancel')){
      print(await client.invoke('terminal:channel-registration',[{command:subcommand==='authorization'?'read':'cancel',id:required(rest[0],'REGISTRATION_ID_REQUIRED')}]));return;
    }
    if(command&&resourceCollections[command]&&subcommand){
      let input:unknown={};if(values.stdin){try{input=JSON.parse(await stdin());}catch{throw new Error('INVALID_JSON_INPUT');}}
      print(await runResourceCommand(client,{collection:str('collection')??resourceCollections[command],operation:str('action')??subcommand,id:rest[0],input,device,locale,cursor:str('cursor'),limit,query:str('query')}));return;
    }
    const interactive=!json&&!values['no-input']&&!values.once&&process.stdin.isTTY&&process.stdout.isTTY;
    const uiCommand=!command||!!resourceCollections[command]||['login','models','providers','devices','config','attach','resources'].includes(command)||(command==='chat'&&!values.once);
    if(uiCommand){
      if(!interactive)throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
      client=reconnectingClient(directory,client);
      const page=command==='login'?'login':command==='models'||command==='providers'?'models':command==='devices'?'connections':command==='config'?'service':command==='resources'||command&&resourceCollections[command]?'resources':'tasks';
      let nextPage=page, nextDevice=device;
      for(;;){
        const external=await runTui(client,{locale,page:nextPage,task:command==='attach'?required(subcommand,'TASK_ID_REQUIRED'):undefined,device:nextDevice,sso:values.sso===true,collection:command?str('collection')??resourceCollections[command]:undefined});
        if(!external)break;
        client=await startBackground(directory);
        if(external.type==='provider-terminal'){await runProviderTerminal(client,external.loginId);client=reconnectingClient(directory,client);nextPage='models';nextDevice=external.device;continue;}
        if(external.type==='service-uninstall'){
          print(await new TerminalServiceManager(directory,fileURLToPath(import.meta.url)).completeUninstall());return;
        }
        if(external.type==='service-activate'){client=await activateService(directory,client);client=reconnectingClient(directory,client);nextPage='service';continue;}
        if(external.type==='service-boot'){client.close();client=reconnectingClient(directory,await enableBootService(directory));nextPage='service';continue;}
        const manager=new EngineManager({profileDir:directory});const binary=await manager.resolve(external.kind);
        if(!binary)throw new Error('ENGINE_NOT_INSTALLED');
        if (external.kind === 'claude-code') await claudeAuthorization(client,binary.binary,external.operation);
        else await runNativeLogin(external.kind,binary.binary,external.operation,{onInstruction:value=>print(value==='pi-login'?'/login':'/logout')});
        client=reconnectingClient(directory,await startBackground(directory));
        await client.invoke('terminal:engines:refresh').catch(()=>{});nextPage='engines';
      }
      return;
    }
    if(command==='chat'&&values.once){
      const text=values.stdin?await stdin():positionals.slice(1).join(' ');
      if(!text.trim()&&!inputFiles.length)throw new Error('MESSAGE_REQUIRED');
      const selection=device?(await connectedModels(client,device)).find(model=>(!str('provider')||model.providerId===str('provider'))&&(!str('engine')||model.agentKind===str('engine'))&&(!str('model')||model.model===str('model'))):undefined;
      if(device&&!selection)throw new Error('MODEL_NOT_CONFIGURED');
      const data=object(await call('maker:create-session',[{...selection,title:t.newTask,
        ...(!str('cwd')?{workspaceKind:'dialogue'}:{}),
        ...(str('cwd')?{workingDir:device?str('cwd'):path.resolve(str('cwd')!)}:{}),...(str('model')?{model:str('model')}:{}),
        ...(str('provider')?{providerId:str('provider')}:{}),...(str('engine')?{agentKind:str('engine')}:{}),
      }]));
      const id=data.sessionId??data.id;if(typeof id!=='string')throw new Error('INVALID_SESSION_RESPONSE');
      const requestId=str('request-id')??randomUUID();
      const result=await enqueueMessage(client,id,text,requestId,device,{files:inputFiles});
      await finishTurn(id,requestId,result,!values.detach);return;
    }
    throw new Error('UNKNOWN_COMMAND');
  }finally{client.close();}
}

void main().catch(error=>{
  const raw=error instanceof Error?String(('code' in error?error.code:undefined)??error.message):'';
  const code=/^[A-Za-z][A-Za-z0-9_]+$/.test(raw)?raw.toUpperCase():'OPERATION_FAILED';
  if(json)process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\n');
  else process.stderr.write(`${getMessages(locale).error} · ${code}\n`);
  process.exitCode=1;
});
