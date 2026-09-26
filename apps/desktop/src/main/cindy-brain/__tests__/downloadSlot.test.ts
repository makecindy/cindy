import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginDownloadSlot } from '../downloadSlot';
import type { InstalledGhost } from '../../../shared/ghost';
it('restricts redirects, rejects arbitrary paths and isolates owner delivery', async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'plugin-download-test-')));
 let scope='a';const events:unknown[]=[];
 const ghost={enabled:true,approval:{state:'approved'},manifest:{node:{},network:{hosts:['github.com']}}} as unknown as InstalledGhost;
 let calls=0;
 const slot=new PluginDownloadSlot({root:()=>root,scope:()=>scope,getGhost:()=>ghost,send:(_,e)=>events.push(e),download:async o=>{
 calls++;expect(()=>o.validateUrl!('https://evil.invalid/file')).toThrow();
 expect(()=>o.validateUrl!('http://github.com/file')).toThrow();
 o.onProgress?.({loaded:1,total:2,percent:50,speedBps:1});
 scope='b';return {path:o.targetPath,size:2,sha256:o.sha256,fromCache:false,durationMs:1,resumedFromBytes:0};
 }});
 const req={kind:'start',id:'x',url:'https://github.com/file',sha256:'a'.repeat(64),bytes:2};
 try{
 expect(await slot.handle('p',{...req,targetPath:'/tmp/arbitrary'})).toMatchObject({ok:false});
 expect(calls).toBe(0);
 expect(await slot.handle('p',req)).toMatchObject({ok:false});
 expect(calls).toBe(1);
 expect(events.filter((x:any)=>x.data.phase==='completed')).toHaveLength(0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
it('cancel reaches only the matching active request',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'plugin-download-test-')));
 const ghost={enabled:true,approval:{},manifest:{node:{},network:{hosts:['github.com']}}} as unknown as InstalledGhost;
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const slot=new PluginDownloadSlot({root:()=>root,scope:()=> 'a',getGhost:()=>ghost,send:()=>{},download:async o=>new Promise((_,reject)=>{started();o.signal!.addEventListener('abort',()=>reject(Error('aborted')));})});
 try{const work=slot.handle('p',{kind:'start',id:'x',url:'https://github.com/file',sha256:'a'.repeat(64),bytes:2});await ready;await slot.handle('p',{kind:'cancel',id:'x'});expect(await work).toMatchObject({ok:false,message:'下载已取消'});}finally{await fs.rm(root,{recursive:true,force:true});}
});
