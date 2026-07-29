/**
 * RemoteSection — Settings → Remote tab.
 *
 * Phase A: list SSH hosts (sourced from ~/.ssh/config + ones added here),
 * connect/disconnect, add a new host, remove a manually-added host.
 * No agent-on-remote yet — that's Phase B.
 *
 * Design: matches ConnectionsSection card layout. Inline add-form
 * (no modal) keeps the surface area small for this first version.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Server, RefreshCw, Trash2, ChevronRight, ChevronDown, KeyRound, Pencil } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { remoteSshHostsStore } from '@/lib/remoteSshHostsStore';
import { extractIpcError, mapIpcErrorToI18nKey } from '@/utils/ipcError';
import { LEGACY_AGENT_PROXY_REMOTE_PORT, normalizeAgentProxyUrl } from '../../../shared/agentProxyConfig';

import { RemoteHostDetail } from './RemoteHostDetail';
import { SshKeySetupDialog } from './SshKeySetupDialog';

type Status = RemoteHostSnapshot['status'];

interface RowProps {
  snap: RemoteHostSnapshot;
  busy: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onSetupKey: () => void;
  onEdit: () => void;
  onToggleAutoConnect: (next: boolean) => void;
}

function statusVariables(status: Status): { dot: string; label: string } {
  // Status dot uses semantic colors (sanctioned exception to the "no hue" rule;
  // user explicitly asked for 绿/橙/红/灰 signaling — see colors.ts notes).
  // Hues go through theme tokens, never hardcoded hex per CLAUDE.md §18.
  switch (status) {
    case 'ready':
      return { dot: 'var(--remote-status-ready)', label: 'remote.status.ready' };
    case 'connecting':
    case 'authenticating':
    case 'reconnecting':
      return { dot: 'var(--remote-status-progress)', label: `remote.status.${status}` };
    case 'failed':
      return { dot: 'var(--remote-status-failed)', label: 'remote.status.failed' };
    default:
      return { dot: 'var(--remote-status-disconnected)', label: 'remote.status.disconnected' };
  }
}

function HostRow({
  snap,
  busy,
  expanded,
  onToggleExpanded,
  onConnect,
  onDisconnect,
  onRemove,
  onSetupKey,
  onEdit,
  onToggleAutoConnect,
}: RowProps) {
  const { t } = useTranslation();
  const { dot, label } = statusVariables(snap.status);
  const connectable = snap.status === 'disconnected' || snap.status === 'failed';
  const disconnectable = snap.status === 'ready' || snap.status === 'connecting'
    || snap.status === 'authenticating' || snap.status === 'reconnecting';
  const canExpand = snap.status === 'ready';

  // For non-failed states append " · via <auth-label>" so the user can see
  // which credential is actually carrying the connection. Catches the case
  // where authMethod=key was selected but the configured identityFile didn't
  // really get used (e.g. radio still on agent, or fallback through agent).
  const via = snap.lastAuthLabel
    ? ` · ${t('settings.remote.viaAuth', { label: snap.lastAuthLabel })}`
    : '';
  const subtitle = snap.lastError && snap.status === 'failed'
    ? snap.lastError
    : `${snap.config.user}@${snap.config.hostname}:${snap.config.port}${via}`;

  return (
    <div className="flex items-center gap-3 px-5 py-4">
      <button
        type="button"
        onClick={onToggleExpanded}
        disabled={!canExpand}
        aria-label={t(
          expanded ? 'settings.remote.button.collapse' : 'settings.remote.button.expand',
        )}
        className={cn(
          'flex h-5 w-5 items-center justify-center transition-colors',
          !canExpand && 'cursor-not-allowed opacity-30',
        )}
        style={{ color: 'var(--settings-integration-subtitle)' }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <div
        className="flex h-9 w-9 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        <Server size={18} />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-14 font-medium leading-tight"
            style={{ color: 'var(--settings-section-title)' }}
          >
            {snap.config.id}
          </span>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dot }}
            aria-hidden
          />
          <span
            className="text-12"
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            {t(`settings.${label}`)}
          </span>
        </div>
        <span
          className={cn(
            'text-13 leading-tight',
            // Failed state usually carries an actionable hint (e.g. the
            // `ssh-copy-id` instructions on auth failure) — let it wrap up
            // to 3 lines so the command is readable. Other states fit in
            // one line (`user@host:port`).
            snap.status === 'failed' ? 'whitespace-pre-wrap break-words' : 'truncate',
          )}
          style={{ color: 'var(--settings-integration-subtitle)' }}
          title={snap.status === 'failed' ? subtitle : undefined}
        >
          {subtitle}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* AutoConnect — 启动时是否自动连这个 host. 控件本身不算"动作", 但放
            在 action chips 区第一位最容易扫到, 也方便快速切换。disabled 仅在
            busy(connect/disconnect 进行中)时锁住, 避免与正在进行的 transition
            竞态。 */}
        <label
          className={cn(
            'flex items-center gap-1.5 cursor-pointer select-none px-2 h-8 rounded-full transition-colors',
            busy && 'cursor-not-allowed opacity-60',
          )}
          title={t('settings.remote.button.autoConnectTip')}
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          <input
            type="checkbox"
            checked={snap.autoConnect}
            disabled={busy}
            onChange={(e) => onToggleAutoConnect(e.target.checked)}
            className="cursor-pointer accent-[var(--settings-menu-text-selected)]"
          />
          <span className="text-12">{t('settings.remote.button.autoConnect')}</span>
        </label>
        {snap.status === 'failed' && (
          <button
            type="button"
            onClick={onSetupKey}
            disabled={busy}
            title={t('settings.remote.button.setupKeyTip')}
            className={cn(
              'flex h-8 items-center gap-1 justify-center rounded-full px-[14px] text-13 leading-none font-medium transition-colors border',
              busy && 'cursor-not-allowed opacity-60',
            )}
            style={{
              backgroundColor: 'transparent',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <KeyRound size={12} />
            <span className="relative top-px">{t('settings.remote.button.setupKey')}</span>
          </button>
        )}
        {connectable && (
          <button
            type="button"
            onClick={onConnect}
            disabled={busy}
            className={cn(
              'flex h-8 items-center justify-center rounded-full px-[14px] text-13 leading-none font-medium transition-colors border',
              busy && 'cursor-not-allowed opacity-60',
            )}
            style={{
              backgroundColor: 'var(--settings-btn-secondary-bg)',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <span className="relative top-px">{t('settings.remote.button.connect')}</span>
          </button>
        )}
        {disconnectable && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={busy}
            className={cn(
              'flex h-8 items-center justify-center rounded-full px-[14px] text-13 leading-none font-medium transition-colors border',
              busy && 'cursor-not-allowed opacity-60',
            )}
            style={{
              backgroundColor: 'var(--settings-btn-secondary-bg)',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <span className="relative top-px">{t('settings.remote.button.disconnect')}</span>
          </button>
        )}
        {/* Edit always available — surgical update preserves any hand-written
            directives (ProxyJump, ServerAliveInterval, ...) the user may
            have added in ~/.ssh/config. */}
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          aria-label={t('settings.remote.button.edit')}
          title={t('settings.remote.button.edit')}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
            busy && 'cursor-not-allowed opacity-60',
          )}
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          <Pencil size={14} />
        </button>
        {snap.config.source === 'manual' && (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            aria-label={t('settings.remote.button.remove')}
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
              busy && 'cursor-not-allowed opacity-60',
            )}
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

interface AddFormState {
  id: string;
  hostname: string;
  user: string;
  port: string;
  authMethod: 'agent' | 'key';
  identityFile: string;
  /** 「Agent 流量走 Proxy」开关。 */
  agentProxyEnabled: boolean;
  /** tunnel = Cindy 代建隧道; env = 自备代理 (仅注入环境变量)。 */
  agentProxyMode: 'tunnel' | 'env';
  /** tunnel 模式: 本地 Proxy 地址 (host:port)。 */
  agentProxyAddr: string;
  /** tunnel 模式: 远端固定监听端口 (文本输入, 提交时转数字)。 */
  agentProxyRemotePort: string;
  /** env 模式: 远端可达的代理 URL。 */
  agentProxyUrl: string;
}

const DEFAULT_AGENT_PROXY_REMOTE_PORT = String(LEGACY_AGENT_PROXY_REMOTE_PORT);

const EMPTY_FORM: AddFormState = {
  id: '',
  hostname: '',
  user: '',
  port: '22',
  authMethod: 'agent',
  identityFile: '',
  agentProxyEnabled: false,
  agentProxyMode: 'tunnel',
  agentProxyAddr: '127.0.0.1:7890',
  agentProxyRemotePort: DEFAULT_AGENT_PROXY_REMOTE_PORT,
  agentProxyUrl: 'http://127.0.0.1:7890',
};

/**
 * 解析 "host:port" 输入 — 支持 IPv6 bracket 形态 ([::1]:7890)。
 * 返回 null = 无法解析 (表单校验据此拦截提交)。
 */
export function parseProxyAddrInput(input: string): { localHost: string; localPort: number } | null {
  const s = input.trim();
  if (!s) return null;
  const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (bracket) {
    const localHost = bracket[1]!;
    const localPort = Number(bracket[2]);
    // bracket 内的 host 同样拒空白与引号 (与非 bracket 分支及 main 侧
    // IPC 校验一致, review: PR #715 R5)。
    return localHost && !/\s/.test(localHost) && !localHost.includes("'") && !localHost.includes('"')
        && Number.isInteger(localPort) && localPort >= 1 && localPort <= 65535
      ? { localHost, localPort }
      : null;
  }
  const idx = s.lastIndexOf(':');
  if (idx <= 0) return null;
  const localHost = s.slice(0, idx).trim();
  const portText = s.slice(idx + 1);
  // 严格数字校验 (review: PR #715 五轮审核 P2): parseInt 会把 "7890abc"
  // 静默截断成 7890, 表单和 main 侧都会接受这个并非用户本意的端口。
  if (!/^\d+$/.test(portText)) return null;
  const localPort = Number(portText);
  // 引号校验与 main 侧 normalizeAgentProxyInput 一致 (review: PR #715 R5) —
  // 渲染层放行、main 层拒绝的两套标准会让用户填了合法表象却被 IPC 打回。
  if (!localHost || /\s/.test(localHost) || localHost.includes("'") || localHost.includes('"')) return null;
  if (!Number.isInteger(localPort)) return null;
  if (localPort < 1 || localPort > 65535) return null;
  return { localHost, localPort };
}

/** 远端固定端口输入 — 严格整数, 且拒特权/知名服务端口 (与 main 侧
 * isAllowedAgentProxyRemotePort 同口径, 防清理路径误杀系统 sshd)。 */
export function parseRemotePortInput(input: string): number | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const port = Number(s);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

type AgentProxyPayload =
  | { enabled: boolean; mode: 'tunnel'; localHost: string; localPort: number; remotePort: number }
  | { enabled: boolean; mode: 'env'; proxyUrl: string };

/** 表单 → IPC agentProxy 载荷; 校验失败返回错误文案 key (toast 用)。 */
function buildAgentProxyPayload(
  form: AddFormState,
): { ok: true; agentProxy: AgentProxyPayload | null } | { ok: false; errorKey: string } {
  if (!form.agentProxyEnabled) return { ok: true, agentProxy: null };
  if (form.agentProxyMode === 'tunnel') {
    const addr = parseProxyAddrInput(form.agentProxyAddr);
    if (!addr) return { ok: false, errorKey: 'settings.remote.add.agentProxyAddrInvalid' };
    const remotePort = parseRemotePortInput(form.agentProxyRemotePort);
    if (!remotePort) return { ok: false, errorKey: 'settings.remote.add.agentProxyRemotePortInvalid' };
    return { ok: true, agentProxy: { enabled: true, mode: 'tunnel', ...addr, remotePort } };
  }
  const proxyUrl = parseProxyUrlInput(form.agentProxyUrl);
  if (!proxyUrl) return { ok: false, errorKey: 'settings.remote.add.agentProxyUrlInvalid' };
  return { ok: true, agentProxy: { enabled: true, mode: 'env', proxyUrl } };
}

/**
 * env 模式代理 URL 校验 — 直接复用 shared 的 normalizeAgentProxyUrl,
 * 与 main 侧 prefs/IPC 恒同口径 (两套标准会让用户填了合法表象被 IPC 打回)。
 */
export function parseProxyUrlInput(input: string): string | null {
  return normalizeAgentProxyUrl(input);
}

interface HostFormProps {
  /**
   * 'add' → blank form, alias editable, submit creates a new host.
   * 'edit' → form pre-filled with `initial`, alias locked (renaming is
   *          rename + re-add — keeps ~/.ssh/config consistency simple),
   *          submit updates the existing host.
   */
  mode: 'add' | 'edit';
  initial?: AddFormState;
  busy: boolean;
  onSubmit: (form: AddFormState) => void;
  onCancel: () => void;
}

function HostForm({ mode, initial, busy, onSubmit, onCancel }: HostFormProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<AddFormState>(initial ?? EMPTY_FORM);
  // Local dialog state. Three open modes — they share the same dialog but
  // have very different semantics for `onKeyPicked`:
  //   'manage'  → agent users opening to inspect / generate / unlock keys.
  //               Pick does NOT mutate the form.
  //   'pick'    → key-file users hunting for the right identityFile.
  //               Pick fills identityFile, keeps authMethod=key.
  //   'pinPick' → agent users pinning the agent to a single key
  //               (FilteredAgent path — solves MaxAuthTries with busy agents).
  //               Pick fills identityFile, KEEPS authMethod=agent.
  const [keysOpenMode, setKeysOpenMode] = useState<'manage' | 'pick' | 'pinPick' | null>(null);
  const isEdit = mode === 'edit';

  const valid = useMemo(() => {
    if (!form.id.trim() || /\s|[*?!]/.test(form.id)) return false;
    if (!form.hostname.trim()) return false;
    if (!form.user.trim()) return false;
    if (form.authMethod === 'key' && !form.identityFile.trim()) return false;
    if (form.agentProxyEnabled) {
      if (form.agentProxyMode === 'tunnel') {
        if (!parseProxyAddrInput(form.agentProxyAddr)) return false;
        if (!parseRemotePortInput(form.agentProxyRemotePort)) return false;
      } else if (!parseProxyUrlInput(form.agentProxyUrl)) {
        return false;
      }
    }
    return true;
  }, [form]);

  return (
    <div
      className="flex flex-col gap-3 px-5 py-4"
      style={isEdit ? { borderTop: '1px solid var(--settings-theme-card-border)' } : undefined}
    >
      <p
        className="text-13 font-medium"
        style={{ color: 'var(--settings-section-sublabel)' }}
      >
        {isEdit
          ? t('settings.remote.edit.title', { id: form.id })
          : t('settings.remote.add.title')}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label={t('settings.remote.add.alias')}
          placeholder="my-server"
          value={form.id}
          onChange={(v) => setForm({ ...form, id: v })}
          // Alias / Host directive is the join key between ~/.ssh/config and
          // our pool, AND the name a user may have typed in terminal scripts.
          // Renaming via UI = remove + re-add (out of scope to make safe).
          disabled={isEdit}
        />
        <LabeledInput
          label={t('settings.remote.add.hostname')}
          placeholder="example.com or 1.2.3.4"
          value={form.hostname}
          onChange={(v) => setForm({ ...form, hostname: v })}
        />
        <LabeledInput
          label={t('settings.remote.add.user')}
          placeholder="ubuntu"
          value={form.user}
          onChange={(v) => setForm({ ...form, user: v })}
        />
        <LabeledInput
          label={t('settings.remote.add.port')}
          placeholder="22"
          value={form.port}
          onChange={(v) => setForm({ ...form, port: v.replace(/[^0-9]/g, '') })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          className="text-12 font-medium"
          style={{ color: 'var(--settings-section-sublabel)' }}
        >
          {t('settings.remote.add.authMethod')}
        </label>
        <div className="flex gap-4">
          <RadioOption
            checked={form.authMethod === 'agent'}
            label={t('settings.remote.add.auth.agent')}
            hint={t('settings.remote.add.auth.agentHint')}
            // Keep identityFile across switches — in agent mode it's the
            // optional pin (FilteredAgent), in key mode it's the file we
            // read directly. User can unpin / clear from the agent block.
            onClick={() => setForm({ ...form, authMethod: 'agent' })}
          />
          <RadioOption
            checked={form.authMethod === 'key'}
            label={t('settings.remote.add.auth.key')}
            hint={t('settings.remote.add.auth.keyHint')}
            onClick={() => setForm({ ...form, authMethod: 'key' })}
          />
        </div>
        {form.authMethod === 'key' && (
          <div className="flex flex-col gap-1">
            <LabeledInput
              label={t('settings.remote.add.identityFile')}
              placeholder="~/.ssh/id_ed25519"
              value={form.identityFile}
              onChange={(v) => setForm({ ...form, identityFile: v })}
            />
            {/* Picker shortcut — opens dialog with `pick` semantics so a
                click on a key fills identityFile (instead of just browsing). */}
            <div className="flex items-center gap-2 text-12">
              <span style={{ color: 'var(--settings-integration-subtitle)' }}>
                {t('settings.remote.add.auth.keyPickPrompt')}
              </span>
              <button
                type="button"
                onClick={() => setKeysOpenMode('pick')}
                className="inline-flex items-center gap-1 underline underline-offset-2"
                style={{ color: 'var(--settings-section-title)' }}
              >
                <KeyRound size={11} />
                {t('settings.remote.button.pickKey')}
              </button>
            </div>
          </div>
        )}
        {form.authMethod === 'agent' && (
          <div className="flex flex-col gap-2">
            {/* Optional pin: when set, FilteredAgent only offers this one
                key to the server (sidesteps MaxAuthTries with busy agents).
                Empty = behave like vanilla agent (enumerate everything). */}
            <div className="flex flex-col gap-1">
              <span
                className="text-12 font-medium"
                style={{ color: 'var(--settings-section-sublabel)' }}
              >
                {t('settings.remote.add.auth.pinnedKeyLabel')}
              </span>
              {form.identityFile ? (
                <div className="flex items-center gap-2">
                  <code
                    className="flex-1 text-12 truncate rounded-md px-2 py-1.5"
                    style={{
                      backgroundColor: 'var(--surface-chip, #f5f5f5)',
                      color: 'var(--settings-section-title)',
                      fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
                    }}
                    title={form.identityFile}
                  >
                    {form.identityFile.split(/[/\\]/).pop()}
                  </code>
                  <button
                    type="button"
                    onClick={() => setKeysOpenMode('pinPick')}
                    className="h-7 rounded-full px-3 text-12 border"
                    style={{
                      backgroundColor: 'transparent',
                      borderColor: 'var(--settings-btn-secondary-border)',
                      color: 'var(--settings-btn-secondary-text)',
                    }}
                  >
                    {t('settings.remote.add.auth.pinnedKeyChange')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, identityFile: '' })}
                    className="h-7 rounded-full px-3 text-12 border"
                    style={{
                      backgroundColor: 'transparent',
                      borderColor: 'var(--settings-btn-secondary-border)',
                      color: 'var(--settings-btn-secondary-text)',
                    }}
                  >
                    {t('settings.remote.add.auth.pinnedKeyClear')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setKeysOpenMode('pinPick')}
                  className="self-start inline-flex items-center gap-1 h-7 rounded-full px-3 text-12 leading-none border"
                  style={{
                    backgroundColor: 'transparent',
                    borderColor: 'var(--settings-btn-secondary-border)',
                    color: 'var(--settings-btn-secondary-text)',
                  }}
                >
                  <KeyRound size={11} />
                  <span className="relative top-px">{t('settings.remote.add.auth.pinnedKeyPick')}</span>
                </button>
              )}
              <span
                className="text-11"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {form.identityFile
                  ? t('settings.remote.add.auth.pinnedKeyHintSet')
                  : t('settings.remote.add.auth.pinnedKeyHintUnset')}
              </span>
            </div>

            {/* Manage entry: pure read-only inspection of the agent state. */}
            <div className="flex items-center gap-2 text-12">
              <span style={{ color: 'var(--settings-integration-subtitle)' }}>
                {t('settings.remote.add.auth.agentKeysPrompt')}
              </span>
              <button
                type="button"
                onClick={() => setKeysOpenMode('manage')}
                className="inline-flex items-center gap-1 underline underline-offset-2"
                style={{ color: 'var(--settings-section-title)' }}
              >
                <KeyRound size={11} />
                {t('settings.remote.button.manageKeys')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Agent Proxy ──
          开关 + 双模式。pref 落 desktop 本地 ssh-host-prefs.json (不写
          ~/.ssh/config)。tunnel 模式: 远端 127.0.0.1:<固定端口> → 独立 SSH
          隧道 → 本机 Proxy; env 模式: 只注入用户给的远端可达 URL。
          codex daemon 经 env marker (重启生效), claude 按 session env (即时)。 */}
      <div className="flex flex-col gap-2">
        <label
          className="flex items-center gap-2 cursor-pointer select-none"
          title={t('settings.remote.add.agentProxyTip')}
        >
          <input
            type="checkbox"
            checked={form.agentProxyEnabled}
            onChange={(e) => setForm({ ...form, agentProxyEnabled: e.target.checked })}
            className="cursor-pointer accent-[var(--settings-menu-text-selected)]"
          />
          <span
            className="text-12 font-medium"
            style={{ color: 'var(--settings-section-sublabel)' }}
          >
            {t('settings.remote.add.agentProxy')}
          </span>
        </label>
        {form.agentProxyEnabled && (
          <div className="flex flex-col gap-2 pl-6">
            <div className="flex flex-col gap-1">
              {(['tunnel', 'env'] as const).map((mode) => (
                <label key={mode} className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="radio"
                    name="agent-proxy-mode"
                    checked={form.agentProxyMode === mode}
                    onChange={() => setForm({ ...form, agentProxyMode: mode })}
                    className="mt-[3px] cursor-pointer accent-[var(--settings-menu-text-selected)]"
                  />
                  <span className="flex flex-col">
                    <span
                      className="text-12 font-medium"
                      style={{ color: 'var(--settings-section-sublabel)' }}
                    >
                      {t(mode === 'tunnel'
                        ? 'settings.remote.add.agentProxyModeTunnel'
                        : 'settings.remote.add.agentProxyModeEnv')}
                    </span>
                    <span
                      className="text-11"
                      style={{ color: 'var(--settings-integration-subtitle)' }}
                    >
                      {t(mode === 'tunnel'
                        ? 'settings.remote.add.agentProxyModeTunnelDesc'
                        : 'settings.remote.add.agentProxyModeEnvDesc')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {form.agentProxyMode === 'tunnel' ? (
              <div className="flex flex-col gap-1">
                <LabeledInput
                  label={t('settings.remote.add.agentProxyAddr')}
                  placeholder="127.0.0.1:7890"
                  value={form.agentProxyAddr}
                  onChange={(v) => setForm({ ...form, agentProxyAddr: v })}
                />
                {form.agentProxyAddr.trim() && !parseProxyAddrInput(form.agentProxyAddr) && (
                  <span className="text-11" style={{ color: 'var(--error-fg)' }}>
                    {t('settings.remote.add.agentProxyAddrInvalid')}
                  </span>
                )}
                <LabeledInput
                  label={t('settings.remote.add.agentProxyRemotePort')}
                  placeholder={DEFAULT_AGENT_PROXY_REMOTE_PORT}
                  value={form.agentProxyRemotePort}
                  onChange={(v) => setForm({ ...form, agentProxyRemotePort: v })}
                />
                {form.agentProxyRemotePort.trim() && !parseRemotePortInput(form.agentProxyRemotePort) && (
                  <span className="text-11" style={{ color: 'var(--error-fg)' }}>
                    {t('settings.remote.add.agentProxyRemotePortInvalid')}
                  </span>
                )}
                <span
                  className="text-11"
                  style={{ color: 'var(--settings-integration-subtitle)' }}
                >
                  {t('settings.remote.add.agentProxyHint')}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <LabeledInput
                  label={t('settings.remote.add.agentProxyUrl')}
                  placeholder="http://127.0.0.1:7890"
                  value={form.agentProxyUrl}
                  onChange={(v) => setForm({ ...form, agentProxyUrl: v })}
                />
                {form.agentProxyUrl.trim() && !parseProxyUrlInput(form.agentProxyUrl) && (
                  <span className="text-11" style={{ color: 'var(--error-fg)' }}>
                    {t('settings.remote.add.agentProxyUrlInvalid')}
                  </span>
                )}
                <span
                  className="text-11"
                  style={{ color: 'var(--settings-integration-subtitle)' }}
                >
                  {t('settings.remote.add.agentProxyUrlHint')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex h-8 items-center rounded-full px-[14px] text-13 leading-none font-medium border"
          style={{
            backgroundColor: 'transparent',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          <span className="relative top-px">{t('settings.remote.add.cancel')}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            const next: AddFormState = {
              ...form,
              port: form.port.trim() || '22',
            };
            onSubmit(next);
          }}
          disabled={!valid || busy}
          className={cn(
            'flex h-8 items-center rounded-full px-[14px] text-13 leading-none font-medium border',
            (!valid || busy) && 'cursor-not-allowed opacity-60',
          )}
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          <span className="relative top-px">{isEdit
            ? t('settings.remote.edit.submit')
            : t('settings.remote.add.submit')}</span>
        </button>
      </div>

      {/* hostId=null + hostInline = the unsaved-form case: dialog renders
          the install command from the form's user/hostname/port instead of
          looking the host up by id in the pool (the host may not exist
          there yet for add-mode, or be stale during edit). The onKeyPicked
          wiring depends on WHY the dialog was opened:
            pick    → key-file mode picking identityFile (authMethod stays 'key')
            pinPick → agent mode pinning the agent to one key (authMethod stays 'agent')
            manage  → pure inspection, no mutation
          identityFile in both pick/pinPick is the private key path; resolveAuth
          derives the matching .pub for the FilteredAgent fingerprint lookup. */}
      <SshKeySetupDialog
        hostId={null}
        hostInline={{
          user: form.user.trim(),
          hostname: form.hostname.trim(),
          port: parseInt(form.port, 10) || undefined,
        }}
        open={keysOpenMode !== null}
        onOpenChange={(open) => { if (!open) setKeysOpenMode(null); }}
        onKeyPicked={(keysOpenMode === 'pick' || keysOpenMode === 'pinPick')
          ? (_pubkeyPath, privateKeyPath) => {
              setForm((prev) => ({ ...prev, identityFile: privateKeyPath }));
              setKeysOpenMode(null);
            }
          : undefined}
      />
    </div>
  );
}

function LabeledInput({
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  label: string;
  placeholder?: string;
  disabled?: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span
        className="text-12 font-medium"
        style={{ color: 'var(--settings-section-sublabel)' }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-9 rounded-lg border bg-transparent px-3 text-13 outline-none',
          disabled && 'cursor-not-allowed opacity-60',
        )}
        style={{
          borderColor: 'var(--settings-theme-card-border)',
          color: 'var(--settings-section-title)',
        }}
      />
    </label>
  );
}

function RadioOption({
  checked,
  label,
  hint,
  onClick,
}: {
  checked: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col gap-1 items-start text-left rounded-lg border p-3 transition-colors"
      style={{
        backgroundColor: checked
          ? 'var(--settings-menu-bg-selected)'
          : 'transparent',
        borderColor: checked
          ? 'var(--settings-menu-border-selected)'
          : 'var(--settings-theme-card-border)',
        color: 'var(--settings-section-title)',
      }}
    >
      <span className="text-13 font-medium">{label}</span>
      <span
        className="text-12"
        style={{ color: 'var(--settings-integration-subtitle)' }}
      >
        {hint}
      </span>
    </button>
  );
}

export function RemoteSection({ showTitle = true }: { showTitle?: boolean } = {}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<RemoteHostSnapshot[]>([]);
  const [adding, setAdding] = useState(false);
  /** Per-host busy flag so per-row buttons disable independently of each other. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [addBusy, setAddBusy] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  /** When non-null, SshKeySetupDialog is open and targeted at this host. */
  const [keySetupHostId, setKeySetupHostId] = useState<string | null>(null);
  /** True when the standalone "Manage keys" wizard is open (hostId=null,
   *  so the install-on-remote step is hidden — pure local key management). */
  const [keysManagerOpen, setKeysManagerOpen] = useState(false);
  /** When non-null, the inline edit form is shown below this host's row. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const setBusy = useCallback((id: string, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await window.electronAPI.remoteSsh.list();
      setHosts(res.hosts);
      remoteSshHostsStore.replace(res.hosts);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.loadFailed' })));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
    const off = window.electronAPI.remoteSsh.onStatusChanged((snap) => {
      setHosts((prev) => {
        const idx = prev.findIndex((h) => h.config.id === snap.config.id);
        if (idx < 0) return [...prev, snap];
        const copy = prev.slice();
        copy[idx] = snap;
        return copy;
      });
    });
    return () => {
      off();
    };
  }, [refresh]);

  const handleReload = useCallback(async () => {
    try {
      const res = await window.electronAPI.remoteSsh.reloadConfig();
      setHosts(res.hosts as RemoteHostSnapshot[]);
      remoteSshHostsStore.replace(res.hosts);
      toast.success(t('settings.remote.toast.reloaded'));
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.loadFailed' })));
    }
  }, [t]);

  const handleConnect = useCallback(async (id: string) => {
    setBusy(id, true);
    // 乐观把状态点立刻切到 connecting (橙), 否则上次 failed 的红会停留到 main 端
    // setStatus('connecting') 的 broadcast 真到达 renderer (一般几十 ms, 但因为
    // 按 connect 时 setBusy(true) 立刻触发 re-render, 中间会闪一帧"还是红")。
    // 真状态 push 回来时 onStatusChanged 会再覆盖一次, 始终以 main 端为准。
    setHosts((prev) => prev.map((h) => (
      h.config.id === id ? { ...h, status: 'connecting' as const, lastError: undefined } : h
    )));
    try {
      await window.electronAPI.remoteSsh.connect(id);
    } catch (err) {
      // SSH_AUTH_FAILED carries an actionable hint (ssh-copy-id command)
      // generated by RemoteHost.authFailureHint — show that verbatim
      // instead of the generic i18n key, so the user sees the exact
      // command they need to run.
      const ipc = extractIpcError(err);
      if (ipc?.code === 'SSH_AUTH_FAILED') {
        toast.error(ipc.message);
      } else {
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.connectFailed' })));
      }
    } finally {
      setBusy(id, false);
    }
  }, [setBusy, t]);

  const handleDisconnect = useCallback(async (id: string) => {
    setBusy(id, true);
    try {
      await window.electronAPI.remoteSsh.disconnect(id);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.disconnectFailed' })));
    } finally {
      setBusy(id, false);
    }
  }, [setBusy, t]);

  const handleSetAutoConnect = useCallback(async (id: string, next: boolean) => {
    // 乐观更新, main 端 STATUS_CHANGED 推回来会再覆盖一次同样的值。失败回滚 +
    // 显示 toast (不动 busyIds — 这个切换不涉及网络/SSH I/O, 用 busy 锁会让
    // 整行其它按钮假死, 与 connect/disconnect 的语义不同)。
    setHosts((prev) => prev.map((h) => (h.config.id === id ? { ...h, autoConnect: next } : h)));
    try {
      await window.electronAPI.remoteSsh.setAutoConnect(id, next);
    } catch (err) {
      setHosts((prev) => prev.map((h) => (h.config.id === id ? { ...h, autoConnect: !next } : h)));
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.autoConnectFailed' })));
    }
  }, [t]);

  const handleRemove = useCallback(async (id: string) => {
    setBusy(id, true);
    try {
      await window.electronAPI.remoteSsh.remove(id);
      setHosts((prev) => prev.filter((h) => h.config.id !== id));
      remoteSshHostsStore.remove(id);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.removeFailed' })));
    } finally {
      setBusy(id, false);
    }
  }, [setBusy, t]);

  const handleEdit = useCallback(async (form: AddFormState) => {
    setEditBusy(true);
    try {
      const port = parseInt(form.port, 10);
      // identityFile is meaningful in BOTH auth modes:
      //   key   → the private key to read directly
      //   agent → optional pin (FilteredAgent only offers this one key)
      // Empty string from the input = unset, send undefined.
      const trimmedIdentityFile = form.identityFile.trim();
      const proxyPayload = buildAgentProxyPayload(form);
      if (!proxyPayload.ok) {
        toast.error(t(proxyPayload.errorKey));
        return;
      }
      await window.electronAPI.remoteSsh.update({
        id: form.id.trim(),
        hostname: form.hostname.trim(),
        user: form.user.trim(),
        port: Number.isFinite(port) && port > 0 ? port : 22,
        authMethod: form.authMethod,
        identityFile: trimmedIdentityFile || undefined,
        agentProxy: proxyPayload.agentProxy,
      });
      // refresh() pulls the latest snapshot; updateConfig already fired a
      // status event, but a full refresh is the safest way to also reflect
      // the post-disconnect status flip in the same render.
      await refresh();
      setEditingId(null);
      toast.success(t('settings.remote.toast.edited'));
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.editFailed' })));
    } finally {
      setEditBusy(false);
    }
  }, [refresh, t]);

  const handleAdd = useCallback(async (form: AddFormState) => {
    setAddBusy(true);
    try {
      const port = parseInt(form.port, 10);
      // identityFile is meaningful in BOTH auth modes (see handleEdit).
      const trimmedIdentityFile = form.identityFile.trim();
      const proxyPayload = buildAgentProxyPayload(form);
      if (!proxyPayload.ok) {
        toast.error(t(proxyPayload.errorKey));
        return;
      }
      await window.electronAPI.remoteSsh.add({
        id: form.id.trim(),
        hostname: form.hostname.trim(),
        user: form.user.trim(),
        port: Number.isFinite(port) && port > 0 ? port : 22,
        authMethod: form.authMethod,
        identityFile: trimmedIdentityFile || undefined,
        agentProxy: proxyPayload.agentProxy,
      });
      await refresh();
      setAdding(false);
      toast.success(t('settings.remote.toast.added'));
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.toast.addFailed' })));
    } finally {
      setAddBusy(false);
    }
  }, [refresh, t]);

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        {showTitle ? (
          <h2
            className="text-16 font-medium leading-[1.2]"
            style={{ color: 'var(--settings-section-title)' }}
          >
            {t('settings.remote.title')}
          </h2>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReload}
            aria-label={t('settings.remote.button.reload')}
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors"
            style={{ color: 'var(--settings-integration-subtitle)' }}
          >
            <RefreshCw size={16} />
          </button>
          {/* Standalone key manager — opens SshKeySetupDialog with hostId=null
              so the user can browse / generate / unlock keys without first
              hitting a connection failure on a specific host. */}
          <button
            type="button"
            onClick={() => setKeysManagerOpen(true)}
            title={t('settings.remote.button.manageKeysTip')}
            className="flex h-8 items-center gap-1.5 rounded-full px-[14px] text-13 leading-none font-medium border"
            style={{
              backgroundColor: 'transparent',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <KeyRound size={14} />
            <span className="relative top-px">{t('settings.remote.button.manageKeys')}</span>
          </button>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="flex h-8 items-center gap-1.5 rounded-full px-[14px] text-13 leading-none font-medium border"
            style={{
              backgroundColor: 'var(--settings-btn-secondary-bg)',
              borderColor: 'var(--settings-btn-secondary-border)',
              color: 'var(--settings-btn-secondary-text)',
            }}
          >
            <Plus size={14} />
            <span className="relative top-px">{t('settings.remote.button.add')}</span>
          </button>
        </div>
      </div>

      <div
        className={cn('flex flex-col rounded-xl', 'bg-[var(--settings-theme-card-bg)]')}
        style={{ border: '1px solid var(--settings-theme-card-border)' }}
      >
        {adding && (
          <HostForm
            mode="add"
            busy={addBusy}
            onSubmit={handleAdd}
            onCancel={() => setAdding(false)}
          />
        )}
        {hosts.length === 0 && !adding && (
          <div className="px-5 py-6 text-center">
            <p className="text-13" style={{ color: 'var(--settings-integration-subtitle)' }}>
              {t('settings.remote.empty.title')}
            </p>
            <p
              className="text-12 mt-1"
              style={{ color: 'var(--settings-integration-subtitle)' }}
            >
              {t('settings.remote.empty.hint')}
            </p>
          </div>
        )}
        {hosts.map((snap, idx) => {
          const expanded = expandedIds.has(snap.config.id) && snap.status === 'ready';
          return (
            <div
              key={snap.config.id}
              style={idx > 0 || adding
                ? { borderTop: '1px solid var(--settings-theme-card-border)' }
                : undefined}
            >
              <HostRow
                snap={snap}
                busy={busyIds.has(snap.config.id)}
                expanded={expanded}
                onToggleExpanded={() => toggleExpanded(snap.config.id)}
                onConnect={() => handleConnect(snap.config.id)}
                onDisconnect={() => handleDisconnect(snap.config.id)}
                onRemove={() => handleRemove(snap.config.id)}
                onSetupKey={() => setKeySetupHostId(snap.config.id)}
                onEdit={() => setEditingId(snap.config.id)}
                onToggleAutoConnect={(next) => void handleSetAutoConnect(snap.config.id, next)}
              />
              {editingId === snap.config.id && (
                <HostForm
                  mode="edit"
                  busy={editBusy}
                  initial={{
                    id: snap.config.id,
                    hostname: snap.config.hostname,
                    user: snap.config.user,
                    port: String(snap.config.port ?? 22),
                    authMethod: snap.config.authMethod === 'key' ? 'key' : 'agent',
                    identityFile: snap.config.identityFile ?? '',
                    agentProxyEnabled: snap.agentProxy?.enabled === true,
                    agentProxyMode: snap.agentProxy?.mode === 'env' ? 'env' : 'tunnel',
                    agentProxyAddr: snap.agentProxy?.mode === 'tunnel'
                      ? `${snap.agentProxy.localHost}:${snap.agentProxy.localPort}`
                      : '127.0.0.1:7890',
                    agentProxyRemotePort: snap.agentProxy?.mode === 'tunnel'
                      ? String(snap.agentProxy.remotePort)
                      : DEFAULT_AGENT_PROXY_REMOTE_PORT,
                    agentProxyUrl: snap.agentProxy?.mode === 'env'
                      ? snap.agentProxy.proxyUrl
                      : 'http://127.0.0.1:7890',
                  }}
                  onSubmit={handleEdit}
                  onCancel={() => setEditingId(null)}
                />
              )}
              {expanded && editingId !== snap.config.id && (
                <RemoteHostDetail hostId={snap.config.id} />
              )}
            </div>
          );
        })}
      </div>

      <SshKeySetupDialog
        hostId={keySetupHostId}
        open={keySetupHostId != null}
        onOpenChange={(open) => { if (!open) setKeySetupHostId(null); }}
      />
      {/* Same dialog, no target host — shows pubkey only, no install command.
          Driven by a separate open flag so it doesn't fight the per-host one. */}
      <SshKeySetupDialog
        hostId={null}
        open={keysManagerOpen}
        onOpenChange={(open) => setKeysManagerOpen(open)}
      />
    </div>
  );
}
