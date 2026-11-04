import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { companionCloudApi, refreshCompanionCloudSettled, useCompanionCloud } from './companionCloudStore';

/**
 * The notices shown per bot while main's dismissal is not yet read back, so a snapshot that still
 * carries them never repeats the toast. An entry ends as soon as that dismissal and refresh are
 * done (or failed), so the next arrival of the same companion is a new one and shows again; an
 * entry of another account is never honoured.
 */
const shown = new Map<string, { owner: DataOwnerGeneration; batch: string }>();

/**
 * One line after a companion arrived on this computer for what its old setup could not keep (the
 * permission level never travels; a saved model that is not usable here is replaced by this
 * computer's default). Shown when its chat opens, then dismissed in main
 * (docs/product-rules/cloud-companions.md §2).
 */
export function useCompanionArrivalNotice(botId: string | undefined, name: string | undefined): void {
  const { t } = useTranslation();
  const notices = useCompanionCloud().actors.find((actor) => actor.externalId === botId)?.arrivalNotices;
  useEffect(() => {
    if (!botId || !notices?.length) return;
    const batch = notices.join(',');
    const known = shown.get(botId);
    if (known && known.batch === batch && isDataOwnerGenerationCurrent(known.owner)) return;
    const entry = { owner: getDataOwnerGeneration(), batch };
    shown.set(botId, entry);
    for (const notice of notices) {
      toast.info(t(notice === 'model' ? 'bots.cloud.arrivalModel' : 'bots.cloud.arrivalPermissions', { name: name ?? '' }));
    }
    // Whether main dismissed it or not, the dedupe ends here; a failed dismissal may show again next time.
    void Promise.resolve(companionCloudApi()?.dismissCompanionArrivalNotices?.(botId))
      .then(() => refreshCompanionCloudSettled(), () => undefined)
      .finally(() => { if (shown.get(botId) === entry) shown.delete(botId); });
  }, [botId, name, notices, t]);
}
