import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import type { ManagementItem } from '../../../shared/settingsManagement';

type Action = ManagementItem['actions'][number];
export function cloudBotActionLabel(item: ManagementItem, action: Action) {
  const channel = item.id.replace(/^bot:/, '');
  if (action.intent === 'connect' && channel === 'feishu') return 'settings.feishuBot.bind';
  if (action.intent === 'reconnect') return 'settings.feishuBot.saved.reconnect';
  if (action.intent === 'connect') return `settings.${channel}Bot.connect`;
  if (action.label === 'management.actions.create') return 'settings.remoteControl.hook.multi.addWorkspace';
  return action.intent === 'disconnect'
    ? 'settings.providers.button.disconnect'
    : 'settings.providers.button.authorize';
}

/** Same native fields, transient inputs; saved secrets are never read back. */
export function CloudBotConnectionForm({
  item,
  action,
  disabled,
  submit,
}: {
  item: ManagementItem;
  action: Action;
  disabled: boolean;
  submit(values: Record<string, string>): Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const value = (field: Action['fields'][number]) =>
    values[field.name] ?? (field.kind === 'password' ? '' : (field.value ?? ''));
  const valid = action.fields.every((field) => {
    const v = value(field);
    return (
      (!field.required || !!v.trim()) &&
      v.length <= field.maxLength &&
      (field.kind !== 'select' || field.options?.some((option) => option.value === v))
    );
  });
  const channel = item.id.replace(/^bot:/, '');
  return (
    <form
      className="flex flex-col gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !valid) return;
        const submitted = Object.fromEntries(
          action.fields.map((field) => [field.name, value(field)]),
        );
        setValues({});
        void submit(submitted).finally(() => {
          for (const key of Object.keys(submitted)) delete submitted[key];
        });
      }}
    >
      {action.fields.map((field) => {
        const label = t(`settings.${channel}Bot.${field.name}Label`, { defaultValue: field.name });
        return (
          <FormField
            key={field.name}
            label={label}
            id={`${id}-${field.name}`}
            required={field.required}
          >
            {() =>
              field.kind === 'select' ? (
                <SegmentedControl
                  aria-label={label}
                  value={value(field)}
                  disabled={disabled}
                  options={field.options ?? []}
                  onValueChange={(next) => setValues((old) => ({ ...old, [field.name]: next }))}
                />
              ) : (
                <SettingsTextInput
                  id={`${id}-${field.name}`}
                  aria-label={label}
                  type={field.kind === 'password' ? 'password' : 'text'}
                  autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                  spellCheck={false}
                  value={value(field)}
                  maxLength={field.maxLength}
                  required={field.required}
                  disabled={disabled}
                  onChange={(next) => setValues((old) => ({ ...old, [field.name]: next }))}
                />
              )
            }
          </FormField>
        );
      })}
      <div>
        <Button type="submit" variant="secondary" size="md" disabled={disabled || !valid}>
          {t(cloudBotActionLabel(item, action))}
        </Button>
      </div>
    </form>
  );
}
