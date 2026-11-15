import { useEffect, useState } from 'react';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';

/** Re-read native settings after an AI write without opening or remounting Settings. */
export function useAppSettingsRevision(section: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => window.electronAPI?.appPreferenceControl?.onSettingsChanged(event => {
    if (event.section === section && isDataOwnerPushStampCurrent(event.ownerStamp)) setRevision(value => value + 1);
  }), [section]);
  return revision;
}
