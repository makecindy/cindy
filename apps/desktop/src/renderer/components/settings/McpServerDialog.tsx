/** Shared MCP settings form: remote endpoints or a local command, saved for all harnesses. */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Sparkles, Trash2 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Tip } from '@/components/ui/tooltip';
import { SettingsTextInput } from './SettingsTextInput';
import { mcpFields } from './McpServerDialog.settings-search';
import { SegmentedControl } from '@/components/ui/segmented-control';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  createCustomMcpServer,
  readCustomMcpToken,
  updateCustomMcpServer,
} from '@/lib/customMcpServers';

import type { McpSetupProposal } from '@/../shared/mcpSetup';
import { MCP_TRANSPORTS, isStdioMcpConfig, type StdioMcpConfig, type CustomMcpConfig, type McpTransport } from '@/../shared/customMcp';

interface McpServerDialogProps {
  initial?: CustomMcpConfig;
  proposal?: McpSetupProposal;
  embedded?: boolean;
  /** 伙伴对话里打开：新工具在同一对话下一轮生效，不提示新建任务。 */
  teammate?: boolean;
  /** 已占用的全部 MCP id;新建自动生成 id 时避让。 */
  existingIds?: string[];
  onSaved: (serverId: string) => void;
  onClose: () => void;
}

interface HeaderRow {
  name: string;
  value: string;
  _key: number;
}

/**
 * 自定义 MCP id 统一前缀。内置 lizi MCP 命名为 `lizi_*` 与裸 `slack`;自定义 id 一律带
 * `custom_` 前缀,保证不会与内置 provider.name 撞车(Claude 按 name 映射配置、Codex 的
 * `mcp_servers.<name>` 是单一命名空间,撞名会覆盖内置)。前缀是对用户隐藏的内部句柄。
 */
const CUSTOM_ID_PREFIX = 'custom_';
// MAX_ID_LEN on server = 40; prefix = 7; reserve 3 chars for '-99' suffix → slug ≤ 30 chars
const MAX_SLUG_LEN = 40 - CUSTOM_ID_PREFIX.length - 3;

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return s || 'mcp';
}
function uniqueId(name: string, existing: ReadonlySet<string>): string {
  const base = `${CUSTOM_ID_PREFIX}${slugify(name).slice(0, MAX_SLUG_LEN)}`;
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

export function McpServerDialog({ initial, proposal, embedded, teammate, existingIds, onSaved, onClose }: McpServerDialogProps) {
  const { t } = useTranslation();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? proposal?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? proposal?.transport ?? 'http');
  const [url, setUrl] = useState(initial?.url ?? proposal?.url ?? '');
  const [localConfig, setLocalConfig] = useState(() => JSON.stringify(initial?.stdio ?? {
    command: proposal?.command ?? '', args: proposal?.args ?? [], env: {},
  }, null, 2));
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const headerKeyRef = useRef(0);
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const initRows =
      initial && Object.keys(initial.headers).length > 0
        ? Object.entries(initial.headers).map(([n, v]) => ({ name: n, value: v }))
        : [{ name: '', value: '' }];
    return initRows.map((r) => ({ ...r, _key: headerKeyRef.current++ }));
  });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const addHeaderRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [errors, setErrors] = useState<{ name?: string; url?: string; localConfig?: string }>({});
  const close = () => {
    if (!savingRef.current) onClose();
  };

  // 编辑态:回填已存 token(让 token 框「能看」/可核对,据此点亮「已保存」徽标)。
  useEffect(() => {
    if (!editing || !initial || initial.transport === 'stdio') return;
    let cancelled = false;
    void (async () => {
      const k = await readCustomMcpToken(initial.id);
      if (cancelled) return;
      if (k) {
        setHasToken(true);
        setToken(k);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing, initial]);

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    const nextErrors: { name?: string; url?: string; localConfig?: string } = {};
    if (!trimmedName) nextErrors.name = t('settings.mcp.errors.nameRequired');
    let stdio: StdioMcpConfig | undefined;
    if (transport === 'stdio') {
      try {
        const parsed: unknown = JSON.parse(localConfig);
        if (!isStdioMcpConfig(parsed)) throw new Error();
        stdio = parsed;
      } catch {
        nextErrors.localConfig = t('settings.mcp.errors.localConfigInvalid');
      }
    } else {
      try {
        const u = new URL(trimmedUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          nextErrors.url = t('settings.mcp.errors.urlInvalid');
      } catch {
        nextErrors.url = t('settings.mcp.errors.urlInvalid');
      }
    }
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.url || nextErrors.localConfig) {
      const invalid = document.getElementById(`${id}-${nextErrors.name ? 'name' : nextErrors.localConfig ? 'localConfig' : 'url'}`);
      invalid?.focus();
      invalid?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      const n = h.name.trim();
      if (n) headerMap[n] = h.value.trim();
    }
    const configId =
      editing && initial ? initial.id : uniqueId(trimmedName, new Set(existingIds ?? []));
    const config: CustomMcpConfig = {
      id: configId,
      name: trimmedName,
      transport,
      url: transport === 'stdio' ? '' : trimmedUrl,
      headers: transport === 'stdio' ? {} : headerMap,
      ...(stdio ? { stdio } : {}),
    };
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing) {
        // clearToken=true：只有在 token 已加载（hasToken=true）且字段被清空时才撤销鉴权；
        // 若 token 字段为空但 hasToken=false（async 回填尚未完成），则保留已存 token。
        const clearToken = transport === 'stdio' || (hasToken && !token.trim());
        await updateCustomMcpServer(config, transport === 'stdio' ? '' : token, clearToken);
        toast.success(t('settings.mcp.toast.updated'));
      } else {
        await createCustomMcpServer(config, transport === 'stdio' ? '' : token);
        toast.success(t('settings.mcp.toast.created'));
      }
      onSaved(configId);
    } catch (e) {
      const ipc = extractIpcError(e);
      toast.error(ipc?.message ?? t('settings.mcp.toast.saveFailed'));
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    id,
    name,
    url,
    transport,
    localConfig,
    token,
    hasToken,
    headers,
    editing,
    initial,
    existingIds,
    onSaved,
    t,
  ]);

  const tokenPlaceholder = hasToken
    ? t('settings.mcp.fields.tokenEditPlaceholder')
    : t('settings.mcp.fields.tokenPlaceholder');

  const Title = embedded ? 'h3' : Dialog.Title;
  const Description = embedded ? 'p' : Dialog.Description;
  const content = <>
          <div className="flex shrink-0 items-center gap-2.5 p-4">
            <Sparkles size={20} className="shrink-0 text-[var(--settings-section-title)]" />
            <Title className="text-18 font-medium text-[var(--settings-section-title)]">
              {editing ? t('settings.mcp.dialog.editTitle') : t('settings.mcp.dialog.createTitle')}
            </Title>
          </div>
          <div className={cn("flex min-h-0 flex-col gap-4 px-4 pb-2 pt-1", !embedded && "overflow-y-auto")}>
            <Description className="text-13 leading-relaxed text-[var(--settings-section-desc)]">
              {t(teammate ? 'settings.mcp.dialog.teammateDesc' : 'settings.mcp.dialog.desc')}
            </Description>
            <FormField
              id={`${id}-name`}
              label={t('settings.mcp.fields.name')}
              required
              error={errors.name}
              reserveFeedback
            >
              {(control) => (
                <SettingsTextInput
                  {...control}
                  data-setting-id={mcpFields.name.id}
                  inputRef={nameRef}
                  surface="ivory"
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    setErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  placeholder={t('settings.mcp.fields.namePlaceholder')}
                />
              )}
            </FormField>
            <fieldset className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.mcp.fields.transport')}
              </legend>
              <div className="flex flex-wrap gap-2">
                {/*
                  transport 是紧凑互斥设置,走共享分段控件(DESIGN.md §4 Settings
                  segmented controls):单一 Tab 停靠点、方向键 / Home / End 与 RTL
                  键盘行为由控件自带,不再用独立 Button 自造第二套选中态(review P2)。
                */}
                <SegmentedControl
                  data-setting-id={mcpFields.transport.id}
                  aria-label={t('settings.mcp.fields.transport')}
                  value={transport}
                  onValueChange={setTransport}
                  options={MCP_TRANSPORTS.map((tp) => ({
                    value: tp,
                    label: <span className="uppercase">{tp}</span>,
                  }))}
                />
              </div>
            </fieldset>
            <div className="flex flex-col gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface)] p-4">
              {transport === 'stdio' ? (
                <FormField id={`${id}-localConfig`} label={t('settings.mcp.fields.localConfig')}
                  hint={t('settings.mcp.fields.localHelp')} required error={errors.localConfig} reserveFeedback>
                  {(control) => <Textarea {...control} data-setting-id={mcpFields.localConfig.id} surface="ivory" rows={8} spellCheck={false}
                    value={localConfig} onChange={(value) => {
                      setLocalConfig(value);
                      setErrors((prev) => ({ ...prev, localConfig: undefined }));
                    }} />}
                </FormField>
              ) : <>
              <FormField
                id={`${id}-url`}
                label={t('settings.mcp.fields.url')}
                required
                error={errors.url}
                reserveFeedback
              >
                {(control) => (
                  <SettingsTextInput
                    {...control}
                    surface="ivory"
                    data-setting-id={mcpFields.url.id}
                    value={url}
                    onChange={(value) => {
                      setUrl(value);
                      setErrors((prev) => ({ ...prev, url: undefined }));
                    }}
                    placeholder={t('settings.mcp.fields.urlPlaceholder')}
                  />
                )}
              </FormField>
              <FormField
                id={`${id}-token`}
                label={t('settings.mcp.fields.token')}
                hint={t('settings.mcp.fields.tokenHelp')}
                labelAction={
                  hasToken && (
                    <span className="flex items-center gap-1 rounded-full bg-[var(--settings-btn-secondary-bg)] px-2 py-0.5 text-11 font-medium text-[var(--settings-section-desc)]">
                      <Check size={11} />
                      {t('settings.mcp.fields.tokenSaved')}
                    </span>
                  )
                }
              >
                {(control) => (
                  <SettingsTextInput
                    {...control}
                    surface="ivory"
                    data-setting-id={mcpFields.token.id}
                    value={token}
                    onChange={setToken}
                    placeholder={tokenPlaceholder}
                    secret
                    secretTipContentClassName="z-[10001]"
                  />
                )}
              </FormField>
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-2 text-13 font-medium text-[var(--settings-section-title)]">
                  {t('settings.mcp.fields.headers')}
                </legend>
                {headers.map((h, i) => (
                  <div key={h._key} className="flex min-w-0 items-center gap-2">
                    <FormField
                      id={`${id}-header-${h._key}-name`}
                      label={`${t('settings.mcp.fields.headerNamePlaceholder')} ${i + 1}`}
                      hideLabel
                      className="flex-1"
                    >
                      {(control) => (
                        <SettingsTextInput
                          {...control}
                          surface="ivory"
                          data-setting-id={mcpFields.headerName.id}
                          value={h.name}
                          onChange={(value) =>
                            setHeaders((prev) =>
                              prev.map((row) =>
                                row._key === h._key ? { ...row, name: value } : row,
                              ),
                            )
                          }
                          placeholder={t('settings.mcp.fields.headerNamePlaceholder')}
                        />
                      )}
                    </FormField>
                    <FormField
                      id={`${id}-header-${h._key}-value`}
                      label={`${t('settings.mcp.fields.headerValuePlaceholder')} ${i + 1}`}
                      hideLabel
                      className="flex-1"
                    >
                      {(control) => (
                        <SettingsTextInput
                          {...control}
                          surface="ivory"
                          data-setting-id={mcpFields.headerValue.id}
                          value={h.value}
                          onChange={(value) =>
                            setHeaders((prev) =>
                              prev.map((row) => (row._key === h._key ? { ...row, value } : row)),
                            )
                          }
                          placeholder={t('settings.mcp.fields.headerValuePlaceholder')}
                        />
                      )}
                    </FormField>
                    <Tip
                      text={t('settings.mcp.fields.removeRow')}
                      contentClassName="z-[10001]"
                    >
                      <Button
                        data-settings-search-action="Remove this header row"
                        variant="secondary"
                        className="w-9 px-0"
                        size="lg"
                        aria-label={`${t('settings.mcp.fields.removeRow')} ${i + 1}`}
                        onClick={() => {
                          const next = headers[i + 1] ?? headers[i - 1];
                          setHeaders((prev) => prev.filter((row) => row._key !== h._key));
                          requestAnimationFrame(() => {
                            (next
                              ? document.getElementById(`${id}-header-${next._key}-name`)
                              : addHeaderRef.current
                            )?.focus();
                          });
                        }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </Tip>
                  </div>
                ))}
                <Button
                  data-settings-search-action="Add a header row to this configuration"
                  ref={addHeaderRef}
                  variant="secondary"
                  className="gap-1.5 self-start"
                  onClick={() => {
                    const key = headerKeyRef.current++;
                    setHeaders((prev) => [...prev, { name: '', value: '', _key: key }]);
                    requestAnimationFrame(() =>
                      document.getElementById(`${id}-header-${key}-name`)?.focus(),
                    );
                  }}
                >
                  <Plus size={14} />
                  {t('settings.mcp.fields.addHeader')}
                </Button>
              </fieldset>
              </>}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2.5 p-4">
            <Button
              variant="secondary"
              size="lg"
              disabled={saving}
              data-settings-search-action="Cancel editing this configuration"
              onClick={close}
              palette="confirmation"
            >
              {t('settings.mcp.cancel')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              loading={saving}
              data-settings-search-action="Save this MCP configuration"
              onClick={() => void handleSave()}
              palette="confirmation"
              className="min-w-[96px]"
            >
              {t('settings.mcp.save')}
            </Button>
          </div>
  </>;
  if (embedded) return (
    <section aria-label={t('settings.mcp.dialog.createTitle')}
      className="w-full min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {content}
    </section>
  );

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          className={cn(
            'modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[88vh] w-[min(600px,calc(100vw-32px))] flex-col outline-none',
            '[&_button:focus-visible]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-[var(--focus-ring)]',
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (savingRef.current || event.isComposing || event.keyCode === 229)
              event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          {content}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
