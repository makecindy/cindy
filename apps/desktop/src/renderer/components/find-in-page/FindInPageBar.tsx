import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { isFindInPageClaimed } from './findInPageOwnership';

const SEARCH_DEBOUNCE_MS = 120;

interface PendingSearchInput {
  input: HTMLInputElement;
  requestId: number | null;
  restoreFocus: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  userInteracted: boolean;
  earlyResults: FindInPageResult[];
}

interface FindInPageResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

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
  const [maskNativeSearchInput, setMaskNativeSearchInput] = useState(false);
  const [matches, setMatches] = useState(0);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSearchInputRef = useRef<PendingSearchInput | null>(null);
  const searchGenerationRef = useRef(0);
  const isComposingRef = useRef(false);
  // Chromium may emit the final input/change after compositionend. Remember
  // that value so the committed IME text starts exactly one native search.
  const compositionCommitRef = useRef<string | null>(null);
  // Track the requestId returned by `findInPage` so we can ignore stale
  // result events from an earlier query (Chromium fires `found-in-page`
  // multiple times per request as the search progresses).
  const lastRequestIdRef = useRef<number | null>(null);

  const clearScheduledSearch = useCallback(() => {
    if (searchTimerRef.current === null) return;
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }, []);

  const restoreSearchInputFocus = useCallback((pending: PendingSearchInput) => {
    if (!pending.restoreFocus || pending.userInteracted || inputRef.current !== pending.input) {
      return;
    }
    const shouldRestoreSelection = document.activeElement !== pending.input;
    pending.input.focus({ preventScroll: true });
    if (
      shouldRestoreSelection &&
      pending.selectionStart !== null &&
      pending.selectionEnd !== null
    ) {
      pending.input.setSelectionRange(pending.selectionStart, pending.selectionEnd);
    }
  }, []);

  const releaseSearchInput = useCallback(
    (pending: PendingSearchInput, restoreFocus = pending.restoreFocus) => {
      pending.input.type = 'text';
      setMaskNativeSearchInput(false);
      if (restoreFocus) restoreSearchInputFocus(pending);
    },
    [restoreSearchInputFocus],
  );

  const cancelPendingSearchInput = useCallback(() => {
    const pending = pendingSearchInputRef.current;
    if (!pending) return;
    pendingSearchInputRef.current = null;
    releaseSearchInput(pending, false);
  }, [releaseSearchInput]);

  const applySearchResult = useCallback(
    (result: FindInPageResult) => {
      if (result.requestId !== lastRequestIdRef.current) return;
      setMatches(result.matches);
      setActive(result.activeMatchOrdinal);

      const pending = pendingSearchInputRef.current;
      if (!pending || pending.requestId !== result.requestId) return;
      if (result.finalUpdate) {
        pendingSearchInputRef.current = null;
        releaseSearchInput(pending);
      } else {
        // Restore focus as soon as Chromium moves it to the first match, while
        // keeping the password-backed value until finalUpdate so the remaining
        // asynchronous scan cannot match this field.
        restoreSearchInputFocus(pending);
      }
    },
    [releaseSearchInput, restoreSearchInputFocus],
  );

  // Native find can focus a link/contenteditable match. Track an explicit
  // pointer/keyboard actions separately so that programmatic focus does not
  // block restoring the query field, while deliberate navigation wins.
  useEffect(() => {
    const markUserInteraction = () => {
      const pending = pendingSearchInputRef.current;
      if (!pending) return;
      pending.userInteracted = true;
    };
    const markKeyboardNavigation = (event: KeyboardEvent) => {
      const pending = pendingSearchInputRef.current;
      if (!pending) return;
      const target = event.target;
      const movesCaret =
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey));
      if (
        event.key === 'Tab' ||
        movesCaret ||
        !(target instanceof Node && pending.input.contains(target))
      ) {
        pending.userInteracted = true;
      }
    };
    window.addEventListener('pointerdown', markUserInteraction, true);
    window.addEventListener('keydown', markKeyboardNavigation, true);
    return () => {
      window.removeEventListener('pointerdown', markUserInteraction, true);
      window.removeEventListener('keydown', markKeyboardNavigation, true);
    };
  }, []);

  // Changing an input's type can make Chromium drop focus. Restore the query
  // field immediately after switching to the password-backed representation;
  // it remains editable while native find scopes the page.
  useLayoutEffect(() => {
    if (!maskNativeSearchInput) return;
    const pending = pendingSearchInputRef.current;
    if (!pending || !pending.restoreFocus || pending.userInteracted) return;
    pending.input.focus({ preventScroll: true });
  }, [maskNativeSearchInput]);

  // Subscribe to result events while the bar is open. The fan-out subscriber
  // returns an unsubscribe function — calling it on close releases the
  // underlying ipcRenderer binding (see preload.ts createIpcFanOut).
  useEffect(() => {
    if (!open) return;
    const unsub = window.electronAPI.onFindInPageResult((result) => {
      const pending = pendingSearchInputRef.current;
      if (pending?.requestId === null) {
        // The found-in-page event and invoke reply use separate IPC paths;
        // buffer early events until we know which request ID this invocation
        // received, then discard any late result from an older query.
        pending.earlyResults.push(result);
        return;
      }
      applySearchResult(result);
    });
    return () => {
      unsub();
    };
  }, [applySearchResult, open]);

  const close = useCallback(() => {
    searchGenerationRef.current += 1;
    clearScheduledSearch();
    cancelPendingSearchInput();
    setOpen(false);
    setText('');
    setMaskNativeSearchInput(false);
    setMatches(0);
    setActive(0);
    isComposingRef.current = false;
    compositionCommitRef.current = null;
    lastRequestIdRef.current = null;
    window.electronAPI.stopFindInPage('clearSelection');
  }, [cancelPendingSearchInput, clearScheduledSearch]);

  useEffect(
    () => () => {
      searchGenerationRef.current += 1;
      clearScheduledSearch();
      cancelPendingSearchInput();
    },
    [cancelPendingSearchInput, clearScheduledSearch],
  );

  // Global find-in-page shortcut (registry 默认 Ctrl/Cmd+F, 用户可改绑) →
  // open + focus. Capture phase so editable inputs (TipTap, plain inputs,
  // contenteditable) don't swallow the chord first.
  useAppShortcut('find-in-page', () => {
    // 有局部接管者(如 doc 模式的 FileBodyView)时让位 —— 不消费事件,
    // 让接管者自己的 handler 处理。注册顺序此时无所谓。
    if (isFindInPageClaimed()) return false;
    const pending = pendingSearchInputRef.current;
    if (pending) pending.userInteracted = true;
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
      const generation = searchGenerationRef.current + 1;
      searchGenerationRef.current = generation;
      clearScheduledSearch();
      cancelPendingSearchInput();
      if (!nextText) {
        setMatches(0);
        setActive(0);
        lastRequestIdRef.current = null;
        window.electronAPI.stopFindInPage('clearSelection');
        return;
      }
      lastRequestIdRef.current = null;

      const input = inputRef.current;
      const pending: PendingSearchInput | null = input
        ? {
            input,
            requestId: null,
            restoreFocus: document.activeElement === input,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            userInteracted: false,
            earlyResults: [],
          }
        : null;
      if (pending) {
        // Chromium includes ordinary form-control values in find-in-page's
        // asynchronous scan. A password input remains editable/focusable,
        // but its value is excluded from the searchable text. The empty
        // sibling below uses CSS generated content for the clear query text;
        // generated content is not part of Chromium's searchable DOM text.
        pendingSearchInputRef.current = pending;
        flushSync(() => setMaskNativeSearchInput(true));
      }

      try {
        const id = await window.electronAPI.findInPage({
          text: nextText,
          forward: opts.forward ?? true,
          findNext: opts.findNext ?? false,
        });
        if (generation !== searchGenerationRef.current) return;
        if (typeof id === 'number') {
          lastRequestIdRef.current = id;
          if (pendingSearchInputRef.current === pending && pending) {
            pending.requestId = id;
            // The native scan may move focus before its first result event;
            // restore the editable query field as soon as dispatch is
            // acknowledged. The password-backed value keeps it excluded
            // while Chromium continues scanning.
            restoreSearchInputFocus(pending);
            for (const result of pending.earlyResults.splice(0)) {
              applySearchResult(result);
            }
          }
        } else if (pendingSearchInputRef.current === pending && pending) {
          pendingSearchInputRef.current = null;
          releaseSearchInput(pending);
        }
      } catch {
        if (pendingSearchInputRef.current === pending && pending) {
          pendingSearchInputRef.current = null;
          releaseSearchInput(pending);
        }
      }
    },
    [
      applySearchResult,
      cancelPendingSearchInput,
      clearScheduledSearch,
      releaseSearchInput,
      restoreSearchInputFocus,
    ],
  );

  const scheduleSearch = useCallback(
    (nextText: string) => {
      searchGenerationRef.current += 1;
      clearScheduledSearch();
      cancelPendingSearchInput();
      setMatches(0);
      setActive(0);
      lastRequestIdRef.current = null;
      window.electronAPI.stopFindInPage('clearSelection');
      if (!nextText) return;
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        void runSearch(nextText, { forward: true, findNext: false });
      }, SEARCH_DEBOUNCE_MS);
    },
    [cancelPendingSearchInput, clearScheduledSearch, runSearch],
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
      <div
        className={cn(
          'relative flex-1 min-w-0 overflow-hidden',
          maskNativeSearchInput &&
            text && [
              'before:pointer-events-none before:absolute before:inset-y-0 before:left-0',
              'before:flex before:items-center before:whitespace-pre before:text-sm',
              'before:text-popover-foreground before:content-[attr(data-query)]',
            ],
        )}
        data-query={maskNativeSearchInput && text ? text : undefined}
      >
        <input
          ref={inputRef}
          type={maskNativeSearchInput ? 'password' : 'text'}
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
            scheduleSearch(next);
          }}
          onCompositionStart={() => {
            isComposingRef.current = true;
            compositionCommitRef.current = null;
            searchGenerationRef.current += 1;
            lastRequestIdRef.current = null;
            clearScheduledSearch();
            cancelPendingSearchInput();
            setMatches(0);
            setActive(0);
            window.electronAPI.stopFindInPage('clearSelection');
          }}
          onCompositionEnd={(e) => {
            const committed = e.currentTarget.value;
            isComposingRef.current = false;
            compositionCommitRef.current = committed;
            setText(committed);
            scheduleSearch(committed);
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
              if (text) {
                void runSearch(text, {
                  forward: !e.shiftKey,
                  findNext: lastRequestIdRef.current !== null,
                });
              }
            }
          }}
          className={cn(
            'w-full min-w-0',
            'bg-transparent outline-none',
            'text-sm',
            maskNativeSearchInput && 'text-transparent',
            'placeholder:text-muted-foreground',
          )}
        />
      </div>
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
