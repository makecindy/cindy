/**
 * CopyAsImageBlock — 表格 / 块级公式的「复制为图片 / 标注」hover 外壳。
 *
 * 与 CodeBlockPre / MarkdownMermaidBlock 同一套 hover 工具栏配方(右上角
 * `h-7 w-7` 图标按钮、group-hover 显隐、Check 1.5s 反馈)。内容经
 * `domToPngBlob`(html-to-image foreignObject 序列化)光栅化:
 *   - 外层 `group relative` 承载完整高度的 sticky 工具栏,内容包装层用负上边距回叠;
 *     导出目标本身不带布局偏移,工具栏也不会因挂在 overflow 容器内被裁剪或随横向滚动漂移;
 *   - 光栅化目标是内层内容节点,`scrollWidth` 取完整内容宽,宽表格不被可视
 *     口截断;
 *   - 标注入口仅在聊天会话上下文出现(useCopyAsImage.canAnnotate)。
 */

import { useRef, type ReactNode } from 'react';
import { Check, Copy, Pen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { domToPngBlob, resolveExportBackground } from '@/lib/rasterizeToImage';
import { useCopyAsImage } from './useCopyAsImage';

interface CopyAsImageBlockProps {
  children: ReactNode;
  /** 外层 wrapper 追加类(如 `my-3`)。 */
  className?: string;
  /** 内层内容容器类(如表格的 `overflow-x-auto`);光栅化以该节点为目标。 */
  contentClassName?: string;
  /**
   * 可选:从内容节点提取随图附带的 text/plain 源码表示(表格 → TSV、
   * 公式 → LaTeX)。粘贴目标自选格式:图片应用吃图,文本编辑器吃源码。
   */
  extractPlainText?: (node: HTMLElement) => string | undefined;
}

/**
 * GFM 表格 → TSV(制表符分隔,行为单位):这是电子表格软件(Excel /
 * 飞书表格 / Numbers)约定俗成的粘贴格式,贴过去直接还原成单元格。
 * 单元格内换行压成空格,避免破坏行结构。
 */
export function tableToTsv(node: HTMLElement): string | undefined {
  const rows = Array.from(node.querySelectorAll('tr'));
  if (rows.length === 0) return undefined;
  return rows
    .map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => (cell as HTMLElement).innerText.replace(/\s*\n\s*/g, ' ').trim())
        .join('\t'),
    )
    .join('\n');
}

/**
 * 块级 KaTeX 公式 → LaTeX 源码:KaTeX 渲染产物里保留了原始 TeX
 * (`<annotation encoding="application/x-tex">`),取出并包回 `$$ … $$`,
 * 粘贴回 markdown 环境可直接复现公式块。
 */
export function mathBlockToLatex(node: HTMLElement): string | undefined {
  const tex = node
    .querySelector('annotation[encoding="application/x-tex"]')
    ?.textContent?.trim();
  return tex ? `$$\n${tex}\n$$` : undefined;
}

export function CopyAsImageBlock({
  children,
  className,
  contentClassName,
  extractPlainText,
}: CopyAsImageBlockProps) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);

  const { copiedImage, copyAsImage, canAnnotate, openAnnotate, annotateNode } =
    useCopyAsImage(async () => {
      const node = contentRef.current;
      if (!node) throw new Error('content not mounted');
      const blob = await domToPngBlob(node, {
        background: resolveExportBackground(node),
      });
      return { blob, plainText: extractPlainText?.(node) };
    });

  const buttonClass = cn(
    'inline-flex h-7 w-7 items-center justify-center',
    'rounded-md border border-[var(--msg-code-block-border)]',
    'bg-[var(--msg-code-block-bg)] text-[var(--msg-tool-text)]',
    'hover:bg-[var(--cmd-palette-item-hover)] hover:text-[var(--msg-assistant-text)]',
  );

  return (
    <div className={cn('group relative flex flex-col', className)}>
      <div className="-mt-9">
        <div ref={contentRef} className={contentClassName}>
          {children}
        </div>
      </div>
      <div
        className={cn(
          'pointer-events-none order-first sticky top-0 z-10 flex h-9 items-end justify-end gap-1 pr-2 select-none',
          'opacity-0 transition-opacity duration-150',
          'group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          type="button"
          onClick={copyAsImage}
          aria-label={
            copiedImage
              ? t('chat.markdownRenderer.blockCopied')
              : t('chat.markdownRenderer.copy')
          }
          title={
            copiedImage
              ? t('chat.markdownRenderer.blockCopied')
              : t('chat.markdownRenderer.copy')
          }
          className={cn(buttonClass, 'pointer-events-auto')}
        >
          {copiedImage ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        {canAnnotate ? (
          <button
            type="button"
            onClick={openAnnotate}
            aria-label={t('chat.markdownRenderer.annotateImage')}
            title={t('chat.markdownRenderer.annotateImage')}
            className={cn(buttonClass, 'pointer-events-auto')}
          >
            <Pen className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {annotateNode}
    </div>
  );
}
