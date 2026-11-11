import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { PluginWriteAccessGate } from '../pluginWriteAccessGate.js';

const source=readFileSync(new URL('../register.ts',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  const pluginWriteAccessFromHost ='),source.indexOf("  ipcMain.handle('maker:get-plugin-write-access-recovery'"));
const js=ts.transpileModule(`${handler}\nreturn pluginWriteAccessFromHost;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
async function fixture(){
 const owner={client:{}};let current:unknown=owner,identity='approved';
 const gate=new PluginWriteAccessGate();await gate.request(JSON.stringify(['plugin','task']),identity,'auto',false,async()=>({granted:false}));
 const event={sender:{isDestroyed:()=>false},senderFrame:{}};
 const read=vi.fn(async()=>({operation:'create',pluginId:'plugin'}));
 const get=vi.fn(async()=>({}));
 const remote=vi.fn(()=>false),trusted=vi.fn(()=>{});
 const call=vi.fn(async(_id:string,_request:unknown,explicit:boolean,assert:()=>void)=>{expect(explicit).toBe(true);assert();return {granted:true};});
 const deps={isDeviceLinkInvoke:remote,assertTrustedAppRendererEvent:trusted,throwIpcError:(code:string,message:string)=>{throw Object.assign(new Error(message),{code});},getCurrentDbClientSnapshot:()=>current,createPluginTaskStore:()=>({get:read}),pluginTaskServiceForCurrentOwner:()=>({get}),pluginWriteAccessIdentity:()=>identity,pluginWriteAccessGate:gate,handlePluginTask:call};
 const run=new Function(...Object.keys(deps),js)(...Object.values(deps));
 return {run:(retry=true)=>run(event,'task',retry),read,get,remote,trusted,call,event,changeOwner:()=>{current={};},changeInstall:()=>{identity='new';}};
}
describe('local task permission recovery boundary',()=>{
 it('reads the original mode without granting and only explicit retry calls the common handler',async()=>{
  const f=await fixture();await expect(f.run(false)).resolves.toEqual({granted:false,available:true});expect(f.call).not.toHaveBeenCalled();
  await expect(f.run()).resolves.toMatchObject({granted:true,mode:'auto'});
  expect(f.call).toHaveBeenCalledWith('plugin',expect.objectContaining({taskId:'task',mode:'auto'}),true,expect.any(Function));
 });
 it.each(['remote','untrusted'] as const)('rejects %s before reading private task records',async kind=>{
  const f=await fixture();if(kind==='remote')f.remote.mockReturnValue(true);else f.trusted.mockImplementation(()=>{throw new Error('untrusted');});
  await expect(f.run()).rejects.toThrow();expect(f.read).not.toHaveBeenCalled();expect(f.call).not.toHaveBeenCalled();
 });
 it('rejects account replacement during task lookup',async()=>{
  const f=await fixture();f.get.mockImplementation(async()=>{f.changeOwner();return {};});
  await expect(f.run()).rejects.toMatchObject({code:'PERMISSION_DENIED'});expect(f.call).not.toHaveBeenCalled();
 });
 it.each(['install','window'] as const)('rechecks %s before the recovered native grant',async point=>{
  const f=await fixture();f.call.mockImplementation(async(_id,_request,_explicit,assert)=>{if(point==='install')f.changeInstall();else f.event.senderFrame={};assert();return {granted:true};});
  await expect(f.run()).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 });
 it('does not let a different installation recover an old denied request',async()=>{
  const f=await fixture();f.changeInstall();await expect(f.run()).resolves.toMatchObject({available:false,granted:false});expect(f.call).not.toHaveBeenCalled();
 });
});
