import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Undo2 } from 'lucide-react';
import type { Editor } from '@tiptap/core';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

interface ComposerEnhancePromptButtonProps {
  /** The composer editor whose draft is rewritten. */
  editor: Editor | null;
  /** Composer-level lock (shared guest, remote session, streaming, ...). */
  disabled?: boolean;
}

/**
 * "Enhance prompt" control for the chat composer.
 *
 * The draft is rewritten by the auxiliary-model chain (Settings → Auxiliary
 * model), so enhancing never spends the quota of the model the conversation is
 * about to use. The original draft is kept so the rewrite can be undone.
 *
 * Chrome follows the composer toolbar's persistent-tool tier: a permanent
 * outline over `composer-pill-bg`, like the voice control.
 */
export function ComposerEnhancePromptButton({
  editor,
  disabled = false,
}: ComposerEnhancePromptButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [originalDraft, setOriginalDraft] = useState<string | null>(null);

  // The button only shows up once there is something to rewrite.
  useEffect(() => {
    if (!editor) {
      setHasDraft(false);
      return;
    }
    const sync = () => setHasDraft(editor.getText().trim().length > 0);
    sync();
    editor.on('update', sync);
    editor.on('create', sync);
    return () => {
      editor.off('update', sync);
      editor.off('create', sync);
    };
  }, [editor]);

  const enhance = useCallback(async () => {
    if (!editor || busy) return;
    const draft = editor.getText().trim();
    if (!draft) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.composer.enhancePrompt(draft);
      setOriginalDraft(draft);
      editor.commands.setContent(result.text);
      // Leave the rewritten text selected so the user can read it and press
      // Enter to send, or keep editing (same contract as the rename and
      // prompt-suggestion flows: fill back, never send).
      editor.commands.focus();
      editor.commands.selectAll();
      toast.success(t('newChat.composerEnhance.success'));
    } catch (error) {
      const key = mapIpcErrorToI18nKey(error, { namespace: 'ipcError' });
      toast.error(t(key, { defaultValue: t('newChat.composerEnhance.failed') }));
    } finally {
      setBusy(false);
    }
  }, [busy, editor, t]);

  const undo = useCallback(() => {
    if (!editor || originalDraft === null) return;
    editor.commands.setContent(originalDraft);
    setOriginalDraft(null);
  }, [editor, originalDraft]);

  if (!editor || (!hasDraft && originalDraft === null)) return null;

  const controlClass = cn(
    'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full',
    'border border-[var(--border-default)] bg-[var(--composer-pill-bg)] text-[var(--composer-pill-icon)]',
    'transition-[background-color,transform] duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chat-input-bg)]',
    !disabled && !busy && 'hover:bg-[var(--model-trigger-hover)] active:scale-[0.98]',
    disabled && 'cursor-not-allowed opacity-40',
  );

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tip text={busy ? t('newChat.composerEnhance.working') : t('newChat.composerEnhance.enhance')} side="top">
        <button
          type="button"
          onClick={() => void enhance()}
          disabled={disabled || busy}
          aria-label={t('newChat.composerEnhance.enhance')}
          className={controlClass}
        >
          {busy ? <Spinner size={14} /> : <Sparkles size={15} />}
        </button>
      </Tip>
      {originalDraft !== null && (
        <Tip text={t('newChat.composerEnhance.undo')} side="top">
          <button
            type="button"
            onClick={undo}
            aria-label={t('newChat.composerEnhance.undo')}
            className={controlClass}
          >
            <Undo2 size={15} />
          </button>
        </Tip>
      )}
    </div>
  );
}
