import {fork} from 'node:child_process';
import path from 'node:path';
import type {ForgeScaffoldWriter,ForgeScaffoldWriteResult} from './forge.js';

/** The shared worker pins cwd to the verified parent. Node's IPC transports
 * the same request as Desktop's utility process, including bigint identities. */
export function createNativeScaffoldWriter(options:{nodePath:string;workerPath:string}):ForgeScaffoldWriter {
  if(![options.nodePath,options.workerPath].every(value=>path.isAbsolute(value)))throw new Error('PLUGIN_WORKER_PATH_INVALID');
  return request=>new Promise(resolve=>{
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL'])if(process.env[key]!==undefined)env[key]=process.env[key];
    const child=fork(options.workerPath,[],{execPath:options.nodePath,cwd:request.parentDir,env,stdio:['ignore','ignore','pipe','ipc'],serialization:'advanced'});
    let settled=false,ready=false;
    const finish=(result:ForgeScaffoldWriteResult)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill();resolve(result);};
    const fail=()=>finish({ok:false,errorCode:'INTERNAL',message:'Forge scaffold worker failed'});
    const timer=setTimeout(fail,30_000);timer.unref();child.stderr?.resume();
    child.on('message',message=>{
      if(!message||typeof message!=='object')return;
      const value=message as {type?:unknown;ok?:unknown;errorCode?:unknown;message?:unknown};
      if(!ready&&value.type==='ready'){
        ready=true;const {parentDir:_parent,...body}=request;
        child.send({type:'scaffold',request:body},error=>{if(error)fail();});
      }else if(value.ok===true)finish({ok:true});
      else if(value.ok===false&&(value.errorCode==='TARGET_EXISTS'||value.errorCode==='INTERNAL'))finish({ok:false,errorCode:value.errorCode,message:String(value.message??'Forge scaffold worker failed')});
    });
    child.on('error',fail);child.on('exit',()=>{if(!settled)fail();});
  });
}
