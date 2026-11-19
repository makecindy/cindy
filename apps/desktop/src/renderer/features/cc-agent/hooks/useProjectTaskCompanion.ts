import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import { supportsProjectTaskCompanion, type ProjectTaskCompanionSelection } from '../../../../shared/projectTaskCompanion';
import type { Session } from '@/lib/ccAgent.types';

export function useProjectTaskCompanion(session: Session | null | undefined, local = true) {
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  const id = local && session && supportsProjectTaskCompanion(session) ? session.id : null;
  const [state, setState] = useState<{ id: string; generation: number; selection: ProjectTaskCompanionSelection }>();
  useEffect(() => {
    if (!id || !window.electronAPI.maker?.projectTaskCompanion) return;
    const owner = getDataOwnerGeneration();
    let disposed = false;
    const load = async () => {
      const selection = await window.electronAPI.maker.projectTaskCompanion(id);
      if (disposed || !isDataOwnerGenerationCurrent(owner)) return;
      setState(old => old?.id === id && old.generation === dataOwnerGeneration && old.selection.revision > selection.revision
        ? old : { id, generation: dataOwnerGeneration, selection });
    };
    const refresh = () => { void load().catch(() => { if (!disposed && isDataOwnerGenerationCurrent(owner)) setState(undefined); }); };
    const off = window.electronAPI.localDb.sessionsPush.onPatched(({ sessionId, patch }, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && id === sessionId && patch.sdkSessionId === null) refresh();
    });
    refresh();
    return () => { disposed = true; off(); };
  }, [id, dataOwnerId, dataOwnerGeneration]);
  return state && state.id === id && state.generation === dataOwnerGeneration ? state.selection : undefined;
}
