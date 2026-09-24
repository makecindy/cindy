import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  resolveRemoteText,
  parseRemoteResourceChangedPayload,
  type RemoteActionInvokeResponse,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { createCoalescedRefresh } from '@/lib/coalescedRefresh';
import { extractIpcError } from '@/utils/ipcError';
import { BotModelChainEditor } from './BotModelChainEditor';
import { BotPortraitPicker } from './BotPortraitPicker';
import type { RemoteBot } from './remoteBotRoster';
import {
  readRemoteBotSettings,
  readRemoteBotModelChain,
  settingsChanges,
  settingsClient,
  type RemoteBotSettingsData,
  type SettingsPanel,
  type SettingsValues,
} from './remoteBotSettingsData';

interface Props {
  bot: RemoteBot;
  beforeCloseRef: MutableRefObject<(() => Promise<boolean>) | null>;
  onDeleted(): void;
}
/** Same drawer and controls as local settings, with every read/write bound to the selected host. */
export function RemoteBotSettings(props: Props) {
  const owner = getDataOwnerGeneration();
  return (
    <RemoteBotSettingsContent
      key={`${owner.dataOwnerId}:${owner.generation}:${props.bot.deviceId}:${props.bot.id}`}
      {...props}
    />
  );
}
function RemoteBotSettingsContent({ bot, beforeCloseRef, onDeleted }: Props) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [data, setData] = useState<RemoteBotSettingsData | null>(null);
  const [resourceId, setResourceId] = useState(bot.id);
  const [page, setPage] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsValues>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const scope = useRef(getDataOwnerGeneration());
  const online = useRef(bot.online);
  online.current = bot.online;
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    return () => {
      mounted.current = false;
      sequence.current++;
      abort.current?.abort();
    };
  }, []);
  const current = () => mounted.current && isDataOwnerGenerationCurrent(scope.current);
  const label = (text: SettingsPanel['title']) => resolveRemoteText(text, i18n.language);
  const editorScope = useRef('');
  const portraitRequest = useRef(0);
  editorScope.current = `${resourceId}:${page}`;
  const panel = data?.panels.find((item) => item.id === page);
  const changes = panel ? settingsChanges(panel, draft) : {};
  const dirty = Object.keys(changes).length > 0;
  const latest = useRef({ data, panel, dirty });
  latest.current = { data, panel, dirty };
  const read = useCallback(
    (id: string) => readRemoteBotSettings(bot.deviceId, id, i18n.language),
    [bot.deviceId, i18n.language],
  );
  const coalesce = useMemo(() => createCoalescedRefresh<void>(), [read, resourceId]);
  const load = useCallback(() => {
    const token = ++sequence.current;
    return coalesce(async () => {
      if (!current() || token !== sequence.current) return;
      if (!online.current || inFlight.current) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const next = await read(resourceId);
        if (!current() || token !== sequence.current) return;
        if (
          latest.current.dirty &&
          latest.current.data?.resource.revision !== next.resource.revision
        ) {
          setError('conflict');
          return;
        }
        setData(next);
        setError(null);
        if (!latest.current.dirty)
          setDraft(next.panels.find((item) => item.id === latest.current.panel?.id)?.values ?? {});
      } catch {
        if (current() && token === sequence.current) setError('loadFailed');
      } finally {
        if (current() && token === sequence.current) setLoading(false);
      }
    });
  }, [coalesce, read, resourceId]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load, bot.online]);
  useEffect(
    () =>
      window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
        const payload = parseRemoteResourceChangedPayload(push.payload);
        if (
          payload?.collectionId === 'teammates' &&
          (!payload.resourceRefs?.length ||
            payload.resourceRefs.some(
              (ref) =>
                ref.kind === 'bot' &&
                (ref.id === bot.id || ref.id === resourceId || ref.id.startsWith(`${resourceId}/`)),
            )) &&
          push.deviceId === bot.deviceId &&
          push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL &&
          isDeviceLinkRemotePushCurrent(push, stamp) &&
          !latest.current.dirty
        )
          void load();
      }),
    [bot.deviceId, bot.id, load, resourceId],
  );

  const submit = async (
    target: SettingsPanel,
    values: SettingsValues,
    mutation: boolean,
  ): Promise<boolean> => {
    if (
      !data ||
      !target.action ||
      target.action.disabled ||
      !online.current ||
      inFlight.current ||
      !current()
    )
      return false;
    inFlight.current = true;
    sequence.current++;
    setBusy(true);
    setReceipt(null);
    try {
      const confirmation = target.action.confirmation;
      if (
        confirmation &&
        !(await confirm(
          {
            title: label(confirmation.title),
            description: confirmation.body ? label(confirmation.body) : undefined,
            confirmText: confirmation.confirmLabel ? label(confirmation.confirmLabel) : undefined,
            confirmVariant: target.action.tone === 'destructive' ? 'destructive' : 'default',
            ...(target.id === 'delete'
              ? {
                  requireTypedConfirmation: {
                    expected: label(data.resource.display.title),
                    label: t('bots.creationName'),
                  },
                }
              : {}),
          },
          abort.current?.signal,
        ))
      )
        return false;
      if (!current() || !online.current) return false;
      // Renew expiring opaque actions only against the draft's unchanged revision.
      const fresh = await read(resourceId);
      if (!current() || !online.current) return false;
      if (fresh.resource.revision !== data.resource.revision) {
        setError('conflict');
        return false;
      }
      const action = fresh.panels.find((item) => item.id === target.id)?.action;
      if (!action || action.disabled) {
        setError('unsupported');
        return false;
      }
      const response = (await window.electronAPI.deviceLink.invoke(
        bot.deviceId,
        REMOTE_RESOURCE_INVOKE_CHANNEL,
        [
          {
            client: settingsClient(i18n.language),
            collectionId: 'teammates',
            resourceRef: fresh.resource.ref,
            actionId: action.id,
            input:
              target.id === 'delete'
                ? { confirmName: label(fresh.resource.display.title) }
                : values,
          },
        ],
      )) as RemoteActionInvokeResponse;
      if (!current()) return false;
      // A successful receipt remains success if the subsequent refresh fails.
      setError(null);
      setDraft({ ...target.values, ...values });
      const updated = {
        ...data,
        panels: data.panels.map((item) =>
          item.id === target.id ? { ...item, values: { ...item.values, ...values } } : item,
        ),
      };
      setData(updated);
      latest.current = {
        data: updated,
        panel: updated.panels.find((item) => item.id === page),
        dirty: false,
      };
      const toast = response.effects?.find((effect) => effect.kind === 'toast');
      setReceipt(toast?.kind === 'toast' ? label(toast.message) : t('bots.autosave.saved'));
      if (target.id === 'delete' && mutation) {
        onDeleted();
        return true;
      }
      if (target.id === 'remove' && mutation) {
        setData(null);
        setDraft({});
        setPage(null);
        setResourceId(resourceId.slice(0, resourceId.lastIndexOf('/')));
        return true;
      }
      try {
        const next = await read(resourceId);
        if (!current()) return false;
        setData(next);
        setDraft(next.panels.find((item) => item.id === target.id)?.values ?? {});
      } catch {
        if (current()) setError('loadFailed');
      }
      return true;
    } catch (failure) {
      if (current())
        setError(
          extractIpcError(failure)?.code === 'PRECONDITION_FAILED' ? 'conflict' : 'saveFailed',
        );
      return false;
    } finally {
      inFlight.current = false;
      if (current()) {
        setBusy(false);
        setLoading(false);
      }
    }
  };
  const save = () =>
    panel?.action && dirty ? submit(panel, changes, false) : Promise.resolve(!inFlight.current);
  useEffect(() => {
    beforeCloseRef.current = save;
    return () => {
      beforeCloseRef.current = null;
    };
  });
  const open = async (id: string | null, resource = resourceId) => {
    if (!(await save()) || !current()) return;
    setReceipt(null);
    setError(null);
    if (resource !== resourceId) {
      setData(null);
      setResourceId(resource);
      setDraft({});
    } else setDraft(data?.panels.find((item) => item.id === id)?.values ?? {});
    setPage(id);
  };
  const reload = async () => {
    if (inFlight.current) return;
    if (
      dirty &&
      !(await confirm(
        {
          title: t('bots.memory.unsavedTitle'),
          description: t('bots.remoteSettings.discardDescription'),
          confirmText: t('bots.memory.discard'),
        },
        abort.current?.signal,
      ))
    )
      return;
    if (!current()) return;
    latest.current.dirty = false;
    setDraft(panel?.values ?? {});
    await load();
  };
  const disabled =
    busy || loading || !bot.online || error === 'conflict' || !!panel?.action?.disabled;
  const row = (id: string, title: string, action: () => void) => (
    <button
      key={id}
      type="button"
      disabled={busy || loading}
      onClick={action}
      className="flex min-h-10 w-full items-center justify-between gap-3 rounded-full px-3 py-2 text-left text-13 hover:bg-[var(--surface-hover)] disabled:opacity-50"
    >
      <span>{title}</span>
      <ChevronRight size={16} />
    </button>
  );
  const fields = (item: SettingsPanel) =>
    item.action?.fields?.map((field) => {
      const id = `remote-bot-${field.id}`;
      if (field.id === 'modelChain' || field.id === 'confirmName') return null;
      const change = (value: string | boolean) =>
        setDraft((valueBefore) => ({ ...valueBefore, [field.id]: value }));
      return (
        <label
          key={field.id}
          htmlFor={id}
          className="flex flex-col gap-2 text-13 text-[var(--text-secondary)]"
        >
          <span>{label(field.label)}</span>
          {field.kind === 'toggle' ? (
            <Switch
              id={id}
              checked={draft[field.id] === true}
              disabled={disabled}
              onCheckedChange={change}
            />
          ) : field.kind === 'select' ? (
            <Select
              id={id}
              label={label(field.label)}
              value={String(draft[field.id] ?? '')}
              disabled={disabled}
              options={(field.options ?? []).map((option) => ({
                value: option.value,
                label: label(option.label),
              }))}
              onValueChange={change}
            />
          ) : field.kind === 'multiline' ? (
            <Textarea
              id={id}
              value={String(draft[field.id] ?? '')}
              rows={8}
              disabled={disabled}
              required={field.required}
              onChange={change}
            />
          ) : (
            <Input
              id={id}
              value={String(draft[field.id] ?? '')}
              disabled={disabled}
              required={field.required}
              onChange={change}
            />
          )}
        </label>
      );
    });
  const editor = (item: SettingsPanel) => (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {item.id === 'avatar' ? (
        <BotPortraitPicker
          disabled={disabled}
          value={
            typeof draft.avatarImageBase64 === 'string' && draft.avatarImageBase64
              ? `data:image/jpeg;base64,${draft.avatarImageBase64}`
              : undefined
          }
          onChange={(value) => {
            const selectedScope = editorScope.current;
            const request = ++portraitRequest.current;
            const image = new Image();
            image.src = value;
            void image
              .decode()
              .then(() => {
                if (
                  !current() ||
                  inFlight.current ||
                  request !== portraitRequest.current ||
                  selectedScope !== editorScope.current
                )
                  return;
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 128;
                const context = canvas.getContext('2d');
                if (!context) throw new Error('Image unavailable');
                context.drawImage(image, 0, 0, 128, 128);
                setDraft({ avatarImageBase64: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] });
              })
              .catch(() => {
                if (
                  current() &&
                  request === portraitRequest.current &&
                  selectedScope === editorScope.current
                )
                  setError('saveFailed');
              });
          }}
        />
      ) : (
        fields(item)
      )}
      {item.id === 'models' ? (
        <BotModelChainEditor
          deviceId={bot.deviceId}
          value={readRemoteBotModelChain(draft.modelChain)}
          disabled={disabled || draft.followsDefault === true}
          onChange={(chain) =>
            setDraft((previous) => ({
              ...previous,
              modelChain: JSON.stringify(chain),
              followsDefault: false,
            }))
          }
        />
      ) : null}
      <Button type="submit" disabled={disabled || !dirty} loading={busy}>
        {t('bots.save')}
      </Button>
    </form>
  );
  const panels = data?.panels ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5 text-[var(--text-primary)]">
      <p className="mb-4 truncate text-12 text-[var(--text-tertiary)]">{bot.deviceName}</p>
      {page || resourceId !== bot.id ? (
        <Button
          variant="secondary"
          tone="quiet"
          compact
          className="mb-4"
          disabled={busy}
          onClick={() =>
            void open(
              null,
              resourceId === bot.id
                ? bot.id
                : resourceId.includes('/connections/') || resourceId.includes('/skills/')
                  ? resourceId.slice(0, resourceId.lastIndexOf('/'))
                  : bot.id,
            )
          }
        >
          <ArrowLeft size={16} />
          {t('bots.settingsBack')}
        </Button>
      ) : null}
      {!bot.online ? (
        <p role="status" className="mb-4 text-13">
          {t('bots.remote.offlineDescription', { name: bot.name, device: bot.deviceName })}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mb-4 space-y-2 text-13">
          <p>{t(`bots.remoteSettings.${error}`)}</p>
          <Button
            variant="secondary"
            compact
            disabled={busy || !bot.online}
            onClick={() => void reload()}
          >
            {t('bots.memory.useLatest')}
          </Button>
        </div>
      ) : null}
      {receipt ? (
        <p role="status" className="mb-4 text-12 text-[var(--text-secondary)]">
          {receipt}
        </p>
      ) : null}
      {loading && !data ? <Spinner size={18} /> : null}
      {page && panel ? (
        <>
          <h2 className="mb-4 text-15 font-medium">{label(panel.title)}</h2>
          {panel.action ? (
            editor(panel)
          ) : (
            <p className="whitespace-pre-wrap text-13">{panel.text}</p>
          )}
        </>
      ) : !page && data ? (
        <div className="space-y-1">
          {resourceId !== bot.id ? (
            <h2 className="mb-4 text-15 font-medium">{label(data.resource.display.title)}</h2>
          ) : null}
          {[...panels]
            .sort((a, b) => Number(b.id === 'models') - Number(a.id === 'models'))
            .map((item) =>
              item.entries.length ? (
                <div key={item.id}>
                  {item.entries.map((entry) =>
                    row(entry.id, label(entry.title), () => void open(null, entry.resourceId)),
                  )}
                </div>
              ) : item.action && ['restart', 'resume', 'delete', 'remove'].includes(item.id) ? (
                row(item.id, label(item.action.label), () => void submit(item, {}, true))
              ) : item.action || item.text ? (
                row(item.id, label(item.title), () => void open(item.id))
              ) : null,
            )}
          {!panels.some((item) => item.action || item.entries.length) ? (
            <p className="py-3 text-13 text-[var(--text-secondary)]">
              {t(
                resourceId === bot.id
                  ? 'bots.remoteSettings.unsupported'
                  : 'bots.remoteSettings.empty',
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
