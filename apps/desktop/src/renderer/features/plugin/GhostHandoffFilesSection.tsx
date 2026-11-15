/**
 * GhostHandoffFilesSection — 插件详情页「对话中交给插件的文件」(本机)。
 * ---------------------------------------------------------------------------
 * 列出宿主为该插件保存的对话文件副本(7 天未使用后自动删除),逐个删除前确认。
 * 只在有副本或有工具声明接收时渲染;不显示本机路径,可在访达 / 资源管理器中打开副本目录。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen, RefreshCw } from 'lucide-react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import type { GhostHandoffFile } from '../../../shared/ghost';

const SECTION_CLASS = 'mt-10';
const SURFACE_CLASS =
  'border border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]';
const DANGER_BUTTON_CLASS =
  'shrink-0 text-13 font-medium text-[var(--error-fg)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function GhostHandoffFilesSection({ ghostId, declared }: { ghostId: string; declared: boolean }) {
  const [files, setFiles] = useState<GhostHandoffFile[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Copies are account data: reload on an account switch and ignore late answers.
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const request = useRef(0);
  // A delete started for a previous plugin refreshes through its old closure;
  // skip it before it takes a request number, or it could overwrite this plugin.
  const shownGhost = useRef(ghostId);
  useLayoutEffect(() => {
    shownGhost.current = ghostId;
  }, [ghostId]);

  const refresh = useCallback(async () => {
    if (shownGhost.current !== ghostId) return;
    const current = ++request.current;
    try {
      const [next, nextFolder] = await Promise.all([
        window.electronAPI.ghosts.handoffList(ghostId),
        window.electronAPI.ghosts.handoffFolder(ghostId),
      ]);
      if (current !== request.current) return;
      setFiles(next);
      setFolder(nextFolder);
      setFailed(false);
    } catch {
      if (current === request.current) setFailed(true);
    }
  }, [ghostId]);

  useEffect(() => {
    setFiles(null);
    setFolder(null);
    setFailed(false);
    void refresh();
  }, [refresh, ownerGeneration]);

  // 不接收交接的插件只在仍有副本时显示;声明接收的插件读取失败要说明。
  if (!declared && (failed || !files?.length)) return null;
  return <HandoffFilesBody ghostId={ghostId} files={files} folder={folder} failed={failed} refresh={refresh} />;
}

function HandoffFilesBody({
  ghostId,
  files,
  folder,
  failed,
  refresh,
}: {
  ghostId: string;
  files: GhostHandoffFile[] | null;
  folder: string | null;
  failed: boolean;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [deleting, setDeleting] = useState<string | null>(null);
  const formatTime = (value: number) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const openLabel = t(
    window.electronAPI?.platform === 'darwin'
      ? 'settings.ghosts.handoff.openInFinder'
      : 'settings.ghosts.handoff.openInExplorer',
  );
  const openFolder = () => {
    if (!folder) return;
    void window.electronAPI.openPath(folder).then(
      (result) => {
        if (shouldShowOpenPathError(result)) toast.error(t('settings.ghosts.errors.generic'));
      },
      () => toast.error(t('settings.ghosts.errors.generic')),
    );
  };

  const handleDelete = async (file: GhostHandoffFile) => {
    if (deleting) return;
    const ok = await confirm({
      title: t('settings.ghosts.handoff.deleteTitle'),
      description: t('settings.ghosts.handoff.deleteDescription', { name: file.name }),
      confirmText: t('settings.ghosts.handoff.delete'),
      cancelText: t('settings.ghosts.handoff.cancel'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setDeleting(file.ref);
    try {
      await window.electronAPI.ghosts.handoffDelete(ghostId, file.ref);
    } catch {
      toast.error(t('settings.ghosts.handoff.deleteFailed'));
    } finally {
      setDeleting(null);
      void refresh();
    }
  };

  return (
    <section className={SECTION_CLASS} aria-labelledby="ghost-handoff-title">
      <div className="flex max-w-[760px] items-center justify-between">
        <h3 id="ghost-handoff-title" className="flex items-center gap-2 text-18 font-medium leading-[1.444] text-[var(--text-primary)]">
          <FileText size={18} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
          {t('settings.ghosts.handoff.title')}
        </h3>
        <div className="flex items-center gap-1">
          <Tip text={openLabel}>
            <Button
              variant="secondary"
              tone="quiet"
              size="sm"
              className="w-7 p-0"
              disabled={!folder || !files?.length}
              onClick={openFolder}
              aria-label={openLabel}
            >
              <FolderOpen size={14} aria-hidden="true" />
            </Button>
          </Tip>
          <Tip text={t('settings.ghosts.handoff.refresh')}>
            <Button
              variant="secondary"
              tone="quiet"
              size="sm"
              className="w-7 p-0"
              onClick={() => void refresh()}
              aria-label={t('settings.ghosts.handoff.refresh')}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </Button>
          </Tip>
        </div>
      </div>
      <p className="mt-2 max-w-[760px] text-13 text-[var(--text-secondary)]">{t('settings.ghosts.handoff.description')}</p>

      <div className={cn(SURFACE_CLASS, 'mt-4 max-w-[760px] rounded-xl')}>
        {failed ? (
          <p className="p-4 text-13 text-[var(--warning-fg)]">{t('settings.ghosts.handoff.loadFailed')}</p>
        ) : files === null ? null : files.length === 0 ? (
          <p className="p-4 text-13 text-[var(--text-tertiary)]">{t('settings.ghosts.handoff.empty')}</p>
        ) : (
          <ul>
            {files.map((file) => (
              <li
                key={file.ref}
                className="flex items-center justify-between gap-4 border-b border-[var(--border-default)] px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-13 font-medium text-[var(--text-primary)]" title={file.name}>
                    {file.name}
                  </p>
                  <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
                    {t('settings.ghosts.handoff.meta', {
                      size: formatBytes(file.size),
                      handedAt: formatTime(file.createdAt),
                      expiresAt: formatTime(file.expiresAt),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  className={DANGER_BUTTON_CLASS}
                  disabled={deleting !== null}
                  aria-label={t('settings.ghosts.handoff.deleteNamed', { name: file.name })}
                  onClick={() => void handleDelete(file)}
                >
                  {t('settings.ghosts.handoff.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
