import { createPortal } from 'react-dom';
import { Mic } from 'lucide-react';
import type { VoiceInputState } from '@cindy/voice-input-core';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

interface VoiceInputPointerHintProps {
  visible: boolean;
  x: number;
  y: number;
  state: VoiceInputState;
}

// Voice input temporarily makes the hovered text non-selectable/non-editable.
// The pointer hint explains that state without using the generic disabled
// cursor; during refinement, the spinner also gives the user a small piece of
// motion to make the wait feel less static.
export function VoiceInputPointerHint({
  visible,
  x,
  y,
  state,
}: VoiceInputPointerHintProps) {
  if (!visible || typeof document === 'undefined') return null;

  const isProcessing = state === 'submitting' || state === 'refining';
  const viewportWidth = typeof window === 'undefined' ? x + 48 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? y + 48 : window.innerHeight;
  const left = Math.max(8, Math.min(x + 10, viewportWidth - 34));
  const top = Math.max(8, Math.min(y + 10, viewportHeight - 34));

  return createPortal(
    <div
      className={cn(
        'pointer-events-none fixed z-modal',
        'flex h-6 w-6 items-center justify-center rounded-full border',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
        'text-[var(--model-trigger-text)]',
      )}
      style={{ left, top }}
      aria-hidden
    >
      {isProcessing ? (
        <Spinner size={13} />
      ) : (
        <Mic size={13} />
      )}
    </div>,
    document.body,
  );
}
