import { useEffect, useRef } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select, type SelectProps } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cn } from '@/lib/utils';
import { GroupMaskAvatar, GroupMaskStatusText } from './GroupMaskControls';
import { useGroupMask, type GroupMaskTrigger } from './groupMaskPresentation';
import { SETTINGS_DIVIDER, SETTINGS_HINT, SettingsCard, SettingsNotice, SettingsRow, SettingsRowIcon } from './ChatGroupSettingsRows';
import { Reply } from 'lucide-react';

/** A setting row whose choice sits on the right, in the group settings' row look. */
function SelectRow(props: SelectProps) {
  return <SettingsRow wrap title={props.label} trailing={<Select {...props} className="h-8 max-w-[220px]" />} />;
}

const key = (name: string) => `bots.groupChat.mask.${name}`;
/** AI 代答: your own setting in this group, one card per concern (who, when, to-dos). */
export function GroupMaskSettings({ groupId }: { groupId: string }) {
  const mask = useGroupMask(groupId);
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const current = useRef(mask); current.current = mask;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!mask) return null;
  if (mask.loading) return <div className={cn('p-5 text-13', 'text-[var(--text-secondary)]')} role="status">{t(key('loading'))}</div>;
  const { settings: config, update, saving } = mask;
  const companion = mask.companions.find(c => c.id === config.companionId);
  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="group-mask-settings">
    <div className="flex animate-fade-in flex-col gap-6 px-5 pb-8 pt-5">
      <SettingsCard>
        <SettingsRow media lead={companion ? <GroupMaskAvatar self={mask.self} companion={companion} /> : <SettingsRowIcon><Reply size={16} aria-hidden /></SettingsRowIcon>}
          title={t(key('title'))} hint={<span role="status">{saving ? t(key('saving')) : <GroupMaskStatusText mask={mask} />}</span>}
          value={t(key(`status.${mask.status}`))} />
      </SettingsCard>
      {mask.error && <SettingsNotice tone="error" action={<Button variant="secondary" size="sm" onClick={mask.retry}>{t(key('retry'))}</Button>}>{t(key('saveError'))}</SettingsNotice>}
      <SettingsCard>
        <SelectRow label={t(key('companion'))} value={config.companionId ?? ''} disabled={saving} truncateOptions
          options={mask.companions.map(c => ({ value: c.id, label: c.name }))}
          onValueChange={companionId => update({ companionId })} />
        <SettingsRow title={t(key('enabled'))} trailing={<Switch checked={config.enabled} disabled={saving || !config.companionId} aria-label={t(key('enabled'))}
          onCheckedChange={enabled => update({ enabled })} />} />
        {mask.toolAccessSupported && <SelectRow label={t(key('toolAccess'))} value={config.access ?? 'chat'} disabled={saving}
          options={(['chat', 'tools'] as const).map(value => ({ value, label: t(`bots.groupChat.server.settings.${value === 'tools' ? 'accessTools' : 'accessChat'}`) }))}
          onValueChange={async access => {
            const owner = getDataOwnerGeneration(), companionId = config.companionId;
            if (access === 'tools' && !await confirm({ presentation: 'standard',
              title: t('bots.groupChat.server.settings.authorizeTitle', { name: mask.companions.find(c => c.id === config.companionId)?.name ?? '' }),
              description: t('bots.groupChat.server.settings.toolsHint'), confirmText: t('bots.groupChat.server.settings.confirm'),
              cancelText: t('bots.cancel'), confirmVariant: 'destructive' })) return;
            if (mounted.current && isDataOwnerGenerationCurrent(owner) && current.current?.groupId === groupId && current.current.settings.companionId === companionId)
              current.current.update({ access: access as 'chat' | 'tools' });
          }} />}
      </SettingsCard>
      {config.enabled && <SettingsCard>
        <SelectRow label={t(key('triggerLabel'))} value={config.trigger} disabled={saving}
          options={(['scheduled', 'manual', 'always'] as const).map(value => ({ value, label: t(key(`trigger.${value}`)) }))}
          onValueChange={trigger => update({ trigger: trigger as GroupMaskTrigger })} />
        {config.trigger === 'always' && <SelectRow label={t(key('resumeAfter'))} value={String(config.resumeMinutes)} disabled={saving}
          options={[5, 15, 30, 60].map(value => ({ value: String(value), label: t(key('minutes'), { count: value }) }))}
          onValueChange={value => update({ resumeMinutes: Number(value) })} />}
        {config.trigger === 'scheduled' && <SettingsRow wrap title={t(key('hours'))} trailing={<span className="flex items-center gap-2">
          {(['start', 'end'] as const).map((field, index) => <span key={field} className="contents">
            {index > 0 && <span aria-hidden className="text-[var(--text-tertiary)]">–</span>}
            <input type="time" aria-label={t(key(field))} value={config[field]} disabled={saving}
              className="h-8 w-[104px] rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 tabular-nums text-[var(--text-primary)] outline-none [color-scheme:light_dark] focus:border-[var(--text-tertiary-stone)] focus:ring-2 focus:ring-[var(--focus-ring-soft)] disabled:opacity-60"
              onChange={event => event.target.value && update({ [field]: event.target.value })} />
          </span>)}
        </span>} />}
        {config.trigger === 'manual' && <div className={cn('px-4 py-3', SETTINGS_DIVIDER)}>
          <Button size="sm" variant="secondary" disabled={saving} onClick={mask.manualRunning ? mask.stopManual : mask.resume}>
            {t(key(mask.manualRunning ? 'stop' : 'startManual'))}</Button>
        </div>}
      </SettingsCard>}
      <SettingsCard>
        <SettingsRow title={t(key('todos'))} trailing={<Switch checked={config.collectTodos} disabled={saving} aria-label={t(key('todos'))}
          onCheckedChange={collectTodos => update({ collectTodos })} />} />
        {config.collectTodos && <SelectRow label={t(key('digestLabel'))} value={config.digest} disabled={saving}
          options={(['daily', 'manual'] as const).map(value => ({ value, label: t(key(`digest.${value}`)) }))}
          onValueChange={digest => update({ digest: digest as 'daily' | 'manual' })} />}
        {config.collectTodos && mask.requestDigest && <div className={cn('flex flex-wrap items-center gap-3 px-4 py-3', SETTINGS_DIVIDER)}>
          <Button variant="secondary" size="sm" disabled={saving || !config.companionId || mask.digestStatus === 'queued' || mask.digestStatus === 'running'} onClick={mask.requestDigest}>
            {t(key(mask.digestStatus === 'queued' || mask.digestStatus === 'running' ? 'digestWorking' : 'digestNow'))}
          </Button>
          {mask.digestStatus === 'done' && <span role="status" className="text-12 text-[var(--text-secondary)]">{t(key('digestSent'))}</span>}
          {mask.digestStatus === 'empty' && <span role="status" className="text-12 text-[var(--text-secondary)]">{t(key('digestEmpty'))}</span>}
          {mask.digestStatus === 'failed' && <span role="alert" className="text-12 text-[var(--text-danger)]">{t(key('digestFailed'))}</span>}
        </div>}
      </SettingsCard>
      <p className={cn('-mt-3', SETTINGS_HINT)}>{t(key('ownerOnly'))}</p>
    </div>
  </div>;
}
