import { useCallback, useState } from 'react';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { VendorPrefs } from '@/state/newMakerDraft';

export interface AlternateDraftModel {
  ownerGeneration: number;
  vendor: MakerVendor;
  prefs: Pick<VendorPrefs, 'model' | 'providerId' | 'effort'>;
  fast: boolean | 'ultrafast';
  favoriteUid: string | null;
  agentDevice?: { deviceId: string; name: string } | null;
}

// One window's unfinished drafts survive page navigation, without changing saved defaults.
const drafts = new Map<string, AlternateDraftModel>();
export function alternateDraftModelFor(key: string, ownerGeneration: number): AlternateDraftModel | null {
  const value = drafts.get(key);
  return value?.ownerGeneration === ownerGeneration ? value : null;
}
export function setAlternateDraftModel(key: string, value: AlternateDraftModel | null): void {
  if (value) drafts.set(key, value);
  else drafts.delete(key);
}
export function useAlternateDraftModel(key: string, ownerGeneration: number) {
  const [value, setValue] = useState(() => alternateDraftModelFor(key, ownerGeneration));
  const set = useCallback((next: AlternateDraftModel | null) => {
    setAlternateDraftModel(key, next);
    setValue(next);
  }, [key]);
  return [value?.ownerGeneration === ownerGeneration ? value : null, set] as const;
}
