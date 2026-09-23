import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  parseRemoteResourceChangedPayload,
  resolveRemoteText,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { normalizeBotModelChain } from '../../../shared/botModelChain';
import { BotModelChainEditor } from './BotModelChainEditor';
import { BotPortraitPicker } from './BotPortraitPicker';
import { useBotTranslation } from './botPronounContext';
import type { RemoteBot } from './remoteBotRoster';
import {
  parseRemoteBotSettings,
  remoteBotSettingsClient,
  type RemoteBotSettingsResource,
  type RemoteBotSettingsValues,
} from './remoteBotSettingsResource';

/** The drawer shares host-issued forms with Mobile; no local Bot store mutation is permitted. */
export function RemoteBotSettings({
  bot,
  beforeCloseRef,
  onBack,
}: {
  bot: RemoteBot;
  beforeCloseRef: { current: (() => Promise<boolean>) | null };
  onBack: () => void;
}) {
  const { t, i18n } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ owner }), [owner, bot.deviceId, bot.id, bot.online]);
  const current = useRef<typeof scope | null>(scope);
  current.current = scope;
  const [path, setPath] = useState([bot.id]);
  const resourceId = path.at(-1)!;
  const [resource, setResource] = useState<RemoteBotSettingsResource | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [values, setValues] = useState<RemoteBotSettingsValues>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [portraitError, setPortraitError] = useState(false);
  const pending = useRef(false);
  const fresh = useRef(false);
  const sequence = useRef(0);
  const panel = resource?.panels.find((item) => item.id === panelId);
  const dirty = !!panel?.action?.fields?.some(
    (field) => (values[field.id] ?? '') !== (panel.values[field.id] ?? ''),
  );
  const draft = useRef({ dirty, panelId, panel, values });
  draft.current = { dirty, panelId, panel, values };
  const label = (value: Parameters<typeof resolveRemoteText>[0]) =>
    resolveRemoteText(value, i18n.language);
  const valid = useCallback(
    () => current.current === scope && isDataOwnerGenerationCurrent(scope.owner),
    [scope],
  );

  const canLeave = useCallback(async () => {
    if (pending.current) return false;
    if (!draft.current.dirty) return true;
    return confirm({
      title: t('bots.remote.settings.discardTitle'),
      description: t('bots.remote.settings.discardBody'),
      confirmText: t('bots.remote.settings.discard'),
    });
  }, [confirm, t]);
  useEffect(() => {
    beforeCloseRef.current = canLeave;
    return () => {
      beforeCloseRef.current = null;
    };
  }, [beforeCloseRef, canLeave]);
  useEffect(
    () => () => {
      current.current = null;
    },
    [],
  );

  const load = useCallback(
    async (reconcileDraft = false) => {
      if (!bot.online || !valid()) return;
      const read = ++sequence.current;
      fresh.current = false;
      setLoading(true);
      setFailed(false);
      try {
        const ref = { collectionId: 'teammates', kind: 'bot', id: resourceId };
        const raw = await window.electronAPI.deviceLink.invoke(
          bot.deviceId,
          REMOTE_RESOURCE_GET_CHANNEL,
          [{ client: remoteBotSettingsClient(i18n.language), ref }],
        );
        const next = parseRemoteBotSettings(raw, ref);
        if (!valid() || read !== sequence.current) return;
        const editing = draft.current;
        const nextPanel = next.panels.find((item) => item.id === editing.panelId);
        let nextValues = nextPanel?.values ?? {};
        if (editing.dirty) {
          if (!reconcileDraft) {
            setStale(true);
            return;
          }
          const changedFields = (editing.panel?.action?.fields ?? []).filter(
            (field) => editing.values[field.id] !== editing.panel?.values[field.id],
          );
          const conflict =
            !nextPanel?.action ||
            changedFields.some(
              (field) =>
                nextValues[field.id] !== editing.panel?.values[field.id] &&
                nextValues[field.id] !== editing.values[field.id],
            );
          if (conflict) {
            setStale(true);
            if (
              !(await confirm({
                title: t('bots.remote.settings.discardTitle'),
                description: t('bots.remote.settings.conflict'),
                confirmText: t('bots.remote.settings.discard'),
              }))
            )
              return;
            if (!valid() || read !== sequence.current) return;
          } else {
            // ACK loss may mean the write succeeded. Reconcile it, or retain only
            // our edited fields over the new baseline; never resubmit implicitly.
            nextValues = {
              ...nextValues,
              ...Object.fromEntries(
                changedFields.map((field) => [field.id, editing.values[field.id]]),
              ),
            };
          }
        }
        setResource(next);
        setValues(nextValues);
        setStale(false);
        fresh.current = true;
      } catch {
        if (valid() && read === sequence.current) setFailed(true);
      } finally {
        if (valid() && read === sequence.current) setLoading(false);
      }
    },
    [bot.deviceId, bot.online, resourceId, i18n.language, valid, confirm, t],
  );

  useEffect(() => {
    fresh.current = false;
    if (draft.current.dirty) setStale(true);
    else void load();
    return () => {
      sequence.current++;
      fresh.current = false;
    };
  }, [load]);
  useEffect(
    () =>
      window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
        if (
          !valid() ||
          push.deviceId !== bot.deviceId ||
          push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL ||
          !isDeviceLinkRemotePushCurrent(push, stamp)
        )
          return;
        const change = parseRemoteResourceChangedPayload(push.payload);
        if (change?.collectionId !== 'teammates') return;
        // A reply changes the collection too. Only settings writes need a fresh grant;
        // the host's settings revision excludes chat activity and rejects stale saves.
        if (
          change.resourceRefs?.length &&
          !change.resourceRefs.some((ref) => ref.id === bot.id || ref.id === resourceId)
        )
          return;
        if (!draft.current.dirty && !pending.current) void load();
      }),
    [bot.deviceId, bot.id, resourceId, valid, load],
  );

  const reload = async () => {
    if (pending.current || !valid()) return;
    await load(true);
  };
  const goBack = async () => {
    if (!(await canLeave()) || !valid()) return;
    if (panelId) {
      setPanelId(null);
      setValues({});
      setSaved(false);
    } else if (path.length > 1) {
      setResource(null);
      setPath(path.slice(0, -1));
    } else onBack();
  };
  const openResource = (id: string) => {
    // Links can only address this teammate's advertised settings resources.
    if (!id.startsWith(`settings:${bot.id}/`) || pending.current) return;
    setResource(null);
    setPanelId(null);
    setValues({});
    setSaved(false);
    setPath([...path, id]);
  };
  const edit = (id: string, value: string | boolean) => {
    if (pending.current) return;
    setSaved(false);
    setValues((previous) => ({ ...previous, [id]: value }));
  };
  const submit = async () => {
    const action = panel?.action;
    if (
      !resource ||
      !action ||
      action.disabled ||
      !bot.online ||
      !fresh.current ||
      pending.current ||
      !valid()
    )
      return;
    pending.current = true;
    setBusy(true);
    setSaved(false);
    try {
      if (
        action.confirmation &&
        !(await confirm({
          title: label(action.confirmation.title),
          description: action.confirmation.body ? label(action.confirmation.body) : undefined,
          confirmText: action.confirmation.confirmLabel
            ? label(action.confirmation.confirmLabel)
            : label(action.label),
          confirmVariant: action.tone === 'destructive' ? 'destructive' : 'default',
        }))
      )
        return;
      if (!valid() || !bot.online || !fresh.current) return;
      const input = Object.fromEntries(
        (action.fields ?? [])
          .filter(
            (field) => panel.primitive === 'action' || values[field.id] !== panel.values[field.id],
          )
          .map((field) => [field.id, values[field.id]]),
      );
      fresh.current = false;
      await window.electronAPI.deviceLink.invoke(bot.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [
        {
          client: remoteBotSettingsClient(i18n.language),
          collectionId: resource.ref.collectionId,
          resourceRef: resource.ref,
          actionId: action.id,
          input,
        },
      ]);
      if (!valid()) return;
      draft.current.dirty = false;
      setValues(panel.values);
      setSaved(true);
      if (panel.id === 'delete') {
        onBack();
        return;
      }
      await load();
    } catch {
      // An expired/conflicting/ambiguous action is never replayed. Keep the draft
      // and require a user-driven re-read before issuing another host grant.
      if (valid()) {
        setFailed(true);
        setStale(true);
      }
    } finally {
      pending.current = false;
      if (current.current) setBusy(false);
    }
  };
  let chain = null;
  if (panel?.id === 'models') {
    try {
      chain = normalizeBotModelChain(JSON.parse(String(values.modelChain)));
    } catch {
      /* Read-only fallback below. */
    }
  }
  const disabled = !bot.online || stale || failed || loading || busy;
  const fieldsValid =
    panel?.action?.fields?.every(
      (field) =>
        !field.required ||
        (field.kind === 'toggle'
          ? typeof values[field.id] === 'boolean'
          : !!String(values[field.id] ?? '').trim()),
    ) ?? true;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5 text-13 text-[var(--text-primary)]">
      <Button
        variant="secondary"
        tone="quiet"
        size="sm"
        disabled={busy}
        onClick={() => void goBack()}
      >
        <ArrowLeft size={15} />
        {t('bots.settingsBack')}
      </Button>
      <p className="mt-3 text-12 text-[var(--text-tertiary)]">{bot.deviceName}</p>
      <h2 className="mb-4 mt-1 text-15 font-medium">
        {panel
          ? label(panel.title ?? panel.action?.label ?? resource?.title ?? bot.name)
          : label(resource?.title ?? bot.name)}
      </h2>
      {!bot.online ? (
        <p role="status">
          {t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })}
        </p>
      ) : null}
      {loading ? <Spinner size={18} /> : null}
      {failed || stale ? (
        <div role="alert" className="mb-4 space-y-2">
          <p>{t('bots.remote.settings.refreshRequired')}</p>
          <Button
            variant="secondary"
            disabled={!bot.online || busy || loading}
            onClick={() => void reload()}
          >
            {t('bots.remote.settings.reload')}
          </Button>
        </div>
      ) : null}
      {!loading &&
      resource &&
      !resource.panels.some((item) => item.action || item.data?.entries?.length) ? (
        <p>{t('bots.remote.settings.unavailable')}</p>
      ) : null}
      {saved ? (
        <p role="status" className="mb-3 text-[var(--text-secondary)]">
          {t('bots.autosave.saved')}
        </p>
      ) : null}
      {portraitError ? (
        <p role="alert" className="mb-3 text-[var(--error-fg)]">
          {t('bots.remote.settings.imageTooLarge')}
        </p>
      ) : null}
      {!panel ? (
        <div className="space-y-1">
          {resource?.panels.map((item) =>
            item.data?.entries?.length ? (
              item.data.entries.map((entry) => (
                <Button
                  key={`${item.id}:${entry.id}`}
                  variant="secondary"
                  tone="quiet"
                  className="w-full justify-between"
                  disabled={disabled}
                  onClick={() => openResource(entry.resourceId)}
                >
                  {label(entry.title)}
                  <ChevronRight size={15} />
                </Button>
              ))
            ) : item.action || item.title ? (
              <Button
                key={item.id}
                variant="secondary"
                tone="quiet"
                className="w-full justify-between"
                disabled={disabled}
                onClick={() => {
                  setPanelId(item.id);
                  setValues(item.values);
                  setSaved(false);
                }}
              >
                {label(item.title ?? item.action!.label)}
                <ChevronRight size={15} />
              </Button>
            ) : item.fallbackMarkdown ? (
              <p
                key={item.id}
                className="whitespace-pre-wrap break-words text-[var(--text-secondary)]"
              >
                {item.fallbackMarkdown}
              </p>
            ) : null,
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {!panel.action ? (
            <p className="whitespace-pre-wrap break-words">{panel.fallbackMarkdown}</p>
          ) : (
            <>
              {panel.action.fields?.map((field) => (
                <FormField key={field.id} label={label(field.label)} required={field.required}>
                  {(control) => {
                    if (panel.id === 'models' && field.id === 'modelChain')
                      return chain ? (
                        <BotModelChainEditor
                          deviceId={bot.deviceId}
                          value={chain}
                          disabled={disabled || values.followsDefault === true}
                          onChange={(next) => edit(field.id, JSON.stringify(next))}
                        />
                      ) : (
                        <p>{panel.fallbackMarkdown}</p>
                      );
                    if (field.id === 'avatarImageBase64')
                      return (
                        <BotPortraitPicker
                          disabled={disabled}
                          value={
                            values[field.id]
                              ? `data:image/png;base64,${values[field.id]}`
                              : undefined
                          }
                          onChange={(value) => {
                            const bytes = value.split(',')[1];
                            if (!bytes || bytes.length > 60_000) {
                              setPortraitError(true);
                              return;
                            }
                            setPortraitError(false);
                            edit(field.id, bytes);
                          }}
                        />
                      );
                    if (field.kind === 'toggle')
                      return (
                        <Switch
                          id={control.id}
                          checked={values[field.id] === true}
                          disabled={disabled}
                          onCheckedChange={(value) => edit(field.id, value)}
                        />
                      );
                    if (field.kind === 'select')
                      return (
                        <Select
                          {...control}
                          label={label(field.label)}
                          value={String(values[field.id] ?? '')}
                          disabled={disabled}
                          options={(field.options ?? []).map((option) => ({
                            value: option.value,
                            label: label(option.label),
                          }))}
                          onValueChange={(value) => edit(field.id, value)}
                        />
                      );
                    if (field.kind === 'multiline')
                      return (
                        <Textarea
                          {...control}
                          rows={6}
                          value={String(values[field.id] ?? '')}
                          disabled={disabled}
                          onChange={(value) => edit(field.id, value)}
                        />
                      );
                    return (
                      <Input
                        {...control}
                        value={String(values[field.id] ?? '')}
                        disabled={disabled}
                        onChange={(value) => edit(field.id, value)}
                      />
                    );
                  }}
                </FormField>
              ))}
              <Button
                variant="primary"
                tone={panel.action.tone === 'destructive' ? 'danger-solid' : 'default'}
                loading={busy}
                disabled={
                  disabled ||
                  panel.action.disabled ||
                  !fieldsValid ||
                  (panel.primitive === 'form' && !dirty)
                }
                onClick={() => void submit()}
              >
                {panel.primitive === 'action' ? label(panel.action.label) : t('bots.save')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
