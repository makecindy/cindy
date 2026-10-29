import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import { getComposerSendShortcutPreference, resolveComposerEnterIntent } from '@/hooks/useComposerSendShortcutPreference';
import { quoteSourceDisplayLabel, type ChatQuote } from '@/lib/chatQuotes';

/** Shared by selection capture and editing an existing composer quote. */
export function QuoteCommentEditor({ quote, onSave, onCancel, onDelete, saveLabel }: {
  quote: ChatQuote;
  onSave: (comment: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
  saveLabel: string;
}) {
  const { t } = useTranslation();
  const [comment, setComment] = useState(quote.comment ?? '');
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="flex min-w-0 flex-col gap-3" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
    }}>
      <div className="max-h-32 overflow-auto whitespace-pre-wrap text-13 text-muted-foreground [overflow-wrap:anywhere]">{quote.text}</div>
      {quote.sourcePath && <div className="truncate text-11 text-muted-foreground">{quoteSourceDisplayLabel(quote)}</div>}
      <FormField label={t('chat.quote.comment')}>
        {(control) => <Textarea
          {...control}
          textareaRef={input}
          placeholder={t('chat.quote.comment')}
          value={comment}
          rows={3}
          onChange={setComment}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const intent = resolveComposerEnterIntent(event.nativeEvent, getComposerSendShortcutPreference(), {
              turnRunning: false, platform: window.electronAPI?.platform,
            });
            if (intent === 'queue') { event.preventDefault(); onSave(comment); }
            else if (intent === 'ignore') event.preventDefault();
          }}
        />}
      </FormField>
      <div className="flex flex-wrap justify-end gap-2">
        {onDelete && <Button variant="secondary" size="sm" type="button" onClick={onDelete}>{t('chat.quote.remove')}</Button>}
        <Button variant="secondary" size="sm" type="button" onClick={onCancel}>{t('chat.quote.cancel')}</Button>
        <Button size="sm" type="button" onClick={() => onSave(comment)}>{saveLabel}</Button>
      </div>
    </div>
  );
}
