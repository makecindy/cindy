import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { marketLocalCopies } from '../lib/marketLocalCopies';
import { invalidate as invalidateInfo } from '../lib/infoDedupe';
import { semverCompare } from '../versionUtils';
import type { MarketSkill } from './useMarketList';
import { invalidateHash } from './useSkillFolderHash';
import { refresh } from './useSkillhub';
import { useSkillhubTarget } from '../SkillhubTargetContext';

/** Update the copy represented by the card, without opening the install picker. */
export function useMarketSkillUpdate() {
  const { t } = useTranslation();
  const target = useSkillhubTarget();
  const owner = getDataOwnerGeneration();
  // The installer serializes by name, including same-name records in other catalogs.
  const running = useRef(new Set<string>());
  const [updatingNames, setUpdatingNames] = useState<ReadonlySet<string>>(new Set());
  const isUpdating = useCallback((name: string) => running.current.has(name), []);

  const update = useCallback(async (skill: MarketSkill) => {
    if (!skill.updateAvailable || !skill.installedAbsolutePath
      || running.current.has(skill.name) || !isDataOwnerGenerationCurrent(owner)) return;
    running.current.add(skill.name);
    setUpdatingNames(new Set(running.current));
    try {
      if (target) {
        const locals = await target.refresh();
        if (!target.current()) return;
        const local = marketLocalCopies(locals, skill).find((entry) => entry.id === target.state.skills.find((entry) => entry.absolutePath === skill.installedAbsolutePath)?.id);
        if (!local) return;
        const result = await target.mutate('update', local, skill);
        if (target.current() && result.phase === 'failed') toast.error(t('skillhub.marketCard.updateFailed'));
        else if (target.current() && result.phase === 'succeeded') toast.success(t('skillhub.detail.updatedToast', { name: skill.name, version: skill.latestVersion }));
        return;
      }
      // Recheck the registry before authorizing replacement of an existing directory.
      const locals = await refresh();
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const local = marketLocalCopies(locals, skill).find((entry) =>
        entry.absolutePath === skill.installedAbsolutePath && entry.registryEntry);
      if (!local?.registryEntry?.version
        || semverCompare(skill.latestVersion, local.registryEntry.version) <= 0) return;

      const result = await window.electronAPI.skillhub.install({
        name: skill.name,
        version: skill.latestVersion,
        catalogScope: skill.catalogScope,
        installPath: local.absolutePath,
        force: true,
        skipBackup: false,
      });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (result.success) {
        invalidateHash(local.absolutePath);
        invalidateInfo(skill.name, skill.catalogScope);
        await refresh();
        if (isDataOwnerGenerationCurrent(owner)) {
          toast.success(t('skillhub.detail.updatedToast', { name: skill.name, version: result.version }));
        }
      } else if (result.errorCode !== 'CANCELLED') {
        toast.error(t('skillhub.marketCard.updateFailed'));
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner) && (!target || target.current())) toast.error(t('skillhub.marketCard.updateFailed'));
    } finally {
      running.current.delete(skill.name);
      setUpdatingNames(new Set(running.current));
    }
  }, [owner, t, target]);

  return { update, updatingNames, isUpdating };
}
