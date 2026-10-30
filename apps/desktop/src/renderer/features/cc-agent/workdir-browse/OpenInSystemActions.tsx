import { Button } from '@/components/ui/button';
import { shouldShowOpenPathError } from '../../../../shared/openPathResult';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface OpenInSystemActionsProps {
  /** Absolute filesystem path of the file to open. */
  absPath: string;
  /** Absolute filesystem path of the file's containing folder. */
  folderPath: string;
  /** Extra classes applied to the outer button row. */
  className?: string;
}

export function OpenInSystemActions({
  absPath,
  folderPath,
  className,
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

  const onOpenFolder = async () => {
    try {
      const r = await window.electronAPI.openPath(folderPath);
      if (shouldShowOpenPathError(r)) toast.error(r.error || t('ccAgent.common.openFolderFailed'));
    } catch (err) {
      toast.error(
        t('ccAgent.common.openFolderFailedWith', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button variant="cta" size="md" compact type="button" onClick={onOpenFile}>
        <ExternalLink size={14} />
        {t('ccAgent.workdirBrowse.unrenderable.openInSystem')}
      </Button>
      <Button variant="secondary" size="md" compact type="button" onClick={onOpenFolder}>
        <FolderOpen size={14} />
        {t('ccAgent.workdirBrowse.unrenderable.revealFolder')}
      </Button>
    </div>
  );
}
