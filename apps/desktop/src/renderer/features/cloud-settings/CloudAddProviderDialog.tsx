import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from '@/components/settings/OAuthDeviceCodeCard';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import type { useCloudAuthorization } from './useCloudAuthorization';
import { CloudAuthProgress } from './CloudAuthProgress';

type Action = ManagementItem['actions'][number];
type Field = Action['fields'][number];
type Auth = ReturnType<typeof useCloudAuthorization>;
type Phase = Extract<ManagementResult, { kind: 'operation' }>['phase'];

/** One choice of the instance's add actions; an API preset option becomes its own row. */
interface Choice {
  key: string;
  item: ManagementItem;
  action: Action;
  group: 'subscription' | 'apiKey' | 'custom';
  name: string;
  logo: string;
  fixed?: Record<string, string>;
}

const FIELD_LABEL: Record<string, string> = {
  name: 'settings.providers.custom.fields.name',
  baseUrl: 'settings.providers.custom.fields.baseUrl',
  apiKey: 'settings.providers.custom.fields.apiKey',
  protocol: 'settings.providers.custom.fields.wireProtocol',
  models: 'settings.providers.custom.fields.models',
};
const FIELD_PLACEHOLDER: Record<string, string> = {
  name: 'settings.providers.custom.fields.namePlaceholder',
  baseUrl: 'settings.providers.custom.fields.baseUrlPlaceholder',
  apiKey: 'settings.providers.custom.fields.apiKeyPlaceholder',
  models: 'settings.providers.custom.fields.modelIdPlaceholder',
};

/**
 * @param unlisted Built-in providers not shown in the rail; their sign-in is offered here,
 *   as the local wizard offers a built-in subscription that is not connected.
 */
export function cloudAddChoices(
  items: readonly ManagementItem[],
  unlisted: ReadonlySet<string> = new Set(),
): Choice[] {
  const choices: Choice[] = [];
  for (const item of items) {
    const id = item.id;
    if (id.startsWith('provider:') && unlisted.has(id.slice('provider:'.length))) {
      const action = item.actions.find((a) => a.intent === 'authorize' && !a.fields.length);
      if (action)
        choices.push({
          key: id,
          item,
          action,
          group: 'subscription',
          name: item.label,
          logo: id.slice('provider:'.length),
        });
    } else if (id === 'add:api-preset') {
      const action = item.actions.find((a) => a.intent === 'create');
      const preset = action?.fields.find((field) => field.name === 'preset');
      for (const option of preset?.options ?? [])
        choices.push({
          key: `${id}:${option.value}`,
          item,
          action: action!,
          group: 'apiKey',
          name: option.label,
          logo: option.value,
          fixed: { preset: option.value },
        });
    } else if (id === 'add:custom') {
      const action = item.actions.find((a) => a.intent === 'create');
      if (action)
        choices.push({ key: id, item, action, group: 'custom', name: item.label, logo: '' });
    } else if (id.startsWith('add:')) {
      const action = item.actions.find((a) => a.intent === 'authorize' && !a.fields.length);
      if (action)
        choices.push({
          key: id,
          item,
          action,
          group: 'subscription',
          name: item.label,
          logo: id.slice(4),
        });
    } else if (id.startsWith('builtin-key:') && item.status !== 'connected') {
      const action = item.actions.find((a) => a.intent === 'connect' && a.fields.length);
      if (action)
        choices.push({
          key: id,
          item,
          action,
          group: 'apiKey',
          name: item.label,
          logo: id.slice('builtin-key:'.length),
        });
    }
  }
  return choices;
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="block px-2 pb-1.5 pt-3 text-11 font-medium uppercase"
      style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
    >
      {children}
    </span>
  );
}

function ChoiceIcon({ choice }: { choice: Choice }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
      style={{
        backgroundColor: 'var(--settings-integration-avatar-bg)',
        border: '1px solid var(--settings-integration-avatar-border)',
        color: 'var(--settings-integration-avatar-icon)',
      }}
    >
      {choice.group === 'custom' ? (
        <Plus size={14} />
      ) : hasProviderLogo(choice.logo) ? (
        <ProviderLogoMark providerId={choice.logo} size={14} />
      ) : (
        <span className="text-13 font-medium leading-none">{choice.name.slice(0, 1)}</span>
      )}
    </span>
  );
}

/** The local wizard's first step, listing what the instance can add; connecting runs on the instance. */
export function CloudAddProviderDialog({
  open,
  onOpenChange,
  auth,
  disabled,
  run,
  unlisted,
  start,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  auth: Auth;
  disabled: boolean;
  run: (item: ManagementItem, action: Action, values?: Record<string, string>) => Promise<Phase>;
  unlisted?: ReadonlySet<string>;
  /** Provider id to begin with, as a local CLI suggestion opens the wizard at its sign-in. */
  start?: string | null;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [query, setQuery] = useState('');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const choices = useMemo(() => cloudAddChoices(auth.items, unlisted), [auth.items, unlisted]);
  useEffect(() => {
    if (open) return;
    setQuery('');
    setChoice(null);
    setValues({});
  }, [open]);
  const owns = !!choice && auth.operationItem === choice.item.id;
  const prompt = owns ? auth.prompt : undefined;
  const fields = choice?.action.fields.filter((field) => !choice.fixed?.[field.name]) ?? [];
  const value = (field: Field) =>
    values[field.name] ?? (field.kind === 'password' ? '' : (field.value ?? ''));
  const valid = fields.every((field) => {
    const v = value(field);
    return (
      (!field.required || !!v.trim()) &&
      v.length <= field.maxLength &&
      (field.kind !== 'select' || !!field.options?.some((option) => option.value === v))
    );
  });
  const submit = async (picked: Choice, submitted: Record<string, string>) => {
    const phase = await run(picked.item, picked.action, { ...submitted, ...picked.fixed });
    if (phase === 'succeeded') onOpenChange(false);
  };
  useEffect(() => {
    if (!open || !start) return;
    const picked = choices.find(
      (c) =>
        c.group === 'subscription' && (c.key === `provider:${start}` || c.key === `add:${start}`),
    );
    if (!picked) return;
    setChoice(picked);
    if (!picked.action.fields.length) void submit(picked, {});
    // Only when opened for a suggestion; later choice changes are the user's.
  }, [open, start]);
  const q = query.trim().toLowerCase();
  const visible = q ? choices.filter((c) => c.name.toLowerCase().includes(q)) : choices;
  const meta = {
    subscription: t('settings.providers.wizard.metaOAuth'),
    apiKey: t('settings.providers.wizard.metaApiKey'),
    custom: t('settings.providers.wizard.customAction'),
  };
  const groupTitle = {
    subscription: t('settings.providers.wizard.groupSubscription'),
    apiKey: t('settings.providers.wizard.groupApiKey'),
    custom: t('settings.providers.wizard.groupCustom'),
  };
  const title = choice
    ? t('settings.providers.wizard.titleWith', {
        name: choice.group === 'custom' ? t('settings.providers.wizard.groupCustom') : choice.name,
      })
    : t('settings.providers.wizard.title');
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !auth.busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE} />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          style={WINDOW_NO_DRAG_STYLE}
          className="modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[min(640px,85vh)] w-[min(600px,calc(100vw-32px))] flex-col overflow-hidden outline-none"
        >
          <div className="flex items-center justify-between gap-4 px-4 pb-3 pt-4">
            <Dialog.Title asChild>
              <h3
                className="min-w-0 break-words text-16 font-medium"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {title}
              </h3>
            </Dialog.Title>
            <Dialog.Close
              disabled={auth.busy}
              className="shrink-0 rounded-full p-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--settings-menu-bg-hover)] hover:text-[var(--text-primary)]"
              aria-label={t('settings.providers.wizard.closeAria')}
            >
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          {!choice ? (
            <div className="flex min-h-0 flex-col px-4 pb-4">
              <p className="pb-2 text-12" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.providers.wizard.stepPick')}
              </p>
              <SettingsTextInput
                aria-label={t('settings.providers.wizard.searchPlaceholder')}
                placeholder={t('settings.providers.wizard.searchPlaceholder')}
                value={query}
                onChange={setQuery}
              />
              <div className="mt-1 min-h-0 overflow-y-auto">
                {(['subscription', 'apiKey', 'custom'] as const).map((group) => {
                  const rows = visible.filter((c) => c.group === group);
                  if (!rows.length) return null;
                  return (
                    <div key={group}>
                      <GroupLabel>{groupTitle[group]}</GroupLabel>
                      {rows.map((row) => (
                        <button
                          key={row.key}
                          type="button"
                          title={row.name}
                          disabled={disabled}
                          onClick={() => {
                            setChoice(row);
                            setValues({});
                            if (!row.action.fields.length) void submit(row, {});
                          }}
                          className="flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
                        >
                          <ChoiceIcon choice={row} />
                          <span
                            className="min-w-0 flex-1 truncate text-13 font-medium"
                            style={{ color: 'var(--settings-section-title)' }}
                          >
                            {row.group === 'custom'
                              ? t('settings.providers.wizard.groupCustom')
                              : row.name}
                          </span>
                          <span
                            className="min-w-0 truncate text-11"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            {meta[row.group]}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
              {fields.length === 0 ? (
                <>
                  <p className="text-13" style={{ color: 'var(--text-secondary)' }}>
                    {t('settings.providers.wizard.oauthDesc')}
                  </p>
                  {prompt?.kind === 'device' && prompt.userCode ? (
                    <OAuthDeviceCodeCard
                      deviceCode={{
                        verificationUrl: prompt.url,
                        userCode: prompt.userCode,
                        expiresAt: prompt.expiresAt,
                      }}
                      onOpen={auth.open}
                    />
                  ) : prompt ? (
                    <OAuthBrowserLink url={prompt.url} onOpen={auth.open} />
                  ) : owns ? (
                    <CloudAuthProgress
                      // A sign-in that did not finish says so here, not only behind the dialog.
                      text={
                        auth.phaseText ??
                        (auth.failure === 'authNotDone' ? t('cloudSettings.authNotDone') : undefined)
                      }
                      checking={auth.checking}
                      unreadable={auth.progressUnreadable}
                      disabled={auth.requesting}
                    />
                  ) : null}
                </>
              ) : (
                <form
                  id={formId}
                  className="flex flex-col gap-3"
                  autoComplete="off"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (disabled || !valid) return;
                    const submitted = Object.fromEntries(
                      fields.map((field) => [field.name, value(field)]),
                    );
                    setValues({});
                    void submit(choice, submitted);
                  }}
                >
                  {fields.map((field) => {
                    const label = t(FIELD_LABEL[field.name] ?? field.name, {
                      defaultValue: field.name,
                    });
                    const id = `${formId}-${field.name}`;
                    return (
                      <FormField key={field.name} label={label} id={id} required={field.required}>
                        {() =>
                          field.kind === 'select' ? (
                            <SegmentedControl
                              aria-label={label}
                              value={value(field)}
                              disabled={disabled}
                              options={field.options ?? []}
                              onValueChange={(next) =>
                                setValues((old) => ({ ...old, [field.name]: next }))
                              }
                            />
                          ) : field.kind === 'textarea' ? (
                            <textarea
                              id={id}
                              aria-label={label}
                              rows={4}
                              spellCheck={false}
                              value={value(field)}
                              maxLength={field.maxLength}
                              disabled={disabled}
                              placeholder={t(FIELD_PLACEHOLDER[field.name] ?? '', {
                                defaultValue: '',
                              })}
                              onChange={(event) =>
                                setValues((old) => ({ ...old, [field.name]: event.target.value }))
                              }
                              className="w-full resize-y rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
                            />
                          ) : (
                            <SettingsTextInput
                              id={id}
                              aria-label={label}
                              type={field.kind === 'password' ? 'password' : 'text'}
                              autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                              spellCheck={false}
                              value={value(field)}
                              maxLength={field.maxLength}
                              required={field.required}
                              disabled={disabled}
                              placeholder={t(FIELD_PLACEHOLDER[field.name] ?? '', {
                                defaultValue: '',
                              })}
                              onChange={(next) =>
                                setValues((old) => ({ ...old, [field.name]: next }))
                              }
                            />
                          )
                        }
                      </FormField>
                    );
                  })}
                  {owns && (auth.busy || auth.settling) && (
                    <CloudAuthProgress
                      text={auth.phaseText}
                      checking={auth.checking}
                      unreadable={auth.progressUnreadable}
                      disabled={auth.requesting}
                    />
                  )}
                </form>
              )}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="md"
                  disabled={auth.busy}
                  onClick={() => {
                    setChoice(null);
                    setValues({});
                  }}
                >
                  {t('settings.providers.wizard.back')}
                </Button>
                {owns && auth.busy ? (
                  <Button variant="secondary" size="md" onClick={() => void auth.operate('cancel')}>
                    {t('settings.providers.button.cancel')}
                  </Button>
                ) : fields.length ? (
                  <Button
                    type="submit"
                    form={formId}
                    variant="cta"
                    size="md"
                    disabled={disabled || !valid}
                  >
                    {t('settings.providers.wizard.finish')}
                  </Button>
                ) : (
                  <Button
                    variant="cta"
                    size="md"
                    disabled={disabled}
                    onClick={() => void submit(choice, {})}
                  >
                    {t('settings.providers.wizard.authorizeInBrowser')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
