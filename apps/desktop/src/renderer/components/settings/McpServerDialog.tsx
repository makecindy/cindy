/**
 * McpServerDialog —— 自定义 MCP 服务器「新建 / 编辑」表单弹窗。
 *
 * 结构参照 CustomProviderDialog:显示名称 + transport(http/sse)分段 + 端点 URL +
 * 可选 bearer token + 可选请求头(增删行)。
 *
 * 「MCP id」内部句柄由显示名 slug 派生 + 去重,对用户隐藏(= agent 侧 mcpServers[name],
 * 不能含 . 或 /)。配置经 maker IPC 入 localDb;token 经 safeStorage 存(见 lib/customMcpServers)。
 * 编辑态回填已存 token、留空 = 不改;id 不可改。颜色全走主题 token。
 *
 * 说明:transport 仅远程 http/sse。token 在 Claude 端合成 Authorization: Bearer;
 * Codex 端只支持 Bearer 型鉴权,用户自定义的非 Bearer header 仅 Claude 生效。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, EyeOff, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  createCustomMcpServer,
  readCustomMcpEnv,
  readCustomMcpToken,
  updateCustomMcpServer,
} from '@/lib/customMcpServers';

import { MCP_TRANSPORTS, type CustomMcpConfig, type McpTransport } from '@/../shared/customMcp';

interface McpServerDialogProps {
  initial?: CustomMcpConfig;
  /** 已占用的全部 MCP id;新建自动生成 id 时避让。 */
  existingIds?: string[];
  onSaved: () => void;
  onClose: () => void;
}

interface HeaderRow {
  name: string;
  value: string;
  _key: number;
}
interface EnvRow extends HeaderRow {}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-13 font-medium text-[var(--settings-section-title)]">{children}</span>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  trailing,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'h-[40px] w-full rounded-[10px] pl-[12px] text-14 outline-none transition-colors',
          trailing ? 'pr-9' : 'pr-[12px]',
          'text-[var(--settings-input-text)] placeholder:text-[var(--settings-input-placeholder)]',
          'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] focus:border-[var(--settings-input-border-focus)]',
        )}
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      />
      {trailing}
    </div>
  );
}

export function McpServerDialog({ initial, existingIds, onSaved, onClose }: McpServerDialogProps) {
  const { t } = useTranslation();
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? 'http');
  const [url, setUrl] = useState(initial?.transport === 'stdio' ? '' : (initial?.url ?? ''));
  const [command, setCommand] = useState(initial?.transport === 'stdio' ? initial.command : '');
  const [args, setArgs] = useState(initial?.transport === 'stdio' ? initial.args.join('\n') : '');
  const [cwd, setCwd] = useState(initial?.transport === 'stdio' ? initial.cwd : '');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const headerKeyRef = useRef(0);
  const [headers, setHeaders] = useState<HeaderRow[]>(() => {
    const initialHeaders = initial?.transport === 'stdio' ? undefined : initial?.headers;
    const initRows: Omit<HeaderRow, '_key'>[] =
      initialHeaders && Object.keys(initialHeaders).length > 0
        ? Object.entries(initialHeaders).map(([name, value]) => ({ name, value }))
        : [{ name: '', value: '' }];
    return initRows.map((r) => ({ ...r, _key: headerKeyRef.current++ }));
  });
  const envKeyRef = useRef(1);
  const [env, setEnv] = useState<EnvRow[]>([{ name: '', value: '', _key: 0 }]);
  const [saving, setSaving] = useState(false);

  // 编辑态:回填已存 token(让 token 框「能看」/可核对,据此点亮「已保存」徽标)。
  useEffect(() => {
    if (!editing || !initial) return;
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
  useEffect(() => {
    if (!editing || !initial || initial.transport !== 'stdio') return;
    let cancelled = false;
    void readCustomMcpEnv(initial.id).then((values) => {
      if (cancelled) return;
      const rows = Object.entries(values).map(([name, value]) => ({
        name,
        value,
        _key: envKeyRef.current++,
      }));
      setEnv(rows.length ? rows : [{ name: '', value: '', _key: envKeyRef.current++ }]);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, initial]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t('settings.mcp.errors.nameRequired'));
      return;
    }
    const isStdio = transport === 'stdio';
    const trimmedUrl = url.trim();
    if (!isStdio)
      try {
        const u = new URL(trimmedUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          toast.error(t('settings.mcp.errors.urlInvalid'));
          return;
        }
      } catch {
        toast.error(t('settings.mcp.errors.urlInvalid'));
        return;
      }
    if (isStdio && !command.trim()) {
      toast.error(t('settings.mcp.errors.commandRequired'));
      return;
    }
    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      const n = h.name.trim();
      if (n) headerMap[n] = h.value.trim();
    }
    const id = editing && initial ? initial.id : uniqueId(trimmedName, new Set(existingIds ?? []));
    const config: CustomMcpConfig = isStdio
      ? {
          id,
          name: trimmedName,
          transport: 'stdio',
          command: command.trim(),
          args: args
            .split('\n')
            .map((arg) => arg.trim())
            .filter(Boolean),
          cwd: cwd.trim(),
        }
      : { id, name: trimmedName, transport, url: trimmedUrl, headers: headerMap };
    const envMap = Object.fromEntries(
      env.map((entry) => [entry.name.trim(), entry.value]).filter(([key]) => key),
    );
    if (isStdio && Object.keys(envMap).some((key) => !ENV_NAME_RE.test(key))) {
      toast.error(t('settings.mcp.errors.envNameInvalid'));
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        // clearToken=true：只有在 token 已加载（hasToken=true）且字段被清空时才撤销鉴权；
        // 若 token 字段为空但 hasToken=false（async 回填尚未完成），则保留已存 token。
        const clearToken = hasToken && !token.trim();
        await updateCustomMcpServer(config, token, clearToken, envMap);
        toast.success(t('settings.mcp.toast.updated'));
      } else {
        await createCustomMcpServer(config, token, envMap);
        toast.success(t('settings.mcp.toast.created'));
      }
      onSaved();
    } catch (e) {
      const ipc = extractIpcError(e);
      toast.error(ipc?.message ?? t('settings.mcp.toast.saveFailed'));
      setSaving(false);
    }
  }, [
    name,
    url,
    transport,
    command,
    args,
    cwd,
    token,
    hasToken,
    headers,
    env,
    editing,
    initial,
    existingIds,
    onSaved,
    t,
  ]);

  const tokenPlaceholder = hasToken
    ? t('settings.mcp.fields.tokenEditPlaceholder')
    : t('settings.mcp.fields.tokenPlaceholder');

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[var(--overlay-modal)]">
      <div
        className={cn(
          'flex max-h-[88vh] w-[600px] flex-col rounded-[16px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-3 py-3">
          <div className="flex items-center gap-2.5 pl-2">
            <Sparkles size={20} className="text-[var(--settings-section-title)]" />
            <h2 className="text-18 font-semibold text-[var(--settings-section-title)]">
              {editing ? t('settings.mcp.dialog.editTitle') : t('settings.mcp.dialog.createTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.mcp.cancel')}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col gap-[18px] overflow-y-auto px-6 pb-2 pt-1">
          <p className="text-13 leading-[1.55] text-[var(--settings-section-desc)]">
            {t('settings.mcp.dialog.desc')}
          </p>

          {/* 显示名称 */}
          <div className="flex flex-col gap-[7px]">
            <FieldLabel>{t('settings.mcp.fields.name')}</FieldLabel>
            <TextInput
              value={name}
              onChange={setName}
              placeholder={t('settings.mcp.fields.namePlaceholder')}
            />
          </div>

          {/* transport 分段 */}
          <div className="flex flex-col gap-2">
            <FieldLabel>{t('settings.mcp.fields.transport')}</FieldLabel>
            <div
              className="flex h-9 items-center gap-0.5 rounded-full p-[3px]"
              style={{ backgroundColor: 'var(--surface-chip)' }}
              role="tablist"
            >
              {MCP_TRANSPORTS.map((tp) => {
                const active = transport === tp;
                return (
                  <button
                    key={tp}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTransport(tp)}
                    className={cn(
                      'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-13 uppercase leading-none transition-colors',
                      active ? 'font-medium' : 'font-normal',
                    )}
                    style={
                      active
                        ? {
                            backgroundColor: 'var(--surface-elevated)',
                            border: '1px solid var(--border-default)',
                            color: 'var(--settings-section-title)',
                          }
                        : { color: 'var(--text-secondary)' }
                    }
                  >
                    {tp}
                  </button>
                );
              })}
            </div>
          </div>

          {transport === 'stdio' ? (
            <div
              className="flex flex-col gap-4 rounded-[12px] p-4"
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--settings-theme-card-border)',
              }}
            >
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.mcp.fields.command')}</FieldLabel>
                <TextInput
                  value={command}
                  onChange={setCommand}
                  placeholder={t('settings.mcp.fields.commandPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.mcp.fields.args')}</FieldLabel>
                <textarea
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder={t('settings.mcp.fields.argsPlaceholder')}
                  className="min-h-20 rounded-[10px] border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] p-3 text-14 text-[var(--settings-input-text)] outline-none focus:border-[var(--settings-input-border-focus)]"
                />
              </div>
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.mcp.fields.cwd')}</FieldLabel>
                <TextInput
                  value={cwd}
                  onChange={setCwd}
                  placeholder={t('settings.mcp.fields.cwdPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-2">
                <FieldLabel>{t('settings.mcp.fields.env')}</FieldLabel>
                {env.map((entry, i) => (
                  <div key={entry._key} className="flex items-center gap-2">
                    <div className="flex-1">
                      <TextInput
                        value={entry.name}
                        onChange={(value) =>
                          setEnv((rows) =>
                            rows.map((row, index) => (index === i ? { ...row, name: value } : row)),
                          )
                        }
                        placeholder={t('settings.mcp.fields.envNamePlaceholder')}
                      />
                    </div>
                    <div className="flex-1">
                      <TextInput
                        value={entry.value}
                        onChange={(value) =>
                          setEnv((rows) =>
                            rows.map((row, index) => (index === i ? { ...row, value } : row)),
                          )
                        }
                        placeholder={t('settings.mcp.fields.envValuePlaceholder')}
                        type="password"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setEnv((rows) => rows.filter((_, index) => index !== i))}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
                      aria-label={t('settings.mcp.fields.removeRow')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setEnv((rows) => [...rows, { name: '', value: '', _key: envKeyRef.current++ }])
                  }
                  className="flex items-center gap-1.5 self-start py-0.5 text-13 font-medium text-[var(--settings-section-title)]"
                >
                  <Plus size={14} className="text-[var(--settings-section-desc)]" />
                  {t('settings.mcp.fields.addEnv')}
                </button>
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.mcp.fields.envHelp')}
                </span>
              </div>
            </div>
          ) : (
            <div
              className="flex flex-col gap-4 rounded-[12px] p-4"
              style={{
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--settings-theme-card-border)',
              }}
            >
              <div className="flex flex-col gap-[7px]">
                <FieldLabel>{t('settings.mcp.fields.url')}</FieldLabel>
                <TextInput
                  value={url}
                  onChange={setUrl}
                  placeholder={t('settings.mcp.fields.urlPlaceholder')}
                />
              </div>

              {/* bearer token（可选） */}
              <div className="flex flex-col gap-[7px]">
                <div className="flex items-center gap-2">
                  <FieldLabel>{t('settings.mcp.fields.token')}</FieldLabel>
                  {hasToken && (
                    <span
                      className="flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium"
                      style={{
                        backgroundColor: 'var(--settings-btn-secondary-bg)',
                        color: 'var(--settings-section-desc)',
                      }}
                    >
                      <Check size={11} strokeWidth={2.5} />
                      {t('settings.mcp.fields.tokenSaved')}
                    </span>
                  )}
                </div>
                <TextInput
                  value={token}
                  onChange={setToken}
                  placeholder={tokenPlaceholder}
                  type={showToken ? 'text' : 'password'}
                  trailing={
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="absolute right-[12px] top-1/2 -translate-y-1/2 text-[var(--settings-eye-icon)] transition-colors hover:text-[var(--settings-eye-icon-hover)]"
                      aria-label={
                        showToken ? t('settings.apiKey.hideKey') : t('settings.apiKey.showKey')
                      }
                    >
                      {showToken ? <Eye size={16} /> : <EyeOff size={16} />}
                    </button>
                  }
                />
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.mcp.fields.tokenHelp')}
                </span>
              </div>

              {/* 请求头（可选） */}
              <div className="flex flex-col gap-2">
                <FieldLabel>{t('settings.mcp.fields.headers')}</FieldLabel>
                {headers.map((h, i) => (
                  <div key={h._key} className="flex items-center gap-2">
                    <div className="flex-1">
                      <TextInput
                        value={h.name}
                        onChange={(v) =>
                          setHeaders((prev) =>
                            prev.map((y, j) => (j === i ? { ...y, name: v } : y)),
                          )
                        }
                        placeholder={t('settings.mcp.fields.headerNamePlaceholder')}
                      />
                    </div>
                    <div className="flex-1">
                      <TextInput
                        value={h.value}
                        onChange={(v) =>
                          setHeaders((prev) =>
                            prev.map((y, j) => (j === i ? { ...y, value: v } : y)),
                          )
                        }
                        placeholder={t('settings.mcp.fields.headerValuePlaceholder')}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setHeaders((prev) => prev.filter((_, j) => j !== i))}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
                      aria-label={t('settings.mcp.fields.removeRow')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setHeaders((prev) => [
                      ...prev,
                      { name: '', value: '', _key: headerKeyRef.current++ },
                    ])
                  }
                  className="flex items-center gap-1.5 self-start py-0.5 text-13 font-medium text-[var(--settings-section-title)]"
                >
                  <Plus size={14} className="text-[var(--settings-section-desc)]" />
                  {t('settings.mcp.fields.addHeader')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2.5 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'inline-flex items-center justify-center rounded-full border bg-transparent px-6 py-2.5 text-13 font-medium transition-colors active:scale-[0.98]',
              'border-[var(--confirm-btn-secondary-border)] text-[var(--confirm-btn-secondary-text)] hover:bg-[var(--confirm-btn-secondary-hover)]',
            )}
          >
            {t('settings.mcp.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className={cn(
              'relative inline-flex min-w-[96px] items-center justify-center rounded-full px-6 py-2.5 text-13 font-medium transition-colors active:scale-[0.98]',
              'bg-[var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] hover:bg-[var(--confirm-btn-primary-hover)]',
              saving && 'cursor-not-allowed opacity-50',
            )}
          >
            {saving && (
              <span className="absolute left-[18px] inline-flex animate-spin motion-reduce:animate-none">
                <Loader2 className="h-[14px] w-[14px]" />
              </span>
            )}
            {t('settings.mcp.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
