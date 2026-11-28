/**
 * 路由详情里的「试一下」：列出每个来源这次会被选中、备用还是跳过及原因；只看不选(dry run)，不推进轮流、不记进「最近的选择」。
 * 按模型排的路由与合并整个供应商的路由共用这一块(2026-11-26：后者原来没有)。后者在每个模型上各是一条路由，先选一个模型再试。
 * 配置改过以后旧结果作废(resetKey 变了就不再显示)；选着要试的那个模型不变，免得改个权重下拉又跳回第一个。
 */
import { useMemo, useState } from 'react';
import { Check, CornerDownRight, Minus, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SettingsBlock, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import {
  modelGroupExceptionText,
  modelGroupWhyText,
  useModelGroupCandidateNames,
} from '@/features/model-groups/modelGroupsClient';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

import { modelGroupHarnessLabel } from '../../../shared/modelGroupRouteNoteText';
import { modelGroupCandidateKey, type ModelGroupResolveResult, type ModelGroupRoute } from '../../../shared/modelGroups';

const log = createLogger('ModelGroupRoutePreview');

export function ModelGroupRoutePreview({ routes, nameCandidates, resetKey }: {
  /** 路由配置的指纹：变了以后上一次的结果作废。 */
  resetKey: string;
  /** 可以试的路由：按模型排的路由是它自己一条；合并整个供应商的路由是它在每个模型上的展开(先选模型)。 */
  routes: readonly ModelGroupRoute[];
  /** 「试一下」里可能出现的来源(时段例外能改走到别的路由)，名字一起备好。 */
  nameCandidates: Parameters<typeof useModelGroupCandidateNames>[0];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const namesOf = useModelGroupCandidateNames(nameCandidates);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = routes.find((route) => route.id === chosen) ?? routes[0];
  const [preview, setPreview] = useState<{ routeId: string; resetKey: string; result: ModelGroupResolveResult } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const shown = target && preview?.routeId === target.id && preview.resetKey === resetKey ? preview.result : null;
  const modelOptions = useMemo(() => routes.map((route) => ({ value: route.id, label: route.name })), [routes]);
  const run = async () => {
    if (!target) return;
    setPreviewing(true);
    try {
      const result = await window.electronAPI.modelGroups.resolve({ selection: { type: 'route', id: target.id }, dryRun: true });
      setPreview({ routeId: target.id, resetKey, result });
    } catch (error) {
      log.warn('preview failed', error);
      toast.error(t('modelGroups.settings.try.failed'));
    } finally {
      setPreviewing(false);
    }
  };
  const picked = shown?.trace.find((item) => item.state === 'picked');
  // 自动选法下把胜出项排到最前、其次正常备用、再按量兜底与跳过项，方便一眼看清优先级。
  const orderedTrace = useMemo(() => {
    if (!shown) return [];
    if (target?.strategy !== 'expiring') return shown.trace;
    const rank = (entry: (typeof shown.trace)[number]) => {
      if (entry.state === 'picked') return 0;
      if (entry.state === 'standby') return entry.why === 'paygReserve' ? 2 : 1;
      return 3;
    };
    return shown.trace
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
      .map((item) => item.entry);
  }, [shown, target?.strategy]);
  return (
    <SettingsSection
      title={t('modelGroups.settings.try.title')}
      description={t('modelGroups.settings.try.hint')}
      action={
        <div className="flex min-w-0 items-center gap-2">
          {routes.length > 1 && (
            <Select data-settings-search-action="Chooses which model to preview; changes no setting" label={t('modelGroups.settings.try.model')} value={target?.id ?? ''} options={modelOptions}
              onValueChange={(value) => setChosen(value)} width="sm" className="shrink" />
          )}
          <Button variant="secondary" size="md" loading={previewing} disabled={!target || target.candidates.length === 0} onClick={() => void run()}
            data-settings-search-action="Previews which source a route would pick; changes no setting">
            <Play size={14} aria-hidden />
            {t('modelGroups.settings.try.run')}
          </Button>
        </div>
      }
    >
      {shown && (
        <SettingsCard data-testid="model-group-preview" className="animate-fade-in">
          {shown.outcome === 'routed' && shown.exceptions && shown.exceptions.length > 0 && (
            <SettingsBlock data-model-group-preview-exception className="text-13 leading-[1.5] text-[var(--text-secondary)]">
              {modelGroupExceptionText(shown.exceptions, t)}
            </SettingsBlock>
          )}
          {shown.outcome !== 'routed' && (
            <SettingsBlock className="text-13 leading-[1.5] text-[var(--text-secondary)]">{t('modelGroups.settings.try.unavailable')}</SettingsBlock>
          )}
          {orderedTrace.map((entry) => {
            const Icon = entry.state === 'picked' ? Check : entry.state === 'standby' ? CornerDownRight : Minus;
            // 同一个来源（同供应商、同位置、同账号槽位）的几个模型共用一份额度：备用的那几行不再重复写「先留着」。
            const sameSource = !!picked
              && entry.providerId === picked.providerId
              && (entry.agentDeviceId ?? null) === (picked.agentDeviceId ?? null)
              && (entry.accountId ?? null) === (picked.accountId ?? null);
            const sameQuota = entry.state === 'standby' && sameSource && !!picked?.quota && !!entry.quota
              && picked.quota.resetAtMs === entry.quota.resetAtMs && picked.quota.usedPercent === entry.quota.usedPercent;
            // 名字与路由里那一行相同(含运行位置)；设置页还没读到那边的目录时用这次选路读到的。
            const names = namesOf(entry, entry);
            return (
              <SettingsRow
                key={modelGroupCandidateKey(entry)}
                data-model-group-trace={entry.state}
                lead={<Icon size={15} aria-hidden className={entry.state === 'picked' ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'} />}
                title={[names.modelName, names.sourceLabel, modelGroupHarnessLabel(entry.agentKind)].filter(Boolean).join(' · ')}
                tag={t(`modelGroups.settings.try.${entry.state}`)}
                hint={modelGroupWhyText(sameQuota ? { ...entry, quota: null } : entry, t, locale, picked)}
              />
            );
          })}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
