/**
 * TextLightbox
 * ---------------------------------------------------------------------------
 * Full-screen text-file preview overlay rendered via React Portal.
 *
 * text-lightbox spec (2026-04-19):
 *   F3  Overlay via --overlay-lightbox + centered Doc Card (80vw/80vh, 12px radius)
 *   F4  Toolbar (file-text · name · · · size · external-link · copy) +
 *       scrollable body containing the plain-text content.
 *   F5  超限状态（> OVERSIZE_LIMIT_MB）：triangle-alert + title + dynamic copy +
 *       单个 Black-Pill 系统打开 CTA。
 *   F6  Esc OR click on Overlay backdrop closes; clicks inside Doc Card stay.
 *
 * Sibling: ImageLightbox.tsx — same Portal/scroll-lock/Esc/fade pattern.
 * Difference: this lightbox has interactive widgets (Toolbar, body), so the
 * backdrop is a separate background button behind the Doc Card. Per F6, only
 * the backdrop and Esc close.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ExternalLink, FileText, Folder, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn, basename } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { detectRenderable } from '@/lib/textPreview';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { chatFileErrorText, fetchChatFileToCache } from '@/lib/remoteFileOpen';
import { useChatSessionFile } from './ChatSessionFileContext';
import { PlaintextEditor, type PlaintextEditorHandle } from '@/components/markdown/PlaintextEditor';
import { MarkdownRenderer } from './MarkdownRenderer';

interface TextLightboxProps {
  /** Absolute path of the file being previewed. */
  filePath: string;
  /** Display name shown in the toolbar. Defaults to the path's basename. */
  fileName?: string;
  /** Optional 1-based line number parsed from markdown file references. */
  initialLine?: number;
  /**
   * F6 — focus return target. The lightbox restores keyboard focus to this
   * element when closed (Esc / backdrop click), per spec "关闭后焦点回到入口
   * 元素". Pass the chip <button> ref so the user's tab stop survives the
   * round-trip. Optional: when omitted, focus falls back to document.body.
   */
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

// Renderer-side bytes cap. Mirrors the main-process MAX_PREVIEW_MB; the
// IPC response also carries `limitMb` so dynamic copy stays single-sourced.
const OVERSIZE_LIMIT_MB = 10;
const OVERSIZE_LIMIT = OVERSIZE_LIMIT_MB * 1024 * 1024;
const TEXT_LIGHTBOX_OVERLAY_Z_INDEX = 9999;
const TEXT_LIGHTBOX_TOOLTIP_STYLE = {
  zIndex: TEXT_LIGHTBOX_OVERLAY_Z_INDEX + 1,
} as const;

/**
 * Format a byte count for display in the toolbar (`3.4 MB`, `812 KB`, `73 B`).
 * Mirrors the spec wording — no thin-space, no parentheses, just "<n> <unit>".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * Markdown line-scroll anchor selection (pure, unit-tested).
 *
 * Given the `[data-source-line]` markers MarkdownRenderer emits (each carrying
 * the 1-based source line of the block it renders) and a target line, pick the
 * marker to scroll to: the one whose source line is the LARGEST value still
 * `<= targetLine`. That's the block that contains — or most closely precedes —
 * the requested line, since a block starting at line N covers lines until the
 * next marker. Entries with a non-finite line or a line past the target are
 * ignored. Returns null when nothing qualifies (e.g. target is above the first
 * marker), letting the caller fall back to height-based estimation.
 */
export function pickSourceLineAnchor<T extends { line: number }>(
  entries: readonly T[],
  targetLine: number,
): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (!Number.isFinite(entry.line) || entry.line > targetLine) continue;
    if (best === null || entry.line > best.line) best = entry;
  }
  return best;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; content: string; size: number }
  | { phase: 'oversize'; size: number; limitMb: number }
  | { phase: 'error'; message: string };

export function TextLightbox({ filePath, fileName, initialLine, triggerRef, onClose }: TextLightboxProps) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ phase: 'loading' });
  // 远程会话(device-link / SSH):filePath 是远端绝对路径,内容经 chat-file:fetch
  // 取回缓存副本后 READ_CACHED 读取;本机操作(打开 / 定位)一律对副本进行。
  // 聊天流外(文件浏览器等)context 是 local 默认值 → 走原有本机读取,零变化。
  const sessionFileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(sessionFileCtx.origin) ? sessionFileCtx.origin : null;
  const [remoteCopy, setRemoteCopy] = useState<{ cachePath: string; stale: boolean } | null>(null);
  // 远端取回进度(chat-file:fetch 的 TRANSFER push,relPath 键 = 原始 absPath)。
  const [fetchProgress, setFetchProgress] = useState<{ received: number; total: number } | null>(null);
  const isClosingRef = useRef(false);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<PlaintextEditorHandle>(null);
  const initialLineScrollKeyRef = useRef<string | null>(null);

  const displayName = useMemo(() => fileName ?? basename(filePath), [fileName, filePath]);
  const renderable = useMemo(() => detectRenderable(filePath), [filePath]);
  // text-lightbox-trigger-extension F1: links in the previewed markdown
  // resolve relative to the previewed file's own directory, not the chat
  // session cwd. Pure-string parent-dir derivation so we don't need IPC.
  const fileParentDir = useMemo(() => {
    const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (idx < 0) return filePath;
    // POSIX root case: '/x.md' → idx=0, slice(0,0)='' loses the root.
    // Preserve '/' so resolveLocalPath keeps cwd semantics correct.
    if (idx === 0) return filePath.startsWith('/') ? '/' : filePath.slice(0, 1);
    return filePath.slice(0, idx);
  }, [filePath]);

  const [showSpinner, setShowSpinner] = useState(false);

  const contentReady =
    loadState.phase === 'oversize' ||
    loadState.phase === 'error' ||
    loadState.phase === 'ready';
  // 远端会话:「定位 / 系统打开」操作的是缓存副本,副本未取回前按钮置灰,
  // 避免点击静默无响应(本地会话恒可用,行为不变)。
  const localActionsReady = !remoteOrigin || remoteCopy !== null;

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsVisible(false);
    // F6 focus return: restore focus to the trigger chip BEFORE the parent
    // unmounts the lightbox. Wrapping in setTimeout (matched to the fade-out
    // duration) keeps the visual close + focus return in lockstep, mirroring
    // ImageLightbox's pattern. Guard against the trigger having been removed
    // from the DOM in the interim (e.g. message stream re-rendered).
    setTimeout(() => {
      const trigger = triggerRef?.current;
      if (trigger && document.contains(trigger)) {
        try {
          trigger.focus({ preventScroll: true });
        } catch {
          /* noop */
        }
      }
      onClose();
    }, 200);
  }, [onClose, triggerRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: filePath/initialLine 需要触发滚动状态重置。
  useEffect(() => {
    initialLineScrollKeyRef.current = null;
  }, [filePath, initialLine]);

  // Trigger fade-in on mount (mirrors ImageLightbox)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // F6: Esc key listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // F6: Scroll lock on the message stream's scroll container.
  // Same selector ImageLightbox uses; keeping it in sync prevents the page
  // behind the overlay from scrolling under wheel/touchpad input.
  useEffect(() => {
    const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

  // 1-second grace period before showing the loading spinner. If content
  // becomes ready within 1s the user sees it directly ("instant open").
  // Otherwise the spinner appears to communicate work is still in progress.
  useEffect(() => {
    if (contentReady) return;
    const timer = setTimeout(() => setShowSpinner(true), 1000);
    return () => clearTimeout(timer);
  }, [contentReady]);

  // F4 / F5: load file on mount. Threshold + limit value come from the IPC
  // response so we don't have to re-statically encode the MB number in two places.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 远程:先取回缓存副本(同 identity 与侧边栏共享,命中秒回),再读副本。
        if (remoteOrigin) {
          const fetched = await fetchChatFileToCache(remoteOrigin, sessionFileCtx.workingDir, filePath);
          if (cancelled) return;
          if (!fetched.ok) {
            setLoadState({ phase: 'error', message: chatFileErrorText(fetched.code) });
            return;
          }
          setRemoteCopy({ cachePath: fetched.cachePath, stale: fetched.stale });
          if (fetched.size > OVERSIZE_LIMIT) {
            setLoadState({ phase: 'oversize', size: fetched.size, limitMb: OVERSIZE_LIMIT_MB });
            return;
          }
          const read = await window.electronAPI.fileBrowser.readCached({ cachePath: fetched.cachePath });
          if (cancelled) return;
          if (read.ok && read.kind === 'text') {
            // stale 兜底副本 size 未知(-1):以内容长度近似,只影响工具栏展示。
            const size = fetched.size >= 0 ? fetched.size : read.content.length;
            setLoadState({ phase: 'ready', content: read.content, size });
            return;
          }
          setLoadState({
            phase: 'error',
            message: read.ok ? t('chat.textLightbox.unreadable') : read.message,
          });
          return;
        }
        const res = await window.electronAPI.readTextFilePreview({ filePath });
        if (cancelled) return;
        if (res.success && typeof res.data === 'string') {
          setLoadState({ phase: 'ready', content: res.data, size: res.size });
          return;
        }
        if (res.reason === 'oversize') {
          setLoadState({
            phase: 'oversize',
            size: res.size,
            limitMb: res.limitMb ?? OVERSIZE_LIMIT_MB,
          });
          return;
        }
        setLoadState({
          phase: 'error',
          message: res.error || t('chat.textLightbox.unreadable'),
        });
      } catch (err) {
        if (cancelled) return;
        setLoadState({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, remoteOrigin, sessionFileCtx.workingDir, t]);

  // 远程取回进度:大文件首拉可能秒级到分钟级,spinner 区显示百分比。
  useEffect(() => {
    if (!remoteOrigin || contentReady) return;
    const off = window.electronAPI.fileBrowser.onTransferProgress((e) => {
      if (e.relPath === filePath) setFetchProgress({ received: e.received, total: e.total });
    });
    return off;
  }, [remoteOrigin, contentReady, filePath]);


  useEffect(() => {
    if (!contentReady || loadState.phase !== 'ready') return;
    if (initialLine == null || !Number.isFinite(initialLine) || initialLine <= 0) return;

    const line = Math.floor(initialLine);
    const scrollKey = `${filePath}:${line}:${renderable.kind}`;
    if (initialLineScrollKeyRef.current === scrollKey) return;
    initialLineScrollKeyRef.current = scrollKey;

    if (renderable.kind !== 'markdown') {
      const raf = requestAnimationFrame(() => {
        editorRef.current?.scrollToLine(line);
      });
      return () => cancelAnimationFrame(raf);
    }

    const raf = requestAnimationFrame(() => {
      const scroller = bodyScrollRef.current;
      if (!scroller) return;

      const entries = Array.from(
        scroller.querySelectorAll<HTMLElement>('[data-source-line]'),
      ).map((el) => ({ el, line: Number(el.getAttribute('data-source-line')) }));
      const target = pickSourceLineAnchor(entries, line)?.el;
      if (target) {
        const targetRect = target.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        scroller.scrollTop = targetRect.top - scrollerRect.top + scroller.scrollTop;
      }
    });

    return () => cancelAnimationFrame(raf);
  }, [contentReady, filePath, initialLine, loadState.phase, renderable.kind]);

  // F3 toolbar：点击文件名复制完整路径；F4：点击右侧 Copy 复制全文。
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(filePath);
      toast.success(t('chat.lightbox.pathCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  async function copyContent() {
    if (loadState.phase !== 'ready') return;
    try {
      await navigator.clipboard.writeText(loadState.content);
      toast.success(t('chat.lightbox.contentCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  // 远程会话:系统打开 / 目录定位一律对**本地缓存副本**进行(远端路径在本机
  // 无意义,直呼 openPath 是误开本机同路径文件的隐患);copyPath 仍复制远端
  // 原始路径(用户要的是"这个文件在远端哪里")。
  async function openInSystem() {
    const target = remoteOrigin ? remoteCopy?.cachePath : filePath;
    if (!target) return;
    const res = await window.electronAPI.openPath(target);
    if (!res.success) {
      toast.error(res.error || t('chat.textLightbox.openSystemFailed'));
    }
  }

  async function showInFolder() {
    const target = remoteOrigin ? remoteCopy?.cachePath : filePath;
    if (!target) return;
    const res = await window.electronAPI.showItemInFolder({ filePath: target });
    if (!res.success) {
      toast.error(res.error || t('chat.textLightbox.openSystemFailed'));
    }
  }

  // Determine displayed size for toolbar — prefer the latest known size.
  // During the Loading phase we render an em-dash ("—") as a stable
  // placeholder so the Toolbar size slot doesn't shift width when the read
  // resolves. Matches design node `PSTiX` in the Loading frame.
  const displaySize =
    loadState.phase === 'ready' || loadState.phase === 'oversize'
      ? formatBytes(loadState.size)
      : loadState.phase === 'loading'
        ? '—'
        : null;

  const showOversize = loadState.phase === 'oversize';
  const oversizeSizeText = showOversize ? formatBytes(loadState.size) : '';
  const oversizeLimitMb = showOversize ? loadState.limitMb : OVERSIZE_LIMIT_MB;

  const overlay = (
    <div
      data-text-lightbox-overlay
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: TEXT_LIGHTBOX_OVERLAY_Z_INDEX,
        background: 'var(--overlay-lightbox)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        cursor: 'default',
      }}
    >
      <button
        type="button"
        aria-label={t('chat.lightbox.close')}
        style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
        onClick={handleClose}
      />
      {/* F3: Doc Card — clicks inside MUST NOT close (per F6 异常流). */}
      <div
        data-text-lightbox-card
        className={cn(
          'cursor-auto flex flex-col overflow-hidden rounded-[12px]',
          'border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
        )}
        style={{
          width: '80vw',
          height: '80vh',
          maxWidth: '1600px',
          maxHeight: '1200px',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Toolbar — file-text · name · · · size · open · copy */}
        <div
          className={cn(
            'flex items-center justify-between',
            'h-14 shrink-0 px-5',
            'border-b border-[var(--msg-tool-card-border)]',
          )}
        >
          {/* Left — clicking filename copies the FULL path (F3 toolbar 三段). */}
          {/* v5: 原生 title 替换为 Radix Tooltip(默认 sans) — 短文案提示。 */}
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                type="button"
                onClick={copyPath}
                className={cn(
                  'flex items-center gap-2 min-w-0',
                  'rounded-[6px] px-1 -mx-1 py-0.5',
                  'hover:bg-[var(--msg-code-inline-bg)] transition-colors',
                  'text-left cursor-pointer',
                )}
              >
                <FileText size={16} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
                <span
                  className={cn(
                    'font-semibold text-14',
                    'text-[var(--msg-tool-card-text)]',
                    'truncate',
                  )}
                >
                  {displayName}
                </span>
                {displaySize && (
                  <>
                    <span className="shrink-0 text-14 text-[var(--cmd-palette-item-meta)]">·</span>
                    <span className="shrink-0 text-12 text-[var(--msg-tool-card-chevron)]">
                      {displaySize}
                    </span>
                  </>
                )}
                {remoteCopy?.stale && (
                  // 断线兜底的历史副本:提示内容可能不是远端最新版本。
                  <span
                    className={cn(
                      'shrink-0 rounded-[4px] border border-[var(--msg-tool-card-border)]',
                      'px-1.5 py-[1px] text-11 text-[var(--msg-tool-card-chevron)]',
                    )}
                  >
                    {t('chat.remoteFile.staleBadge')}
                  </span>
                )}
              </button>
            </Tooltip.Trigger>
            <Tooltip.Content style={TEXT_LIGHTBOX_TOOLTIP_STYLE}>
              {t('chat.lightbox.clickToCopyPath')}
            </Tooltip.Content>
          </Tooltip.Root>

          {/* Right — Show in folder + Copy content + Close (Open in System moved to Oversize CTA only). */}
          {/* v5: 原生 title 替换为 Radix Tooltip(默认 sans) — 短文案提示。 */}
          <div className="flex items-center gap-1">
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={showInFolder}
                  disabled={!localActionsReady}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-[6px]',
                    'transition-colors',
                    localActionsReady
                      ? 'hover:bg-[var(--msg-code-inline-bg)] cursor-pointer'
                      : 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Folder size={18} className="text-[var(--msg-tool-card-chevron)]" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content style={TEXT_LIGHTBOX_TOOLTIP_STYLE}>
                {remoteOrigin ? t('chat.remoteFile.revealLocalCopy') : t('chat.lightbox.openInExplorer')}
              </Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={copyContent}
                  disabled={loadState.phase !== 'ready'}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-[6px]',
                    'transition-colors cursor-pointer',
                    loadState.phase === 'ready'
                      ? 'hover:bg-[var(--msg-code-inline-bg)]'
                      : 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Copy size={18} className="text-[var(--msg-tool-card-chevron)]" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content style={TEXT_LIGHTBOX_TOOLTIP_STYLE}>
                {t('chat.textLightbox.copyAll')}
              </Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={handleClose}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-[6px]',
                    'hover:bg-[var(--msg-code-inline-bg)] transition-colors',
                    'cursor-pointer',
                  )}
                >
                  <X size={20} className="text-[var(--msg-tool-card-chevron)]" />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content style={TEXT_LIGHTBOX_TOOLTIP_STYLE}>
                {t('chat.lightbox.close')}
              </Tooltip.Content>
            </Tooltip.Root>
          </div>
        </div>

        {/* Body */}
        {!contentReady &&
          (showSpinner ? (
            // 1 秒宽限期后再显示 spinner：快速打开保持即时感，慢加载仍能反馈进度。
            <div
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-3',
                'text-13 text-[var(--msg-tool-card-chevron)]',
              )}
            >
              <Spinner size={32} className="text-[var(--msg-tool-card-chevron)]" />
              <div>
                {remoteOrigin ? t('chat.remoteFile.fetching') : t('chat.textLightbox.loading')}
                {remoteOrigin && fetchProgress && fetchProgress.total > 0
                  ? ` ${Math.min(100, Math.round((fetchProgress.received / fetchProgress.total) * 100))}%`
                  : null}
              </div>
            </div>
          ) : (
            // Grace period — card is open but body is empty; keeps the
            // toolbar visible so the user knows the window responded.
            <div className="flex-1" />
          ))}

        {loadState.phase === 'error' && (
          <div
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-3 p-6',
              'text-center',
            )}
          >
            <TriangleAlert size={32} className="text-[var(--msg-tool-card-chevron)]" />
            <div className="text-14 font-semibold text-[var(--msg-tool-card-text)]">
              {t('chat.textLightbox.cannotRead')}
            </div>
            <div className="text-13 text-[var(--msg-tool-card-chevron)]">
              {loadState.message}
            </div>
          </div>
        )}

        {showOversize && (
          // F5: 超限状态包含警告图标、标题、动态容量说明和单个 CTA。
          // 文案统一走 i18n，CTA 继续使用 --lightbox-cta-* token，确保各主题对比度稳定。
          <div
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-4 p-6',
              'text-center',
            )}
          >
            <TriangleAlert size={40} className="text-[var(--msg-tool-card-chevron)]" />
            <div className="text-16 font-semibold text-[var(--msg-tool-card-text)]">
              {t('chat.textLightbox.oversizeTitle')}
            </div>
            <div
              className="text-13 leading-[1.6] text-[var(--msg-tool-card-chevron)]"
              style={{ maxWidth: 480 }}
            >
              {t('chat.textLightbox.oversizeBody', { size: oversizeSizeText, limit: oversizeLimitMb })}
            </div>
            <button
              type="button"
              onClick={openInSystem}
              disabled={!localActionsReady}
              className={cn(
                'mt-2 inline-flex items-center gap-2 rounded-[9999px]',
                'bg-[var(--lightbox-cta-bg)] px-5 py-[10px]',
                'text-14 font-medium text-[var(--lightbox-cta-fg)]',
                'transition-colors',
                localActionsReady
                  ? 'hover:bg-[var(--lightbox-cta-hover)] cursor-pointer'
                  : 'opacity-40 cursor-not-allowed',
              )}
            >
              <ExternalLink size={14} />
              {t('chat.textLightbox.openInSystem')}
            </button>
          </div>
        )}

        {contentReady &&
          loadState.phase === 'ready' &&
          (renderable.kind === 'text' || renderable.kind === 'code') && (
            <PlaintextEditor
              key={filePath}
              ref={editorRef}
              readOnly
              initialValue={loadState.content}
              language={renderable.kind === 'code' ? renderable.lang : undefined}
              className="min-h-0 flex-1 text-[var(--msg-tool-card-text)]"
            />
          )}

        {contentReady &&
          loadState.phase === 'ready' &&
          renderable.kind === 'markdown' && (
            // Markdown body — same MarkdownRenderer used by chat bubbles, so the
            // visual (headings, tables, fenced code, GFM checklists) stays in
            // lockstep. Wrapper owns scroll + padding because MarkdownRenderer
            // emits flow content with its own margins.
            <div
              ref={bodyScrollRef}
              className={cn(
                'flex-1 overflow-y-auto overflow-x-hidden',
                'text-14 leading-[1.6]',
                'text-[var(--msg-tool-card-text)]',
                'select-text',
                // 文稿弹窗是阅读视图,代码块横向滚动条不利于阅读 —
                // 覆写 MarkdownRenderer 默认的 overflow-x-auto,改为软换行。
                // 仅作用于本弹窗作用域,聊天气泡仍保持原行为。
                '[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:overflow-x-visible',
                // 两侧 gutter 常驻,避免滚动条出现时 mx-auto 居中相对
                // "扣掉滚动条后的可用宽度"导致整列偏左。
                '[scrollbar-gutter:stable_both-edges]',
              )}
            >
              <div className="mx-auto max-w-5xl px-6 py-5">
                <MarkdownRenderer
                  workingDir={fileParentDir}
                  content={loadState.content}
                  emitSourceLines={initialLine != null}
                />
              </div>
            </div>
          )}

      </div>

      {/* F6 提示 footer：位于 backdrop 上，不压到卡片内部。 */}
      <div
        className="mt-5 flex items-center gap-2 select-none"
        style={{ position: 'relative', zIndex: 1 }}
      >
        <span
          className={cn(
            'rounded-[4px] border px-1.5 py-[2px]',
            'text-11 font-medium',
            'text-white/60 border-white/40',
          )}
        >
          Esc
        </span>
        <span className="text-12 text-white/40">{t('chat.textLightbox.closeHint')}</span>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}

export const __test_internals = {
  OVERSIZE_LIMIT,
  OVERSIZE_LIMIT_MB,
};
