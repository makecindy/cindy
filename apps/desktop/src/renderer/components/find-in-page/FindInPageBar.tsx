import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { isFindInPageClaimed } from './findInPageOwnership';

/**
 * F-FIP-1 — Find in Page overlay (Ctrl/Cmd+F).
 *
 * Drives Chromium's native `webContents.findInPage` via IPC and surfaces
 * match counts in a small floating bar pinned to the top-right of the
 * window. Esc closes; Enter / Shift+Enter walk forward / backward.
 *
 * Why a single global instance (mounted once in App.tsx):
 *   `findInPage` is per-WebContents — every press of Ctrl+F should drive
 *   the SAME native search session, otherwise the highlighted matches
 *   bounce around or get orphaned. One bar = one source of truth.
 */
export function FindInPageBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [matches, setMatches] = useState(0);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  // Chromium may emit the final input/change after compositionend. Remember
  // that value so the committed IME text starts exactly one native search.
  const compositionCommitRef = useRef<string | null>(null);
  // Track the requestId returned by `findInPage` so we can ignore stale
  // result events from an earlier query (Chromium fires `found-in-page`
  // multiple times per request as the search progresses).
  const lastRequestIdRef = useRef<number | null>(null);

  // Subscribe to result events while the bar is open. The fan-out subscriber
  // returns an unsubscribe function — calling it on close releases the
  // underlying ipcRenderer binding (see preload.ts createIpcFanOut).
  useEffect(() => {
    if (!open) return;
    const unsub = window.electronAPI.onFindInPageResult((result) => {
      // Discard results that don't belong to our most recent request.
      if (lastRequestIdRef.current !== null && result.requestId !== lastRequestIdRef.current) {
        return;
      }
      setMatches(result.matches);
      setActive(result.activeMatchOrdinal);
    });
    return () => {
      unsub();
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setText('');
    setMatches(0);
    setActive(0);
    isComposingRef.current = false;
    compositionCommitRef.current = null;
    lastRequestIdRef.current = null;
    window.electronAPI.stopFindInPage('clearSelection');
  }, []);

  // Global find-in-page shortcut (registry 默认 Ctrl/Cmd+F, 用户可改绑) →
  // open + focus. Capture phase so editable inputs (TipTap, plain inputs,
  // contenteditable) don't swallow the chord first.
  useAppShortcut('find-in-page', () => {
    // 有局部接管者(如 doc 模式的 FileBodyView)时让位 —— 不消费事件,
    // 让接管者自己的 handler 处理。注册顺序此时无所谓。
    if (isFindInPageClaimed()) return false;
    setOpen(true);
    // Defer focus to next tick so the input is mounted & visible.
    queueMicrotask(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return true;
  });

  // Electron uses `findNext=true` to start a new request and false to continue
  // walking the current search session.
  const runSearch = useCallback(
    async (nextText: string, opts: { forward?: boolean; findNext?: boolean } = {}) => {
      if (!nextText) {
        setMatches(0);
        setActive(0);
        lastRequestIdRef.current = null;
        window.electronAPI.stopFindInPage('clearSelection');
        return;
      }
      const id = await window.electronAPI.findInPage({
        text: nextText,
        forward: opts.forward ?? true,
        findNext: opts.findNext ?? true,
      });
      if (typeof id === 'number') {
        lastRequestIdRef.current = id;
      }
    },
    [],
  );

  if (!open) return null;

  return (
    <div
      className={cn(
        // Title bar is 46px tall — sit just below it so it never overlaps.
        'fixed right-4 top-[54px] z-50',
        'flex items-center gap-1',
        'rounded-lg border border-border',
        'bg-popover text-popover-foreground',
        'shadow-lg',
        'px-2 py-1.5',
        'min-w-[280px]',
        // mount-only 入场:Cmd+F 呼出时从右上角(标题栏方向)轻长出;
        // 关闭走 unmount 直接消失(查找栏关闭要"立即让路",不做 exit)。
        'origin-top-right animate-float-in',
      )}
      role="dialog"
      aria-label={t('findInPage.dialogAriaLabel')}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder={t('findInPage.placeholder')}
        onChange={(e) => {
          const next = e.target.value;
          const nativeIsComposing =
            'isComposing' in e.nativeEvent && e.nativeEvent.isComposing === true;
          setText(next);
          if (isComposingRef.current || nativeIsComposing) return;
          if (compositionCommitRef.current !== null) {
            const committed = compositionCommitRef.current;
            compositionCommitRef.current = null;
            if (next === committed) return;
          }
          void runSearch(next, { forward: true, findNext: true });
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
          compositionCommitRef.current = null;
        }}
        onCompositionEnd={(e) => {
          const committed = e.currentTarget.value;
          isComposingRef.current = false;
          compositionCommitRef.current = committed;
          setText(committed);
          void runSearch(committed, { forward: true, findNext: true });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (
            e.key === 'Enter' &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            if (text) void runSearch(text, { forward: !e.shiftKey, findNext: false });
          }
        }}
        className={cn(
          'flex-1 min-w-0',
          'bg-transparent outline-none',
          'text-sm',
          'placeholder:text-muted-foreground',
        )}
      />
      <span
        className="text-xs tabular-nums text-muted-foreground select-none whitespace-nowrap px-1"
        aria-live="polite"
      >
        {text ? (matches > 0 ? `${active}/${matches}` : '0/0') : ''}
      </span>
      <button
        type="button"
        aria-label={t('findInPage.previous')}
        disabled={!text || matches === 0}
        onClick={() => void runSearch(text, { forward: false, findNext: false })}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none',
        )}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        aria-label={t('findInPage.next')}
        disabled={!text || matches === 0}
        onClick={() => void runSearch(text, { forward: true, findNext: false })}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none',
        )}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        aria-label={t('findInPage.close')}
        onClick={close}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded',
          'hover:bg-titlebar-button-hover',
          'focus-visible:outline-none',
        )}
      >
        <X size={14} />
      </button>
    </div>
  );
}
