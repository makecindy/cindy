import { useEffect, useState } from 'react';
import type { VoiceInputState } from '@cindy/voice-input-core';

/** Delay only visual feedback, never the stop operation or interaction lock. */
export function useVoiceProcessingIndicator(state: VoiceInputState): boolean {
  const processing = state === 'submitting' || state === 'refining';
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    if (!processing) return;
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [processing]);
  return processing && visible;
}
