/**
 * 模型代理(Model Proxy)子区块 —— 设置 → 模型供应商 页底部。
 *
 * 把 Cindy 已有的本地 loopback 代理对外开放,让用户**自己电脑上的 CLI** 复用这里配好的
 * 供应商 + 凭证(cc-switch 的「服务端」版)。两族出口各自独立开关 + 各自独立 token:
 *   - Claude Code / Anthropic(`ANTHROPIC_BASE_URL`,Anthropic wire)。
 *   - Codex / 通用 OpenAI(`OPENAI_BASE_URL`,OpenAI Responses + Chat Completions),另一个 loopback 端口。
 * 跨族 token 不互通(各 host 只认自己族的 token)。
 *
 * 安全:
 *   - 常态只显示掩码 token;明文只在用户点「复制环境变量 / 写入配置」时经 IPC 取回。
 *   - 「写入配置」改用户 `~/.claude/settings.json` 或 `~/.codex/config.toml`,先预览(展示改动
 *     + 冲突)再二次确认;codex 侧 **token 绝不写进文件**,预览里给出需自设的 export 行。
 *   - 开关、端口、默认供应商、重置 token 都过 main 侧 trusted-renderer 闸(见 IPC register)。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Copy, FileCog, RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { SettingsTextInput } from './SettingsTextInput';
import type {
  LocalProxyProviderOption,
  LocalProxyServiceState,
} from '../../../shared/localProxyService';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const CARD_STYLE = {
  backgroundColor: 'var(--surface-elevated)',
  borderColor: 'var(--settings-theme-card-border)',
} as const;

const SUBLABEL_STYLE = { color: 'var(--settings-section-sublabel)' } as const;
const HINT_STYLE = { color: 'var(--text-tertiary)' } as const;
const PILL_STYLE = {
  borderColor: 'var(--settings-input-border)',
  color: 'var(--settings-input-text)',
} as const;

export function ModelProxySubsection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [state, setState] = useState<LocalProxyServiceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [portDraft, setPortDraft] = useState('');
  const [codexPortDraft, setCodexPortDraft] = useState('');

  const applyState = useCallback((next: LocalProxyServiceState) => {
    setState(next);
    setPortDraft(next.port > 0 ? String(next.port) : '');
    setCodexPortDraft(next.codexPort > 0 ? String(next.codexPort) : '');
  }, []);

  const refresh = useCallback(async () => {
    // preload 尚未就绪 / 测试环境未注入该命名空间时,静默保持未加载,不抛未处理拒绝。
    const api = window.electronAPI?.localProxyService;
    if (!api) return;
    try {
      applyState(await api.getState());
    } catch {
      // 取状态失败:维持 state=null(整块不渲染),不影响所在设置页。
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        const res = await window.electronAPI.localProxyService.setEnabled(enabled);
        applyState(res.state);
        if (!res.success) toast.error(t('settings.localProxy.toast.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [applyState, t],
  );

  const handleRegenerate = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.localProxy.regenerate.title'),
      description: t('settings.localProxy.regenerate.description'),
      confirmText: t('settings.localProxy.regenerate.confirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.regenerateToken();
      applyState(res.state);
      if (res.success) toast.success(t('settings.localProxy.toast.tokenReset'));
      else toast.error(t('settings.localProxy.toast.updateFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyState, confirm, t]);

  const handleCopyToken = useCallback(async () => {
    const res = await window.electronAPI.localProxyService.getEnvExample();
    if (!res.success) {
      toast.error(t('settings.localProxy.toast.notReady'));
      return;
    }
    const ok = await copyToClipboard(res.env.apiKey);
    if (ok) toast.success(t('settings.localProxy.toast.tokenCopied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [t]);

  // ───────── Claude Code / Anthropic 出口 ─────────

  const handleApplyPort = useCallback(async () => {
    // 空/纯空白 = 恢复「自动」(端口 0 → host 启动时随机绑),与 placeholder 文案一致。
    const parsed = portDraft.trim() === '' ? 0 : Number.parseInt(portDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      toast.error(t('settings.localProxy.toast.invalidPort'));
      return;
    }
    if (state && parsed === state.port) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.setPort(parsed);
      applyState(res.state);
      if (res.success) toast.success(t('settings.localProxy.toast.portApplied'));
      else toast.error(t('settings.localProxy.toast.updateFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyState, portDraft, state, t]);

  const handleDefaultProvider = useCallback(
    async (providerId: string) => {
      setBusy(true);
      try {
        const res = await window.electronAPI.localProxyService.setDefaultProvider(providerId);
        applyState(res.state);
        if (!res.success) toast.error(t('settings.localProxy.toast.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [applyState, t],
  );

  const handleCopyAddress = useCallback(async () => {
    if (!state?.url) return;
    const ok = await copyToClipboard(state.url);
    if (ok) toast.success(t('settings.localProxy.toast.copied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [state, t]);

  const handleCopyEnv = useCallback(async () => {
    const res = await window.electronAPI.localProxyService.getEnvExample();
    if (!res.success) {
      toast.error(t('settings.localProxy.toast.notReady'));
      return;
    }
    const ok = await copyToClipboard(res.env.lines.join('\n'));
    if (ok) toast.success(t('settings.localProxy.toast.envCopied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [t]);

  const handleWriteConfig = useCallback(async () => {
    const preview = await window.electronAPI.localProxyService.previewExternalConfig();
    if (!preview.success) {
      toast.error(t('settings.localProxy.toast.notReady'));
      return;
    }
    const { path, exists, proposedEnv, conflicts } = preview.preview;
    const ok = await confirm({
      title: t('settings.localProxy.writeConfig.title'),
      description: exists
        ? t('settings.localProxy.writeConfig.descExisting', { path })
        : t('settings.localProxy.writeConfig.descNew', { path }),
      confirmText: t('settings.localProxy.writeConfig.confirm'),
      maxWidth: 480,
      content: (
        <div className="mt-2 flex flex-col gap-2 text-12">
          <pre
            className="overflow-x-auto rounded-lg border p-2.5 font-mono text-11 leading-[1.5]"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--settings-theme-card-border)',
              color: 'var(--text-secondary)',
            }}
          >
            {Object.entries(proposedEnv)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')}
          </pre>
          {conflicts.length > 0 && (
            <p className="text-11 leading-[1.5]" style={{ color: 'var(--text-warning, var(--text-tertiary))' }}>
              {t('settings.localProxy.writeConfig.overwriteWarning', {
                keys: conflicts.map((c) => c.key).join(', '),
              })}
            </p>
          )}
        </div>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.writeExternalConfig();
      if (res.success) toast.success(t('settings.localProxy.toast.configWritten'));
      else toast.error(t('settings.localProxy.toast.configWriteFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, t]);

  // ───────── Codex / 通用 OpenAI 出口 ─────────

  const handleToggleCodex = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        const res = await window.electronAPI.localProxyService.setCodexEnabled(enabled);
        applyState(res.state);
        if (!res.success) toast.error(t('settings.localProxy.toast.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [applyState, t],
  );

  const handleRegenerateCodex = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.localProxy.regenerate.title'),
      description: t('settings.localProxy.regenerate.description'),
      confirmText: t('settings.localProxy.regenerate.confirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.regenerateCodexToken();
      applyState(res.state);
      if (res.success) toast.success(t('settings.localProxy.toast.tokenReset'));
      else toast.error(t('settings.localProxy.toast.updateFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyState, confirm, t]);

  const handleCopyCodexToken = useCallback(async () => {
    const res = await window.electronAPI.localProxyService.getCodexEnvExample();
    if (!res.success) {
      toast.error(t('settings.localProxy.toast.codexNotReady'));
      return;
    }
    const ok = await copyToClipboard(res.env.apiKey);
    if (ok) toast.success(t('settings.localProxy.toast.tokenCopied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [t]);

  const handleApplyCodexPort = useCallback(async () => {
    // 空/纯空白 = 恢复「自动」(端口 0 → host 启动时随机绑),与 placeholder 文案一致。
    const parsed = codexPortDraft.trim() === '' ? 0 : Number.parseInt(codexPortDraft, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      toast.error(t('settings.localProxy.toast.invalidPort'));
      return;
    }
    if (state && parsed === state.codexPort) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.setCodexPort(parsed);
      applyState(res.state);
      if (res.success) toast.success(t('settings.localProxy.toast.codexPortApplied'));
      else toast.error(t('settings.localProxy.toast.updateFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyState, codexPortDraft, state, t]);

  const handleCodexDefaultProvider = useCallback(
    async (providerId: string) => {
      setBusy(true);
      try {
        const res =
          await window.electronAPI.localProxyService.setCodexDefaultProvider(providerId);
        applyState(res.state);
        if (!res.success) toast.error(t('settings.localProxy.toast.updateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [applyState, t],
  );

  const handleCopyCodexAddress = useCallback(async () => {
    if (!state?.codexUrl) return;
    const ok = await copyToClipboard(state.codexUrl);
    if (ok) toast.success(t('settings.localProxy.toast.copied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [state, t]);

  const handleCopyCodexEnv = useCallback(async () => {
    const res = await window.electronAPI.localProxyService.getCodexEnvExample();
    if (!res.success) {
      toast.error(t('settings.localProxy.toast.codexNotReady'));
      return;
    }
    const ok = await copyToClipboard(res.env.lines.join('\n'));
    if (ok) toast.success(t('settings.localProxy.toast.codexEnvCopied'));
    else toast.error(t('settings.localProxy.toast.copyFailed'));
  }, [t]);

  const handleWriteCodexConfig = useCallback(async () => {
    const preview = await window.electronAPI.localProxyService.previewCodexConfig();
    if (!preview.success) {
      toast.error(t('settings.localProxy.toast.codexNotReady'));
      return;
    }
    const { path, exists, proposedToml, conflicts, tokenExportLine } = preview.preview;
    const ok = await confirm({
      title: t('settings.localProxy.openai.writeConfig.title'),
      description: exists
        ? t('settings.localProxy.openai.writeConfig.descExisting', { path })
        : t('settings.localProxy.openai.writeConfig.descNew', { path }),
      confirmText: t('settings.localProxy.openai.writeConfig.confirm'),
      maxWidth: 520,
      content: (
        <div className="mt-2 flex flex-col gap-2 text-12">
          <pre
            className="max-h-[240px] overflow-auto rounded-lg border p-2.5 font-mono text-11 leading-[1.5]"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--settings-theme-card-border)',
              color: 'var(--text-secondary)',
            }}
          >
            {proposedToml}
          </pre>
          {conflicts.length > 0 && (
            <p className="text-11 leading-[1.5]" style={{ color: 'var(--text-warning, var(--text-tertiary))' }}>
              {t('settings.localProxy.writeConfig.overwriteWarning', {
                keys: conflicts.map((c) => c.key).join(', '),
              })}
            </p>
          )}
          {/* token 不入文件:提示用户需自行在外部 shell 设 CINDY_LOCAL_TOKEN(codex 从 env_key 读)。 */}
          <p className="text-11 leading-[1.5]" style={HINT_STYLE}>
            {t('settings.localProxy.openai.writeConfig.tokenExportHint')}
          </p>
          <pre
            className="overflow-x-auto rounded-lg border p-2.5 font-mono text-11 leading-[1.5]"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--settings-theme-card-border)',
              color: 'var(--text-secondary)',
            }}
          >
            {tokenExportLine}
          </pre>
        </div>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.electronAPI.localProxyService.writeCodexConfig();
      if (res.success) toast.success(t('settings.localProxy.toast.codexConfigWritten'));
      else toast.error(t('settings.localProxy.toast.codexConfigWriteFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, t]);

  if (!state) return null;

  /** 一族出口卡片里的「对外默认供应商」下拉(两族共用外形,只是数据源不同)。 */
  const renderProviderSelect = (
    providers: LocalProxyProviderOption[],
    value: string,
    onChange: (id: string) => void,
    ariaLabel: string,
  ) =>
    providers.length === 0 ? (
      <p className="text-11 leading-[1.4]" style={HINT_STYLE}>
        {t('settings.localProxy.noProviders')}
      </p>
    ) : (
      <div className="relative w-full max-w-[280px]">
        <select
          value={value}
          disabled={busy}
          onChange={(e) => void onChange(e.target.value)}
          className={cn(
            'h-9 w-full min-w-0 appearance-none rounded-full border py-0 pl-3 pr-9 text-12 outline-none disabled:opacity-50',
            'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
            'border-[var(--settings-input-border)] focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
          )}
          aria-label={ariaLabel}
        >
          <option value="">{t('settings.localProxy.defaultProviderNone')}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <ChevronDown
          size={15}
          className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 opacity-75"
          style={{ color: 'var(--settings-input-text)' }}
        />
      </div>
    );

  /** 一族出口卡片里的独立对外 token 块(掩码展示 + 复制 + 重置)。两族外形一致,数据/回调不同。 */
  const renderTokenBlock = (
    masked: string | null,
    onCopy: () => void,
    onRegenerate: () => void,
  ) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-12 font-medium" style={SUBLABEL_STYLE}>
        {t('settings.localProxy.token')}
      </span>
      <div className="flex items-center gap-2">
        <SettingsTextInput
          value={masked ?? ''}
          onChange={() => {}}
          size="sm"
          mono
          className="flex-1 min-w-0"
        />
        <button
          type="button"
          onClick={onRegenerate}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-12 disabled:opacity-50"
          style={PILL_STYLE}
        >
          <RefreshCw size={13} />
          {t('settings.localProxy.regenerate.button')}
        </button>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-12"
          style={PILL_STYLE}
        >
          <Copy size={13} />
          {t('settings.localProxy.copy')}
        </button>
      </div>
    </div>
  );

  /**
   * 服务地址 + 端口合并成「一个框」:scheme+host 前缀固定不可改(从实际 url 解析,回落 loopback
   * 默认),只有端口段可编辑;「应用」提交改端口(会重启本地代理),「复制」拷贝**完整** url。
   * url 为 null(代理未就绪)时退化为只读的「未就绪」框,端口不可编辑。
   */
  const renderAddressField = (
    url: string | null,
    portDraft: string,
    setPortDraft: (v: string) => void,
    onApply: () => void,
    onCopy: () => void,
    portHint: string,
    addressLabel: string,
  ) => {
    let prefix = 'http://127.0.0.1:';
    if (url) {
      try {
        const u = new URL(url);
        prefix = `${u.protocol}//${u.hostname}:`;
      } catch {
        // 解析失败保留 loopback 默认前缀。
      }
    }
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-12 font-medium" style={SUBLABEL_STYLE}>
          {addressLabel}
        </span>
        <div className="flex items-center gap-2">
          {url ? (
            <div
              className="flex h-8 min-w-0 flex-1 items-center rounded-full border px-3 text-12 focus-within:ring-2 focus-within:ring-[var(--focus-ring)]"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--settings-input-border)',
              }}
            >
              {/* 固定前缀:scheme + 127.0.0.1(不可改),弱化色以示只读。 */}
              <span
                className="shrink-0 font-mono"
                style={{ color: 'var(--settings-input-placeholder)' }}
              >
                {prefix}
              </span>
              {/* 仅端口可编辑。 */}
              <input
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                placeholder={t('settings.localProxy.portPlaceholder')}
                inputMode="numeric"
                aria-label={t('settings.localProxy.port')}
                className="min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:text-[var(--settings-input-placeholder)]"
                style={{ color: 'var(--settings-input-text)' }}
              />
            </div>
          ) : (
            <SettingsTextInput
              value={t('settings.localProxy.notReady')}
              onChange={() => {}}
              size="sm"
              mono
              className="flex-1 min-w-0"
            />
          )}
          <button
            type="button"
            onClick={onApply}
            disabled={busy || !url}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-12 disabled:opacity-50"
            style={PILL_STYLE}
          >
            <Check size={13} />
            {t('settings.localProxy.applyPort')}
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={!url}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-12 disabled:opacity-50"
            style={PILL_STYLE}
          >
            <Copy size={13} />
            {t('settings.localProxy.copy')}
          </button>
        </div>
        <p className="text-11 leading-[1.4]" style={HINT_STYLE}>
          {portHint}
        </p>
      </div>
    );
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border p-4"
      style={{
        backgroundColor: 'var(--settings-theme-card-bg)',
        borderColor: 'var(--settings-theme-card-border)',
      }}
    >
      {/* 子区块标题(无总开关:两族各自独立开启) */}
      <div className="flex flex-col gap-1">
        <span
          className="text-14 font-medium leading-[1.2]"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {t('settings.localProxy.title')}
        </span>
        <p
          className="text-12 leading-[1.5]"
          style={{ color: 'var(--settings-section-desc)' }}
        >
          {t('settings.localProxy.subtitle')}
        </p>
      </div>

      {/* 卡片 A:Claude Code / Anthropic —— 独立开关 + 独立 token */}
      <div className="flex flex-col gap-3 rounded-lg border p-3" style={CARD_STYLE}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-12 font-semibold" style={{ color: 'var(--settings-section-title)' }}>
              {t('settings.localProxy.anthropic.title')}
            </span>
            <p className="text-11 leading-[1.5]" style={HINT_STYLE}>
              {t('settings.localProxy.anthropic.subtitle')}
            </p>
          </div>
          <Switch
            checked={state.enabled}
            disabled={busy}
            onCheckedChange={(v) => void handleToggle(v)}
            aria-label={t('settings.localProxy.anthropic.title')}
          />
        </div>

        {state.enabled && (
          <div
            className="flex flex-col gap-3 border-t pt-3"
            style={{ borderColor: 'var(--settings-theme-card-border)' }}
          >
            {renderTokenBlock(
              state.maskedToken,
              () => void handleCopyToken(),
              () => void handleRegenerate(),
            )}

            {renderAddressField(
              state.url,
              portDraft,
              setPortDraft,
              () => void handleApplyPort(),
              () => void handleCopyAddress(),
              t('settings.localProxy.portHint'),
              t('settings.localProxy.address'),
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-12 font-medium" style={SUBLABEL_STYLE}>
                {t('settings.localProxy.defaultProvider')}
              </span>
              {renderProviderSelect(
                state.providers,
                state.defaultProviderId,
                handleDefaultProvider,
                t('settings.localProxy.defaultProvider'),
              )}
              <p className="text-11 leading-[1.4]" style={HINT_STYLE}>
                {t('settings.localProxy.defaultProviderHint')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleCopyEnv()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-12 font-medium"
                style={PILL_STYLE}
              >
                <Copy size={14} />
                {t('settings.localProxy.copyEnv')}
              </button>
              <button
                type="button"
                onClick={() => void handleWriteConfig()}
                disabled={busy}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-12 font-medium disabled:opacity-50"
                style={PILL_STYLE}
              >
                <FileCog size={14} />
                {t('settings.localProxy.writeConfig.button')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 卡片 B:Codex / 通用 OpenAI —— 独立开关 + 独立 token */}
      <div className="flex flex-col gap-3 rounded-lg border p-3" style={CARD_STYLE}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-12 font-semibold" style={{ color: 'var(--settings-section-title)' }}>
              {t('settings.localProxy.openai.title')}
            </span>
            <p className="text-11 leading-[1.5]" style={HINT_STYLE}>
              {t('settings.localProxy.openai.subtitle')}
            </p>
          </div>
          <Switch
            checked={state.codexEnabled}
            disabled={busy}
            onCheckedChange={(v) => void handleToggleCodex(v)}
            aria-label={t('settings.localProxy.openai.title')}
          />
        </div>

        {state.codexEnabled && (
          <div
            className="flex flex-col gap-3 border-t pt-3"
            style={{ borderColor: 'var(--settings-theme-card-border)' }}
          >
            {renderTokenBlock(
              state.codexMaskedToken,
              () => void handleCopyCodexToken(),
              () => void handleRegenerateCodex(),
            )}

            {renderAddressField(
              state.codexUrl,
              codexPortDraft,
              setCodexPortDraft,
              () => void handleApplyCodexPort(),
              () => void handleCopyCodexAddress(),
              t('settings.localProxy.openai.portHint'),
              t('settings.localProxy.openai.address'),
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-12 font-medium" style={SUBLABEL_STYLE}>
                {t('settings.localProxy.openai.defaultProvider')}
              </span>
              {renderProviderSelect(
                state.codexProviders,
                state.codexDefaultProviderId,
                handleCodexDefaultProvider,
                t('settings.localProxy.openai.defaultProvider'),
              )}
              <p className="text-11 leading-[1.4]" style={HINT_STYLE}>
                {t('settings.localProxy.openai.defaultProviderHint')}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void handleCopyCodexEnv()}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-12 font-medium"
                style={PILL_STYLE}
              >
                <Copy size={14} />
                {t('settings.localProxy.openai.copyEnv')}
              </button>
              <button
                type="button"
                onClick={() => void handleWriteCodexConfig()}
                disabled={busy || !state.codexUrl}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-12 font-medium disabled:opacity-50"
                style={PILL_STYLE}
              >
                <FileCog size={14} />
                {t('settings.localProxy.openai.writeConfig.button')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
