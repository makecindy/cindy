import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TerminalService } from '../src/service.js';
import { connectTerminal } from '../src/transport.js';

// Explicit, opt-in acceptance: uses the installed vendor CLI's existing login.
// Does not read/copy its credentials or change its configuration.
const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-acceptance-'));
const service = new TerminalService(path.join(directory, 'profile'), 'global', { worktreeAppDataRoot: path.join(directory, 'worktree-app-data') });
let dispose = () => {};
const timer = setTimeout(() => { process.stderr.write('REAL_TASK_TIMEOUT\n'); void service.close(); process.exitCode = 1; }, 120_000);
try {
  await service.start();
  const client = await connectTerminal(service.profileDir);
  try {
    await client.invoke('terminal:vault:initialize', ['machine']);
    const providers = await client.invoke<Array<{ id: string; connected: boolean; models: Record<string,Array<{id:string;defaultEnabled?:boolean;disabled?:boolean}>> }>>('maker:provider:list');
    const provider = providers.find(provider => provider.connected && provider.models.codex?.some(model => model.defaultEnabled !== false && !model.disabled));
    assert.ok(provider, 'NATIVE_CODEX_LOGIN_REQUIRED');
    const model = provider.models.codex.find(model => model.defaultEnabled !== false && !model.disabled)!;
    console.log(JSON.stringify({ phase:'route', engine:'codex',provider:provider.id,model:model.id }));
    const task = await client.invoke<{id:string}>('maker:create-session',[{title:'Terminal acceptance',workingDir:directory,agentKind:'codex',providerId:provider.id,model:model.id}]);
    let complete!: () => void;
    let fail!: (error:Error) => void;
    const done = new Promise<void>((resolve,reject)=>{complete=resolve;fail=reject;});
    let output = '';
    dispose = client.subscribe((channel,args)=>{
      const value=args[0] as {sessionId?:string;event?:{type?:string;data?:unknown}}|undefined;
      if(channel!=='maker:event'||value?.sessionId!==task.id)return;
      const event=value.event;
      if(event?.type==='text'){
        const data=event.data as {text?:string;content?:string;isFinal?:boolean};
        const text=typeof event.data==='string'?event.data:data?.text??data?.content??'';
        output=data?.isFinal?text:output+text;
      }
      if(event?.type==='error')fail(new Error('NATIVE_TURN_FAILED'));
      if(event?.type==='done')complete();
    });
    await client.invoke('maker:send',[task.id,{text:'Reply with exactly CINDY_TERMINAL_OK. Do not call tools.',clientId:crypto.randomUUID()}]);
    await done;
    assert.match(output,/CINDY_TERMINAL_OK/);
    const observer=await connectTerminal(service.profileDir);
    client.close();
    try {
      const history=await observer.invoke<unknown[]>('local-db:messages:list',[task.id,{limit:20}]);
      assert.ok(history.length>=2);
      console.log(JSON.stringify({phase:'completed',nativeTurn:true,reattach:true,messages:history.length}));
    } finally { observer.close(); }
  } finally { dispose();client.close(); }
} finally {
  clearTimeout(timer);await service.close();await rm(directory,{recursive:true,force:true});
}
