/**
 * useCopyAsImage — 消息内容块「复制为图片 / 标注」的共享交互 hook。
 *
 * Mermaid / 表格 / 块级公式三种块的按钮行为完全一致,只有"怎么光栅化"不同,
 * 因此把光栅化收敛为调用方传入的 `getPayload`(mermaid 走 svgToPngBlob,DOM
 * 块走 domToPngBlob;可附带 plainText 源码表示),hook 统一承担:
 *   - 复制:PNG + 可选 text/plain 在同一次原生剪贴板写入中提供(纯内存,不落盘;
 *     粘贴目标自选格式——飞书吃图、编辑器吃源码),成功用图标切换反馈
 *     (与"复制源码"同款 1.5s Check),失败 toast;
 *   - 标注:PNG Blob → data: URL → ImageLightbox(autoAnnotate 直进涂画),
 *     后续复制/发送到对话全部走 lightbox 现有出口(发送经 cindy-media 总仓,
 *     规则 25 合规)。标注入口只在聊天会话上下文里出现(canAnnotate)——
 *     TextLightbox / workdir 浏览器等无 session 场景自动隐藏。
 *
 * 并发防抖:光栅化是异步重操作(字体内联/大 canvas),pending 期间忽略重复
 * 点击,避免连点产生多份位图同时压 renderer。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { blobToDataUrl } from '@/lib/annotationBurnIn';
import { copyPngBlobToClipboard } from '@/lib/rasterizeToImage';
import { createLogger } from '@/lib/logger';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { ImageLightbox } from './ImageLightbox';
import { useChatSessionFile } from './ChatSessionFileContext';

const log = createLogger('CopyAsImage');

export interface CopyAsImagePayload {
  blob: Blob;
  /** 可选的源码文本表示(mermaid 源码 / 表格 TSV / 公式 LaTeX)。 */
  plainText?: string;
}

export function useCopyAsImage(getPayload: () => Promise<CopyAsImagePayload>): {
  /** 复制成功后的 1.5s 反馈窗口(调用方切 Check 图标)。 */
  copiedImage: boolean;
  copyAsImage: () => void;
  /** 是否展示「标注」入口(需要聊天会话上下文才有发送出口)。 */
  canAnnotate: boolean;
  openAnnotate: () => void;
  /** 标注 lightbox(打开时非 null),调用方直接挂进 JSX。 */
  annotateNode: ReactNode;
} {
  const { t } = useTranslation();
  const { sessionId } = useChatSessionFile();
  const [copiedImage, setCopiedImage] = useState(false);
  const [annotateUrl, setAnnotateUrl] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  function copyAsImage() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    let stage: 'rasterize' | 'clipboard' = 'rasterize';
    getPayload()
      .then(({ blob, plainText }) => {
        stage = 'clipboard';
        return copyPngBlobToClipboard(blob, plainText);
      })
      .then(() => {
        setCopiedImage(true);
        if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedImage(false);
          copyTimerRef.current = null;
        }, 1500);
      })
      .catch((err) => {
        log.warn('copy as image failed', {
          stage,
          code: extractIpcError(err)?.code ?? 'UNKNOWN',
        });
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'chat.media.copyFailed' })));
      })
      .finally(() => {
        pendingRef.current = false;
      });
  }

  function openAnnotate() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    getPayload()
      .then(({ blob }) => blobToDataUrl(blob))
      .then((dataUrl) => setAnnotateUrl(dataUrl))
      .catch((err) => {
        log.warn('rasterize for annotate failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        toast.error(t('chat.media.copyFailed'));
      })
      .finally(() => {
        pendingRef.current = false;
      });
  }

  const annotateNode =
    annotateUrl != null ? (
      <ImageLightbox src={annotateUrl} autoAnnotate onClose={() => setAnnotateUrl(null)} />
    ) : null;

  return {
    copiedImage,
    copyAsImage,
    canAnnotate: Boolean(sessionId),
    openAnnotate,
    annotateNode,
  };
}
