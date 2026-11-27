import { useCallback, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import type { Effort } from '@/lib/userPreferences.types';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resolveSshSessionModelSelection } from './sshSessionModelSelection';

type SshDraftChoice = {
  model: string;
  effort?: Effort;
  fastMode: boolean | 'ultrafast';
};

/** SSH choices belong to this draft/host, never the controller's model presets. */
export function useSshCodexDraftSelection(hostId: string | null, providers: ProviderView[]) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([hostId, owner.dataOwnerId, owner.generation]);
  const [state, setState] = useState<{ key: string; choice: SshDraftChoice } | null>(null);
  const choice = state?.key === key ? state.choice : undefined;
  const resolved = resolveSshSessionModelSelection({
    agentKind: 'codex', providers, loading: false, loadFailed: false,
    preferred: choice ? { ...choice, providerId: 'openai' } : undefined,
  });
  const selection = hostId && resolved.ok ? resolved : null;
  const patch = useCallback((update: Partial<SshDraftChoice>) => {
    if (!hostId) return;
    setState((previous) => ({
      key,
      choice: {
        model: selection?.model ?? '',
        ...(selection?.effort ? { effort: selection.effort } : {}),
        fastMode: selection?.fastMode ?? false,
        ...(previous?.key === key ? previous.choice : {}),
        ...update,
      },
    }));
  }, [hostId, key, selection?.model, selection?.effort, selection?.fastMode]);
  return { selection, patch };
}
