import { useEffect, useState } from 'react';
import type { MobileVoiceState } from '@/session/mobileVoiceInput';

export const MOBILE_VOICE_PROCESSING_INDICATOR_DELAY_MS = 150;

/**
 * Delays only the visible "processing" spinner after stop, matching desktop.
 * A stop that finishes quickly (confirmed transcript, silent recording) no
 * longer flashes a spinner. Callers keep locking interaction for the whole
 * submitting/refining phase; this never delays the stop itself.
 */
export function useMobileVoiceProcessingIndicator(state: MobileVoiceState): {
  showProcessing: boolean;
  stopping: boolean;
} {
  const processing = state === 'submitting' || state === 'refining';
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!processing) return;
    const timer = setTimeout(() => setVisible(true), MOBILE_VOICE_PROCESSING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [processing]);
  const showProcessing = processing && visible;
  return { showProcessing, stopping: processing && !showProcessing };
}
