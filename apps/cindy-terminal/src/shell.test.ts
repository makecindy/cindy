/** Rule: a remote PTY belongs to its authenticated controller and account.
 * Existing window-owned PTY tests do not cover remote identity or replay.
 * Minimal failure: another controller guesses a live terminal ID. Tier: unit;
 * the public host entry is real, only OS PTY callbacks are supplied in memory. */
import { describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';
import { RemoteTerminalHost } from '@cindy/terminal-core';

describe('remote terminal authority',()=>{
  it('isolates controllers, deduplicates input, and drops PTYs on account replacement',async()=>{
    let scope='account-one',spawned=0,killed=0;
    const written:string[]=[];
    let output:(data:string)=>void=()=>{};
    const host=new RemoteTerminalHost({getScope:()=>scope,logger:{info(){},warn(){}},spawn:()=>{
      spawned++;return {pid:1,write:(data:string)=>written.push(data),resize(){},kill:()=>{killed++;},onData:(callback:(data:string)=>void)=>{output=callback;return {dispose(){}};},onExit:()=>({dispose(){}})} as unknown as IPty;
    }});
    const invoke=(controller:string,op:string,args:Record<string,unknown>={})=>host.invoke({version:1,op,id:'terminal-one',...args},{controller,assertCurrent(){}});
    try{
      await Promise.all([invoke('controller-a','create',{cwd:process.cwd()}),invoke('controller-a','create',{cwd:process.cwd()})]);
      expect(spawned).toBe(1);
      await expect(invoke('controller-b','read')).rejects.toThrow('TERMINAL_NOT_FOUND');
      await expect(invoke('controller-b','write',{requestId:'write-one',data:'secret'})).rejects.toThrow('TERMINAL_NOT_FOUND');
      await invoke('controller-a','write',{requestId:'write-one',data:'hello\r'});
      await invoke('controller-a','write',{requestId:'write-one',data:'hello\r'});
      expect(written).toEqual(['hello\r']);
      await expect(invoke('controller-a','write',{requestId:'write-one',data:'different\r'})).rejects.toThrow('TERMINAL_REQUEST_CONFLICT');
      output('中文结果');
      expect(await invoke('controller-a','read')).toMatchObject({chunks:[{data:'中文结果'}],gap:false});
      output('x'.repeat(3*1024*1024));
      const page=await invoke('controller-a','read') as {chunks:Array<{data:string}>;gap:boolean};
      expect(page.gap).toBe(true);expect(page.chunks.reduce((sum,item)=>sum+item.data.length,0)).toBeLessThanOrEqual(256*1024);
      scope='account-two';expect(await invoke('controller-a','list')).toEqual([]);expect(killed).toBe(1);
      await expect(invoke('controller-a','read')).rejects.toThrow('TERMINAL_NOT_FOUND');
    }finally{host.close();}
  });
});
