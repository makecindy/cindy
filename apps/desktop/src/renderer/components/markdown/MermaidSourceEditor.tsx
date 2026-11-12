import { Button } from '@/components/ui/button';
/**
 * MermaidSourceEditor
 *
 * Modal source editor for a single mermaid fence in workdir-browse. Mounted
 * via `MermaidSourceEditorHost` (alongside the lightbox host) inside
 * FileBodyView.
 *
 * Why a modal rather than reveal-the-source-inline:
 *   - The first version of the live-preview field tried cursor-aware reveal
 *     (skip the block decoration when the cursor sits inside the fence) and
 *     it broke CodeMirror's height-map measurement (see comment block in
 *     `markdownMermaidLivePreview.ts`). Any selection-driven decoration
 *     rebuild risks the same regression.
 *   - A modal is purely user-initiated: the only state change in CM is the
 *     final `view.dispatch` on Save, which is a single docChanged transaction.
 *     The block widget rebuilds normally on the next pass.
 *
 * The widget passes its `applyEdit(newSource)` closure through the
 * CustomEvent detail. That closure has already captured the live `EditorView`
 * + the body's char range, so the modal doesn't need to know which file is
 * open or how to reach the editor — it just calls the callback on Save.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useDialogExit } from '@/hooks/useDialogExit';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

import {
  MERMAID_EDIT_EVENT,
  type MermaidEditApplyResult,
  type MermaidEditOpenDetail,
} from './markdownMermaidLivePreview';

interface OpenState {
  source: string;
  applyEdit: (newSource: string) => MermaidEditApplyResult;
}

export function MermaidSourceEditorHost() {
  const { t } = useTranslation();
  const [state, setState] = useState<OpenState | null>(null);

  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<MermaidEditOpenDetail>).detail;
      if (!detail) return;
      setState({ source: detail.source, applyEdit: detail.applyEdit });
    };
    window.addEventListener(MERMAID_EDIT_EVENT, onOpen);
    return () => window.removeEventListener(MERMAID_EDIT_EVENT, onOpen);
  }, []);

  if (state == null) return null;
  return (
    <MermaidSourceEditor
      initialSource={state.source}
      onSave={(next) => {
        const result = state.applyEdit(next);
        if (result === 'target-missing') {
          // Block was deleted / fence broken between the modal opening and
          // Save being clicked. Without this toast the modal just closes
          // looking like a successful save — the user has no idea their
          // edits silently went nowhere.
          toast.error(t('ccAgent.workdirBrowse.mermaidEditor.targetMissing'));
        }
        setState(null);
      }}
      onCancel={() => setState(null)}
    />
  );
}

interface MermaidSourceEditorProps {
  initialSource: string;
  onSave: (newSource: string) => void;
  onCancel: () => void;
}

function MermaidSourceEditor({
  initialSource,
  onSave,
  onCancel,
}: MermaidSourceEditorProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialSource);
  const dialog = useDialogExit();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Tell window-capture shortcut handlers (e.g. FileBodyView's Cmd+F /
  // Cmd+S) to bail while this modal is open. Capture-phase listeners on
  // window fire in registration order; FileBodyView mounted first so any
  // listener WE register won't preempt its `stopImmediatePropagation` calls.
  // A dataset flag on `<body>` is the cheapest cross-component "modal owns
  // the keyboard" signal. Without this, Cmd+F would steal focus to a
  // DocSearchBar hidden behind the modal, leaving the user typing into an
  // invisible input.
  useEffect(() => {
    document.body.dataset.mermaidEditorOpen = '1';
    return () => {
      delete document.body.dataset.mermaidEditorOpen;
    };
  }, []);

  const close = useCallback((commit: boolean) => {
    dialog.close(() => {
      if (commit) onSave(draft);
      else onCancel();
    });
  }, [dialog.close, draft, onSave, onCancel]);

  const dirty = draft !== initialSource;

  const onKeyDown = (ev: React.KeyboardEvent) => {
      // Cmd/Ctrl+Enter saves — quick exit for users who edited and want out.
      // Gate on `dirty` so a stale shortcut press on an unchanged diagram
      // doesn't fire a no-op `view.dispatch`. The dispatch would still
      // produce a docChanged event → markdown autosave → potential noisy
      // file-mtime bump and (if the block was deleted between open and
      // press) a spurious "target-missing" toast.
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        if (dirty) close(true);
        else close(false);
      }
      // Cmd/Ctrl+S is intentionally NOT handled here. FileBodyView already
      // owns the global Cmd+S → save-current-file shortcut (registered as a
      // capture-phase window listener with `stopImmediatePropagation`), and
      // this modal mounts AFTER FileBodyView so any capture-phase listener
      // we'd add here can't preempt it by registration order. Trying to win
      // the race with cross-component flags would couple FileBodyView to
      // this component for negligible benefit:
      //   - The shortcut hint advertises Cmd+Enter to save, not Cmd+S.
      //   - When FileBodyView's Cmd+S writes the underlying CM doc while the
      //     modal is open, it writes the SAME bytes already on disk (the
      //     modal draft hasn't been dispatched), so there's no real data
      //     loss — only a no-op write.
  };

  return (
    <Dialog.Root open={dialog.open} onOpenChange={(open) => { if (!open) close(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[60]" style={WINDOW_DRAG_STYLE} />
      {/* The scrim does not dismiss: a stray click outside must not discard the
          draft. Cancel and Escape remain the ways out (DESIGN §4 Dialog). */}
      <Dialog.Content
        aria-describedby={undefined}
        onPointerDownOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          dialog.onOpenAutoFocus();
          event.preventDefault();
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(0, 0);
        }}
        onCloseAutoFocus={dialog.onCloseAutoFocus}
        onKeyDown={onKeyDown}
        style={WINDOW_NO_DRAG_STYLE}
        className={cn(
          'modal-panel fixed inset-0 z-[61] m-auto flex flex-col outline-none',
          'w-[min(880px,90vw)] h-[min(640px,80vh)]',
          'overflow-hidden',
        )}
      >
        <div
          className={cn(
            'flex items-center justify-between',
            'px-5 py-3 border-b border-[var(--border-default)]',
          )}
        >
          <Dialog.Title asChild><div className="text-14 font-medium text-[var(--text-primary)]">
            {t('ccAgent.workdirBrowse.mermaidEditor.title')}
          </div></Dialog.Title>
          <div className="text-11 text-[var(--text-tertiary)]">
            {t('ccAgent.workdirBrowse.mermaidEditor.shortcuts')}
          </div>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className={cn(
            'flex-1 min-h-0 w-full px-5 py-4 resize-none outline-none',
            'bg-transparent text-[var(--text-primary)]',
            'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.55]',
          )}
        />
        <div
          className={cn(
            'flex items-center justify-end gap-2',
            'px-5 py-3 border-t border-[var(--border-default)]',
          )}
        >
          <Button
            variant="secondary"
            size="md"
            compact
            tone="quiet"
            type="button"
            onClick={() => close(false)}
          >
            {t('ccAgent.workdirBrowse.mermaidEditor.cancel')}
          </Button>
          <Button
            variant="cta"
            size="md"
            compact
            type="button"
            disabled={!dirty}
            onClick={() => close(true)}
          >
            {t('ccAgent.workdirBrowse.mermaidEditor.save')}
          </Button>
        </div>
      </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
