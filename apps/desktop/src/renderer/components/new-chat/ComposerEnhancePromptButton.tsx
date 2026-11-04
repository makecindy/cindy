import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Undo2 } from 'lucide-react';
import type { Editor, JSONContent } from '@tiptap/core';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { plainTextToComposerDocument } from '@/lib/composerListDocument';
import {
  documentFingerprint,
  documentHasStructuredNodes,
  editorIsComposing,
} from '@/lib/composerEnhanceDraft';

interface ComposerEnhancePromptButtonProps {
  /** The composer editor whose draft is rewritten. */
  editor: Editor | null;
  /**
   * Identifies the draft the request was started from. It changes when the
   * composer switches to another session or draft, so a late answer for an
   * abandoned draft is dropped instead of overwriting the new one.
   */
  draftKey?: string;
  /** Composer-level lock (shared guest, remote session, streaming, ...). */
  disabled?: boolean;
  /** Why the control is unavailable, shown in the tooltip. */
  disabledReason?: string;
}


/**
 * "Enhance prompt" control for the chat composer.
 *
 * The draft is rewritten by the auxiliary-model chain (Settings → Auxiliary
 * model), so enhancing never spends the quota of the model the conversation is
 * about to use.
 *
 * The rewrite is only applied when the draft is still exactly the one the
 * request was started from: a draft that changed in the meantime, that moved
 * to another session, or that is mid IME composition keeps the user's text.
 * The pre-enhancement document is kept so the rewrite can be undone, and the
 * undo only applies while the document still is the rewritten one.
 */
export function ComposerEnhancePromptButton({
  editor,
  draftKey,
  disabled = false,
  disabledReason,
}: ComposerEnhancePromptButtonProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [structured, setStructured] = useState(false);
  const [undoState, setUndoState] = useState<{ original: JSONContent; applied: string } | null>(null);

  // Track the draft so the button only appears once there is something to
  // rewrite, and so a structured draft can be detected up front.
  useEffect(() => {
    if (!editor) {
      setHasDraft(false);
      setStructured(false);
      return;
    }
    const sync = () => {
      const doc = editor.getJSON();
      setHasDraft(editor.getText().trim().length > 0);
      setStructured(documentHasStructuredNodes(doc));
    };
    sync();
    editor.on('update', sync);
    editor.on('create', sync);
    return () => {
      editor.off('update', sync);
      editor.off('create', sync);
    };
  }, [editor]);

  // A different draft invalidates the undo record.
  useEffect(() => {
    setUndoState(null);
  }, [draftKey]);

  const unavailableReason = useMemo(() => {
    if (disabled) return disabledReason ?? t('newChat.composerEnhance.disabled');
    if (structured) return t('newChat.composerEnhance.unsupported');
    return null;
  }, [disabled, disabledReason, structured, t]);

  const enhance = useCallback(async () => {
    if (!editor || busy || unavailableReason) return;
    const originalDoc = editor.getJSON();
    const originalFingerprint = documentFingerprint(originalDoc);
    const draft = editor.getText().trim();
    if (!draft) return;
    const requestKey = draftKey;
    setBusy(true);
    try {
      const result = await window.electronAPI.composer.enhancePrompt(draft);
      const stillSameDraft =
        draftKey === requestKey &&
        documentFingerprint(editor.getJSON()) === originalFingerprint;
      if (!stillSameDraft || editorIsComposing(editor)) {
        toast.warning(t('newChat.composerEnhance.stale'));
        return;
      }
      editor.commands.setContent(plainTextToComposerDocument(result.text));
      setUndoState({ original: originalDoc, applied: documentFingerprint(editor.getJSON()) });
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
  }, [busy, draftKey, editor, t, unavailableReason]);

  const undo = useCallback(() => {
    if (!editor || undoState === null) return;
    if (documentFingerprint(editor.getJSON()) !== undoState.applied) {
      toast.warning(t('newChat.composerEnhance.undoUnavailable'));
      return;
    }
    editor.commands.setContent(undoState.original);
    setUndoState(null);
    editor.commands.focus();
    editor.commands.selectAll();
  }, [editor, t, undoState]);

  if (!editor || !hasDraft) return null;

  const controlClass = cn(
    'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full',
    'border border-[var(--border-default)] bg-[var(--composer-pill-bg)] text-[var(--composer-pill-icon)]',
    'transition-[background-color,transform] duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chat-input-bg)]',
    !unavailableReason && !busy && 'hover:bg-[var(--model-trigger-hover)] active:scale-[0.98]',
    (unavailableReason || busy) && 'cursor-not-allowed opacity-40',
  );

  const label = busy ? t('newChat.composerEnhance.working') : t('newChat.composerEnhance.enhance');

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tip text={unavailableReason ?? label} side="top">
        <button
          type="button"
          onClick={() => void enhance()}
          disabled={Boolean(unavailableReason) || busy}
          aria-label={label}
          aria-disabled={Boolean(unavailableReason)}
          className={controlClass}
        >
          {busy ? <Spinner size={14} /> : <Sparkles size={15} />}
        </button>
      </Tip>
      {undoState !== null && (
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
