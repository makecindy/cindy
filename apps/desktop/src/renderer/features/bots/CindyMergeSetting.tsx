/**
 * 把多台电脑上各自长出来的 Cindy 合成一个（docs/product-rules/cloud-companions.md，2026-10-16 裁决 2）。
 * Cindy 的设置里一行「合并重复的 Cindy」：只在云端有两个以上 Cindy 时出现。用户选一个作为资料基准，
 * 其余的聊天、记忆、技能、待办和例行任务并进来，同名内容另存一份不覆盖，原来的 Cindy 停用。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Layers } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { CompanionCindyCopy, CompanionCloudFailureCode } from '../../../shared/companionCloud';
import { ensureBotProfilesLoaded } from './botStore';
import { companionCloudApi, refreshCompanionCloud, useCompanionCloud } from './companionCloudStore';

const MERGE_ERROR_KEYS: Partial<Record<CompanionCloudFailureCode, string>> = {
  BUSY: 'bots.cloud.mergeBusy',
  PAUSED: 'bots.cloud.mergePaused',
  OFFLINE: 'bots.cloud.mergeOffline',
  HOME_OUTDATED: 'bots.cloud.mergeOutdated',
};

export function CindyMergeSetting({ bot, className = 'mt-3' }: { bot: { id: string; name: string }; className?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = useCompanionCloud();
  const [copies, setCopies] = useState<CompanionCindyCopy[]>([]);
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState(bot.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const actorsKey = cloud.actors.map((actor) => `${actor.externalId}:${actor.homeDeviceId ?? ''}`).join(',');

  useEffect(() => {
    const api = companionCloudApi();
    if (!cloud.enabled || !api || typeof api.listCindyCopies !== 'function') { setCopies([]); return; }
    let live = true;
    const owner = getDataOwnerGeneration();
    void api.listCindyCopies().then((next) => { if (live && isDataOwnerGenerationCurrent(owner)) setCopies(next); }, () => undefined);
    return () => { live = false; };
  }, [cloud.enabled, actorsKey]);

  if (copies.length < 2 || !copies.some((copy) => copy.botId === bot.id)) return null;
  const deviceName = (copy: CompanionCindyCopy) => {
    const actor = cloud.actors.find((candidate) => candidate.externalId === copy.botId);
    if (copy.homeDeviceId && copy.homeDeviceId === cloud.selfDeviceId) return t('bots.cloud.thisComputer');
    return actor?.homeDevice?.name?.trim() || t('bots.cloud.unknownDevice');
  };
  const devices = copies.map(deviceName).join('、');
  const kept = copies.find((copy) => copy.botId === keep) ?? copies[0]!;

  const merge = async () => {
    const api = companionCloudApi();
    if (!api || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api.mergeCindy(kept.botId, copies.filter((copy) => copy.botId !== kept.botId).map((copy) => copy.botId));
      if (!isDataOwnerGenerationCurrent(owner)) return;
      refreshCompanionCloud();
      if (!result.ok) {
        setError(t(MERGE_ERROR_KEYS[result.code] ?? 'bots.cloud.mergeFailed', { device: deviceName(kept) }));
        return;
      }
      setOpen(false);
      setCopies([]);
      toast.info(result.renamed.length
        ? t('bots.cloud.mergedRenamed', { count: result.merged + 1, messages: result.messages, renamed: result.renamed.join('、') })
        : t('bots.cloud.merged', { count: result.merged + 1, messages: result.messages }));
      await ensureBotProfilesLoaded(true).catch(() => undefined);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      // Open the one Cindy that is left, where it runs.
      if (kept.botId !== bot.id || kept.homeDeviceId !== cloud.selfDeviceId) {
        navigate(kept.homeDeviceId && kept.homeDeviceId !== cloud.selfDeviceId
          ? `/bots/remote/${encodeURIComponent(kept.homeDeviceId)}/${encodeURIComponent(kept.botId)}`
          : `/bots/${encodeURIComponent(kept.botId)}`);
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setError(t('bots.cloud.mergeFailed', { device: deviceName(kept) }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <button
          type="button"
          data-testid="cindy-merge-row"
          onClick={() => { setKeep(bot.id); setError(null); setOpen(true); }}
          className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
        >
          <Layers size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1">
            <span className="block">{t('bots.cloud.mergeLabel')}</span>
            <span className="block truncate text-12 text-[var(--text-secondary)]">{t('bots.cloud.mergeHint', { count: copies.length, devices })}</span>
          </span>
        </button>
      </div>
      <ConfirmDialog
        open={open}
        presentation="standard"
        cancelFirst
        onOpenChange={(next) => { if (!next && !inFlight.current) setOpen(false); }}
        title={t('bots.cloud.mergeTitle', { count: copies.length })}
        description={t('bots.cloud.mergeDescription')}
        content={(
          <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('bots.cloud.mergeKeep')}>
            <p className="text-13 text-[var(--text-secondary)]">{t('bots.cloud.mergeKeep')}</p>
            {copies.map((copy) => {
              const selected = copy.botId === kept.botId;
              return (
                <button
                  key={copy.botId}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setKeep(copy.botId)}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-lg border border-[var(--border-default)] px-3 py-2 text-left text-14 outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                    selected && 'bg-[var(--surface-hover)]',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[var(--text-primary)]">{copy.name}</span>
                    <span className="block truncate text-12 text-[var(--text-secondary)]">{t('bots.cloud.runsOn', { device: deviceName(copy) })}</span>
                  </span>
                  {selected ? <Check size={16} className="shrink-0 text-[var(--text-primary)]" /> : null}
                </button>
              );
            })}
            {error ? <p role="alert" className="text-12 text-[var(--text-danger)]">{error}</p> : null}
          </div>
        )}
        confirmText={t('bots.cloud.mergeAction')}
        cancelText={t('bots.cancel')}
        loading={busy}
        onConfirm={() => void merge()}
      />
    </div>
  );
}
