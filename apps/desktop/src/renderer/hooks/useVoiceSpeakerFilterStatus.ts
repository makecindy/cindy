import { useCallback, useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';
import type { VoiceSpeakerFilterStatus } from '../../shared/voiceSpeakerFilter';

const log = createLogger('useVoiceSpeakerFilterStatus');

/**
 * Model download and enrollment state of "recognize my voice". Main pushes every
 * change (download progress, enroll, delete), so this only seeds the first
 * value and then follows the push.
 */
export function useVoiceSpeakerFilterStatus(): {
  status: VoiceSpeakerFilterStatus | null;
  setStatus: (status: VoiceSpeakerFilterStatus) => void;
  refresh: () => void;
} {
  const [status, setStatus] = useState<VoiceSpeakerFilterStatus | null>(null);

  const refresh = useCallback(() => {
    void window.electronAPI.voiceInput.speakerFilter
      .getStatus()
      .then(setStatus)
      .catch((error) => {
        log.warn('speaker filter status failed:', error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI.voiceInput.speakerFilter.onStatusChanged(setStatus);
    refresh();
    return unsubscribe;
  }, [refresh]);

  return { status, setStatus, refresh };
}
