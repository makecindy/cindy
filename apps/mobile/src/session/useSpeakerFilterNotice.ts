import { useCallback, useEffect, useRef, useState } from 'react';
import { SPEAKER_FILTER_NOTICE_MS } from '@cindy/voice-input-core';

/**
 * "Ignored another voice" notice for one dictation surface. Each muted window
 * from the voiceprint filter calls `show`; the notice clears a few seconds
 * after the last one, or immediately on `clear` when a run starts.
 */
export function useSpeakerFilterNotice(): {
  visible: boolean;
  show: () => void;
  clear: () => void;
} {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
  }, []);

  const show = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisible(false);
    }, SPEAKER_FILTER_NOTICE_MS);
    setVisible(true);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return { visible, show, clear };
}
