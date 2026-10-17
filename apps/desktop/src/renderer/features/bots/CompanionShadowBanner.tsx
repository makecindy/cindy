/**
 * 已降级的本机副本（docs/product-rules/cloud-companions.md §3.1）：伙伴在主力电脑上运行，这里的
 * 主任务只读；横幅提供「打开主力电脑上的伙伴」与「在这台电脑继续」。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { ensureBotProfilesLoaded } from './botStore';
import { companionCloudApi, refreshCompanionCloud, useCompanionCloud } from './companionCloudStore';

export function CompanionShadowBanner({ botId, name }: { botId: string; name: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actor = cloud.actors.find((candidate) => candidate.externalId === botId);
  const home = actor?.homeDeviceId && actor.homeDeviceId !== cloud.selfDeviceId ? actor.homeDeviceId : null;
  const device = actor?.homeDevice?.name?.trim() || t('bots.cloud.unknownDevice');

  const takeOver = async () => {
    const api = companionCloudApi();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api.takeOverCompanion(botId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      refreshCompanionCloud();
      if (result.ok) { await ensureBotProfilesLoaded(true).catch(() => undefined); return; }
      if (result.code === 'HOME_CONFLICT') toast.info(t('bots.cloud.takeOverConflict', { name, device }));
      else setError(t(result.code === 'OFFLINE' ? 'bots.cloud.takeOverOffline' : result.code === 'NOT_ENABLED'
        ? 'bots.cloud.notEnabled' : 'bots.cloud.takeOverFailed', { name }));
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setError(t('bots.cloud.takeOverFailed', { name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      role="status"
      data-testid="companion-shadow-banner"
      className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium text-[var(--text-primary)]">{t('bots.cloud.shadowTitle', { device })}</p>
        <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
          {busy ? t('bots.cloud.takingOver', { name }) : error ?? t('bots.cloud.shadowHint')}
        </p>
      </div>
      {home ? (
        <Button variant="secondary" size="md" type="button" disabled={busy}
          onClick={() => navigate(`/bots/remote/${encodeURIComponent(home)}/${encodeURIComponent(botId)}`)}>
          {t('bots.cloud.openOnHome', { device })}
        </Button>
      ) : null}
      <Button variant="primary" size="md" type="button" loading={busy} disabled={busy} onClick={() => void takeOver()}>
        {t('bots.cloud.continueHere')}
      </Button>
    </section>
  );
}
