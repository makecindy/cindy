import {useSyncExternalStore} from 'react';
import {isDataOwnerPushStampCurrent} from '@/contexts/dataOwnerGeneration';
import {getDefaultModelForVendor} from '@/lib/modelDefinitions';
import {createNewMakerDraft,type NewMakerDraft} from '@cindy/app-runtime/newMakerDraft';
export type {VendorPrefs, CollabWorkerConfig, CollabDraft, NewMakerDraft, SuggestedDefaultTuple} from '@cindy/app-runtime/newMakerDraft';
const store=createNewMakerDraft({available:()=>typeof window!=='undefined',storage:()=>window.localStorage,isDataOwnerPushStampCurrent,getDefaultModelForVendor,
 listenStorage:typeof window==='undefined'||typeof window.addEventListener!=='function'?undefined:listener=>{window.addEventListener('storage',listener);return()=>window.removeEventListener('storage',listener);}});
export const {getDraft, getDraftForPreferenceSync, getDraftForOwnerPreferenceSync, setNewMakerDraftOwner, setWorktreePreference, patchDraft, resetDraftWorkspaceTargets, patchCollab, switchVendor, applyAppDefaultModelSelection, fallbackUnavailableVendor, applySuggestedDefaultTuple, markDefaultTupleCustomized, clearDefaultTupleTuningCustomization, patchVendorPrefs, patchVendorPrefsPreservingModelChoice, patchVendorPrefsFromTaskModelSwitch, patchCurrentVendorPrefs, getEffortForModel, setEffortForModel, getFastModeForModel, setFastModeForModel, clearDraft, subscribeDraft, getCurrentVendorPrefs, getPersistedVendorModel, __resetForTest, __STORAGE_KEY} = store;
export function useNewMakerDraft():NewMakerDraft {return useSyncExternalStore(subscribeDraft,getDraft,getDraft);}
if(import.meta.hot)import.meta.hot.dispose(()=>store.dispose());
