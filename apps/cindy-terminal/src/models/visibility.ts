import path from 'node:path';
import {createHash} from 'node:crypto';
import {createModelVisibilityPreferences, type ModelVisibilityStorage} from '@cindy/model-providers/model-plane/modelVisibilityPreferences';
import type {ProviderView} from '@cindy/model-providers';
import {createModelVisibilityMirror} from '@cindy/app-runtime/modelVisibilityMirror';
import {atomicWriteFileSync, readAtomicFileSync} from '@cindy/remote-agent/atomicWriteFile';
import {withCrossProcessLock} from '@cindy/remote-agent/crossProcessLock';
import {createIpcError} from '@cindy/remote-agent/shared/ipc-errors';
import {readModelDefaultsProfileOrigin} from '@cindy/runtime-db/modelDefaultsProfile';
import type {NodeDatabase} from '../database.js';
import {privateDirectory} from '../platform.js';

/** Node storage/lock adapter for the very same preference service used by the GUI. */
export async function openTerminalModelVisibility(options: {
  profileDir: string;
  database: Pick<NodeDatabase, 'dbPath' | 'getCurrentDbClientUserId' | 'getDbClient'>;
  hasModelPreferenceHistory(): boolean;
  changed(): void;
  log: {warn(message: string, fields: unknown): void};
}) {
  const root=path.join(options.profileDir,'model-visibility');
  await privateDirectory(root);
  const owner=options.database.getCurrentDbClientUserId();
  if(!owner)throw new Error('MODEL_OWNER_DATABASE_REQUIRED');
  const client=options.database.getDbClient();
  const guard=()=>{
    if(options.database.getCurrentDbClientUserId()!==owner || options.database.getDbClient()!==client)
      throw new Error('MODEL_OWNER_CHANGED');
  };
  const file=(key:string)=>path.join(root,`${createHash('sha256').update(key).digest('hex')}.json`);
  const storage:ModelVisibilityStorage={
    getItem(key){guard();const raw=readAtomicFileSync(file(key));return raw===null ? null : JSON.parse(raw) as string | null;},
    setItem(key,value){guard();atomicWriteFileSync(file(key),JSON.stringify(value));},
    removeItem(key){guard();atomicWriteFileSync(file(key),'null');},
  };
  const mirror=createModelVisibilityMirror();
  const preferences=createModelVisibilityPreferences({
    available:()=>true,storage:()=>storage,
    locks:()=>({request:(key,operation)=>withCrossProcessLock(`${file(key)}.lock`,{label:'model-visibility'},async status=>{
      if(!status.held)throw new Error('MODEL_VISIBILITY_STORAGE_BUSY');
      guard();return operation();
    })}),
    // This root belongs exclusively to the current owner. It has never contained
    // a pre-account Chromium namespace, so there is no global snapshot to claim.
    claimLegacyOwner:()=>{
      guard();return {dataOwnerId:owner,ownerGeneration:0,canWriteOwnerScoped:true,
        claimed:true,claimedByOtherOwner:false,canInitialize:true,
        profileOrigin:readModelDefaultsProfileOrigin(options.database.dbPath)};
    },
    syncVisibility:async(ownerId,generation,map,policy)=>{
      guard();mirror.syncModelVisibilityMirrorForOwner(map,{dataOwnerId:ownerId,ownerGeneration:generation},
        {dataOwnerId:owner,ownerGeneration:0},false,options.changed,policy);
    },
    hasModelPreferenceHistory:options.hasModelPreferenceHistory,log:options.log,
  });
  await preferences.setModelVisibilityOwner(owner,0,'cloud');
  return {
    preferences,mirror,
    async synchronize(providers:readonly ProviderView[]){
      guard();
      if(!await preferences.migrateModelVisibilityDefaults(owner,0,providers,()=>options.database.getCurrentDbClientUserId()===owner))
        throw createIpcError('MODEL_VISIBILITY_NOT_READY',preferences.getModelVisibilityInitializationFailure(owner,0) ?? 'initializing');
    },
    close(){preferences.dispose();mirror.clearModelVisibilityMirror();},
  };
}
