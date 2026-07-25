/**
 * GhostGrantConfirmCard
 * ---------------------------------------------------------------------------
 * ghost_call 过户 workdir 外文件的确认卡片(kind='ghost_grant_confirm')。
 * 两层策略(2026-07-14 定案):workdir 内自动放行;workdir 外由 main 侧
 * GhostGrantConfirmBridge 推清单到这里,用户看清「哪个意识、哪些文件、
 * 什么路径」后点允许,main 才继续过户——决定权在点击上,模型点不了按钮。
 *
 * 展示要素:目标意识名 + 通道语义说明 + 逐条文件(图片带真实字节缩略预览,
 * 目录带文件数/总体积),完整绝对路径必须可见(知情授权的前提)。
 *
 * 视觉对齐 RenameSessionsConfirmCard(替换 ChatInput 的占位卡片)。
 *
 * Keyboard shortcuts:
 *   Ctrl/Cmd+Enter → 允许
 *   Esc            → 拒绝
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, File, FileAudio, FileVideo, Folder, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingGhostGrantConfirm } from '@/lib/makerChatStore';

interface GhostGrantConfirmCardProps {
  pending: PendingGhostGrantConfirm;
  onRespond: (result: { confirmed: true; allowDirs?: boolean } | { confirmed: false }) => void;
}

export function GhostGrantConfirmCard({ pending, onRespond }: GhostGrantConfirmCardProps) {
  const { t } = useTranslation();
  // 目录级授权勾选(仅 attachments 通道展示):允许的同时把文件所在目录记入
  // 会话级记忆,同目录后续媒体文件免弹——跨调用批量任务只点一次。
  const [allowDirs, setAllowDirs] = useState(false);

  // 同会话连续两次确认(新 requestId)时重置勾选,不让上一单的选择泄漏到下一单。
  useEffect(() => {
    setAllowDirs(false);
  }, [pending.requestId]);

  const handleAllow = useCallback(() => {
    onRespond({ confirmed: true, ...(allowDirs ? { allowDirs: true } : {}) });
  }, [onRespond, allowDirs]);

  const handleDeny = useCallback(() => {
    onRespond({ confirmed: false });
  }, [onRespond]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleAllow();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleDeny();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleAllow, handleDeny]);

  const descriptionKey =
    pending.lane === 'attachments'
      ? 'ghostGrant.confirm.descriptionAttachments'
      : pending.lane === 'dir'
        ? 'ghostGrant.confirm.descriptionDir'
        : pending.lane === 'fs_write'
          ? 'ghostGrant.confirm.descriptionFsWrite'
          : pending.lane === 'workspace'
            ? 'ghostGrant.confirm.descriptionWorkspace'
            : 'ghostGrant.confirm.descriptionSaveDir';

  return (
    <div
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border p-4',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-15 font-semibold leading-tight text-[var(--chat-input-text)]">
            {t('ghostGrant.confirm.title', { name: pending.ghostName })}
          </p>
          <p className="mt-1 text-12 leading-relaxed text-[var(--status-bar-meta)]">
            {t(descriptionKey)}
          </p>
        </div>
        <span className="shrink-0 rounded-[6px] border border-[var(--chat-input-border)] px-2 py-1 text-[12px] font-medium text-[var(--status-bar-meta)]">
          {t('ghostGrant.confirm.count', { count: pending.items.length })}
        </span>
      </div>

      {/* 文件清单:自适应高度,超出封顶滚动。上限 = 4 整行 + 半行(行高 ≈65px:
          48px 缩略图 + py-2 + 分隔线)——刻意露出第 5 条的半截,让"还能往下滚"
          一眼可见(整 4 条收边会看起来像全部内容)。 */}
      <div className="mt-3 max-h-[296px] overflow-y-auto rounded-[8px] border border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]">
        {pending.items.map((item, idx) => (
          <div
            key={`${item.absPath}#${idx}`}
            className="flex items-center gap-3 border-b border-[var(--chat-input-border)] px-3 py-2 last:border-b-0"
          >
            {item.previewDataUrl ? (
              <img
                src={item.previewDataUrl}
                alt={item.name}
                className="size-12 shrink-0 rounded-[6px] border border-[var(--chat-input-border)] object-cover"
              />
            ) : (
              <span className="flex size-12 shrink-0 items-center justify-center rounded-[6px] border border-[var(--chat-input-border)] text-[var(--status-bar-meta)]">
                <ItemIcon isDirectory={item.isDirectory} mimeType={item.mimeType} />
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-13 font-medium text-[var(--chat-input-text)]">{item.name}</p>
              <p className="mt-0.5 truncate text-11 text-[var(--status-bar-meta)]" title={item.absPath}>
                {item.absPath}
              </p>
              <p className="mt-0.5 text-11 text-[var(--status-bar-meta)]">
                {item.isDirectory && typeof item.fileCount === 'number'
                  ? t('ghostGrant.confirm.dirMeta', {
                      count: item.fileCount,
                      size: formatBytes(item.size),
                    })
                  : item.isDirectory
                    ? t('ghostGrant.confirm.directory')
                    : formatBytes(item.size)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {pending.lane === 'attachments' ? (
        <label className="mt-[13px] flex cursor-pointer items-center gap-2 text-12 text-[var(--status-bar-meta)]">
          <input
            type="checkbox"
            checked={allowDirs}
            onChange={(e) => setAllowDirs(e.target.checked)}
            className="size-3.5 accent-[var(--accent-cta-bg)]"
          />
          <span>{t('ghostGrant.confirm.allowDirs')}</span>
        </label>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleDeny}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)] bg-transparent',
            'text-13 font-medium text-[var(--chat-input-text)]',
            'transition-colors hover:bg-[var(--perm-code-bg)]',
          )}
        >
          <X className="size-4" />
          <span>{t('ghostGrant.confirm.deny')}</span>
        </button>
        <button
          type="button"
          onClick={handleAllow}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)]',
            'bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]',
            'text-13 font-medium transition-colors hover:opacity-90',
          )}
        >
          <Check className="size-4" />
          <span>{t('ghostGrant.confirm.allow')}</span>
          <kbd className="rounded-[4px] border border-[var(--perm-allow-kbd-border)] bg-[var(--perm-allow-kbd-bg)] px-1.5 py-[1px] text-[11px] font-normal text-[var(--perm-allow-btn-text)] opacity-70">
            {window.electronAPI?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'}
          </kbd>
        </button>
      </div>
    </div>
  );
}

function ItemIcon({ isDirectory, mimeType }: { isDirectory?: boolean; mimeType?: string }) {
  if (isDirectory) return <Folder className="size-5" />;
  if (mimeType?.startsWith('video/')) return <FileVideo className="size-5" />;
  if (mimeType?.startsWith('audio/')) return <FileAudio className="size-5" />;
  return <File className="size-5" />;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = '';
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}
