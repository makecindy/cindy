import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { errorCode, useBlockRetry } from './blockRetry';
import { CloudRequestError } from './CloudRequestError';
import { SETTLE_DELAYS_MS, useSettleUnknown } from './useSettleUnknown';
import { FormField } from '@/components/ui/form-field';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SettingsCard } from '@/components/ui/settings-rows';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import { McpTokenField } from '@/components/settings/McpTokenField';
import { McpAddRow, McpRow } from '@/components/settings/McpServersSection';
import { McpServerDialog, type McpServerPersistence } from '@/components/settings/McpServerDialog';
import { toast } from '@/lib/toast';
import type { CustomMcpConfig } from '../../../shared/customMcp';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import type { CloudAuthorizationProps } from './useCloudAuthorization';

type Action = ManagementItem['actions'][number];
type Operation = Extract<ManagementResult, { kind: 'operation' }>;
const getAction = (item: ManagementItem, label: string) =>
  item.actions.find((a) => a.label === label);

/** Native MCP presentation. Stored credential values never leave the Host. */
export function CloudMcpAuthorization({
  client,
  active,
  online,
  name,
  trial,
  refresh,
  pageFailed = false,
}: CloudAuthorizationProps) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [, setReadCode] = useState<string>();
  const [readFailures, setReadFailures] = useState(0);
  const [items, setItems] = useState<ManagementItem[]>([]);
  // The instance's "Add MCP" entry; absent on runtimes that cannot create servers here.
  const [createItem, setCreateItem] = useState<ManagementItem>();
  const [dialog, setDialog] = useState<{ item?: ManagementItem; config?: CustomMcpConfig }>();
  const [selected, setSelected] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [operation, setOperation] = useState<Operation>();
  const operationRef = useRef<Operation | undefined>(undefined);
  const publish = (next: Operation) => {
    operationRef.current = next;
    setOperation(next);
  };
  const [pending, setPending] = useState(false);
  const locked = useRef(false),
    seq = useRef(0),
    alive = useRef(true);
  const scope = useRef({ client, online });
  scope.current = { client, online };
  const current = () => alive.current && scope.current.client === client && scope.current.online;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      seq.current++;
    };
  }, [client]);
  const load = async () => {
    if (!current() || !client.manage) return;
    const version = ++seq.current;
    setLoading(true);
    try {
      const all: ManagementItem[] = [];
      let create: ManagementItem | undefined;
      let offset = 0;
      for (let n = 0; n < 128; n++) {
        const page = await client.manage({ operation: 'list', section: 'mcp', offset });
        if (!current() || version !== seq.current) return;
        if (page.kind !== 'page' || page.section !== 'mcp' || (page.offset ?? 0) !== offset)
          throw Error('INVALID_PAGE');
        all.push(...page.items.filter((item) => !!getAction(item, 'management.setToken')));
        create ??= page.items.find(
          (item) => item.id === 'mcp:create' && !!getAction(item, 'management.actions.create'),
        );
        if (page.nextOffset === undefined) {
          if (new Set(all.map((i) => i.id)).size !== all.length) throw Error('INVALID_PAGE');
          setItems(all);
          setCreateItem(create);
          setFailure(undefined);
          return;
        }
        if (page.nextOffset <= offset) throw Error('INVALID_PAGE');
        offset = page.nextOffset;
      }
      throw Error('INVALID_PAGE');
    } catch (error) {
      if (current() && version === seq.current) {
        setFailure('readFailed');
        setReadCode(errorCode(error));
        setReadFailures((count) => count + 1);
      }
    } finally {
      if (current() && version === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (active && online && !locked.current) void load();
  }, [client, active, online, refresh]);
  useEffect(() => {
    if (!active || !online) setSelected(undefined);
  }, [active, online]);
  // Progress that could not be read is read back from the operation, never run again.
  const unknown = useSettleUnknown<string>({
    delays: SETTLE_DELAYS_MS.authorization,
    check: async (id) => {
      if (!current() || !client.manage) throw Error('SCOPE_CHANGED');
      accept(await client.manage({ operation: 'status', operationId: id }), id);
      return 'done';
    },
    onSettled: () => {},
  });
  const settle = (id: string) => {
    publish({ kind: 'operation', operationId: id, phase: 'unknown' });
    void unknown.start(id);
  };
  useEffect(() => () => unknown.stop(), [client]);
  // Credentials set or removed from a row: how it ended is a toast, as the client's MCP page says a
  // save; a cancel says nothing. The dialog and the delete say their own.
  const fromRow = useRef(new Set<string>());
  const accept = (result: ManagementResult, id: string) => {
    if (result.kind !== 'operation' || result.operationId !== id) throw Error('SCOPE_CHANGED');
    if (current() && operationRef.current?.operationId === id) {
      if (fromRow.current.has(id) && !['running', 'waiting', 'unknown'].includes(result.phase)) {
        fromRow.current.delete(id);
        if (result.phase === 'succeeded') toast.success(t('settings.mcp.toast.updated'));
        else if (result.phase !== 'cancelled') toast.error(t('settings.mcp.toast.saveFailed'));
      }
      publish(result);
    }
    return result;
  };
  const run = async (item: ManagementItem, action: Action, values: Record<string, string>) => {
    if (!current() || locked.current || !client.manage) return;
    locked.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      if (
        action.confirmation &&
        !(await confirm({
          title: t('cloudSettings.mcpRemove'),
          // What removing does (cloud only).
          description: t('cloudSettings.mcpRemoveBody', { name }),
          confirmText: t('settings.mcp.deleteConfirm.confirm'),
          cancelText: t('settings.mcp.cancel'),
        }))
      )
        return;
      if (!current()) return;
      const id = crypto.randomUUID();
      fromRow.current.add(id);
      publish({ kind: 'operation', operationId: id, phase: 'running' });
      try {
        accept(
          await client.manage({ operation: 'run', actionId: action.id, operationId: id, values }),
          id,
        );
      } catch {
        if (current()) settle(id);
      }
    } finally {
      // Only newly entered values exist here. No credentials are persisted in the controller.
      values = {};
      locked.current = false;
      if (current()) setPending(false);
    }
  };
  const running = operation && ['running', 'waiting'].includes(operation.phase);
  const check = async () => {
    if (!current() || !operation || !client.manage) return;
    try {
      accept(
        await client.manage({ operation: 'status', operationId: operation.operationId }),
        operation.operationId,
      );
    } catch {
      if (current()) settle(operation.operationId);
    }
  };
  /** One ticket run to its end, for the shared MCP dialog and the row's delete. */
  const runAndWait = async (item: ManagementItem, action: Action, values: Record<string, string>) => {
    if (!current() || locked.current || !client.manage) throw Error('BUSY');
    locked.current = true;
    setPending(true);
    setFailure(undefined);
    const id = crypto.randomUUID();
    try {
      publish({ kind: 'operation', operationId: id, phase: 'running' });
      let result = accept(
        await client.manage({ operation: 'run', actionId: action.id, operationId: id, values }),
        id,
      ) as Operation;
      for (let n = 0; n < 150 && ['running', 'waiting'].includes(result.phase); n++) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        if (!current()) throw Error('SCOPE_CHANGED');
        result = accept(await client.manage({ operation: 'status', operationId: id }), id) as Operation;
      }
      if (result.phase !== 'succeeded') throw Error(result.phase);
    } catch (error) {
      // A reported outcome is shown by its phase; a lost reply may still be running.
      const phase = error instanceof Error ? error.message : '';
      if (current() && !['failed', 'cancelled', 'expired'].includes(phase)) settle(id);
      throw error;
    } finally {
      values = {};
      locked.current = false;
      if (current()) {
        setPending(false);
        void load();
      }
    }
  };
  const fieldsOf = (config: CustomMcpConfig) => ({
    name: config.name,
    url: config.url,
    transport: config.transport,
  });
  const persistence = (item?: ManagementItem): McpServerPersistence => ({
    async create(config) {
      const action = createItem && getAction(createItem, 'management.actions.create');
      if (!createItem || !action) throw Error('UNAVAILABLE');
      await runAndWait(createItem, action, fieldsOf(config));
    },
    async update(config) {
      const action = item && getAction(item, 'management.actions.edit');
      if (!item || !action) throw Error('UNAVAILABLE');
      await runAndWait(item, action, fieldsOf(config));
    },
    credentialsNote: (
      <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
        {t('cloudSettings.mcpCredentialsAfterSave', { name })}
        {/* The instance refuses to send saved credentials to a changed endpoint. */}
        {item &&
          (getAction(item, 'management.removeToken') ||
            getAction(item, 'management.removeHeader')) &&
          ` ${t('cloudSettings.mcpClearCredentialsBeforeUrl')}`}
      </p>
    ),
  });
  const remove = async (item: ManagementItem) => {
    const action = getAction(item, 'management.actions.delete');
    if (!action) return;
    const ok = await confirm({
      title: t('settings.mcp.deleteConfirm.title', { name: item.label }),
      description: t('settings.mcp.deleteConfirm.message'),
      confirmText: t('settings.mcp.deleteConfirm.confirm'),
      cancelText: t('settings.mcp.cancel'),
    });
    if (!ok) return;
    try {
      await runAndWait(item, action, {});
      toast.success(t('settings.mcp.toast.deleted'));
    } catch {
      toast.error(t('settings.mcp.toast.deleteFailed'));
    }
  };
  useEffect(() => {
    if (!online || !operation) return;
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(operation.phase)) {
      void load();
      return;
    }
    if (!running) return;
    const timer = setTimeout(() => void check(), 800);
    return () => clearTimeout(timer);
  }, [client, online, operation]);
  const busy = pending || !!running || operation?.phase === 'unknown';
  // A result that could not be read back: a warning toast whose button reads it once more.
  const unreadableNow = unknown.state === 'unreadable';
  useEffect(() => {
    if (!unreadableNow) return;
    toast.warning(t('settings.ghosts.remote.unknown'), {
      action: { label: t('cloudSettings.authCheck'), onClick: () => void unknown.reload() },
    });
  }, [unreadableNow]);
  // A list that cannot be read is read again on its own before it says so.
  const readRetry = useBlockRetry({
    failed: failure === 'readFailed' && active && online,
    failures: readFailures,
    retry: () => void load(),
    paused: pageFailed,
  });
  return (
    <section className="flex flex-col gap-[14px]" aria-label={t('settings.mcp.title')}>
      <div className="flex flex-col gap-1">
        <h3 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.mcp.title')}
        </h3>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.mcp.subtitle')}
        </p>
      </div>
      {/* A failed read shows its own notice with a reload, below. */}
      {failure && failure !== 'readFailed' && (
        <p role="alert" className="text-13 text-[var(--text-secondary)]">
          {t(`cloudSettings.${failure}`)}
        </p>
      )}
      {/* One line and 「重新读取」, as the client's settings read failure. */}
      {readRetry.exhausted && (
        <CloudRequestError
          message={t('cloudSettings.mcpReadFailed')}
          retryLabel={t('commonUi.retry')}
          onRetry={readRetry.reload}
          disabled={loading || !online}
        />
      )}
      {/* While reading nothing; with no server, only the add row. */}
      {(items.length > 0 || (createItem && online)) && (
      <SettingsCard>
        {items.map((item, i) => {
          const edit = getAction(item, 'management.actions.edit');
          const field = (key: string) => edit?.fields.find((f) => f.name === key)?.value;
          return (
            <div
              key={item.id}
              className={i ? 'border-t border-[var(--settings-theme-card-border)]' : ''}
            >
              <McpRow
                config={{
                  id: item.id,
                  name: item.label,
                  url: field('url') || t('cloudSettings.mcpPrivateEndpoint'),
                  transport: field('transport') === 'sse' ? 'sse' : 'http',
                  headers: {},
                }}
                onEdit={
                  edit && online && !busy
                    ? () =>
                        setDialog({
                          item,
                          config: {
                            id: item.id,
                            name: item.label,
                            url: field('url') ?? '',
                            transport: field('transport') === 'sse' ? 'sse' : 'http',
                            headers: {},
                          },
                        })
                    : undefined
                }
                onDelete={
                  getAction(item, 'management.actions.delete') && online && !busy
                    ? () => void remove(item)
                    : undefined
                }
                actions={
                  <Button
                    variant="secondary"
                    size="md"
                    aria-expanded={selected === item.id}
                    disabled={!online}
                    onClick={() => setSelected(selected === item.id ? undefined : item.id)}
                  >
                    {t('cloudSettings.mcpCredentials')}
                    {selected === item.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </Button>
                }
              />
              {selected === item.id && online && (
                <McpCredentials key={item.id} item={item} busy={busy || loading} run={run} />
              )}
            </div>
          );
        })}
        {createItem && online && (
          <div className={items.length ? 'border-t border-[var(--settings-theme-card-border)]' : ''}>
            <McpAddRow onClick={() => !busy && setDialog({})} />
          </div>
        )}
      </SettingsCard>
      )}
      {dialog && (
        <McpServerDialog
          initial={dialog.config}
          existingIds={items.map((item) => item.id)}
          persistence={persistence(dialog.item)}
          onClose={() => setDialog(undefined)}
          onSaved={() => setDialog(undefined)}
        />
      )}
      <p className="text-12 text-[var(--text-tertiary)]">{t('cloudSettings.mcpScope', { name })}</p>
      {trial && (
        <p className="text-12 text-[var(--text-tertiary)]">{t('cloudSettings.authTrial')}</p>
      )}
    </section>
  );
}

function McpCredentials({
  item,
  busy,
  run,
}: {
  item: ManagementItem;
  busy: boolean;
  run(item: ManagementItem, action: Action, values: Record<string, string>): Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [token, setToken] = useState(''),
    [headerName, setHeaderName] = useState(''),
    [headerValue, setHeaderValue] = useState('');
  const saveToken = getAction(item, 'management.setToken'),
    removeToken = getAction(item, 'management.removeToken');
  const saveHeader = getAction(item, 'management.setHeader'),
    removeHeader = getAction(item, 'management.removeHeader');
  const submit = (action: Action, values: Record<string, string>) => {
    setToken('');
    setHeaderValue('');
    void run(item, action, values);
  };
  return (
    <fieldset
      disabled={busy}
      className="mx-5 mb-5 flex min-w-0 flex-col gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface)] p-4"
    >
      <McpTokenField
        id={`${id}-token`}
        value={token}
        onChange={setToken}
        hasToken={!!removeToken}
        placeholder={t('settings.mcp.fields.tokenPlaceholder')}
        hint={t('cloudSettings.mcpSecretHint')}
      />
      <div className="flex flex-wrap gap-2">
        {saveToken && (
          <Button
            variant="primary"
            size="md"
            disabled={busy || !token.trim()}
            onClick={() => submit(saveToken, { bearerToken: token })}
          >
            {t('settings.mcp.save')}
          </Button>
        )}
        {removeToken && (
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => submit(removeToken, {})}
          >
            {t('cloudSettings.mcpRemoveToken')}
          </Button>
        )}
      </div>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">
          {t('settings.mcp.fields.headers')}
        </legend>
        {removeHeader?.fields
          .find((f) => f.name === 'headerName')
          ?.options?.map((header) => (
            <div
              key={header.value}
              className="flex items-center justify-between gap-2 text-13 text-[var(--text-secondary)]"
            >
              <span className="min-w-0 break-all">{header.label}</span>
              <Button
                variant="secondary"
                size="md"
                aria-label={`${t('settings.mcp.fields.removeRow')} ${header.label}`}
                disabled={busy}
                onClick={() => submit(removeHeader, { headerName: header.value })}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        <div className="flex min-w-0 flex-wrap gap-2">
          <FormField
            id={`${id}-header-name`}
            label={t('settings.mcp.fields.headerNamePlaceholder')}
            className="min-w-0 flex-1"
          >
            {(control) => (
              <SettingsTextInput
                {...control}
                surface="ivory"
                value={headerName}
                onChange={setHeaderName}
                placeholder={t('settings.mcp.fields.headerNamePlaceholder')}
              />
            )}
          </FormField>
          <FormField
            id={`${id}-header-value`}
            label={t('settings.mcp.fields.headerValuePlaceholder')}
            className="min-w-0 flex-1"
          >
            {(control) => (
              <SettingsTextInput
                {...control}
                surface="ivory"
                value={headerValue}
                onChange={setHeaderValue}
                placeholder={t('settings.mcp.fields.headerValuePlaceholder')}
                secret
              />
            )}
          </FormField>
        </div>
        {saveHeader && (
          <Button
            variant="secondary"
            size="md"
            className="self-start"
            disabled={busy || !headerName.trim() || !headerValue.trim()}
            onClick={() => submit(saveHeader, { headerName, headerValue })}
          >
            {t('settings.mcp.save')}
          </Button>
        )}
      </fieldset>
    </fieldset>
  );
}
