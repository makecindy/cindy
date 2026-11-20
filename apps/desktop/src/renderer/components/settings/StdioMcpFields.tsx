import { useRef, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SettingsTextInput } from './SettingsTextInput';
import './stdio-mcp-fields.css';
import { customMcpSettings } from './McpServerDialog.settings-search';

export interface McpArgRow { key: number; value: string }
export interface McpEnvRow { key: number; name: string; value: string; saved: boolean; changed: boolean }

/** Existing secret values never leave Main; unchanged rows preserve their saved value. */
export function StdioMcpFields({ id, command, setCommand, cwd, setCwd, args, setArgs, env, setEnv, errors }: {
  id: string;
  command: string; setCommand: (value: string) => void;
  cwd: string; setCwd: (value: string) => void;
  args: McpArgRow[]; setArgs: Dispatch<SetStateAction<McpArgRow[]>>;
  env: McpEnvRow[]; setEnv: Dispatch<SetStateAction<McpEnvRow[]>>;
  errors: { command?: string; args?: string; cwd?: string; env?: string };
}) {
  const { t } = useTranslation();
  const nextKey = useRef(Math.max(-1, ...args.map(row => row.key), ...env.map(row => row.key)) + 1);
  const focus = (field: string) => requestAnimationFrame(() => document.getElementById(`${id}-${field}`)?.focus());
  return <>
    <FormField id={`${id}-command`} label={t(customMcpSettings.command.titleKey)} required
      hint={t(customMcpSettings.command.descriptionKey)} error={errors.command}>
      {control => <SettingsTextInput {...control} data-setting-id={customMcpSettings.command.id}
        surface="ivory" value={command} onChange={setCommand} placeholder="uvx" />}
    </FormField>
    <fieldset className="flex min-w-0 flex-col gap-2" id={`${id}-args`} tabIndex={-1}
      aria-describedby={`${id}-args-help`} aria-invalid={!!errors.args}>
      <legend className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">{t(customMcpSettings.args.titleKey)}</legend>
      <p id={`${id}-args-help`} role={errors.args ? 'alert' : undefined} className={errors.args ? 'text-12 text-[var(--text-danger)]' : 'text-12 text-[var(--text-secondary)]'}>{errors.args ?? t(customMcpSettings.args.descriptionKey)}</p>
      {args.map((row, index) => <div key={row.key} className="flex min-w-0 items-center gap-2">
        <FormField id={`${id}-arg-${row.key}`} label={`${t(customMcpSettings.args.titleKey)} ${index + 1}`} hideLabel className="min-w-0 flex-1">
          {control => <SettingsTextInput {...control} data-setting-id={customMcpSettings.args.id} surface="ivory"
            value={row.value} onChange={value => setArgs(rows => rows.map(item => item.key === row.key ? { ...item, value } : item))} />}
        </FormField>
        <Button variant="secondary" size="lg" className="w-9 shrink-0 px-0" aria-label={`${t('settings.mcp.fields.removeArg')} ${index + 1}`}
          data-settings-search-action="Remove this command argument" onClick={() => {
            const next = args[index + 1] ?? args[index - 1];
            setArgs(rows => rows.filter(item => item.key !== row.key));
            focus(next ? `arg-${next.key}` : 'add-arg');
          }}><Trash2 size={16} /></Button>
      </div>)}
      <Button id={`${id}-add-arg`} variant="secondary" className="gap-1.5 self-start"
        data-settings-search-action="Add a separate command argument" onClick={() => {
          const key = nextKey.current++;
          setArgs(rows => [...rows, { key, value: '' }]); focus(`arg-${key}`);
        }}><Plus size={14} />{t('settings.mcp.fields.addArg')}</Button>
    </fieldset>
    <FormField id={`${id}-cwd`} label={t(customMcpSettings.cwd.titleKey)} hint={t(customMcpSettings.cwd.descriptionKey)} error={errors.cwd}>
      {control => <SettingsTextInput {...control} data-setting-id={customMcpSettings.cwd.id}
        surface="ivory" value={cwd} onChange={setCwd} />}
    </FormField>
    <fieldset className="flex min-w-0 flex-col gap-2" id={`${id}-env`} tabIndex={-1}
      aria-describedby={`${id}-env-help`} aria-invalid={!!errors.env}>
      <legend className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">{t(customMcpSettings.env.titleKey)}</legend>
      <p id={`${id}-env-help`} role={errors.env ? 'alert' : undefined} className={errors.env ? 'text-12 text-[var(--text-danger)]' : 'text-12 text-[var(--text-secondary)]'}>{errors.env ?? t(customMcpSettings.env.descriptionKey)}</p>
      {env.length > 0 && <div className="mcp-env-fields">
        <div aria-hidden="true" className="mcp-env-head pb-1.5 text-12 text-[var(--text-secondary)]">
          <span>{t('settings.mcp.fields.envName')}</span>
          <span>{t('settings.mcp.fields.envValue')}</span>
        </div>
        {env.map((row, index) => <div key={row.key}
          className="mcp-env-row">
          <FormField id={`${id}-env-${row.key}-name`} label={`${t('settings.mcp.fields.envName')} ${index + 1}`} hideLabel>
            {control => <SettingsTextInput {...control} data-setting-id={customMcpSettings.env.id}
              surface="ivory" readOnly={row.saved} value={row.name} placeholder={t('settings.mcp.fields.envName')}
              spellCheck={false}
              onChange={name => setEnv(rows => rows.map(item => item.key === row.key ? { ...item, name } : item))} />}
          </FormField>
          <FormField id={`${id}-env-${row.key}-value`} label={`${t('settings.mcp.fields.envValue')} ${index + 1}`} hideLabel
            className="mcp-env-value">
            {control => <SettingsTextInput {...control} data-setting-id={customMcpSettings.env.id}
              surface="ivory" secret secretTipContentClassName="z-[10001]" value={row.value}
              autoComplete="off" spellCheck={false}
              placeholder={t(row.saved && !row.changed ? 'settings.mcp.fields.envSaved' : 'settings.mcp.fields.envValue')}
              onChange={value => setEnv(rows => rows.map(item => item.key === row.key ? { ...item, value, changed: true } : item))} />}
          </FormField>
          <Button variant="secondary" tone="quiet" size="lg"
            className="mcp-env-remove w-9 px-0"
            aria-label={`${t('settings.mcp.fields.removeEnv')} ${index + 1}`}
            data-settings-search-action="Remove this environment variable" onClick={() => {
              const next = env[index + 1] ?? env[index - 1];
              setEnv(rows => rows.filter(item => item.key !== row.key));
              focus(next ? `env-${next.key}-name` : 'add-env');
            }}><Trash2 size={16} /></Button>
        </div>)}
      </div>}
      <Button id={`${id}-add-env`} variant="secondary" className="gap-1.5 self-start"
        data-settings-search-action="Add an environment variable" onClick={() => {
          const key = nextKey.current++;
          setEnv(rows => [...rows, { key, name: '', value: '', saved: false, changed: false }]); focus(`env-${key}-name`);
        }}><Plus size={14} />{t('settings.mcp.fields.addEnv')}</Button>
    </fieldset>
  </>;
}
