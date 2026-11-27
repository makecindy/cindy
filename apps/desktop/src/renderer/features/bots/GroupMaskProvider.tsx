import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { isWindowHidden } from '@/lib/hiddenAnimationGate';
import type { ChatMaskAction, ChatMaskMention, ChatMaskState } from '../../../shared/botGroupChat';
import { BOT_GROUP_PERSONAL_REPLIES_ENABLED } from '@cindy/maker-shared/botGroupChat';
import { GroupMentionContext, GroupMaskContext, maskIdentity, type GroupMaskPresentation, type GroupMaskSettings } from './groupMaskPresentation';

/** Server owns activation, persistence and cancellation. This adapter never sends a group reply. */
export function GroupMaskProvider({ groupId, children }: { groupId: string; children: ReactNode }) {
  const supplied = useContext(GroupMaskContext);
  return supplied ? children : <ServerMaskProvider key={groupId} groupId={groupId}>{children}</ServerMaskProvider>;
}
function ServerMaskProvider({ groupId, children }: { groupId: string; children: ReactNode }) {
  const [state,setState]=useState<ChatMaskState|null>(null);
  const [mentions,setMentions]=useState<ChatMaskMention[]>([]);
  const [saving,setSaving]=useState(false), [error,setError]=useState(false), [connectionLost,setConnectionLost]=useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const alive=useRef(true), version=useRef(0), authority=useRef(0), busy=useRef(false), pending=useRef(false);
  const stateRef=useRef(state); stateRef.current=state;
  const failed=useRef(new Map<string, () => Promise<void>>());
  const operations=useRef(new Map<string, () => Promise<void>>());
  const queue=useRef(Promise.resolve());
  const lastParticipation=useRef(0);
  const reload=useCallback(async () => {
    const api=window.electronAPI.maker.chatServer;
    if (!api.mask || !api.mentions) return;
    if (busy.current) { pending.current=true; return; }
    busy.current=true;
    const owner=getDataOwnerGeneration(), revision=version.current;
    const current=()=>alive.current && isDataOwnerGenerationCurrent(owner) && version.current===revision;
    try {
      if (BOT_GROUP_PERSONAL_REPLIES_ENABLED) {
        const response=await api.mask({groupId});
        if (!current()) return;
        if (!response.ok) throw new Error(response.errorCode);
        setState(response.state);
      }
      const all:ChatMaskMention[]=[];
      let before:string|undefined;
      do {
        const page=await api.mentions({groupId,before});
        if (!current()) return;
        if (!page.ok) throw new Error(page.errorCode);
        all.push(...page.mentions);
        if (!page.hasMore || !page.mentions.length) break;
        before=page.mentions.at(-1)!.sequence;
      } while(current());
      if(current()) { setMentions(all); setError(failed.current.size > 0); setConnectionLost(false); }
    } catch (e) {
      if (current()) {
        if (e instanceof Error && ['CONVERSATION_NOT_FOUND', 'OWNER_CHANGED', 'HUMAN_REQUIRED', 'UNSUPPORTED_OPERATION'].includes(e.message)) {
          authority.current++; failed.current.clear(); operations.current.clear(); stateRef.current=null; setState(null); setMentions([]); setReadFailed(false);
        } else { setError(true); setConnectionLost(true); }
      }
    }
    finally {
      busy.current=false;
      if(pending.current && alive.current) { pending.current=false; void reload(); }
    }
  },[groupId]);
  useEffect(()=>{
    const api=window.electronAPI.maker.chatServer;
    if (!api.mask || !api.mentions) return;
    alive.current=true; void reload();
    const stop=window.electronAPI.maker.onBotGroupChanged((event,stamp)=>{
      if(!isDataOwnerPushCurrent(stamp) || event.change==='attachments') return;
      if(event.groupId===groupId || !event.groupId) void reload();
    });
    // Scheduled windows still change when no message is arriving. A hidden window reads once on return.
    // document.hidden stays false when background throttling is off, so the main broadcast also counts.
    let windowHidden=isWindowHidden();
    const isHidden=()=>windowHidden || document.hidden;
    let paused=isHidden();
    const sync=()=>{ const next=isHidden(); if(paused && !next) void reload(); paused=next; };
    const timer=setInterval(()=>{ if(!isHidden()) void reload(); },15000);
    document.addEventListener('visibilitychange',sync);
    const offHidden=window.electronAPI.onWindowHiddenChange?.(hidden=>{ windowHidden=hidden; sync(); });
    return ()=>{alive.current=false; version.current++; clearInterval(timer); document.removeEventListener('visibilitychange',sync); offHidden?.(); stop();};
  },[groupId,reload]);
  const act=useCallback((retryKey:string, makeAction:(current:ChatMaskState)=>ChatMaskAction)=>{
    const owner=getDataOwnerGeneration(), generation=authority.current;
    let operationId=crypto.randomUUID();
    let action:ChatMaskAction|undefined;
    const send=async()=>{
      if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current || operations.current.get(retryKey)!==send || !stateRef.current) return;
      action ??= makeAction(stateRef.current);
      version.current++; setSaving(true); setError(failed.current.size > 0);
      try {
        // Recheck at dispatch too: a queued/retried keystroke can outlive a
        // switch to permanent delegation, which only an explicit disable stops.
        if (action.type === 'participate' && (!stateRef.current.settings.enabled || stateRef.current.settings.trigger === 'always')) {
          failed.current.delete(retryKey); setError(failed.current.size > 0); return;
        }
        const response=await window.electronAPI.maker.chatServer.mask!({groupId,action,operationId});
        if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current) return;
        if(!response.ok) {
          // A definitive revision rejection made no change. Retry against the
          // refreshed state; transport failures retain the original idempotency key.
          if(response.errorCode === 'REVISION_CONFLICT') { action=undefined; operationId=crypto.randomUUID(); }
          throw new Error(response.errorCode);
        }
        stateRef.current=response.state; setState(response.state); if(operations.current.get(retryKey)===send) failed.current.delete(retryKey); setError(failed.current.size > 0);
      } catch { if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current && operations.current.get(retryKey)===send) {setError(true);failed.current.set(retryKey,send);} }
      finally {if(alive.current){setSaving(false);void reload();}
        if(operations.current.get(retryKey)===send && !failed.current.has(retryKey)) operations.current.delete(retryKey);}
    };
    // A new intent for this operation replaces only its own previous failure.
    failed.current.delete(retryKey); operations.current.set(retryKey,send);
    queue.current=queue.current.then(send,send);
  },[groupId,reload]);
  const markRead=useCallback((messageIds?: readonly string[])=>{
    const owner=getDataOwnerGeneration(), generation=authority.current, ids=mentions.filter(m=>!messageIds || messageIds.includes(m.messageId)).map(m=>m.messageId);
    if (!ids.length) return;
    const retryKey=`read:${[...ids].sort().join(',')}`;
    // A failed response may follow a successful write. Resume the same batch
    // with its original operation ID instead of replaying confirmed batches.
    let nextBatch = 0;
    let operationId: string | undefined;
    const send=async()=>{
      if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current || operations.current.get(retryKey)!==send) return;
      version.current++; setSaving(true);
      try {
        for(;nextBatch<ids.length;nextBatch+=100){
          if(!alive.current || !isDataOwnerGenerationCurrent(owner) || generation!==authority.current) return;
          operationId ??= crypto.randomUUID();
          const result=await window.electronAPI.maker.chatServer.mentions!({groupId,readIds:ids.slice(nextBatch,nextBatch+100),operationId});
          if(!result.ok) throw new Error(result.errorCode);
          operationId = undefined;
        }
        if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current && operations.current.get(retryKey)===send) {
          failed.current.delete(retryKey);
          setError(failed.current.size > 0);
          setReadFailed([...failed.current.keys()].some(key => key.startsWith('read:')));
          setMentions(previous=>previous.filter(m=>!ids.includes(m.messageId)));
        }
      }catch{if(alive.current && isDataOwnerGenerationCurrent(owner) && generation===authority.current && operations.current.get(retryKey)===send){setError(true);setReadFailed(true);failed.current.set(retryKey,send);}}
      finally{if(alive.current){setSaving(false);void reload();}
        if(operations.current.get(retryKey)===send && !failed.current.has(retryKey)) operations.current.delete(retryKey);}
    };
    failed.current.delete(retryKey); operations.current.set(retryKey,send);
    queue.current=queue.current.then(send,send);
  },[mentions,groupId,reload]);
  const retryRead = useCallback(() => {
    for (const [key, send] of failed.current) {
      if (!key.startsWith('read:')) continue;
      const attempt = () => failed.current.get(key) === send ? send() : undefined;
      queue.current = queue.current.then(attempt, attempt);
    }
  }, []);
  const history = useMemo(() => ({
    groupId, saving, markMentionsRead: markRead, retryRead: readFailed ? retryRead : undefined,
    unreadMentions: mentions.map(m => ({ ...m, ...(m.reply ? { reply: { ...m.reply, companion: maskIdentity(m.reply.companion) } } : {}) })),
  }), [groupId, saving, markRead, mentions, readFailed, retryRead]);
  // Keep shared composer, settings and attention consumers on one stable projection.
  const value=useMemo<GroupMaskPresentation|null>(()=>{
  if(!state) return null;
  const update=(patch:Partial<GroupMaskSettings>)=>act(`save:${Object.keys(patch).sort().join(',')}`,current=>({type:'save',expectedRevision:current.revision,
    settings:{...current.settings,companionId:current.settings.companionId ?? current.defaultCompanionId ?? null,...patch,timeZone:current.revision ? current.settings.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone}}));
  return {...history,self:maskIdentity(state.self),companions:state.companions.map(maskIdentity),
    toolAccessSupported:state.toolAccessSupported,settings:{...state.settings,companionId:state.settings.companionId ?? state.defaultCompanionId ?? null},status:connectionLost && state.status==='enabled' ? 'offline' : state.status,error,loading:false,manualRunning:state.manualRunning,
    update,retry:()=>{if(failed.current.size) for(const send of failed.current.values()) queue.current=queue.current.then(send,send);else void reload();},
    participate:()=>{if(!stateRef.current?.settings.enabled || stateRef.current.settings.trigger==='always' || Date.now()-lastParticipation.current<2000)return;lastParticipation.current=Date.now();act('participate',()=>({type:'participate'}));},
    resume:()=>{lastParticipation.current=0;act('resume',()=>({type:'resume'}));},stopManual:()=>act('stop',()=>({type:'stop'})),
    requestDigest:()=>act('digest',()=>({type:'digest'})),digestStatus:state.digestStatus,
    attributions:{},
  };
  },[state,history,error,connectionLost,act,reload]);
  return <GroupMentionContext.Provider value={history.unreadMentions.length || readFailed ? history : null}>
    <GroupMaskContext.Provider value={value}>{children}</GroupMaskContext.Provider>
  </GroupMentionContext.Provider>;
}
