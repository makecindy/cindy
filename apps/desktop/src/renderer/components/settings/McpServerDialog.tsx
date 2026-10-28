/** Settings and conversation setup share the same form; secrets stay in local component state. */
import { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Sparkles, Trash2 } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Tip } from '@/components/ui/tooltip';
import { SettingsTextInput } from './SettingsTextInput';
import { SegmentedControl } from '@/components/ui/segmented-control';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { createCustomMcpServer, updateCustomMcpServer } from '@/lib/customMcpServers';

import type { CustomMcpMutation, CustomMcpSummary, McpSetupDraft } from '@/../shared/mcpSetup';
import { MCP_TRANSPORTS, type CustomMcpConfig, type McpTransport } from '@/../shared/customMcp';

interface McpServerDialogProps {
  initial?: CustomMcpConfig & Partial<CustomMcpSummary>;
  proposal?: McpSetupDraft;
  embedded?: boolean;
  submit?: (input: CustomMcpMutation) => Promise<void>;
  canCancel?: boolean;
  deviceName?: string;
  /** 已占用的全部 MCP id;新建自动生成 id 时避让。 */
  existingIds?: string[];
  onSaved: () => void;
  onClose: () => void;
}

interface HeaderRow {
  name: string;
  value: string;
  _key: number;
  savedName?: string;
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

export function McpServerDialog({
  initial,
  proposal,
  embedded,
  submit,
  canCancel,
  deviceName,
  existingIds,
  onSaved,
  onClose,
}: McpServerDialogProps) {
  const { t } = useTranslation();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? proposal?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(
    initial?.transport ?? proposal?.transport ?? 'http',
  );
  const [url, setUrl] = useState(initial?.url ?? proposal?.url ?? '');
  const [urlEdited, setUrlEdited] = useState(false);
  const [token, setToken] = useState('');
  const hasToken = initial?.hasToken === true;
  const [clearToken, setClearToken] = useState(false);
  const headerKeyRef = useRef(0);
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const initRows =
      initial && Object.keys(initial.headers).length > 0
        ? Object.keys(initial.headers).map((n) => ({ name: n, value: '', savedName: n }))
        : proposal?.headerNames.length
          ? proposal.headerNames.map((name) => ({ name, value: '' }))
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
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const close = () => {
    if (!savingRef.current || canCancel) onClose();
  };

  const handleSave = useCallback(async () => {
    if (savingRef.current) return;
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    const nextErrors: { name?: string; url?: string } = {};
    if (!trimmedName) nextErrors.name = t('settings.mcp.errors.nameRequired');
    try {
      const u = new URL(trimmedUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:')
        nextErrors.url = t('settings.mcp.errors.urlInvalid');
      if (embedded && (u.username || u.password || u.search || u.hash))
        nextErrors.url = t('settings.mcp.setup.errors.INVALID_CONFIG');
      if (
        embedded &&
        u.protocol === 'http:' &&
        !['localhost', '[::1]'].includes(u.hostname) &&
        !/^127\./.test(u.hostname)
      )
        nextErrors.url = t('settings.mcp.setup.errors.INSECURE_ENDPOINT');
    } catch {
      nextErrors.url = t('settings.mcp.errors.urlInvalid');
    }
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.url) {
      const invalid = document.getElementById(`${id}-${nextErrors.name ? 'name' : 'url'}`);
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
    const config: CustomMcpMutation = {
      id: configId,
      name: trimmedName,
      transport,
      url: trimmedUrl,
      headers: headerMap,
      expectedRevision: initial?.revision,
      keepUrl: initial?.urlRedacted && !urlEdited,
      keepHeaderNames: headers
        .filter((h) => h.savedName === h.name.trim() && !h.value)
        .map((h) => h.savedName!),
    };
    savingRef.current = true;
    setSaving(true);
    try {
      if (submit) {
        const pending = submit({ ...config, token, tokenAction: 'replace' });
        setToken('');
        setHeaders((rows) => rows.map((row) => ({ ...row, value: '' })));
        await pending;
      } else if (editing) {
        await updateCustomMcpServer(config, token, clearToken);
        toast.success(t('settings.mcp.toast.updated'));
      } else {
        await createCustomMcpServer(config, token);
        toast.success(t('settings.mcp.toast.created'));
      }
      setToken('');
      onSaved();
    } catch {
      toast.error(t('settings.mcp.toast.saveFailed'));
      setToken('');
      setHeaders((rows) => rows.map((row) => ({ ...row, value: '' })));
      savingRef.current = false;
      setSaving(false);
    }
  }, [
    id,
    name,
    url,
    transport,
    token,
    clearToken,
    submit,
    embedded,
    urlEdited,
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

  const Title = embedded ? 'h2' : Dialog.Title;
  const Description = embedded ? 'p' : Dialog.Description;
  const contents = (
    <>
      <div className="flex shrink-0 items-center gap-2.5 p-4">
        <Sparkles size={20} className="shrink-0 text-[var(--settings-section-title)]" />
        <Title className="text-18 font-semibold text-[var(--settings-section-title)]">
          {editing ? t('settings.mcp.dialog.editTitle') : t('settings.mcp.dialog.createTitle')}
        </Title>
      </div>
      <fieldset
        disabled={saving}
        className={cn(
          'flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto px-4 pb-2 pt-1',
          embedded && 'max-h-[min(320px,42vh)] overscroll-contain [scrollbar-gutter:stable]',
        )}
      >
        <Description className="text-13 leading-relaxed text-[var(--settings-section-desc)]">
          {t('settings.mcp.dialog.desc')}
        </Description>
        {embedded && (
          <div className="space-y-1 text-12 text-[var(--text-secondary)]">
            <p>{t('settings.mcp.setup.scope', { device: deviceName })}</p>
            <p>{t('settings.mcp.setup.localOnly')}</p>
          </div>
        )}
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
              aria-label={t('settings.mcp.fields.transport')}
              value={transport}
              onValueChange={(value) => {
                setTransport(value);
                if (embedded) {
                  setToken('');
                  setHeaders((rows) => rows.map((row) => ({ ...row, value: '' })));
                }
              }}
              options={MCP_TRANSPORTS.map((tp) => ({
                value: tp,
                label: <span className="uppercase">{tp}</span>,
              }))}
            />
          </div>
        </fieldset>
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface)] p-4">
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
                value={url}
                onChange={(value) => {
                  setUrl(value);
                  setUrlEdited(true);
                  if (embedded) {
                    setToken('');
                    setHeaders((rows) => rows.map((row) => ({ ...row, value: '' })));
                  }
                  setErrors((prev) => ({ ...prev, url: undefined }));
                }}
                placeholder={t('settings.mcp.fields.urlPlaceholder')}
              />
            )}
          </FormField>
          {initial?.urlRedacted && !urlEdited && (
            <p className="text-12 text-[var(--text-secondary)]">
              {t('settings.mcp.setup.preservedUrl')}
            </p>
          )}
          {embedded && (
            <p className="break-all text-12 text-[var(--text-secondary)]">
              {(() => {
                try {
                  const value = new URL(url);
                  return value.username || value.password || value.search || value.hash
                    ? ''
                    : value.href;
                } catch {
                  return '';
                }
              })()}
            </p>
          )}
          {embedded && url.startsWith('http:') && (
            <p className="text-12 text-[var(--text-secondary)]">
              {t('settings.mcp.setup.loopback')}
            </p>
          )}
          <FormField
            id={`${id}-token`}
            label={t('settings.mcp.fields.token')}
            hint={t('settings.mcp.fields.tokenHelp')}
            labelAction={
              hasToken &&
              !clearToken && (
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
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setClearToken(false);
                }}
                placeholder={tokenPlaceholder}
                secret
                secretTipContentClassName="z-[10001]"
              />
            )}
          </FormField>
          {hasToken && !clearToken && (
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => {
                setClearToken(true);
                setToken('');
              }}
            >
              {t('settings.mcp.setup.clearToken')}
            </Button>
          )}
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
                      value={h.name}
                      onChange={(value) =>
                        setHeaders((prev) =>
                          prev.map((row) => (row._key === h._key ? { ...row, name: value } : row)),
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
                      secret
                      value={h.value}
                      onChange={(value) =>
                        setHeaders((prev) =>
                          prev.map((row) => (row._key === h._key ? { ...row, value } : row)),
                        )
                      }
                      placeholder={
                        h.savedName === h.name && !h.value
                          ? t('settings.mcp.setup.keepHeader')
                          : t('settings.mcp.fields.headerValuePlaceholder')
                      }
                    />
                  )}
                </FormField>
                <Tip text={t('settings.mcp.fields.removeRow')} contentClassName="z-[10001]">
                  <Button
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
        </div>
      </fieldset>
      <div className="flex shrink-0 flex-wrap justify-end gap-2.5 p-4">
        <Button
          variant="secondary"
          size="lg"
          disabled={saving && !canCancel}
          onClick={close}
          palette="confirmation"
        >
          {t('settings.mcp.cancel')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          loading={saving}
          disabled={saving}
          onClick={() => void handleSave()}
          palette="confirmation"
          className="min-w-[96px]"
        >
          {t('settings.mcp.save')}
        </Button>
      </div>
    </>
  );
  if (embedded) return <div className="flex min-h-0 min-w-0 flex-col">{contents}</div>;

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
          {contents}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
