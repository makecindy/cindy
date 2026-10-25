import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFileNoFollow } from '@cindy/remote-agent/readBoundedFile';
import { sniffMediaMime } from '@cindy/media-core';
import { GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE } from '@cindy/plugin-runtime/shared/ghost';
import { MAX_GRANT_ATTACHMENTS,MAX_GRANT_ONLY_ATTACHMENTS } from '@cindy/plugin-runtime/attachmentGrant';
import { collectDirFiles, type DirDepositVault, type SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { CindyGhostsMcpDeps } from 'cindy-tools';
import type { TerminalTaskMedia } from '../tasks/media.js';
import { authorizePluginPaths,canonicalPluginPath,type PluginTaskContext } from './permissions.js';

export async function grantPluginCall(request:Parameters<CindyGhostsMcpDeps['callGhostTool']>[0],options:{
  instance:string;name:string;context:PluginTaskContext;media:TerminalTaskMedia;
  deposits:DirDepositVault;saves:SaveDepositVault;assertCurrent():void;
}){
  const {context}=options,checks=[options.assertCurrent,context.assertCurrent];
  const check=()=>{request.signal?.throwIfAborted();for(const check of checks)check();};check();
  const args={...request.args};
  if(request.attachments?.length){
    const limit=request.grantOnly?MAX_GRANT_ONLY_ATTACHMENTS:MAX_GRANT_ATTACHMENTS;
    if(request.attachments.length>limit)throw new Error('TOO_MANY_ATTACHMENTS');
    const staged:Array<{bytes:Buffer;mimeType:string;originKind:'user'|'tool';path?:string;canonical?:string}>=[];
    let total=0;
    for(const url of request.attachments){
      check();let item;
      if(url.startsWith('cindy-media:'))item=await options.media.preparePluginAttachment(url,context.sessionId,check);
      else{
        const real=canonicalPluginPath(url),bytes=await readBoundedFileNoFollow(real,GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE,{nonBlocking:true});check();
        if(!bytes)throw new Error('ATTACHMENT_INVALID');
        const mimeType=sniffMediaMime(bytes.subarray(0,65536));if(!mimeType)throw new Error('UNRECOGNIZED_MEDIA_TYPE');
        item={bytes:Buffer.from(bytes),mimeType,originKind:'tool' as const,path:url,canonical:real};
      }
      total+=item.bytes.length;if(total>1024*1024*1024)throw new Error('ATTACHMENTS_TOO_LARGE');staged.push(item);
    }
    const local=staged.filter(item=>item.path);
    if(local.length){
      const unchanged=()=>{for(const item of local)if(canonicalPluginPath(item.path!)!==item.canonical)throw new Error('PLUGIN_PATH_CHANGED');};unchanged();checks.push(unchanged);
      const granted=await authorizePluginPaths(context,{ghostId:options.instance,ghostName:options.name,lane:'attachments',items:local.map(item=>({name:path.basename(item.path!),absPath:item.path!,size:item.bytes.length,mimeType:item.mimeType,...(item.mimeType.startsWith('image/')&&item.bytes.length<=4*1024*1024?{previewDataUrl:`data:${item.mimeType};base64,${item.bytes.toString('base64')}`}:{})}))},{signal:request.signal});
      checks.push(granted.assertCurrent);check();for(const item of local)item.originKind=granted.source;
    }
    args.attachments=await options.media.grantPluginAttachments(options.instance,staged,check);check();
  }
  if(!request.grantOnly)for(const [source,lane] of [[request.dir,'dir'],[request.saveDir,'save_dir']] as const){
    if(!source)continue;
    const canonical=canonicalPluginPath(source),info=fs.statSync(canonical);if(!info.isDirectory())throw new Error('DIRECTORY_REQUIRED');
    const collected=lane==='dir'?collectDirFiles(canonical):null;
    if(collected&&!collected.ok)throw new Error('DIRECTORY_DEPOSIT_INVALID');
    const granted=await authorizePluginPaths(context,{ghostId:options.instance,ghostName:options.name,lane,operation:lane==='dir'?'read':'write',items:[{name:path.basename(source),absPath:source,size:collected?.ok?collected.totalBytes:0,isDirectory:true,...(collected?.ok?{fileCount:collected.files.length}:{})}]},{write:lane==='save_dir',signal:request.signal});
    checks.push(granted.assertCurrent);check();
    const result=(lane==='dir'?options.deposits:options.saves).deposit({ghostId:options.instance,dirAbs:source,workdirAbs:context.workingDir,userGranted:!granted.inside,expectedRealPath:granted.paths[0]});
    if(!result.ok)throw new Error('DIRECTORY_DEPOSIT_INVALID');
    args[lane==='dir'?'dir_deposit':'save_deposit']=result.receipt;
  }
  check();return {args,assertCurrent:check};
}
