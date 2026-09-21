/**
 * PdfPreview — 在 FileBodyView 里用 pdf.js 渲染 .pdf 文件。
 *
 * 资源:
 *   - worker 通过 ?url import,Vite 在 dev / build 都会发出可访问 URL。
 *   - cmaps / standard_fonts 在 vite.renderer.config.ts 的 pdfjsAssetsPlugin
 *     里挂在 /pdfjs/ 下(同源 `self`,CSP connect-src 已覆盖)。CJK PDF 没
 *     cmaps 会显示成方块。
 *   - PDF 字节:经 `readFileBytes` IPC 以 Uint8Array 读入(可结构化克隆,
 *     无 base64 中转),喂给 pdf.js `getDocument({ data })`。**不走**
 *     `getDocument({ url })` 直接 fetch xdt-file://——那会要求把 xdt-file:
 *     放进 CSP connect-src。xdt-file:// 本身受扩展名白名单 + 敏感目录黑名单
 *     约束(见 localFileProtocol.ts),并非任意文件;但放进 connect-src 会让
 *     整个渲染进程脚本可 fetch 这些白名单媒体的字节(超出 PDF 预览所需)。
 *     改走 IPC 后:不进 renderer 的 fetch 面、按发送方可信校验 + 与用户附件
 *     同一套 main 侧路径策略、硬上限 30MB;失败以 IpcError 抛出 → 占位卡。
 *
 * 视觉:
 *   - 容器灰底跟仓库其它预览容器对齐 (#f5f5f5 / #2c2c2a)。
 *   - 每页画在独立 <canvas> 里,白底 (无论 light/dark theme),模拟实体纸。
 *     **不要**在容器上加 filter: invert — 会把页面里的图片也反色。
 *   - 加载失败 / 不是合法 PDF → 退回 UnrenderablePlaceholder。
 *
 * 性能:
 *   - 只给滚动容器当前可见(加一小段预取窗口)的页面创建并渲染 canvas。
 *   - 页面离开窗口时取消仍在运行的 RenderTask,并清空已完成的 canvas,避免
 *     长 PDF 把所有页面的位图一直留在 renderer 内存中。
 *   - canvas 的 backing-store DPR 有上限且受单页像素预算约束;CSS 纸张尺寸
 *     不变,因此高 DPI 与超大页面都不会把内存放大到不可控。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { createLogger } from '@/lib/logger';

import { UnrenderablePlaceholder } from './UnrenderablePlaceholder';
import { joinPath } from './lib/fileMeta';

const log = createLogger('PdfPreview');

// worker 只需要配一次。pdfjs.GlobalWorkerOptions 是模块级单例,多次赋值无害。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** 保持现有阅读尺寸:1.5 在 100% zoom 下接近常见 PDF 阅读器默认缩放。 */
export const PDF_PREVIEW_SCALE = 1.5;
/** 高 DPI 屏幕最多保留 2x backing store,避免无界放大位图。 */
export const PDF_PREVIEW_MAX_DPR = 2;
/**
 * 单页 canvas 的最大像素数(宽×高)。4M 像素约 16MB RGBA,而 rootMargin
 * 只会让少量邻近页面同时 rasterize;超大页面会按同一预算自动降采样。
 */
export const PDF_PREVIEW_MAX_CANVAS_PIXELS = 4_000_000;
/** 没有得到页面尺寸前的 A4-ish 占位,让滚动条先有稳定的可用高度。 */
const PDF_PAGE_PLACEHOLDER_WIDTH = 918;
const PDF_PAGE_PLACEHOLDER_HEIGHT = 1188;
/** 离视口 400px 预取,滚动到下一页时不需要等到完全进入才开始绘制。 */
const PDF_PAGE_ROOT_MARGIN = '400px 0px 400px 0px';

export interface PdfPreviewProps {
  workdir: string;
  /** workdir-relative POSIX path */
  relPath: string;
  size: number;
  mtimeMs: number;
}

type RenderState =
  | { kind: 'loading' }
  | { kind: 'rendered'; pageCount: number }
  | { kind: 'error'; message: string };

type PageRenderState = 'idle' | 'rendering' | 'rendered';

/** RenderTask 的最小结构,避免把 pdf.js 的构建类型泄漏到组件状态。 */
type ActiveRenderTask = {
  cancel: () => void;
  promise: Promise<unknown>;
};

/**
 * 计算 canvas backing-store 的像素倍率。
 *
 * CSS viewport 保持原来的 1.5 scale;只有真实像素倍率会因 DPR / budget
 * 降低。允许结果小于 1 是有意的:超大纸张必须硬守像素预算,不能以一次渲染
 * 分配数十或数百 MB 的 RGBA buffer。
 */
export function getPdfRenderPixelRatio(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const dpr = Math.min(safeDpr, PDF_PREVIEW_MAX_DPR);
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  // Divide separately to avoid overflowing the area of very large viewports.
  const budgetRatio = Math.sqrt(PDF_PREVIEW_MAX_CANVAS_PIXELS) / Math.sqrt(width) / Math.sqrt(height);
  // The canvas allocation rounds each side up to at least one pixel. For a
  // very thin page, area alone would then allow its long side to exceed 4M.
  const minSideBudgetRatio = PDF_PREVIEW_MAX_CANVAS_PIXELS / Math.max(width, height);
  // Extremely large finite viewports may need ratios below Number.EPSILON.
  return Math.min(dpr, budgetRatio, minSideBudgetRatio);
}

function cancelRenderTask(task: ActiveRenderTask | null) {
  if (!task) return;
  try {
    task.cancel();
  } catch {
    // pdf.js cancellation is best-effort and can race document destruction.
  }
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  // Resizing to 0 releases the backing store immediately in Chromium. The
  // element itself stays mounted so a subsequent intersection can reuse it.
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.width = '0px';
  canvas.style.height = '0px';
}

interface PdfPageProps {
  pdf: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  isVisible: boolean;
  onError: (pageNumber: number, error: unknown) => void;
}

function PdfPage({ pdf, pageNumber, isVisible, onError }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<ActiveRenderTask | null>(null);
  const [renderState, setRenderState] = useState<PageRenderState>('idle');
  const [pageSize, setPageSize] = useState({
    width: PDF_PAGE_PLACEHOLDER_WIDTH,
    height: PDF_PAGE_PLACEHOLDER_HEIGHT,
  });

  useEffect(() => {
    if (isVisible) return;

    // A completed page is also cleared when it leaves the prefetch window.
    // Keeping only nearby pages makes long documents bounded by the viewport
    // rather than by total page count.
    cancelRenderTask(renderTaskRef.current);
    renderTaskRef.current = null;
    clearCanvas(canvasRef.current);
    setRenderState((current) => (current === 'idle' ? current : 'idle'));
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let activeTask: ActiveRenderTask | null = null;

    setRenderState('rendering');
    void (async () => {
      try {
        // getPage is deliberately inside the visibility gate. A PDF with many
        // pages only asks pdf.js for page resources as the user approaches them.
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const viewport = page.getViewport({ scale: PDF_PREVIEW_SCALE });
        setPageSize({ width: viewport.width, height: viewport.height });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        const pixelRatio = getPdfRenderPixelRatio(
          viewport.width,
          viewport.height,
          window.devicePixelRatio || 1,
        );
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const task = page.render({
          canvas,
          viewport,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
        });
        activeTask = task;
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled || renderTaskRef.current !== task) return;
        renderTaskRef.current = null;
        setRenderState('rendered');
      } catch (error) {
        // Leaving the viewport intentionally rejects RenderTask.promise with
        // RenderingCancelledException. It is not a failed PDF and must not
        // replace the whole preview with an error placeholder.
        if (
          cancelled ||
          (error &&
            typeof error === 'object' &&
            'name' in error &&
            error.name === 'RenderingCancelledException')
        ) {
          if (renderTaskRef.current === activeTask) renderTaskRef.current = null;
          if (!cancelled) setRenderState('idle');
          return;
        }
        renderTaskRef.current = null;
        setRenderState('idle');
        onError(pageNumber, error);
      }
    })();

    return () => {
      cancelled = true;
      cancelRenderTask(activeTask ?? renderTaskRef.current);
      if (renderTaskRef.current === activeTask) renderTaskRef.current = null;
    };
  }, [isVisible, onError, pageNumber, pdf]);

  return (
    <div
      data-pdf-page={pageNumber}
      data-pdf-page-placeholder={renderState !== 'rendered' ? 'true' : undefined}
      aria-busy={renderState !== 'rendered'}
      className="relative mb-2 shrink-0 overflow-hidden rounded-sm bg-white shadow-sm last:mb-0"
      style={{
        width: `${Math.floor(pageSize.width)}px`,
        height: `${Math.floor(pageSize.height)}px`,
      }}
    >
      {(isVisible || renderState !== 'idle') && (
        <canvas
          ref={canvasRef}
          width={0}
          height={0}
          aria-hidden={renderState !== 'rendered'}
          className="block bg-white"
          style={{
            display: renderState === 'rendered' ? 'block' : 'none',
            width: renderState === 'rendered' ? `${Math.floor(pageSize.width)}px` : '0px',
            height: renderState === 'rendered' ? `${Math.floor(pageSize.height)}px` : '0px',
          }}
        />
      )}
      {renderState !== 'rendered' && (
        <div
          className="absolute inset-0 border border-[var(--border-default)] bg-white"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function PdfPreview({ workdir, relPath, size, mtimeMs }: PdfPreviewProps) {
  const { t } = useTranslation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pagesHostRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(() => new Set());
  const documentVersionRef = useRef(0);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [state, setState] = useState<RenderState>({ kind: 'loading' });
  const handlePageError = useCallback(
    (pageNumber: number, error: unknown) => {
      log.warn('pdf page render failed', {
        relPath,
        pageNumber,
        error: String(error),
      });
      setState({ kind: 'error', message: String(error) });
    },
    [relPath],
  );

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    let loadedPdf: pdfjs.PDFDocumentProxy | null = null;
    const nextDocumentVersion = documentVersionRef.current + 1;
    documentVersionRef.current = nextDocumentVersion;
    setDocumentVersion(nextDocumentVersion);
    setPdfDoc(null);
    setPageCount(0);
    setVisiblePages(new Set());
    setState({ kind: 'loading' });

    const absPath = joinPath(workdir, relPath);

    (async () => {
      try {
        // 读字节走 main 侧受策略约束的 IPC(可信发送方校验、拒敏感路径、
        // 硬上限 30MB),以 Uint8Array 直接交给 pdf.js —— 不用 getDocument({
        // url }) 让渲染进程 fetch xdt-file://(那需要放开 CSP connect-src)。
        // 越权 / 超上限 / 读失败时 IPC 以 IpcError reject,由下方 catch 落
        // 占位卡。详见文件头注释。
        const { bytes } = await window.electronAPI.readFileBytes({ filePath: absPath });
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({
          data: bytes,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
        });
        const pdf = await loadingTask.promise;
        loadedPdf = pdf;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        setPdfDoc(pdf);
        setPageCount(pdf.numPages);
        setState({ kind: 'rendered', pageCount: pdf.numPages });
      } catch (err) {
        if (cancelled) return;
        log.warn('pdf render failed', { relPath, error: String(err) });
        setPdfDoc(null);
        setPageCount(0);
        setState({ kind: 'error', message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
      // destroy 两者:loadingTask 中止未完成的加载;pdfDoc 释放已解析文档的
      // worker / 渲染资源(promise resolve 后仅 destroy loadingTask 不够,
      // 中途导航离开会泄漏文档)。destroy 幂等,两者都调是安全的。
      void loadingTask?.destroy();
      void loadedPdf?.destroy();
    };
    // size/mtimeMs 进依赖:同一路径的文件被就地改写(agent 重生成 PDF 等)时
    // relPath 不变但 mtimeMs/size 变,需要重新读字节 + 重渲染,否则预览会停在
    // 旧内容直到用户切走再切回。FileBodyView 正是为此把 size/mtimeMs 传进来。
  }, [workdir, relPath, size, mtimeMs]);

  useEffect(() => {
    const host = pagesHostRef.current;
    if (state.kind !== 'rendered' || !pdfDoc || pageCount === 0 || !host) {
      setVisiblePages(new Set());
      return;
    }

    // Electron supports IntersectionObserver, but keep the preview usable in
    // test shells and older embedded runtimes that do not provide it. With no
    // observer there is no reliable scroll signal, so render the first page
    // only instead of eagerly rasterizing an entire long document.
    if (typeof IntersectionObserver === 'undefined') {
      setVisiblePages(new Set([1]));
      return;
    }

    let disposed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        // disconnect() cannot retract a callback that the browser already
        // queued. Ignore it after cleanup so an old document cannot mark a
        // same-numbered page in the replacement document visible.
        if (disposed) return;
        setVisiblePages((current) => {
          const next = new Set(current);
          let changed = false;
          for (const entry of entries) {
            const pageNumber = Number((entry.target as HTMLElement).dataset.pdfPage);
            if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
            if (entry.isIntersecting) {
              if (!next.has(pageNumber)) {
                next.add(pageNumber);
                changed = true;
              }
            } else if (next.delete(pageNumber)) {
              changed = true;
            }
          }
          return changed ? next : current;
        });
      },
      {
        root: scrollContainerRef.current,
        rootMargin: PDF_PAGE_ROOT_MARGIN,
        // A huge page may never expose 1% of its area, even while filling the
        // viewport. Observe any intersection, including after its placeholder
        // expands to the real page size, so it cannot remain blank on screen.
        threshold: 0,
      },
    );
    host.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((page) => observer.observe(page));
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [pageCount, pdfDoc, state.kind]);

  useEffect(() => {
    if (state.kind !== 'error' || !pdfDoc) return;

    // The error branch unmounts PdfPage first, cancelling sibling RenderTasks.
    // Release the parsed document as well instead of retaining its worker-side
    // resources for as long as the fallback card remains open. The loading
    // effect may destroy the same proxy again on prop change/unmount; pdf.js
    // destroy is idempotent.
    setPdfDoc(null);
    setPageCount(0);
    setVisiblePages(new Set());
    void pdfDoc.destroy();
  }, [pdfDoc, state.kind]);

  if (state.kind === 'error') {
    return (
      <UnrenderablePlaceholder workdir={workdir} relPath={relPath} size={size} mtimeMs={mtimeMs} />
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="relative h-full w-full overflow-y-auto bg-[var(--surface)]"
    >
      {/* Align pages to a shared left edge: a wide page must not push narrower
          placeholders outside the observer's horizontal viewport. */}
      <div ref={pagesHostRef} className="mx-auto flex w-fit flex-col items-start gap-2 px-4 py-6">
        {pdfDoc &&
          Array.from({ length: pageCount }, (_, index) => (
            <PdfPage
              key={`${documentVersion}-${index + 1}`}
              pdf={pdfDoc}
              pageNumber={index + 1}
              isVisible={visiblePages.has(index + 1)}
              onError={handlePageError}
            />
          ))}
        {state.kind === 'loading' && (
          <div className="py-3 text-xs text-[var(--cmd-palette-item-meta)]">
            {t('ccAgent.workdirBrowse.fileBody.pdfLoading', {
              defaultValue: '正在渲染 PDF…',
            })}
          </div>
        )}
      </div>
    </div>
  );
}
