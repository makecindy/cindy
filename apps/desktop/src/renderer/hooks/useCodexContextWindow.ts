import { useEffect, useState } from 'react';
import type { CodexContextWindowInfo } from '@cindy/maker-core';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

/** Native read-only facts. Missing/old hosts stay unknown, never fall back to a model catalog. */
export function useCodexContextWindow(options: {
  enabled: boolean;
  providerId?: string | null;
  modelId: string;
  sessionId?: string;
  reportedWindow?: number;
  refreshKey?: boolean | string;
}) {
  const { enabled, providerId, modelId, sessionId, reportedWindow, refreshKey } = options;
  const key = JSON.stringify([providerId, modelId, sessionId, reportedWindow]);
  const [state, setState] = useState<{ key: string; info: CodexContextWindowInfo | null }>({ key: '', info: null });
  useEffect(() => {
    if (!enabled || (!providerId && !sessionId) || !modelId) return;
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    const request = window.electronAPI?.maker?.getModelContextLimit?.({
      agent: 'codex', providerId: providerId ?? 'codex', modelId, ...(sessionId ? { sessionId } : {}),
    });
    if (!request) return;
    void request.then((view) => {
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) setState({ key, info: view.codexContext ?? null });
    }).catch(() => {
      if (!cancelled) setState({ key, info: null });
    });
    return () => { cancelled = true; };
  }, [enabled, providerId, modelId, sessionId, reportedWindow, refreshKey, key]);
  return enabled && state.key === key ? state.info : null;
}
