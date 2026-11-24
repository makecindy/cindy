/**
 * 已降级的本机副本（docs/product-rules/cloud-companions.md §3.1）：伙伴在主力电脑上运行，这里的
 * 主任务只读；横幅提供「打开主力电脑上的伙伴」与「在这台电脑继续」。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CompanionCindyConflictAction, useCompanionCindyConflictAction } from './CompanionCindyConflictAction';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { BotModelChainEditor } from './BotModelChainEditor';
import { ensureBotProfilesLoaded } from './botStore';
import { companionCloudApi, refreshCompanionCloud, useCompanionCloud } from './companionCloudStore';

export function CompanionShadowBanner({ botId, name, needsModel = false }: { botId: string; name: string; needsModel?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const conflict = useCompanionCindyConflictAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelRequired, setModelRequired] = useState(false);
  const [selectedModel, setSelectedModel] = useState<BotModelRoute[] | null>(null);
  const actor = cloud.actors.find((candidate) => candidate.externalId === botId);
  const home = actor?.homeDeviceId && actor.homeDeviceId !== cloud.selfDeviceId ? actor.homeDeviceId : null;
  const device = actor?.homeDevice?.name?.trim() || t('bots.cloud.unknownDevice');
  const waitingForModel = needsModel || actor?.needsModel === true || modelRequired;

  const takeOver = async () => {
    const api = companionCloudApi();
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    conflict.clear();
    const owner = getDataOwnerGeneration();
    try {
      if (selectedModel?.length) {
        const update = window.electronAPI?.localDb?.bots?.update;
        if (!update) {
          if (isDataOwnerGenerationCurrent(owner)) setError(t('bots.cloud.modelSaveFailed'));
          return;
        }
        try {
          await update({
            id: botId,
            capabilities: { ...selectedModel[0], modelChain: selectedModel, modelChainOverride: selectedModel },
          });
        } catch {
          if (isDataOwnerGenerationCurrent(owner)) setError(t('bots.cloud.modelSaveFailed'));
          return;
        }
        if (!isDataOwnerGenerationCurrent(owner)) return;
      }
      const result = await api.takeOverCompanion(botId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      refreshCompanionCloud();
      if (result.ok) {
        setModelRequired(false);
        await ensureBotProfilesLoaded(true).catch(() => undefined);
        return;
      }
      conflict.report(result);
      if (result.code === 'HOME_CONFLICT') toast.info(t('bots.cloud.takeOverConflict', { name, device }));
      else if (result.reason === 'MODEL_UNAVAILABLE') {
        setModelRequired(true);
        setError(t('bots.cloud.modelRequiredHint', { name }));
      } else setError(t(result.code === 'OFFLINE' ? 'bots.cloud.takeOverOffline' : result.code === 'NOT_ENABLED'
        ? 'bots.cloud.notEnabled' : result.code === 'LOCAL_CINDY_CONFLICT'
          ? 'bots.cloud.localCindyConflict' : 'bots.cloud.takeOverFailed', { name }));
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
      <div className={`min-w-0 flex-1${conflict.action || waitingForModel ? ' basis-full' : ''}`}>
        <p className="text-14 font-medium text-[var(--text-primary)]">
          {waitingForModel ? t('bots.cloud.modelRequiredTitle') : t('bots.cloud.shadowTitle', { device })}
        </p>
        <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
          {busy ? t('bots.cloud.takingOver', { name }) : error ?? (waitingForModel ? t('bots.cloud.modelRequiredHint', { name }) : t('bots.cloud.shadowHint'))}
        </p>
      </div>
      {waitingForModel ? (
        <div className="min-w-0 basis-full" data-testid="companion-model-recovery">
          <BotModelChainEditor
            label={t('bots.settingsTabs.model')}
            value={selectedModel ?? []}
            disabled={busy}
            allowFallbacks={false}
            onChange={(routes) => {
              setSelectedModel(routes.slice(0, 1));
              setError(null);
            }}
            onNavigateToProviders={() => navigate('/settings?tab=providers')}
          />
        </div>
      ) : null}
      <CompanionCindyConflictAction action={conflict.action} />
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
