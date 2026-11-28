import { useTranslation } from 'react-i18next';
import { ghostInstallErrorKey } from '@/cindy-brain/installErrorKey';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { ghostInstallApprovalToken, type ConfirmedGhostUninstall, type InstalledGhost } from '../../../../shared/ghost';
import { installedGhostPhysicalRelId, installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';

export function useUninstallPlugin() {
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();
  return async (ghost: InstalledGhost, name: string, marketId?: string, refreshMarket?: () => Promise<void>) => {
    const owner = getDataOwnerGeneration();
    const id = installedGhostStoragePart(ghost);
    const confirmed: ConfirmedGhostUninstall = {
      owner: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation },
      physicalId: installedGhostPhysicalRelId(ghost),
      approval: ghostInstallApprovalToken(ghost.approval),
      version: ghost.manifest.version,
    };
    const ok = await confirm({
      title: t('settings.ghosts.uninstallConfirm.title', { name }),
      description: t('settings.ghosts.uninstallConfirm.description'),
      confirmText: t('settings.ghosts.uninstall'),
      cancelText: t('settings.ghosts.uninstallConfirm.cancel'),
      confirmVariant: 'destructive',
    });
    if (!ok || !isDataOwnerGenerationCurrent(owner)) return;
    try {
      if (marketId) {
        await window.electronAPI.pluginMarket.uninstall(marketId, confirmed);
        if (isDataOwnerGenerationCurrent(owner)) await refreshMarket?.();
      } else {
        await window.electronAPI.ghosts.uninstall(id, confirmed);
      }
      if (isDataOwnerGenerationCurrent(owner)) toast.success(t('settings.ghosts.toast.uninstalled', { name }));
    } catch (error) {
      if (isDataOwnerGenerationCurrent(owner)) {
        const code = extractIpcError(error)?.code;
        toast.error(t(marketId || code === 'PRECONDITION_FAILED' ? pluginMarketErrorKey(error) : ghostInstallErrorKey(code)));
      }
    }
  };
}
