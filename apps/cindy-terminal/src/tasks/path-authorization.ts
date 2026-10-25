import type {Logger,Session} from '@cindy/maker-core';
import {getSessionPathAuthorizer,setSessionPathAuthorizer,type SessionPathAuthorizer} from '@cindy/mcps';
import {createSessionPathAuthorization,type GetLiveSessionGrantState} from '@cindy/app-runtime/sessionPathAuthorization';
import {resolveGhostFsSessionSnapshot} from '@cindy/app-runtime/ghostFsSessionSnapshot';
import type {GhostGrantConfirmPayload,GhostGrantConfirmDecision} from '@cindy/plugin-runtime/grantTypes';

type Host={logger:Logger;session(id:string):Session|undefined;confirm(id:string,payload:GhostGrantConfirmPayload):Promise<GhostGrantConfirmDecision>};
const hosts=new Map<symbol,{resolve:GetLiveSessionGrantState;authorize:SessionPathAuthorizer}>();
let previous:SessionPathAuthorizer|undefined;
const route:SessionPathAuthorizer=async request=>{
  for(const host of hosts.values())if(request.sessionId&&request.sessionInstanceId&&host.resolve(request.sessionId,request.sessionInstanceId))return host.authorize(request);
  if(previous)return previous(request);
  return {allowed:false,reason:'当前任务实例已失效，不能读写工作目录外的路径。请用当前任务重试。'};
};

/** Original live-session grant rules, routed by the exact Maker instance. */
export function registerTerminalSessionPathHost(host:Host):()=>void{
  const resolve:GetLiveSessionGrantState=(id,instance)=>{
    const session=host.session(id);
    if(!session||session.instanceId!==instance||session.getStatus()!=='active')return null;
    const snapshot=resolveGhostFsSessionSnapshot(host.session,id,instance);
    return {permissionMode:session.stablePermissionModeState?.mode??null,remoteHostId:session.remoteHostId,
      isCurrent:()=>!!snapshot&&!snapshot.planModeEnabled&&snapshot.permissionMode!=='plan'&&snapshot.isCurrent?.()===true,
      reviewAction:snapshot?.reviewAction,autoReviewOwner:session.autoReviewOwner};
  };
  const original=createSessionPathAuthorization({logger:host.logger,ghostDisplayName:()=> 'Cindy',getGrantBridge:()=>({request:host.confirm})});
  const key=Symbol('native-path-host');
  if(!hosts.size){previous=getSessionPathAuthorizer();setSessionPathAuthorizer(route);}
  hosts.set(key,{resolve,authorize:request=>original.authorizeSessionPath(request,resolve)});
  return ()=>{
    hosts.delete(key);
    if(!hosts.size){if(getSessionPathAuthorizer()===route)setSessionPathAuthorizer(previous);previous=undefined;}
  };
}
