import { useTranslation } from 'react-i18next';

import { VoiceInputStatusNotice } from './VoiceInputStatusNotice';

export interface FieldVoiceInputNoticeProps {
  error: string | null;
  speakerFiltered?: boolean;
  className?: string;
  maxWidthClassName?: string;
}

/**
 * Shared status notice for voice-enabled inputs: error takes precedence over
 * the passing voiceprint-filter notice (docs/product-rules/companion-voice-mode.md).
 */
export function FieldVoiceInputNotice({
  error,
  speakerFiltered = false,
  className,
  maxWidthClassName,
}: FieldVoiceInputNoticeProps) {
  const { t } = useTranslation();
  if (error) {
    return (
      <VoiceInputStatusNotice
        message={error}
        className={className}
        maxWidthClassName={maxWidthClassName}
      />
    );
  }
  if (speakerFiltered) {
    return (
      <VoiceInputStatusNotice
        tone="info"
        message={t('voiceInputOverlay.speakerFiltered')}
        className={className}
        maxWidthClassName={maxWidthClassName}
      />
    );
  }
  return null;
}
