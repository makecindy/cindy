import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 * Chrome follows the composer's bare toolbar tier (`docs/design-rules/
 * container-transform.md`): no outline or fill at rest, the pill appears on
 * hover only, like the `+` / permission / model triggers it sits next to. The
 * control keeps its slot while there is no draft, disabled, so typing the
 * first character does not shift the rest of the toolbar.
 *
 * Two rules keep the user's text safe:
 *
 * - A draft is only rewritten when a plain-text round trip can reproduce it.
 *   Mention chips, pasted-text chips, quotes and lists carry structure that a
 *   string cannot restore, so such a draft is not eligible.
 * - The answer is applied only when the draft is still exactly the one the
 *   request was started from: a draft that changed in the meantime, that moved
 *   to another session, or that is mid IME composition keeps the user's text.
 *
 * Enhancement and undo have separate eligibility. A rewrite may come back as
 * a list even when the draft was plain text, and the undo for it must stay
 * available: undo restores a full document, so it is only blocked by the
 * composer lock, a running request, or a document that changed since.
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
  const [undoState, setUndoState] = useState<{
    original: JSONContent;
    applied: string;
    editor: Editor;
    draftKey: string | undefined;
  } | null>(null);

  // The latest committed props, read when an answer comes back. Comparing a
  // value captured in the closure of the request would always match, because
  // the closure never sees the newer render.
  const latest = useRef({ draftKey, editor, disabled });
  useLayoutEffect(() => {
    latest.current = { draftKey, editor, disabled };
  }, [draftKey, editor, disabled]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Track the draft so the button only appears once there is something to
  // rewrite, and so an ineligible draft can be detected up front.
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

  // A different draft, or a different editor instance for the same draft,
  // invalidates the undo record: it belongs to the document it came from.
  useEffect(() => {
    setUndoState((current) =>
      current && (current.editor !== editor || current.draftKey !== draftKey)
        ? null
        : current,
    );
  }, [draftKey, editor]);

  const enhanceUnavailableReason = useMemo(() => {
    if (disabled) return disabledReason ?? t('newChat.composerEnhance.locked');
    if (structured) return t('newChat.composerEnhance.unsupported');
    if (!hasDraft) return t('newChat.composerEnhance.empty');
    return null;
  }, [disabled, disabledReason, hasDraft, structured, t]);

  const enhance = useCallback(async () => {
    if (!editor || busy || enhanceUnavailableReason) return;
    const originalDoc = editor.getJSON();
    // Decide eligibility from the document itself, not from a rendered flag that
    // may lag behind the editor state.
    if (documentHasStructuredNodes(originalDoc)) {
      toast.warning(t('newChat.composerEnhance.unsupported'));
      return;
    }
    const originalFingerprint = documentFingerprint(originalDoc);
    const draft = editor.getText().trim();
    if (!draft) return;
    const requestKey = draftKey;
    setBusy(true);
    try {
      const result = await window.electronAPI.composer.enhancePrompt(draft);
      const current = latest.current;
      const stillSameDraft =
        mounted.current &&
        current.editor === editor &&
        current.draftKey === requestKey &&
        !current.disabled &&
        !editor.isDestroyed &&
        documentFingerprint(editor.getJSON()) === originalFingerprint;
      if (!stillSameDraft || editorIsComposing(editor)) {
        toast.warning(t('newChat.composerEnhance.stale'));
        return;
      }
      editor.commands.setContent(plainTextToComposerDocument(result.text));
      setUndoState({
        original: originalDoc,
        applied: documentFingerprint(editor.getJSON()),
        editor,
        draftKey: requestKey,
      });
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
  }, [busy, draftKey, editor, enhanceUnavailableReason, t]);

  const undo = useCallback(() => {
    if (!editor || undoState === null || busy || disabled) return;
    if (!mounted.current || latest.current.disabled) return;
    if (undoState.editor !== editor) return;
    // The undo record belongs to the draft it was created for. Clearing it on a
    // draft change is a convenience, not the guard: assert the identity here.
    if (undoState.draftKey !== latest.current.draftKey) return;
    if (latest.current.editor !== editor) return;
    if (editor.isDestroyed || editorIsComposing(editor)) return;
    if (documentFingerprint(editor.getJSON()) !== undoState.applied) {
      toast.warning(t('newChat.composerEnhance.undoUnavailable'));
      return;
    }
    editor.commands.setContent(undoState.original);
    setUndoState(null);
    editor.commands.focus();
    editor.commands.selectAll();
  }, [busy, disabled, editor, t, undoState]);

  if (!editor) return null;

  const controlClass = cn(
    'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full',
    // 裸态工具条(2026-07-22 用户定稿):默认无框无底,hover 才浮现胶囊外框。
    // 与 +/权限/模型 同一档;右侧 voice/send 的常驻描边档不适用。
    'border border-transparent bg-transparent text-[var(--composer-pill-icon)]',
    'transition-[background-color,border-color,transform] duration-[var(--motion-fast,150ms)] ease-[var(--motion-ease-out)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chat-input-bg)]',
  );

  const hoverClass =
    'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg)] dark:hover:bg-[var(--composer-pill-bg)] active:scale-[0.98]';

  // The enhance and undo controls have separate eligibility, so they also have
  // separate state styling: an undo that is available must not look disabled.
  const enhanceControlClass = cn(
    controlClass,
    !enhanceUnavailableReason && !busy && hoverClass,
    (enhanceUnavailableReason || busy) && 'cursor-not-allowed opacity-40',
  );

  const undoControlClass = cn(
    controlClass,
    !busy && !disabled && hoverClass,
    (busy || disabled) && 'cursor-not-allowed opacity-40',
  );

  const label = busy ? t('newChat.composerEnhance.working') : t('newChat.composerEnhance.enhance');

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tip text={enhanceUnavailableReason ?? label} side="top">
        <button
          type="button"
          onClick={() => void enhance()}
          disabled={Boolean(enhanceUnavailableReason) || busy}
          aria-label={label}
          className={enhanceControlClass}
        >
          {busy ? <Spinner size={14} /> : <Sparkles size={15} />}
        </button>
      </Tip>
      {undoState !== null && (
        <Tip text={t('newChat.composerEnhance.undo')} side="top">
          <button
            type="button"
            onClick={undo}
            disabled={busy || disabled}
            aria-label={t('newChat.composerEnhance.undo')}
            className={undoControlClass}
          >
            <Undo2 size={15} />
          </button>
        </Tip>
      )}
    </div>
  );
}
