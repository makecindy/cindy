import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { cn } from '@/lib/utils';

import { OpenInSystemActions } from './OpenInSystemActions';
import { basename, dirname, formatBytes, formatMtime, joinPath } from './lib/fileMeta';

export interface ImagePreviewProps {
  workdir: string;
  /** workdir-relative POSIX path */
  relPath: string;
  size: number;
  mtimeMs: number;
  /**
   * 宿主会话 id:透传给 ImageLightbox 启用"发送到对话 / 标注"。不传(如远程
   * 会话缓存副本场景)时 lightbox 只提供查看/缩放/复制/另存。
   */
  sessionId?: string;
}

export function ImagePreview({ workdir, relPath, size, mtimeMs, sessionId }: ImagePreviewProps) {
  const { t } = useTranslation();
  const name = basename(relPath);
  const absPath = joinPath(workdir, relPath);
  const folderPath = joinPath(workdir, dirname(relPath));
  const src = toLocalFileUrl(absPath);
  // 点击图片 → 全屏 ImageLightbox(缩放/复制/另存/标注/发送到对话与聊天图
  // 一致)。此前这里是纯静态 <img>,是图片能力升级后唯一没接 lightbox 的入口。
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // 布局口径:flex column h-full,中间 image wrapper flex-1 自适应、两端
  // 元信息 + 按钮 shrink-0 固定。
  //
  // image wrapper 必须同时具备 `min-h-0 + overflow-hidden`,img 必须 `min-h-0`:
  //   - flex item 默认 min-height: min-content,大图的 intrinsic height 会被
  //     当成 min-content 把 wrapper 撑出 flex-1 边界 → 元信息 / 按钮被挤到
  //     视口外(2026-07-01 用户实测:按钮看不见)。
  //   - `min-h-0` 解除该下限,wrapper 才能在 flex-1 计算结果内被压缩。
  //   - 给 wrapper 加 `overflow-hidden` 是双保险:即便某条 css 路径让 img 仍按
  //     intrinsic 渲染,也不会让它溢出影响外层 layout。
  //   - img 上 `min-h-0 min-w-0`:img 也是 flex item(wrapper 是 flex),同样
  //     默认 min-content,不显式归零,`max-h-full max-w-full` 在某些 Chromium
  //     版本会被无视。
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-8 py-6">
      <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
        <img
          src={src}
          alt={name}
          className={cn(
            'min-h-0 min-w-0 max-h-full max-w-full rounded-lg object-contain',
            'bg-[#ececea] dark:bg-[#2c2c2a]',
            'cursor-pointer transition-opacity hover:opacity-90',
          )}
          onClick={() => setLightboxOpen(true)}
        />
      </div>
      {lightboxOpen ? (
        <ImageLightbox src={src} sessionId={sessionId} onClose={() => setLightboxOpen(false)} />
      ) : null}
      <div className="shrink-0 text-xs text-[var(--text-secondary)]">
        {name} · {formatBytes(size)} ·{' '}
        {t('ccAgent.workdirBrowse.unrenderable.modifiedAt', { time: formatMtime(mtimeMs) })}
      </div>
      <OpenInSystemActions absPath={absPath} folderPath={folderPath} className="shrink-0" />
    </div>
  );
}
