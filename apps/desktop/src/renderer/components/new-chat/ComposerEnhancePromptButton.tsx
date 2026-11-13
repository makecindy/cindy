import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Undo2 } from 'lucide-react';
import type { Editor, JSONContent } from '@tiptap/core';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { hasFocusMovedToInteractiveElement, hasNonCollapsedSelectionOutsideComposer } from './useComposerSendFocusRestore';
import { COMPOSER_ENHANCE_MAX_INPUT_CHARS } from '../../../shared/composerPromptEnhance';
import {
  buildEnhancedDocument,
  canApplyEnhanceResult,
  canUndoEnhanceResult,
  documentFingerprint,
  documentHasStructuredNodes,
  draftExceedsEnhanceInputLimit,
  editorIsComposing,
  resolveEnhanceErrorKind,
  type EnhanceLiveState,
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
 * hover only, like the `+` / permission / model triggers it sits next to. Both
 * actions are square shared `Button`s (DESIGN §14.6), so the focus ring, the
 * disabled state and the pressed feedback come from that primitive; only this
 * tier's paint is set here. The control keeps its slot while there is no draft,
 * disabled, so typing the first character does not shift the rest of the
 * toolbar.
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
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [structured, setStructured] = useState(false);
  const [tooLong, setTooLong] = useState(false);
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
      setTooLong(false);
      return;
    }
    const sync = () => {
      const doc = editor.getJSON();
      const text = editor.getText().trim();
      setHasDraft(text.length > 0);
      setStructured(documentHasStructuredNodes(doc));
      setTooLong(draftExceedsEnhanceInputLimit(text));
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
    // A draft over the input budget is refused by main. Saying so here beats
    // letting the user click into a generic "invalid input" error.
    if (tooLong) {
      return t('newChat.composerEnhance.tooLong', { max: COMPOSER_ENHANCE_MAX_INPUT_CHARS });
    }
    if (!hasDraft) return t('newChat.composerEnhance.empty');
    return null;
  }, [disabled, disabledReason, hasDraft, structured, t, tooLong]);

  /**
   * The live composer state, read when an answer comes back.
   *
   * It is built from the latest committed props and the editor itself, never
   * from the values captured when the request was dispatched.
   */
  const readLiveState = useCallback((): EnhanceLiveState => {
    const current = latest.current;
    const currentEditor = current.editor;
    return {
      editor: currentEditor,
      draftKey: current.draftKey,
      fingerprint: currentEditor ? documentFingerprint(currentEditor.getJSON()) : '',
      disabled: current.disabled,
      mounted: mounted.current,
      destroyed: currentEditor ? currentEditor.isDestroyed : true,
      composing: currentEditor ? editorIsComposing(currentEditor) : false,
    };
  }, []);

  const enhance = useCallback(async () => {
    if (!editor || busy || enhanceUnavailableReason) return;
    const originalDoc = editor.getJSON();
    // Decide eligibility from the document itself, not from a rendered flag that
    // may lag behind the editor state.
    if (documentHasStructuredNodes(originalDoc)) {
      toast.warning(t('newChat.composerEnhance.unsupported'));
      return;
    }
    const draft = editor.getText().trim();
    if (!draft) return;
    const requestKey = draftKey;
    setBusy(true);
    try {
      const result = await window.electronAPI.composer.enhancePrompt(draft);
      const origin = {
        editor,
        draftKey: requestKey,
        fingerprint: documentFingerprint(originalDoc),
      };
      if (!canApplyEnhanceResult(origin, readLiveState())) {
        toast.warning(t('newChat.composerEnhance.stale'));
        return;
      }
      editor.commands.setContent(buildEnhancedDocument(result.text));
      setUndoState({
        original: originalDoc,
        applied: documentFingerprint(editor.getJSON()),
        editor,
        draftKey: requestKey,
      });
      // Leave the rewritten text selected so the user can read it and press
      // Enter to send, or keep editing (same contract as the rename and
      // prompt-suggestion flows: fill back, never send). While the request was
      // running the user may have moved to another control — the model
      // selector's search field, for one. Focusing and selecting there would
      // take the caret out of what they are typing into (and close the popover
      // that owns it), so the rewrite is only selected while the composer still
      // holds the user's attention.
      const focusStayedInComposer = !editor.isDestroyed
        && !hasFocusMovedToInteractiveElement(null, editor.view.dom)
        // A selection outside the composer keeps the focus on the body, so the
        // check above would pass and select-all would replace the text the user
        // was about to copy.
        && !hasNonCollapsedSelectionOutsideComposer(editor.view.dom);
      if (focusStayedInComposer) {
        editor.commands.focus();
        editor.commands.selectAll();
      }
      toast.success(t('newChat.composerEnhance.success'));
    } catch (error) {
      // An exhausted auxiliary chain is a configuration problem, not a
      // transient failure: point the user at the setting that fixes it.
      if (resolveEnhanceErrorKind(error) === 'missing-config') {
        toast.error(t('newChat.composerEnhance.noAuxiliaryModel'), {
          action: {
            label: t('newChat.composerEnhance.openSettings'),
            onClick: () => navigate('/settings?tab=personalization&section=auxiliaryModels'),
          },
        });
        return;
      }
      // Every other failure is the operation itself failing. The generic
      // ipcError wording says "this action is unavailable in the current
      // state, please try again later" — advice that no failure reason here
      // supports — so the message names the operation instead.
      toast.error(t('newChat.composerEnhance.failed'));
    } finally {
      setBusy(false);
    }
  }, [busy, draftKey, editor, enhanceUnavailableReason, navigate, readLiveState, t]);

  const undo = useCallback(() => {
    if (!editor || undoState === null) return;
    // The undo record belongs to the draft it was created for, and the live
    // document must still be the one the rewrite produced.
    if (!canUndoEnhanceResult(undoState, readLiveState(), { busy })) {
      toast.warning(t('newChat.composerEnhance.undoUnavailable'));
      return;
    }
    editor.commands.setContent(undoState.original);
    setUndoState(null);
    editor.commands.focus();
    editor.commands.selectAll();
  }, [busy, editor, readLiveState, t, undoState]);

  if (!editor) return null;

  /**
   * The composer toolbar's bare tier, expressed through the shared Button.
   *
   * DESIGN §14.6: a new icon-only action uses the square shared `Button`
   * (frameless `variant="secondary"` `tone="quiet"`), so focus ring, disabled
   * state and pressed feedback come from that primitive instead of a
   * feature-local native button. What stays here is only this tier's paint:
   * bare at rest, the pill appears on hover — same chrome as the `+` /
   * permission / model triggers it sits next to
   * (`docs/design-rules/container-transform.md`, "Composer toolbar: two chrome
   * tiers").
   */
  const composerPillClass = cn(
    'w-7 px-0',
    '[--button-face-bg:transparent] [--button-face-border:transparent]',
    'text-[var(--composer-pill-icon)]',
    'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--composer-pill-bg)]',
    'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-border:var(--border-default)]',
    'enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--composer-pill-bg)]',
  );

  const label = busy ? t('newChat.composerEnhance.working') : t('newChat.composerEnhance.enhance');

  // A disabled icon-only control has to say why (DESIGN §14.6). Undo can be
  // blocked by a running request or by the composer lock, and neither reason is
  // the same as "nothing to undo", so the tooltip carries it.
  const undoUnavailableReason = busy
    ? t('newChat.composerEnhance.working')
    : disabled
      ? (disabledReason ?? t('newChat.composerEnhance.locked'))
      : null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tip text={enhanceUnavailableReason ?? label} side="top">
        <Button
          variant="secondary"
          tone="quiet"
          size="sm"
          className={composerPillClass}
          onClick={() => void enhance()}
          disabled={Boolean(enhanceUnavailableReason)}
          loading={busy}
          aria-label={label}
        >
          <Sparkles size={15} />
        </Button>
      </Tip>
      {undoState !== null && (
        <Tip text={undoUnavailableReason ?? t('newChat.composerEnhance.undo')} side="top">
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            className={composerPillClass}
            onClick={undo}
            disabled={busy || disabled}
            aria-label={t('newChat.composerEnhance.undo')}
          >
            <Undo2 size={15} />
          </Button>
        </Tip>
      )}
    </div>
  );
}
