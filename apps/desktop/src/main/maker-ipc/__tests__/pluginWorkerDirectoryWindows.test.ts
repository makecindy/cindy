import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { PluginTaskError } from '../pluginTaskService.js';

// Execute the production resolver with Windows path semantics, even on macOS.
const source = readFileSync(new URL('../pluginWorkerDirectory.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
function fixture(links: Record<string, string>) {
 const fs = {
  lstat: vi.fn(async (p: string) => ({isSymbolicLink:()=>p in links})),
  readlink: vi.fn(async (p: string) => links[p]),
  realpath: vi.fn(async (p: string) => p),
  stat: vi.fn(async () => ({isDirectory:()=>true})),
 };
 const exports: Record<string, any> = {};
 const inside=(root:string,dir:string)=>{const relative=path.win32.relative(root,dir);return !relative||(!relative.startsWith('..')&&!path.win32.isAbsolute(relative));};
 new Function('require','exports','process',js)((id:string)=>id==='node:path'?path.win32:id==='node:fs/promises'?fs:id.endsWith('dirDeposit.js')?{isPathInsideDir:inside}:{PluginTaskError},exports,{platform:'win32'});
 return {fs,resolve:exports.resolvePluginWorkerDirectory};
}

it.each(['\\\\server\\share','//server/share','\\\\?\\UNC\\server\\share','\\??\\UNC\\server\\share','\\\\.\\pipe\\name'])('rejects a Windows link to %s before following it',async target=>{
 const f=fixture({'C:\\picked':target});
 await expect(f.resolve({requested:'C:\\picked\\child',leadDirectory:'C:\\picked',isPickedDirectory:()=>false,assertCurrent:()=>{}})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 expect(f.fs.realpath).not.toHaveBeenCalled();expect(f.fs.stat).not.toHaveBeenCalled();
 expect(f.fs.lstat.mock.calls.map(([p])=>p)).toEqual(['C:\\picked']);
});
it('checks multi-hop links, stored roots and cycles before canonical lookup',async()=>{
 for(const links of [
  {'C:\\picked':'C:\\alias','C:\\alias':'\\\\server\\share'},
  {'C:\\picked':'C:\\alias','C:\\alias':'C:\\picked'},
 ]){
  const f=fixture(links);
  await expect(f.resolve({requested:'C:\\picked',configuredDirectory:'C:\\picked',isPickedDirectory:()=>false,assertCurrent:()=>{}})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
  expect(f.fs.realpath).not.toHaveBeenCalled();
 }
 const f=fixture({'C:\\stored':'\\\\server\\share'});
 await expect(f.resolve({requested:'C:\\stored\\child',leadDirectory:'C:\\stored',isPickedDirectory:()=>false,assertCurrent:()=>{}})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
 expect(f.fs.realpath).not.toHaveBeenCalled();
});
it('retains local relative aliases, multi-hop aliases and local long-path syntax',async()=>{
 const f=fixture({'C:\\alias':'target','C:\\target':'\\\\?\\C:\\selected'});
 f.fs.realpath.mockImplementation(async p=>p==='C:\\alias'?'C:\\selected':p);
 const input={requested:'C:\\alias',isPickedDirectory:(p:string)=>p==='C:\\alias'||p==='C:\\selected',assertCurrent:()=>{}};
 await expect(f.resolve(input)).resolves.toBe('C:\\selected');
 await expect(f.resolve({...input,requested:'\\\\?\\C:\\selected'})).resolves.toBe('C:\\selected');
});

it('anchors root-relative local link targets to the link drive',async()=>{
 const f=fixture({'C:\\alias':'\\selected'});
 await expect(f.resolve({requested:'C:\\alias',isPickedDirectory:(p:string)=>p==='C:\\alias'||p==='C:\\selected',assertCurrent:()=>{}})).resolves.toBe('C:\\selected');
 expect(f.fs.realpath).toHaveBeenCalledWith('C:\\selected');
 expect(f.fs.lstat.mock.calls.every(([p])=>p.startsWith('C:\\'))).toBe(true);
});
