import type { RefObject } from 'react';

import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { botGroupInputElement, type BotGroupTextInput } from './botGroupTextInput';

/**
 * Group chat & thread dictation hook. Delegates to the shared `useFieldVoiceInput`
 * so group composers follow the exact same voice lifecycle, live audio levels,
 * shortcut arbitration, long-press gesture and permission flow as all other inputs.
 */
export function useBotGroupVoiceInput({
  draftKey,
  textareaRef,
  text,
  onChange,
  disabled,
  maxLength = -1,
  onTooLong,
  onStart,
}: {
  draftKey: string;
  textareaRef: RefObject<BotGroupTextInput | null>;
  text: string;
  onChange: (text: string, edit: { start: number; end: number; caret: number }) => void;
  disabled: boolean;
  maxLength?: number;
  onTooLong?: () => void;
  /** Accepted microphone/shortcut input participates before any ASR text. */
  onStart?: () => void;
}) {
  return useFieldVoiceInput<BotGroupTextInput>({
    draftKey,
    inputRef: textareaRef,
    getDomElement: botGroupInputElement,
    value: text,
    onChange,
    disabled,
    maxLength,
    onTooLong,
    onStart,
  });
}
