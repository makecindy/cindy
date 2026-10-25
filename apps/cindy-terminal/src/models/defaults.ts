import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createNewMakerDraft,type DraftStorage} from '@cindy/app-runtime/newMakerDraft';
import {createNewMakerDefaultsCache} from '@cindy/app-runtime/newMakerDefaultsCache';
import {coldStartModelIdForVendor} from '@cindy/app-runtime/modelDefinitionDefaults';
import {atomicWriteFileSync,readAtomicFileSync} from '@cindy/remote-agent/atomicWriteFile';
import {withCrossProcessLock} from '@cindy/remote-agent/crossProcessLock';
import type {BotModelRoute} from '@cindy/companion-core/botModelChain';
import type {AppDefaultModelSelection} from '@cindy/companion-core/appDefaultModelSelection';
import type {NodeDatabase} from '../database.js';
import {privateDirectory} from '../platform.js';
import {parseSelection,type ModelSelection} from './config.js';

/** File/owner adapter for the original GUI preference store and main-process mirror. */
export async function openTerminalModelDefaults(options:{
  profileDir:string;
  database:Pick<NodeDatabase,'getDbClient'|'getCurrentDbClientUserId'>;
  legacy?:ModelSelection;
}) {
  const root=path.join(options.profileDir,'new-maker-preferences');
  await privateDirectory(root);
  const owner=options.database.getCurrentDbClientUserId(),client=options.database.getDbClient();
  if(!owner)throw new Error('MODEL_OWNER_DATABASE_REQUIRED');
  const stamp={dataOwnerId:owner,ownerGeneration:0};
  let closed=false,writeError:unknown;
  const guard=()=>{
    if(closed || options.database.getCurrentDbClientUserId()!==owner || options.database.getDbClient()!==client)
      throw new Error('MODEL_OWNER_CHANGED');
  };
  const file=(key:string)=>path.join(root,`${createHash('sha256').update(key).digest('hex')}.json`);
  const storage:DraftStorage={
    getItem(key){guard();const raw=readAtomicFileSync(file(key));return raw===null?null:JSON.parse(raw) as string|null;},
    setItem(key,value){guard();try{atomicWriteFileSync(file(key),JSON.stringify(value));}catch(error){writeError=error;throw error;}},
    removeItem(key){guard();try{atomicWriteFileSync(file(key),'null');}catch(error){writeError=error;throw error;}},
  };
  const cache=createNewMakerDefaultsCache();
  const preferences=createNewMakerDraft({available:()=>true,storage:()=>storage,
    isDataOwnerPushStampCurrent:value=>{guard();return value.dataOwnerId===stamp.dataOwnerId&&value.ownerGeneration===stamp.ownerGeneration;},
    getDefaultModelForVendor:vendor=>({id:coldStartModelIdForVendor(vendor)}),
  });
  preferences.setNewMakerDraftOwner(owner);
  const key=`${preferences.__STORAGE_KEY}:${encodeURIComponent(owner)}`;
  const synchronize=(requestId?:string)=>{
    guard();
    const draft=preferences.getDraftForOwnerPreferenceSync(owner);
    if(!draft)throw new Error('MODEL_OWNER_CHANGED');
    const selected=draft.lastByVendor[draft.vendor];
    cache.syncNewMakerDraftCache({...draft,ownerStamp:stamp,appDefaultModelRequestId:requestId,
      selectedRoute:{harness:draft.vendor==='cc'||draft.vendor==='orca'?'claude':draft.vendor,
        providerId:selected.providerId??null,model:selected.model,effort:selected.effort??'',
        fastMode:draft.fastModeByModel[selected.model]??false}},stamp,options.profileDir,false);
  };
  const lock=<T>(work:()=>T|Promise<T>)=>withCrossProcessLock(`${file(key)}.lock`,{label:'model-defaults'},async status=>{
    if(!status.held)throw new Error('MODEL_DEFAULT_STORAGE_BUSY');guard();return work();
  });
  const apply=(selection:AppDefaultModelSelection)=>{
    guard();writeError=undefined;
    const saved=preferences.applyAppDefaultModelSelection(selection);
    if(writeError)throw writeError;
    if(saved)synchronize(selection.requestId);
    return saved;
  };
  synchronize();
  if(options.legacy)await lock(()=>{
    if(storage.getItem(key)!==null)return;
    const legacy=options.legacy!;
    const route:BotModelRoute={harness:legacy.agentKind==='claude-code'?'claude':legacy.agentKind,
      providerId:legacy.providerId,model:legacy.model,effort:legacy.effort??'',fastMode:false};
    if(!apply({requestId:randomUUID(),route,expectedRoute:cache.getSelectedNewMakerRoute(options.profileDir)??null,ownerStamp:stamp,expiresAt:Date.now()+5000}))
      throw new Error('MODEL_DEFAULT_MIGRATION_CHANGED');
  });
  const off=preferences.subscribeDraft(()=>synchronize());
  const clear=()=>{writeError=undefined;preferences.resetDefaultModelSelection();if(writeError)throw writeError;synchronize();};
  return {
    preferences,cache,stamp,ownerScope:options.profileDir,synchronize,
    selection():ModelSelection|undefined {
      synchronize();const draft=preferences.getDraftForOwnerPreferenceSync(owner)!;
      if(!draft.modelChosenByVendor[draft.vendor])return;
      const route=cache.getSelectedNewMakerRoute(options.profileDir);
      if(!route?.providerId)return;
      return parseSelection({agentKind:route.harness==='claude'?'claude-code':route.harness,
        providerId:route.providerId,model:route.model,...(route.effort?{effort:route.effort}:{})});
    },
    applySelection:(selection:AppDefaultModelSelection)=>lock(()=>apply(selection)),
    setSelection:async(selection:ModelSelection,assertCurrent:()=>void)=>lock(()=>{
      assertCurrent();synchronize();
      const route:BotModelRoute={harness:selection.agentKind==='claude-code'?'claude':selection.agentKind,
        providerId:selection.providerId,model:selection.model,effort:selection.effort??'',
        fastMode:preferences.getFastModeForModel(selection.model)};
      if(!apply({requestId:randomUUID(),route,expectedRoute:cache.getSelectedNewMakerRoute(options.profileDir)??null,ownerStamp:stamp,expiresAt:Date.now()+5000}))
        throw new Error('MODEL_DEFAULT_CHANGED');
    }),
    clear:async(assertCurrent:()=>void)=>lock(()=>{assertCurrent();clear();}),
    stageClear:async()=>lock(()=>{
      const before=storage.getItem(key);clear();const cleared=storage.getItem(key);
      return async()=>lock(()=>{if(storage.getItem(key)!==cleared)throw new Error('MODEL_DEFAULT_CHANGED');
        if(before===null)storage.removeItem(key);else storage.setItem(key,before);synchronize();});
    }),
    close(){if(closed)return;off();preferences.dispose();closed=true;},
  };
}
export type TerminalModelDefaults=Awaited<ReturnType<typeof openTerminalModelDefaults>>;
