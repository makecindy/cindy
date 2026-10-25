import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { REMOTE_TERMINAL_CHANNEL } from '@cindy/terminal-core';
import type { TerminalClient } from './contracts.js';
import { unwrap } from './client-operations.js';
import { getShellMessages, type Locale } from './ui/i18n.js';

/** Raw terminal input goes only to the selected PTY; it never enters task
 * messages, model context, command arguments, or application logs. */
export async function runShell(client: TerminalClient, options: { device?: string; id?: string; cwd?: string; shell?: string; locale: Locale }): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  const t=getShellMessages(options.locale);
  const call=async(op:string,args:Record<string,unknown>={})=>unwrap(await client.invoke(REMOTE_TERMINAL_CHANNEL,[{version:1,op,...args}],options.device)) as Record<string,unknown>;
  await call('capabilities');
  const id=options.id??randomUUID();
  if(!options.id)await call('create',{id,cwd:options.cwd??(options.device?undefined:process.cwd()),shell:options.shell,cols:process.stdout.columns,rows:process.stdout.rows});
  process.stdout.write(`${t.connected} ${id}\r\n${t.detach}\r\n`);
  let cursor=0,code=0,failure:unknown;
  const abort=new AbortController();
  let writes=Promise.resolve();
  const fail=(error:unknown)=>{failure=error;abort.abort();};
  const send=(chunk:string)=>{
    if(abort.signal.aborted)return;
    if(chunk.includes('\u001d')){abort.abort();return;}
    process.stdin.pause();
    writes=writes.then(async()=>{
      for(const data of chunk.match(/[\s\S]{1,32768}/gu)??[])await call('write',{id,data,requestId:randomUUID()});
    }).then(()=>{if(!abort.signal.aborted)process.stdin.resume();}).catch(fail);
  };
  const resize=()=>{void call('resize',{id,cols:process.stdout.columns,rows:process.stdout.rows}).catch(fail);};
  const detach=()=>abort.abort();
  const wasRaw=process.stdin.isRaw;
  process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);process.stdin.resume();
  process.stdin.on('data',send);process.stdout.on('resize',resize);process.once('SIGTERM',detach);
  try{
    resize();
    while(!abort.signal.aborted){
      const state=await call('read',{id,after:cursor});
      if(state.gap)process.stdout.write(`\r\n${t.gap}\r\n`);
      for(const part of state.chunks as Array<{sequence:number;data:string}>){if(!process.stdout.write(part.data))await once(process.stdout,'drain');cursor=part.sequence;}
      if(state.exit){const exit=state.exit as {code?:number};code=exit.code??0;break;}
      if(!state.more)await pause(options.device?180:40,undefined,{signal:abort.signal}).catch(()=>{});
    }
  }finally{
    process.stdin.off('data',send);process.stdout.off('resize',resize);process.off('SIGTERM',detach);
    process.stdin.setRawMode(wasRaw);process.stdin.pause();await writes;
    // Full-screen programs can still be alive on the host when we detach.
    // Restore the local terminal without sending a quit signal to that program.
    process.stdout.write('\u001b[?1049l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[0m\u001b[?25h\r\n');
  }
  if(failure)throw failure;
  return code;
}
