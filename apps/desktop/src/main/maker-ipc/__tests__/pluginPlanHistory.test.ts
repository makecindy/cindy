import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { PluginTaskError } from '../pluginTaskService.js';
import { withSendToSessionLock, hasSendToSessionLock } from '../sendToSessionLock.js';
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const compile = (text: string) => ts.transpileModule(text, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
it.each(['empty', 'user', 'started', 'ended', 'worker', 'reserved', 'unavailable'])('checks durable plan admission after persistence: %s', async state => {
  const start=source.indexOf('assertTeamPlanUnstarted: async taskId => {');
  const property=source.slice(start,source.indexOf('\n      createSession:',start)).trim().replace(/,$/,'');
  const tables=['messages','sessions','orcaWorkers','orcaTeams','orcaWorkerCreationReservations'];
  const records=Object.fromEntries(tables.map(name=>[name,{name}]));
  let drained=false;
  const snapshot={client:{drizzle:{select:()=>{
    let table:{name:string};
    const query={from(value:{name:string}){table=value;return query;},innerJoin(){return query;},where(){return query;},async limit(){
      expect(drained).toBe(true);
      if(state==='unavailable')throw Error('unavailable');
      if(table.name==='sessions')return [{startedAt:state==='started'?0:null,endedAt:state==='ended'?1:null}];
      const populated:Record<string,string>={user:'messages',worker:'orcaWorkers',reserved:'orcaWorkerCreationReservations'};
      return table.name===populated[state]?[{id:'existing'}]:[];
    }};return query;
  }}}};
  const deps={snapshot,assertCurrent:vi.fn(),drainPersistQueue:async()=>{drained=true;},PluginTaskError,eq:vi.fn(),and:vi.fn(),gte:vi.fn(),...records};
  const check=new Function(...Object.keys(deps),compile(`return ({${property}}).assertTeamPlanUnstarted;`))(...Object.values(deps));
  if(state==='empty')await expect(check('task')).resolves.toBeUndefined();
  else await expect(check('task')).rejects.toThrow(state==='unavailable'?'unavailable':'Register the team plan');
});
it('holds the real send lock from directory validation through plan persistence',async()=>{
  const branch=source.slice(source.indexOf("      case 'setTeamPlan':"),source.indexOf("      case 'releaseWorker':"));
  const epoch={};const task={workingDir:'/root',revision:1};
  let release!:()=>void;const saving=new Promise<void>(resolve=>{release=resolve;});
  const save=vi.fn(async()=>{expect(hasSendToSessionLock('plan-history')).toBe(true);await saving;return {ok:true};});
  const deps={withSendToSessionLock,getCurrentDbClientSnapshot:()=>epoch,service:{get:async()=>task,setTeamPlan:save},readGhostErrandConfig:()=>({workingDir:'/root'}),isPluginTaskAuthorized:()=>true,isGhostPickedDir:()=>false,PluginTaskError,resolvePluginWorkerDirectory:async()=>{expect(hasSendToSessionLock('plan-history')).toBe(true);}};
  const run=new Function(...Object.keys(deps),compile(`return async function(pluginId,request){switch(request.kind){${branch}}}`))(...Object.values(deps));
  const pending=run('plugin',{kind:'setTeamPlan',taskId:'plan-history',plan:{items:[{workingDir:'/root'}]}});
  try {await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce());expect(hasSendToSessionLock('plan-history')).toBe(true);}
  finally {release();await pending;}
  await vi.waitFor(()=>expect(hasSendToSessionLock('plan-history')).toBe(false));
});
