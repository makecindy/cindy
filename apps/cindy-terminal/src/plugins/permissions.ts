import fs from 'node:fs';
import path from 'node:path';
import { toolAutoReviewAction } from '@cindy/maker-core';
import { workdirWriteVerdict, type FsSessionSnapshot } from '@cindy/plugin-runtime/fsSlot';
import { isPathInsideDir } from '@cindy/plugin-runtime/store/dirDeposit';
import type { GhostGrantConfirmPayload, GhostGrantConfirmDecision } from '@cindy/plugin-runtime/grantTypes';

export interface PluginTaskContext {
  sessionId:string;workingDir:string;
  source?: string;
  instanceId():string;
  assertCurrent():void;
  snapshot():Promise<(FsSessionSnapshot & {autoReviewOwner?:'native'|'cindy'})|null>;
  confirm(payload:GhostGrantConfirmPayload,signal?:AbortSignal):Promise<GhostGrantConfirmDecision>;
}
export function canonicalPluginPath(source:string,allowMissing=false):string{
  if(!path.isAbsolute(source))throw new Error('ABSOLUTE_PATH_REQUIRED');
  let cursor=path.resolve(source),suffix:string[]=[];
  for(;;){
    try{return path.join(fs.realpathSync.native(cursor),...suffix);}
    catch(error){
      if(!allowMissing||(error as NodeJS.ErrnoException).code!=='ENOENT'||path.dirname(cursor)===cursor)throw error;
      suffix.unshift(path.basename(cursor));cursor=path.dirname(cursor);
    }
  }
}
/** One live permission generation owns the whole operation, including awaits. */
export async function authorizePluginPaths(context:PluginTaskContext,payload:GhostGrantConfirmPayload,options:{write?:boolean;allowMissing?:boolean;signal?:AbortSignal;forceConfirm?:boolean}={}){
  context.assertCurrent();options.signal?.throwIfAborted();
  const live=await context.snapshot();context.assertCurrent();
  if(!live?.workingDir||live.isCurrent?.()!==true)throw new Error('TASK_PERMISSION_CHANGED');
  const check=()=>{context.assertCurrent();options.signal?.throwIfAborted();if(live.isCurrent?.()!==true)throw new Error('TASK_PERMISSION_CHANGED');};check();
  if(options.write&&workdirWriteVerdict(live.permissionMode,live.planModeEnabled)==='deny')throw new Error('PLAN_MODE_READ_ONLY');
  const paths=payload.items.map(item=>canonicalPluginPath(item.absPath,options.allowMissing));
  let workdir:string|null=null;
  if(!live.remoteHostId)try{workdir=canonicalPluginPath(live.workingDir);}catch{/* Unverifiable workdir cannot grant local files. */}
  const inside=Boolean(workdir)&&paths.every(file=>isPathInsideDir(workdir!,file));
  const needsApproval=options.forceConfirm||!inside;
  let source:'user'|'tool'='tool';
  if(needsApproval){
    let allowed=!options.forceConfirm&&live.permissionMode==='bypassPermissions'&&!live.remoteHostId;
    if(!allowed&&!options.forceConfirm&&live.permissionMode==='auto'&&live.reviewAction){
      const aliasesChanged=paths.some((file,index)=>file!==path.resolve(payload.items[index].absPath));
      if(live.autoReviewOwner==='native'&&!live.remoteHostId&&!aliasesChanged)allowed=true;
      else{
        const result=await live.reviewAction(toolAutoReviewAction('plugin_file_handoff',{...payload,items:payload.items.map((item,index)=>({...item,absPath:paths[index]}))},live.remoteHostId?'Files are on the controller, not the remote task filesystem.':undefined));check();
        if(result.verdict==='block')throw new Error('PLUGIN_FILE_HANDOFF_DENIED');
        allowed=result.verdict==='allow';
      }
    }
    if(!allowed){
      const result=await context.confirm({...payload,items:payload.items.map((item,index)=>({...item,absPath:paths[index]}))},options.signal);check();
      if(!result.confirmed)throw new Error('PLUGIN_FILE_HANDOFF_DENIED');source='user';
    }
  }
  const assertCurrent=()=>{check();for(let index=0;index<paths.length;index++)if(canonicalPluginPath(payload.items[index].absPath,options.allowMissing)!==paths[index])throw new Error('PLUGIN_PATH_CHANGED');};
  assertCurrent();return {paths,inside,source,assertCurrent,isCurrent:()=>{try{assertCurrent();return true;}catch{return false;}}};
}
