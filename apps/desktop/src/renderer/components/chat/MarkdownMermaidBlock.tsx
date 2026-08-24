/**
 * MarkdownMermaidBlock
 * ---------------------------------------------------------------------------
 * Renders a markdown ```mermaid fenced code block as an SVG diagram.
 *
 * Hooks into the same `pre` interceptor as MarkdownDiffBlock — see
 * MarkdownRenderer.tsx for the dispatch.
 *
 * Streaming: each render attempt is independent. Partial mermaid source
 * fails parse silently and falls back to source view. When syntax becomes
 * valid the next attempt swaps to SVG. No flash, no toast spam.
 *
 * Auto-repair: when the raw source fails parse, we retry once with the
 * deterministic fixes from `repairMermaidSource` (maker-shared) — common LLM
 * slips like unquoted labels / unicode arrows / `subgraph Id[` missing space.
 * Copy & view-source keep showing the ORIGINAL source; only the rendered SVG
 * comes from the repaired variant. Streaming-partial sources fail both parses
 * and fall through to the same source-view path as before.
 *
 * Theme: re-renders when <html class="dark"> toggles, via MutationObserver.
 */

import { memo, useEffect, useId, useRef, useState } from 'react';
import { Check, Code2, Copy, Expand, Eye, Pen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { repairMermaidSource } from '@cindy/maker-shared/mermaid-autofix';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { resolveExportBackground, svgToPngBlob } from '@/lib/rasterizeToImage';
import { MermaidLightbox } from './MermaidLightbox';
import { useCopyAsImage } from './useCopyAsImage';

interface MarkdownMermaidBlockProps {
  raw: string;
}

type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((mod) => mod.default);
  return mermaidPromise;
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export const MarkdownMermaidBlock = memo(function MarkdownMermaidBlock({
  raw,
}: MarkdownMermaidBlockProps) {
  const { t } = useTranslation();
  const reactId = useId();
  // mermaid.render requires DOM-safe ids — useId() yields ":r3:" which mermaid
  // chokes on. Strip non-alphanumerics.
  const renderId = `mmd-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [dark, setDark] = useState<boolean>(isDarkMode);
  const [copied, setCopied] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);

  // 复制为图片 / 标注:光栅化用 state 里的 SVG 字符串(与显示一致),实底色
  // 取块容器的主题底色;plainText 附带 mermaid 原始源码(粘贴到编辑器时可用)。
  // ref 避免 getPayload 闭包过期。
  const svgRef = useRef<string | null>(null);
  svgRef.current = svg;
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const { copiedImage, copyAsImage, canAnnotate, openAnnotate, annotateNode } =
    useCopyAsImage(async () => {
      const current = svgRef.current;
      if (!current) throw new Error('no svg rendered');
      const blob = await svgToPngBlob(current, {
        background: resolveExportBackground(blockRef.current),
      });
      return { blob, plainText: rawRef.current };
    });

  // Re-render when <html class="dark"> toggles. Module-level MutationObserver
  // would be cheaper but the cost here is negligible (1 observer per visible
  // mermaid block), and per-instance cleanup is simpler.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = isDarkMode();
      setDark((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const trimmed = raw.trim();
    if (!trimmed) {
      setSvg(null);
      setError(null);
      return;
    }

    loadMermaid()
      .then(async (mermaid) => {
        if (cancelled) return;
        // Re-init theme on every render — cheap, keeps dark/light flip clean.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          fontFamily: 'inherit',
          theme: dark ? 'dark' : 'default',
          // useMaxWidth=true (default) makes mermaid stamp width="100%" on the
          // SVG, so a small 400x600 diagram gets stretched to container width
          // and the height blows up proportionally — forcing the user to scroll.
          // Disable it so SVGs render at their intrinsic size; CSS below caps
          // both axes for the rare oversized diagram, and lightbox handles
          // fine-grained zoom.
          flowchart: { useMaxWidth: false },
          sequence: { useMaxWidth: false },
          class: { useMaxWidth: false },
          state: { useMaxWidth: false },
          er: { useMaxWidth: false },
          gantt: { useMaxWidth: false },
          journey: { useMaxWidth: false },
          pie: { useMaxWidth: false },
        });
        try {
          // parse() throws on invalid syntax — gives us a clean fallback path
          // before the heavier render() call.
          await mermaid.parse(trimmed);
          const { svg: rendered } = await mermaid.render(renderId, trimmed);
          if (cancelled) return;
          setSvg(rendered);
          setError(null);
        } catch (err) {
          // Deterministic auto-repair retry: only ever runs on sources that
          // already failed parse, so a valid diagram is never rewritten. The
          // repair itself is cheap string work; the extra parse only happens
          // when the repair actually changed something.
          const repaired = repairMermaidSource(trimmed);
          if (repaired !== trimmed) {
            try {
              await mermaid.parse(repaired);
              const { svg: rendered } = await mermaid.render(renderId, repaired);
              if (cancelled) return;
              setSvg(rendered);
              setError(null);
              return;
            } catch {
              // Repair didn't help — fall through to the original error path.
            }
          }
          if (cancelled) return;
          // Streaming case: source not yet complete. Don't toast; just hold
          // the previous SVG (if any) and let the next attempt try again.
          // Permanent failure: surface the message.
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [raw, dark, renderId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // SVG 未渲染(流式中 / 渲染失败)时的复制兜底:只复制源码文本。
  // 有 SVG 时统一走 copyAsImage(PNG + 源码双格式)。
  async function handleCopySourceOnly() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  // Source-only view: explicitly toggled, OR no SVG ever rendered AND we have
  // a hard error (not just streaming-partial).
  const showSourceView = showSource || (svg == null && error != null);

  return (
    <div ref={blockRef} className="group relative my-3 flex flex-col">
      {showSourceView ? (
        <pre
          className={cn(
            '-mt-9 overflow-x-auto rounded-[12px]',
            'border border-[var(--msg-code-block-border)]',
            'bg-[var(--msg-code-block-bg)]',
            'p-4 font-mono text-[length:var(--app-code-font-size)] leading-[1.5]',
            'select-text',
          )}
        >
          <code className="language-mermaid">{raw}</code>
        </pre>
      ) : svg != null ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => setLightboxOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setLightboxOpen(true);
            }
          }}
          aria-label={t('chat.mermaid.clickToZoom')}
          title={t('chat.mermaid.clickToZoom')}
          className={cn(
            '-mt-9 overflow-x-auto rounded-[12px]',
            'border border-[var(--msg-code-block-border)]',
            'bg-[var(--msg-code-block-bg)]',
            'p-4 flex justify-center cursor-zoom-in',
            // With mermaid's useMaxWidth disabled, SVG carries its intrinsic
            // width/height. Cap both axes so an oversized diagram shrinks to
            // fit (preserving aspect ratio via the SVG's viewBox) without
            // dominating the viewport — fine detail lives in the lightbox.
            '[&>svg]:!max-w-full [&>svg]:!max-h-[60vh] [&>svg]:!h-auto [&>svg]:!w-auto',
          )}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        // Initial load (mermaid chunk in flight) — show a quiet placeholder
        // matching the code-block frame so layout doesn't jump.
        <pre
          className={cn(
            '-mt-9 overflow-x-auto rounded-[12px]',
            'border border-[var(--msg-code-block-border)]',
            'bg-[var(--msg-code-block-bg)]',
            'p-4 font-mono text-[length:var(--app-code-font-size)] leading-[1.5]',
            'select-text opacity-60',
          )}
        >
          <code className="language-mermaid">{raw}</code>
        </pre>
      )}

      {error != null && svg == null ? (
        <div
          className={cn(
            'mt-1 px-3 py-1 text-12',
            'text-[var(--msg-blockquote-text)]',
          )}
          title={error}
        >
          {t('chat.mermaid.renderFailed')}
        </div>
      ) : null}

      <div
        className={cn(
          'pointer-events-none order-first sticky top-0 z-10 flex h-9 items-end justify-end gap-1 pr-2 select-none',
          'opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        {svg != null && !showSourceView ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxOpen(true);
            }}
            aria-label={t('chat.mermaid.zoom')}
            title={t('chat.mermaid.zoom')}
            className={cn(
              'pointer-events-auto inline-flex h-7 w-7 items-center justify-center',
              'rounded-md border border-[var(--msg-code-block-border)]',
              'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
              'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
            )}
          >
            <Expand className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {svg != null && !showSourceView && canAnnotate ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openAnnotate();
            }}
            aria-label={t('chat.mermaid.annotate')}
            title={t('chat.mermaid.annotate')}
            className={cn(
              'pointer-events-auto inline-flex h-7 w-7 items-center justify-center',
              'rounded-md border border-[var(--msg-code-block-border)]',
              'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
              'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
            )}
          >
            <Pen className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {svg != null ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowSource((v) => !v);
            }}
            aria-label={showSourceView ? t('chat.mermaid.viewDiagram') : t('chat.mermaid.viewSource')}
            title={showSourceView ? t('chat.mermaid.viewDiagram') : t('chat.mermaid.viewSource')}
            className={cn(
              'pointer-events-auto inline-flex h-7 w-7 items-center justify-center',
              'rounded-md border border-[var(--msg-code-block-border)]',
              'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
              'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
            )}
          >
            {showSourceView ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          </button>
        ) : null}
        {/* 单一复制按钮:有 SVG 时写入 PNG + 源码双格式(粘贴目标自选),
            SVG 未渲染时退化为只复制源码。 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (svg != null) copyAsImage();
            else void handleCopySourceOnly();
          }}
          aria-label={copied || copiedImage ? t('chat.mermaid.copied') : t('chat.mermaid.copy')}
          title={copied || copiedImage ? t('chat.mermaid.copied') : t('chat.mermaid.copy')}
          className={cn(
            'pointer-events-auto inline-flex h-7 w-7 items-center justify-center',
            'rounded-md border border-[var(--msg-code-block-border)]',
            'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
            'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
          )}
        >
          {copied || copiedImage ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {lightboxOpen && svg != null ? (
        <MermaidLightbox
          svg={svg}
          source={raw}
          onAnnotate={
            canAnnotate
              ? () => {
                  // 先关矢量预览再开 ImageLightbox 标注层,避免两层全屏叠加
                  // (Esc/滚轮手势互抢);annotateNode 挂在本组件,不受影响。
                  setLightboxOpen(false);
                  openAnnotate();
                }
              : undefined
          }
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
      {annotateNode}
    </div>
  );
});
