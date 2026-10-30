import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { resolveSystemLocale } from '../../../shared/locale';
import { THINKING_TRANSLATION_MAX_LENGTH } from '../../../shared/thinkingTranslation';
import { useChatSessionFile } from './ChatSessionFileContext';

/** Component-local projection only. Source/language/account changes invalidate late replies. */
export function useThinkingTranslation(content: string, blockKey?: string, isStreaming?: boolean) {
  const { t, i18n } = useTranslation();
  const { sessionId, origin } = useChatSessionFile();
  const owner = getDataOwnerGeneration();
  const locale = resolveSystemLocale(i18n?.resolvedLanguage ?? i18n?.language);
  const bindingKey = JSON.stringify([
    sessionId,
    origin,
    blockKey,
    locale,
    owner.dataOwnerId,
    owner.generation,
    isStreaming,
    content,
  ]);
  // A → B → A must not revive state or replies from the first A.
  const binding = useMemo(() => ({ key: bindingKey }), [bindingKey]);
  const current = useRef<typeof binding | null>(binding);
  current.current = binding;
  const pending = useRef<typeof binding | null>(null);
  const [state, setState] = useState<{
    binding: typeof binding;
    text?: string;
    translated?: boolean;
    loading?: boolean;
    error?: 'unavailable' | 'failed' | 'unsupported';
  }>();
  useEffect(() => {
    current.current = binding;
    return () => {
      current.current = null;
    };
  }, [binding]);
  const active = state?.binding === binding ? state : undefined;
  const translate = async () => {
    if (!sessionId || isStreaming || pending.current === binding) return;
    pending.current = binding;
    setState({ binding, loading: true });
    try {
      const { translateThinkingFor } = await import('@/lib/makerTransport');
      if (current.current !== binding || !isDataOwnerGenerationCurrent(owner)) return;
      const result = await translateThinkingFor({ sessionId, text: content, locale });
      if (current.current !== binding || !isDataOwnerGenerationCurrent(owner)) return;
      setState(
        result.text
          ? { binding, text: result.text, translated: true }
          : { binding, error: result.error === 'unavailable' ? 'unavailable' : 'failed' },
      );
    } catch (error) {
      if (current.current === binding && isDataOwnerGenerationCurrent(owner)) {
        const unsupported = /CHANNEL_NOT_ALLOWED/.test(String(error));
        setState({ binding, error: unsupported ? 'unsupported' : 'failed' });
      }
    } finally {
      if (pending.current === binding) pending.current = null;
    }
  };
  const eligible = !!sessionId && !!content.trim() && !isStreaming;
  const tooLong = content.length > THINKING_TRANSLATION_MAX_LENGTH;
  const controls = eligible ? (
    <div className="mt-2 flex flex-col gap-1 not-italic text-12 leading-normal text-[var(--text-secondary)]">
      <div className="flex flex-wrap items-center gap-2 select-none">
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          disabled={active?.loading || tooLong}
          onClick={() => {
            if (active?.text) setState({ ...active, translated: !active.translated });
            else void translate();
          }}
        >
          {active?.loading
            ? t('chat.thinking.translation.loading')
            : active?.text
              ? t(
                  active.translated
                    ? 'chat.thinking.translation.showOriginal'
                    : 'chat.thinking.translation.showTranslation',
                )
              : t('chat.thinking.translation.translate')}
        </Button>
        {active?.translated && <span>{t('chat.thinking.translation.machineTranslated')}</span>}
      </div>
      {!active?.text && (
        <span>
          {t(
            tooLong ? 'chat.thinking.translation.tooLong' : 'chat.thinking.translation.disclosure',
          )}
        </span>
      )}
      {active?.error && <span role="status">{t(`chat.thinking.translation.${active.error}`)}</span>}
    </div>
  ) : null;
  return { displayContent: !isStreaming && active?.translated ? active.text! : content, controls };
}
