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
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { createLogger } from '@/lib/logger';

import { UnrenderablePlaceholder } from './UnrenderablePlaceholder';
import { joinPath } from './lib/fileMeta';

const log = createLogger('PdfPreview');

// worker 只需要配一次。pdfjs.GlobalWorkerOptions 是模块级单例,多次赋值无害。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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

export function PdfPreview({ workdir, relPath, size, mtimeMs }: PdfPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<RenderState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    let pdfDoc: pdfjs.PDFDocumentProxy | null = null;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
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
        pdfDoc = pdf;
        if (cancelled) {
          await pdf.destroy();
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          if (cancelled) return;
          // scale=1.5 在 100% zoom 下肉眼接近 "PDF 阅读器" 默认缩放。
          // 配合 devicePixelRatio 让 retina / 高 DPI 屏不糊。
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.className =
            'block bg-white shadow-sm rounded-sm mb-2 last:mb-0';
          await page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          }).promise;
          if (cancelled) return;
          container.appendChild(canvas);
        }
        if (!cancelled) setState({ kind: 'rendered', pageCount: pdf.numPages });
      } catch (err) {
        if (cancelled) return;
        log.warn('pdf render failed', { relPath, error: String(err) });
        setState({ kind: 'error', message: String(err) });
      }
    })();

    return () => {
      cancelled = true;
      // destroy 两者:loadingTask 中止未完成的加载;pdfDoc 释放已解析文档的
      // worker / 渲染资源(promise resolve 后仅 destroy loadingTask 不够,
      // 中途导航离开会泄漏文档)。destroy 幂等,两者都调是安全的。
      void loadingTask?.destroy();
      void pdfDoc?.destroy();
    };
    // size/mtimeMs 进依赖:同一路径的文件被就地改写(agent 重生成 PDF 等)时
    // relPath 不变但 mtimeMs/size 变,需要重新读字节 + 重渲染,否则预览会停在
    // 旧内容直到用户切走再切回。FileBodyView 正是为此把 size/mtimeMs 传进来。
  }, [workdir, relPath, size, mtimeMs]);

  if (state.kind === 'error') {
    return (
      <UnrenderablePlaceholder
        workdir={workdir}
        relPath={relPath}
        size={size}
        mtimeMs={mtimeMs}
      />
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto flex w-fit flex-col items-center gap-2 px-4 py-6">
        <div ref={containerRef} className="flex flex-col gap-2" />
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
