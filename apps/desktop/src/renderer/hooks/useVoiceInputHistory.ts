import { useCallback, useEffect, useState } from 'react';

import {
  type VoiceInputDataSnapshot,
  type VoiceInputHistoryEntry,
} from '../../shared/voiceInputData';

export type { VoiceInputHistoryEntry };

export function getVoiceInputHistory(limit?: number): VoiceInputHistoryEntry[] {
  try {
    return window.electronAPI.voiceInput.getHistory(limit);
  } catch {
    return [];
  }
}

export function getVoiceInputHistoryForRefinement(): VoiceInputHistoryEntry[] {
  try {
    return window.electronAPI.voiceInput.getHistoryForRefinement();
  } catch {
    return [];
  }
}

export function recordVoiceInputHistory(text: string): string | null {
  try {
    return window.electronAPI.voiceInput.recordHistory(text);
  } catch {
    return null;
  }
}

export function updateVoiceInputHistoryEntry(id: string, text: string, rawText?: string): void {
  try {
    window.electronAPI.voiceInput.updateHistoryEntry(id, text, rawText);
  } catch {
    // History is advisory context only; do not interrupt voice input on storage errors.
  }
}

export function deleteVoiceInputHistoryEntry(id: string): void {
  try {
    window.electronAPI.voiceInput.deleteHistoryEntry(id);
  } catch {
    // History is advisory context only; do not interrupt settings UI on storage errors.
  }
}

export function useVoiceInputHistory(): {
  entries: VoiceInputHistoryEntry[];
  deleteEntry: (id: string) => void;
} {
  const [entries, setEntries] = useState<VoiceInputHistoryEntry[]>(() =>
    getVoiceInputHistory(),
  );

  const syncFromSnapshot = useCallback((snapshot?: VoiceInputDataSnapshot) => {
    setEntries(snapshot?.history ?? getVoiceInputHistory());
  }, []);

  const deleteEntry = useCallback((id: string) => {
    deleteVoiceInputHistoryEntry(id);
    setEntries(getVoiceInputHistory());
  }, []);

  useEffect(() => window.electronAPI.voiceInput.onDataChanged(syncFromSnapshot), [syncFromSnapshot]);

  return {
    entries,
    deleteEntry,
  };
}
