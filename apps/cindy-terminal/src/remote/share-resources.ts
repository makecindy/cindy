import { createHash } from 'node:crypto';
import { buildSharedTaskInvitationLink, parseSharedTaskInvitation, sharedTaskHostPeer, type RemoteResourceRegistry, type RemoteCollectionItem } from '@cindy/device-link';
import type { TerminalRemoteAccountService } from './account.js';
import type { TerminalMembershipService } from './membership.js';
import type { TerminalCrossRegionShares } from './cross-region.js';
import type { TerminalRemoteAgentService } from './agent.js';
import type { TerminalRemoteModelGrants } from './model-grants.js';
import type { TerminalReshares } from './reshare.js';
import type { TerminalSharedTasks } from './shared-tasks.js';

import { remoteText as text, remoteString } from './text.js';
const string=(value:unknown)=>{if(typeof value!=='string'||!value.trim())throw new Error('INVALID_ARGUMENT');return value;};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function registerShareResources(registry:RemoteResourceRegistry, options:{
  account:TerminalRemoteAccountService; membership:TerminalMembershipService; cross:TerminalCrossRegionShares;
  agent:TerminalRemoteAgentService; grants:TerminalRemoteModelGrants; deviceId:string; apiBaseUrl():string;
  reshares:TerminalReshares; sharedTasks:TerminalSharedTasks;
  listTasks():Promise<Array<{id:string;title:string}>>;
}) {
  const reshareItems=async():Promise<RemoteCollectionItem[]> => (await options.reshares.list()).map(record=>({ref:{collectionId:'provider-reshares',kind:'provider-reshare',id:record.id},revision:record.state,display:{title:record.name,subtitle:text(record.state)},links:[],actions:[{id:'approve',label:text('Approve','同意')},{id:'reject',label:text('Reject','拒绝'),tone:'destructive'}]}));
  registry.register({collection:{id:'provider-reshares',resourceKind:'provider-reshare',title:text('Forwarded sharing requests','转分享申请'),placement:'settings'},list:async()=>({collectionId:'provider-reshares',revision:'1',items:await reshareItems()}),get:async(context,request)=>{const item=(await reshareItems()).find(item=>item.ref.id===request.ref.id);if(!item)throw new Error('RESHARE_NOT_FOUND');return item;},invoke:async(context,request)=>{if(request.actionId!=='approve'&&request.actionId!=='reject')throw new Error('INVALID_ACTION');const result=await options.reshares.decide(string(request.resourceRef?.id),request.actionId,()=>context.assertCurrent?.());if(!result)throw new Error('RESHARE_NOT_FOUND');return{effects:[{kind:'refresh-collection',collectionId:'provider-reshares'}]};}});
  const shares=async():Promise<RemoteCollectionItem[]>=>{
    const state=await options.membership.list();
    const requests=await options.cross.requests();
    return [
      ...state.owned.map(share=>({ref:{collectionId:'provider-shares',kind:'owned-share',id:share.shareId},revision:JSON.stringify(share),display:{title:share.providerLabel,subtitle:text('{members} members · {requests} requests',undefined,{members:share.members.length,requests:share.requests.length})},links:[],actions:[]})),
      ...state.received.map(share=>({ref:{collectionId:'provider-shares',kind:'received-share',id:share.shareId},revision:share.status,display:{title:share.providerLabel,subtitle:share.owner.displayName,status:{label:text(share.status)}},links:[],actions:[{id:'leave',label:text('Leave share','退出分享'),tone:'destructive'}]})),
      ...requests.map(request=>({ref:{collectionId:'provider-shares',kind:'share-request',id:request.requestId},revision:request.status,display:{title:text('Invitation request','分享申请'),subtitle:text(request.status)},links:[],actions:request.status==='pending'?[{id:'withdraw',label:text('Withdraw request','撤回申请')}]:[]})),
    ];
  };
  registry.register({
    collection:{id:'provider-shares',resourceKind:'provider-share',title:text('Provider sharing','供应商分享'),placement:'settings',actions:[
      {id:'preview',label:text('Preview invitation','查看邀请'),fields:[{id:'link',kind:'text',required:true,label:text('Invitation link','邀请链接')}]},
      {id:'join',label:text('Request access','申请加入'),fields:[{id:'link',kind:'text',required:true,label:text('Invitation link','邀请链接')}]},
    ]},
    list:async()=>({collectionId:'provider-shares',revision:'1',items:await shares()}),
    get:async(context,request)=>{
      const item=(await shares()).find(item=>item.ref.id===request.ref.id&&item.ref.kind===request.ref.kind);if(!item)throw new Error('SHARE_NOT_FOUND');
      if(item.ref.kind!=='owned-share')return item;
      const share=(await options.membership.list()).owned.find(share=>share.shareId===item.ref.id)!;
      const provider=(await options.agent.views()).find(provider=>provider.id===share.providerId);
      const models=[...new Set(Object.values(provider?.models??{}).flatMap(models=>models?.filter(model=>!model.disabled).map(model=>model.id)??[]))];
      return {...item,actions:[...share.requests.flatMap(request=>[
        {id:`approve:${request.requestId}`,label:text('Approve {name}',undefined,{name:request.displayName+' · '+request.pairingCode})},
        {id:`reject:${request.requestId}`,label:text('Reject {name}',undefined,{name:request.displayName})},
      ]),...share.members.flatMap(member=>[
        {id:`${member.status==='active'?'pause':'resume'}:${member.memberId}`,label:text(member.status==='active'?'Pause {name}':'Resume {name}',undefined,{name:member.displayName})},
        {id:`remove:${member.memberId}`,label:text('Remove {name}',undefined,{name:member.displayName}),tone:'destructive'},
        {id:`all:${member.memberId}`,label:text('All models · {name}',undefined,{name:member.displayName})},
        ...models.map(model=>({id:`model:${hash(member.memberId+'\0'+model)}`,label:text(options.grants.allows(share.providerId,model,member.memberId)?'Disable {name}':'Enable {name}',undefined,{name:model+' · '+member.displayName})})),
      ])],blocks:[{id:'members',primitive:'text',fallbackMarkdown:share.members.map(member=>`${member.displayName}: ${remoteString(member.status,request.client.locale)}`).join('\n')}]};
    },
    invoke:async(context,request)=>{
      const guard=()=>context.assertCurrent?.();guard();
      if(request.actionId==='preview') {const preview=await options.cross.preview(string(request.input?.link));guard();return{result:preview,effects:[{kind:'toast',message:{fallback:`${preview.providerLabel} · ${preview.owner.displayName} · ${remoteString(preview.state,request.client.locale)}`}}]};}
      if(request.actionId==='join'){const result=await options.cross.join(string(request.input?.link));guard();return{result,effects:[{kind:'refresh-collection',collectionId:'provider-shares'},{kind:'toast',message:{fallback:result.pairingCode}}]};}
      if(request.resourceRef?.kind==='share-request'&&request.actionId==='withdraw')await options.cross.withdraw(request.resourceRef.id);
      else if(request.resourceRef?.kind==='received-share'&&request.actionId==='leave'){
        const share=(await options.membership.list()).received.find(share=>share.shareId===request.resourceRef!.id);if(!share)throw new Error('SHARE_NOT_FOUND');
        if(!await options.cross.leave(share.memberId))await options.account.providerShares.leave(share.memberId);
      }else{
        const share=(await options.membership.list()).owned.find(share=>share.shareId===request.resourceRef?.id);if(!share)throw new Error('SHARE_NOT_FOUND');guard();
        const [action,id]=request.actionId.split(':');
        if(action==='approve'||action==='reject') {if(!share.requests.some(request=>request.requestId===id))throw new Error('REQUEST_NOT_FOUND');if(action==='approve')await options.account.providerShares.approve(id);else await options.account.providerShares.reject(id);}
        else if(['pause','resume','remove'].includes(action)){if(!share.members.some(member=>member.memberId===id))throw new Error('MEMBER_NOT_FOUND');await options.account.providerShares.setMember(id,action as 'pause'|'resume'|'remove');}
        else if(action==='all'){if(!share.members.some(member=>member.memberId===id))throw new Error('MEMBER_NOT_FOUND');await options.grants.set(share.providerId,null,id,guard);}
        else if(action==='model'){
          const provider=(await options.agent.views()).find(provider=>provider.id===share.providerId);
          const models=[...new Set(Object.values(provider?.models??{}).flatMap(models=>models?.filter(model=>!model.disabled).map(model=>model.id)??[]))];
          const pair=share.members.flatMap(member=>models.map(model=>({member,model}))).find(pair=>hash(pair.member.memberId+'\0'+pair.model)===id);if(!pair)throw new Error('MODEL_NOT_FOUND');
          const previous=options.grants.read(share.providerId,pair.member.memberId).models??models;
          await options.grants.set(share.providerId,previous.includes(pair.model)?previous.filter(model=>model!==pair.model):[...previous,pair.model],pair.member.memberId,guard);
        }else throw new Error('INVALID_ACTION');
      }
      guard();await options.membership.refresh();await options.agent.host.revalidateProviderAccess();
      return{effects:[{kind:'refresh-collection',collectionId:'provider-shares'}]};
    },
  });
  const tasks=async():Promise<RemoteCollectionItem[]>=>Promise.all((await options.account.sharedTasks.list()).map(async task=>{
    const detail=await options.account.sharedTasks.get(task.sharedTaskId);
    const local=detail.hostDeviceId===options.deviceId;
    return {ref:{collectionId:'shared-tasks',kind:local?'hosted-shared-task':'joined-shared-task',id:task.sharedTaskId},revision:String(detail.revision),display:{title:task.title},links:[],actions:local?[
      {id:'invite',label:text('Create invitation','创建邀请')},{id:'close',label:text('Stop sharing','停止共享'),tone:'destructive'},
      ...detail.memberLabels.map(member=>({id:`remove:${member.memberId}`,label:text('Remove {name}',undefined,{name:member.displayName})})),
    ]:[{id:'open',label:text('Open task','打开任务')},{id:'leave',label:text('Leave task','退出任务')}],blocks:[{id:'members',primitive:'text',fallbackMarkdown:detail.memberLabels.map(member=>member.displayName).join('\n')}]};
  }));
  registry.register({
    collection:{id:'shared-tasks',resourceKind:'shared-task',title:text('Shared tasks','共享任务'),placement:'settings',actions:[
      {id:'create',label:text('Share a task','共享任务'),fields:[{id:'sessionId',kind:'text',required:true,label:text('Task ID','任务 ID')}]},
      {id:'join',label:text('Join a task','加入任务'),fields:[{id:'link',kind:'text',required:true,label:text('Invitation link','邀请链接')},{id:'name',kind:'text',required:true,label:text('Display name','显示名称')}]},
    ]},list:async()=>({collectionId:'shared-tasks',revision:'1',items:await tasks()}),
    get:async(context,request)=>{const item=(await tasks()).find(item=>item.ref.id===request.ref.id);if(!item)throw new Error('SHARED_TASK_NOT_FOUND');return item;},
    invoke:async(context,request)=>{
      const guard=()=>context.assertCurrent?.();guard();
      let result:unknown;
      if(request.actionId==='create'){
        const task=(await options.listTasks()).find(task=>task.id===request.input?.sessionId);if(!task)throw new Error('TASK_NOT_FOUND');
        result=await options.sharedTasks.create(task.id,task.title);
      }else if(request.actionId==='join'){
        const invitation=parseSharedTaskInvitation(string(request.input?.link),options.apiBaseUrl());if(!invitation.ok)throw new Error('INVALID_SHARED_TASK_LINK');
        result=await options.account.sharedTasks.join(invitation.invitation,string(request.input?.name));
      }else{
        const id=request.resourceRef?.id;if(!id)throw new Error('SHARED_TASK_NOT_FOUND');
        const task=await options.account.sharedTasks.get(id);guard();
        if(request.actionId==='open')result={deviceId:sharedTaskHostPeer(task.sharedTaskId,task.hostDeviceId),sessionId:task.sessionId};
        else if(request.actionId==='leave')result=await options.account.sharedTasks.leave(id);
        else{
          if(task.hostDeviceId!==options.deviceId)throw new Error('SHARED_TASK_HOST_REQUIRED');
          if(request.actionId==='invite'){const invite=await options.account.sharedTasks.invite(id);const link=buildSharedTaskInvitationLink(invite.invitation,options.apiBaseUrl());guard();return{result:{link},effects:[{kind:'toast',message:{fallback:link}}]};}
          if(request.actionId==='close')result=await options.sharedTasks.closeShare(id,task.sessionId);
          else if(request.actionId.startsWith('remove:')){const member=request.actionId.slice(7);if(!task.guests.some(guest=>guest.memberId===member))throw new Error('MEMBER_NOT_FOUND');result=await options.account.sharedTasks.remove(id,member);}
          else throw new Error('INVALID_ACTION');
        }
      }
      guard();return{result,effects:[{kind:'refresh-collection',collectionId:'shared-tasks'}]};
    },
  });
}
