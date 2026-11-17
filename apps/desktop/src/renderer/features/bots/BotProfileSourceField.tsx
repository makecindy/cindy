import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea, type TextareaProps } from '@/components/ui/input';
import { BOT_PROFILE_SOURCE_MAX_LENGTH } from '../../../shared/botProfileSources';
import { useBotTranslation } from './botPronounContext';

/** Display the complete source, including imported text that the writer cannot save. */
export function BotProfileSourceField({ label, ...props }: TextareaProps & { label: string }) {
  const { t } = useBotTranslation();
  const [copyFailed, setCopyFailed] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const length = props.value.trim().length;
  const excess = length - BOT_PROFILE_SOURCE_MAX_LENGTH;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FormField label={label} hideLabel reserveFeedback
        hint={t('bots.profile.sourceLength', { length, limit: BOT_PROFILE_SOURCE_MAX_LENGTH })}
        error={excess > 0 ? t('bots.profile.sourceExcess', { excess }) : undefined}>
        {control => <Textarea {...props} {...control} />}
      </FormField>
      {excess > 0 && <>
        <p className="text-12 leading-5 text-[var(--text-secondary)]">{t('bots.profile.sourceRecovery')}</p>
        <Button variant="secondary" size="md" data-settings-search-action="copy-profile-source"
          onClick={() => {
            setCopyFailed(false);
            void navigator.clipboard.writeText(props.value)
              .then(() => setCopiedText(props.value))
              .catch(() => setCopyFailed(true));
          }}>
          {t(copiedText === props.value ? 'chat.messageActionBar.copied' : 'bots.profile.sourceCopy')}
        </Button>
        {copyFailed && <p role="alert" className="text-12 text-[var(--text-danger)]">{t('chat.media.copyFailed')}</p>}
      </>}
    </div>
  );
}
