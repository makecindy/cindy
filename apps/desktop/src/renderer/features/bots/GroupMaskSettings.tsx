import { useEffect, useRef } from 'react';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Select, type SelectProps } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { GroupMaskStatusText } from './GroupMaskControls';
import { useGroupMask, type GroupMaskTrigger } from './groupMaskPresentation';

function FieldSelect(props: SelectProps) { return <FormField label={props.label}>{field => <Select {...props} {...field} className="w-full" />}</FormField>; }

const key = (name: string) => `bots.groupChat.mask.${name}`;
export function GroupMaskSettings({ groupId }: { groupId: string }) {
  const mask = useGroupMask(groupId);
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const current = useRef(mask); current.current = mask;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!mask) return null;
  if (mask.loading) return <div className="p-5 text-13 text-[var(--text-secondary)]" role="status">{t(key('loading'))}</div>;
  const { settings: config, update, saving } = mask;
  return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5" data-testid="group-mask-settings">
    <FieldSelect label={t(key('companion'))} value={config.companionId ?? ''} disabled={saving}
      options={mask.companions.map(c => ({ value: c.id, label: c.name }))}
      onValueChange={companionId => update({ companionId })} />
    <label className="flex items-center justify-between gap-4 text-13"><span>{t(key('enabled'))}</span>
      <Switch checked={config.enabled} disabled={saving || !config.companionId} aria-label={t(key('enabled'))} onCheckedChange={enabled => update({ enabled })} /></label>
    {mask.toolAccessSupported && <FieldSelect label={t(key('toolAccess'))} value={config.access ?? 'chat'} disabled={saving}
      options={(['chat', 'tools'] as const).map(value => ({ value, label: t(`bots.groupChat.server.settings.${value}`) }))}
      onValueChange={async access => {
        const owner = getDataOwnerGeneration(), companionId = config.companionId;
        if (access === 'tools' && !await confirm({ presentation:'standard',
          title:t('bots.groupChat.server.settings.authorizeTitle', {name:mask.companions.find(c=>c.id===config.companionId)?.name ?? ''}),
          description:t('bots.groupChat.server.settings.toolsHint'), confirmText:t('bots.groupChat.server.settings.confirm'),
          cancelText:t('bots.cancel'), confirmVariant:'destructive' })) return;
        if (mounted.current && isDataOwnerGenerationCurrent(owner) && current.current?.groupId === groupId && current.current.settings.companionId === companionId)
          current.current.update({access:access as 'chat' | 'tools'});
      }} />}
    {config.enabled && <>
      <FieldSelect label={t(key('triggerLabel'))} value={config.trigger} disabled={saving}
        options={(['scheduled', 'manual', 'always'] as const).map(value => ({ value, label: t(key(`trigger.${value}`)) }))}
        onValueChange={trigger => update({ trigger: trigger as GroupMaskTrigger })} />
      {config.trigger === 'always' && <FieldSelect label={t(key('resumeAfter'))} value={String(config.resumeMinutes)} disabled={saving}
        options={[5, 15, 30, 60].map(value => ({ value: String(value), label: t(key('minutes'), { count: value }) }))}
        onValueChange={value => update({ resumeMinutes: Number(value) })} />}
      {config.trigger === 'scheduled' && <div className="grid grid-cols-2 gap-3">
        {(['start', 'end'] as const).map(field => <FormField key={field} label={t(key(field))}>{props => <input {...props} type="time" value={config[field]} disabled={saving}
          className="h-9 min-w-0 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 [color-scheme:light_dark]"
          onChange={event => event.target.value && update({ [field]: event.target.value })} />}</FormField>)}
      </div>}
      {config.trigger === 'manual' && <Button size="sm" variant="secondary" disabled={saving} onClick={mask.manualRunning ? mask.stopManual : mask.resume}>
        {t(key(mask.manualRunning ? 'stop' : 'startManual'))}</Button>}
    </>}
    <p className="text-12 leading-normal text-[var(--text-secondary)]" role="status">{saving ? t(key('saving')) : <GroupMaskStatusText mask={mask} />}</p>
    {mask.error && <div role="alert" className="flex items-center gap-3 text-13 text-[var(--error-fg)]"><span className="flex-1">{t(key('saveError'))}</span>
      <Button variant="secondary" size="sm" onClick={mask.retry}>{t(key('retry'))}</Button></div>}
    <div className="space-y-5 border-t border-[var(--border-default)] pt-5">
      <label className="flex items-center justify-between gap-4 text-13"><span>{t(key('todos'))}</span>
        <Switch checked={config.collectTodos} disabled={saving} aria-label={t(key('todos'))} onCheckedChange={collectTodos => update({ collectTodos })} /></label>
      {config.collectTodos && <FieldSelect label={t(key('digestLabel'))} value={config.digest} disabled={saving}
        options={(['daily', 'manual'] as const).map(value => ({ value, label: t(key(`digest.${value}`)) }))}
        onValueChange={digest => update({ digest: digest as 'daily' | 'manual' })} />}
      {config.collectTodos && mask.requestDigest && <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={saving || !config.companionId || mask.digestStatus === 'queued' || mask.digestStatus === 'running'} onClick={mask.requestDigest}>
          {t(key(mask.digestStatus === 'queued' || mask.digestStatus === 'running' ? 'digestWorking' : 'digestNow'))}
        </Button>
        {mask.digestStatus === 'done' && <span role="status" className="text-12 text-[var(--text-secondary)]">{t(key('digestSent'))}</span>}
        {mask.digestStatus === 'empty' && <span role="status" className="text-12 text-[var(--text-secondary)]">{t(key('digestEmpty'))}</span>}
        {mask.digestStatus === 'failed' && <span role="alert" className="text-12 text-[var(--error-fg)]">{t(key('digestFailed'))}</span>}
      </div>}
    </div>
  </div>;
}
