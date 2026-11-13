import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isGhostHostUiSettingValue, type GhostHostUiSetting } from '@cindy/plugin-protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsPageHeader, SettingsRow } from '@/components/ui/settings-rows';
import { useAppSettingsRevision } from '@/hooks/useAppSettingsRevision';
import { toast } from '@/lib/toast';

interface SettingsState { value: Record<string, unknown>; customizedKeys: string[] }

/** Mount only when this plugin's native settings page is selected. */
export function PluginSettingsFields({ instanceId, title, fields }: {
  instanceId: string; title: string; fields: readonly GhostHostUiSetting[];
}) {
  const { t } = useTranslation();
  const revision = useAppSettingsRevision(`plugins.${instanceId}`);
  const [state, setState] = useState<SettingsState | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const currentState = useRef(state); currentState.current = state;
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const apply = (next: SettingsState, preserve: boolean) => {
    const previous = currentState.current;
    setDraft(draft => Object.fromEntries(fields.map(field => [field.id,
      preserve && previous && !Object.is(draft[field.id], previous.value[field.id])
        ? draft[field.id] : next.value[field.id],
    ])));
    setState(next); setFailed(false);
  };
  useEffect(() => {
    const request = ++sequence.current;
    void window.electronAPI.maker.mcpApps(null, { op: 'plugin-settings', instanceId, operation: 'get' })
      .then(result => {
        if (sequence.current !== request) return;
        if (!result || typeof result !== 'object' || !('state' in result)) throw new Error('INVALID_SETTINGS_RESULT');
        apply(result.state as SettingsState, true);
      }).catch(() => { if (sequence.current === request) setFailed(true); });
    return () => { sequence.current++; };
  }, [instanceId, fields, revision]);
  const update = async (operation: 'update' | 'reset', patch?: Record<string, unknown>) => {
    sequence.current++;
    setBusy(true);
    try {
      const result = await window.electronAPI.maker.mcpApps(null, { op: 'plugin-settings', instanceId, operation, ...(patch ? { patch } : {}) });
      if (!mounted.current) return;
      sequence.current++;
      if (!result || typeof result !== 'object' || !('state' in result)) throw new Error('INVALID_SETTINGS_RESULT');
      apply(result.state as SettingsState, false);
    } catch { if (mounted.current) toast.error(t('pluginUi.settingsFailed')); }
    finally { if (mounted.current) setBusy(false); }
  };
  const values = Object.fromEntries(fields.map(field => [field.id, field.type === 'number' &&
    typeof draft[field.id] === 'string' && (draft[field.id] as string).trim() !== '' ? Number(draft[field.id]) : draft[field.id]]));
  const invalid = fields.some(field => !isGhostHostUiSettingValue(field, values[field.id]));
  const patch = Object.fromEntries(fields.filter(field => !Object.is(values[field.id], state?.value[field.id]))
    .map(field => [field.id, values[field.id]]));
  const root = `plugin-settings-${instanceId}`;
  return <div id={root} className="flex flex-col gap-6 pt-7 pb-8">
    <SettingsPageHeader title={title} action={<div className="flex shrink-0 gap-2">
      <Button data-settings-search-action="Restore registered plugin settings to their defaults" variant="secondary" size="md" disabled={busy || !state?.customizedKeys.length}
        onClick={() => void update('reset')}>{t('settings.defaults.restore')}</Button>
      <Button data-settings-search-action="Save edited registered plugin settings" variant="primary" size="md" disabled={busy || !state || invalid || !Object.keys(patch).length}
        onClick={() => void update('update', patch)}>{t('pluginUi.save')}</Button>
    </div>} />
    {failed ? <p role="alert" className="text-sm text-[var(--error-fg)]">{t('pluginUi.settingsFailed')}</p> : !state
      ? <p role="status" className="text-sm text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>
      : <SettingsCard>{fields.map(field => <SettingsRow key={field.id} id={`${root}-${field.id}`}
        title={field.title} hint={field.description} wrap trailing={field.options
          ? <Select data-settings-search-action="Edit a plugin option indexed from the approved manifest" data-setting-id={`${root}-${field.id}`} label={field.title} value={String(field.options.findIndex(option => Object.is(option.value, draft[field.id])))}
            options={field.options.map((option, index) => ({ label: option.label, value: String(index) }))}
            disabled={busy} onValueChange={index => setDraft(value => ({ ...value, [field.id]: field.options![Number(index)].value }))} />
          : field.type === 'boolean'
            ? <Switch data-settings-search-action="Edit a plugin switch indexed from the approved manifest" data-setting-id={`${root}-${field.id}`} checked={draft[field.id] === true} disabled={busy} aria-label={field.title}
              onCheckedChange={checked => setDraft(value => ({ ...value, [field.id]: checked }))} />
            : <Input data-settings-search-action="Edit a plugin value indexed from the approved manifest" data-setting-id={`${root}-${field.id}`} ariaLabel={field.title} type={field.type === 'number' ? 'number' : 'text'}
              min={field.min} max={field.max} maxLength={field.maxLength} step="any" disabled={busy}
              value={String(draft[field.id] ?? '')} error={!isGhostHostUiSettingValue(field, values[field.id])}
              onChange={next => setDraft(value => ({ ...value, [field.id]: next }))} className="w-full max-w-72" />}
      />)}</SettingsCard>}
    {state && invalid && <p role="alert" className="text-12 text-[var(--error-fg)]">{t('pluginUi.invalidSetting')}</p>}
  </div>;
}
