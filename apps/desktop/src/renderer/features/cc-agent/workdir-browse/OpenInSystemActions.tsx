import { Button } from '@/components/ui/button';
import { shouldShowOpenPathError } from '../../../../shared/openPathResult';
import { Eye, ExternalLink, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface OpenInSystemActionsProps {
  /** Absolute filesystem path of the file to open or reveal. */
  absPath: string;
  /** Extra classes applied to the outer button row. */
  className?: string;
  systemPreview?: boolean;
  primaryOnly?: boolean;
}

export function canOpenSystemPreview() {
  return typeof window.electronAPI.openSystemPreview === 'function' &&
    ['darwin', 'win32'].includes(window.electronAPI.platform);
}

export async function openSystemPreview(absPath: string, errorMessage: string) {
  if (!(await window.electronAPI.openSystemPreview(absPath).catch(() => false))) toast.error(errorMessage);
}

export function OpenInSystemActions({
  absPath,
  className,
  systemPreview = true,
  primaryOnly = false,
}: OpenInSystemActionsProps) {
  const { t } = useTranslation();

  const onOpenFile = async () => {
    try {
      const r = await window.electronAPI.openPath(absPath);
      if (shouldShowOpenPathError(r)) toast.error(r.error || t('ccAgent.common.openFailed'));
    } catch (err) {
      toast.error(
        t('ccAgent.common.openFailedWith', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  // 在访达 / 资源管理器里选中这个文件,而不是只打开所在目录。
  const onRevealFile = async () => {
    try {
      const r = await window.electronAPI.showItemInFolder({ filePath: absPath });
      if (!r.success) toast.error(r.error || t('ccAgent.common.openFolderFailed'));
    } catch (err) {
      toast.error(
        t('ccAgent.common.openFolderFailedWith', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
      {!primaryOnly && systemPreview && canOpenSystemPreview() && (
        <Button variant="secondary" size="md" compact type="button"
          onClick={() => void openSystemPreview(absPath, t('ccAgent.common.openFailed'))}>
          <Eye size={14} />{t('ccAgent.workdirBrowse.systemPreview')}
        </Button>
      )}
      <Button variant="cta" size="md" compact type="button" onClick={onOpenFile}>
        <ExternalLink size={14} />
        {t('ccAgent.workdirBrowse.unrenderable.openInSystem')}
      </Button>
      {!primaryOnly && (
        <Button variant="secondary" size="md" compact type="button" onClick={onRevealFile}>
          <FolderOpen size={14} />
          {t('ccAgent.workdirBrowse.unrenderable.revealFolder')}
        </Button>
      )}
    </div>
  );
}
