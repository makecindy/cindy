/**
 * ProvidersSection —— 设置 → 模型供应商页(2026-07 重构:双栏管理)。
 *
 * 布局:一张卡片内左右双栏 ——
 *   - 左栏:可拖动排序的扁平供应商列表;除 Cindy AI 外,供应商只在
 *     「已连接 / 已添加」后出现;底部「＋ 添加供应商」打开三步向导。未连接的内置
 *     渠道不再常驻占行 —— 入口在向导目录里,另有「检测建议」组:本机装了
 *     Claude Code / Codex CLI 时置一条建议行,点击直达该渠道的授权步。
 *   - 右栏:选中供应商的详情 = 鉴权头部(复用既有各 Row 的连接/断开/授权逻辑,
 *     **不发明新的连接 IPC**)+ 统一模型可见性列表(UnifiedModelList:并集 +
 *     单开关同写双 agent,「分别调整」兜底,见该组件头注释)。
 *
 * 鉴权通道(与重构前一致):
 *   - Anthropic: maker.claudeOAuth*;OpenAI: useCodexAuth();xAI: maker.xaiOAuth*。
 *   - XD 网关: 凭据由 model-access 自动下发(useModelAccessStatus;无手填入口)。
 *   - 自定义供应商: CRUD IPC + safeStorage 密钥;「刷新模型」= 读回密钥后走
 *     fetchProviderModels,additions-only 合并进配置(与 OAuth 动态发现同语义)。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Copy,
  Gift,
  GripVertical,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { useProviders } from '@/hooks/useProviders';
import { isChatGptConnectionConnected, useCodexAuth } from '@/hooks/useCodexAuth';
import { useApiKey } from '@/hooks/useApiKey';
import { extractIpcError } from '@/utils/ipcError';
import { useModelAccessStatus } from '@/hooks/useModelAccessStatus';
import { useModelAccessCreditUsage } from '@/hooks/useModelAccessCreditUsage';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { useProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from '@/lib/toast';
import {
  appendDiscoveredCustomProviderModels,
  deleteCustomProvider,
  providerViewToCustomProviderConfig,
  readCustomProviderKey,
  updateCustomProvider,
} from '@/lib/customProviders';
import { providerMonogram } from '@/lib/providerModels';
import { PROVIDER_SECRET_IDS, type ProviderSecretId } from '../../../shared/providerSecrets';

import {
  customProviderSubtitleForDisplay,
  providerSubtitleForDisplay,
} from '@/lib/providerSubtitle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BILLING_CURRENCY, formatBillingAmount } from '@/features/billing/money';
import { canAccessBillingSettings } from './billingVisibility';
import { resolveXdAssetModuleState } from './providerAssetModule';
import {
  requestXaiSubscriptionRefresh,
  useXaiSubscriptionUsage,
} from '@/hooks/useXaiSubscriptionUsage';
import {
  formatXaiProductLabel,
  isXaiWeeklyUsageCurrent,
} from '../../../shared/xaiSubscriptionUsage';
import { CustomProviderDialog } from './CustomProviderDialog';
import { AddProviderWizard, type WizardEntry } from './AddProviderWizard';
import { OllamaProviderDetail } from './OllamaProviderDetail';
import {
  isLocalRuntimeBetaProviderId,
  MANAGED_LMSTUDIO_PROVIDER_ID,
  MANAGED_OLLAMA_PROVIDER_ID,
} from '../../../shared/localModelRuntime';
import { OAuthDeviceCodeCard } from './OAuthDeviceCodeCard';
import { SettingsTextInput } from './SettingsTextInput';
import { buildUnionRows, UnifiedModelList } from './UnifiedModelList';
import { AnthropicMark } from '@/components/icons/AnthropicMark';
import { OpenAIMark } from '@/components/icons/OpenAIMark';
import { XDIncMark } from '@/components/icons/XDIncMark';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { SortableList } from '@/components/sidebar/SortableList';

import { localCliDisplayName, type LocalCliDetection } from '../../../shared/localCliDetect';
import { isBuiltinRefreshableProviderId } from '../../../shared/providerModelRefresh';
import { applyProviderOrder } from '../../../shared/providerOrder';
import type { CustomProviderConfig, ProviderView } from '@cindy/model-providers';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function providerHasModels(provider: ProviderView): boolean {
  // 专属媒体清单(imageModels/videoModels/embeddingModels)也算「有模型」:XD 动态
  // 对话目录不可用时内置的图像/视频/向量模型仍可用且可被停用管理,
  // UnifiedModelList 的 buildUnionRows 会为它们合成能力行 —— 只看 models[agent]
  // 会让整个列表不渲染(PR #744 review 第十五轮;向量补入见 PR #1707 review)。
  return (
    provider.agents.some((a) => (provider.models[a]?.length ?? 0) > 0) ||
    (provider.imageModels?.length ?? 0) > 0 ||
    (provider.videoModels?.length ?? 0) > 0 ||
    (provider.embeddingModels?.length ?? 0) > 0
  );
}

/**
 * 写供应商级停用 override(model-disable-store)。成功后由 main 广播
 * PROVIDER_CHANGED 驱动快照刷新,这里不 refetch;失败走统一错误提示。
 */
function writeProviderDisabled(providerId: string, disabled: boolean, errorText: string): void {
  void window.electronAPI.maker
    .setModelDisable({ kind: 'provider', providerId, disabled })
    .catch(() => toast.error(errorText));
}

/** 供应商行图标(内置品牌 mark / 首字母 monogram)。 */
function providerIcon(p: ProviderView, size: number): ReactNode {
  if (hasProviderLogo(p.id, p.routing)) {
    return <ProviderLogoMark providerId={p.id} routing={p.routing} size={size} />;
  }
  return <span className="text-15 font-medium leading-none">{providerMonogram(p.name)}</span>;
}

// ---------------------------------------------------------------------------
// 通用小件(与重构前一致)
// ---------------------------------------------------------------------------

function ConnectedPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <Check size={12} strokeWidth={2.5} />
      {t('settings.providers.pill.connected')}
    </span>
  );
}

/** OpenAI OAuth 仍可恢复但需要用户重新连接；使用中性 chip，避免表现成全局故障。 */
function ReconnectRequiredPill() {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[22px] shrink-0 select-none items-center gap-1 rounded-full px-2.5 text-11 font-medium"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      <RefreshCw size={11} />
      {t('settings.providers.openai.reconnectRequired')}
    </span>
  );
}

/** 摘要只展示去重后的模型数，避免把「模型 × Agent」误读成模型数量。 */
function ModelCountChip({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium tabular-nums"
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        color: 'var(--settings-section-desc)',
      }}
    >
      {t('settings.providers.models.modelCount', { count })}
    </span>
  );
}

function PillButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-8 shrink-0 items-center justify-center rounded-full px-6 text-13 font-medium transition-colors',
        'border',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      style={{
        backgroundColor: 'var(--settings-btn-secondary-bg)',
        borderColor: 'var(--settings-btn-secondary-border)',
        color: 'var(--settings-btn-secondary-text)',
      }}
    >
      {label}
    </button>
  );
}

/**
 * 黑 CTA pill（DESIGN §4 button/cta）—— 一屏最多一颗，用于「在 Cindy 内花钱」这类
 * 主动作。`lg` 是 brand-scale 表面（登录引导空态）用的尺码，`md` 与 PillButton 同高，
 * 用于卡片内与次级动作并排的场合。
 */
function CtaPillButton({
  label,
  onClick,
  size = 'md',
  className,
}: {
  label: string;
  onClick: () => void;
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full px-6 text-13 font-medium transition-opacity hover:opacity-90',
        size === 'lg' ? 'h-9' : 'h-8',
        className,
      )}
      style={{
        // Black Pill(最高强调档)按 DESIGN.md §4 用 pure 对:--accent-cta-bg-pure
        // (Light 纯黑 / Dark 纯白反转)配 --accent-pure-cta-fg。--accent-cta-bg 在
        // 默认 Light 下是 #262626,与规范的 #000000 差一档,不能混用。
        backgroundColor: 'var(--accent-cta-bg-pure)',
        color: 'var(--accent-pure-cta-fg)',
      }}
    >
      {label}
    </button>
  );
}

function CustomTag({ label }: { label: string }) {
  return (
    <span
      className="flex h-[18px] shrink-0 items-center rounded-full px-2 text-11 font-medium"
      style={{
        border: '1px solid var(--settings-integration-avatar-border)',
        color: 'var(--text-tertiary)',
      }}
    >
      {label}
    </span>
  );
}

function BetaTag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] px-2 py-[1px] text-10 font-medium uppercase leading-[1.5] tracking-wide text-[var(--text-secondary)]">
      {label}
    </span>
  );
}

function RowIconButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'var(--text-tertiary)' }}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 详情头部 —— avatar + 标题(+计数/订阅/自定义 tag)/副标题 + 右侧鉴权操作区。
// (重构前的 ProviderCell 去掉展开逻辑;模型列表由详情容器统一渲染。)
// ---------------------------------------------------------------------------

function DetailHeader({
  icon,
  title,
  modelCountSuffix,
  subtitle,
  trailing,
  provider,
  detail,
  badge,
  menuItems,
  menuFooter,
  assetModule,
}: {
  icon: ReactNode;
  title: string;
  /** 紧跟模型数量的供应商专属元数据。 */
  modelCountSuffix?: ReactNode;
  subtitle: string;
  trailing: ReactNode;
  provider?: ProviderView;
  detail?: ReactNode;
  badge?: ReactNode;
  /** 供应商专属的低频动作，置于共用「···」菜单顶部（不另开第二个溢出菜单）。 */
  menuItems?: ReactNode;
  /** 菜单末尾的只读信息行（如脱敏 key），自带一条分隔线。 */
  menuFooter?: ReactNode;
  /**
   * 账户资产模块 —— 标题行下方的固定槽位，用一条 1px 发丝线分隔（不做框中框，
   * 见 DESIGN §2 layer rule）。判定见 providerAssetModule.ts。
   */
  assetModule?: ReactNode;
}) {
  const { t } = useTranslation();
  const hasModels = !!provider && providerHasModels(provider);
  const modelCount = useMemo(
    () => (hasModels && provider ? buildUnionRows(provider).length : null),
    [hasModels, provider],
  );
  const subscriptionProduct =
    provider?.access?.kind === 'subscription' ? provider.access.product : null;
  // 单 agent 供应商在头部统一说明(行级不再逐条标注,见 UnifiedModelList 头注释)。
  const singleAgentNote =
    provider && provider.agents.length === 1
      ? t('settings.providers.detail.singleAgentNote', {
          agent:
            provider.agents[0] === 'claude-code'
              ? 'Claude Code'
              : provider.agents[0] === 'pi'
                ? 'Pi'
                : 'Codex',
        })
      : null;

  return (
    <div className="flex shrink-0 flex-col">
      <div className={cn('flex flex-col px-5 py-4', detail && 'gap-3')}>
        {/* 可折行:最小窗口(右栏 ~275px)放不下「状态 + 操作」时整组换行,
            不被卡片 overflow-hidden 裁掉(PR #1102 review 第三轮)。 */}
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div
            data-testid="provider-detail-identity"
            className="flex min-w-0 flex-auto items-center gap-3"
          >
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: 'var(--settings-integration-avatar-bg)',
                border: '1px solid var(--settings-integration-avatar-border)',
                color: 'var(--settings-integration-avatar-icon)',
              }}
            >
              {icon}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div
                data-testid="provider-detail-metadata"
                className="flex min-w-0 flex-wrap items-center gap-2"
              >
                <span
                  className="min-w-0 truncate text-14 font-medium leading-tight"
                  style={{ color: 'var(--settings-section-title)' }}
                >
                  {title}
                </span>
                {modelCount !== null && <ModelCountChip count={modelCount} />}
                {modelCountSuffix}
                {subscriptionProduct && (
                  <CustomTag
                    label={t('settings.providers.models.subscriptionProduct', {
                      product: subscriptionProduct,
                    })}
                  />
                )}
                {provider?.suspended && (
                  <CustomTag label={t('settings.providers.pill.suspended')} />
                )}
                {badge}
              </div>
              <span
                className="truncate text-13 leading-tight"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {subtitle}
                {singleAgentNote ? ` · ${singleAgentNote}` : ''}
              </span>
            </div>
          </div>

          {trailing}
          {/* 供应商级低频动作(停用/启用):所有供应商详情头统一入口。停用 = 保留凭证、
              整体不可路由(model-disable-store);恢复入口在菜单与下方的已停用条带都有。 */}
          {provider && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('settings.providers.detail.moreActionsAria')}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)]"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <MoreHorizontal size={15} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menuItems}
                <DropdownMenuItem
                  onClick={() =>
                    writeProviderDisabled(
                      provider.id,
                      !provider.suspended,
                      t('settings.providers.models.accessWriteFailed'),
                    )
                  }
                >
                  {t(
                    provider.suspended
                      ? 'settings.providers.menu.enableProvider'
                      : 'settings.providers.menu.disableProvider',
                  )}
                </DropdownMenuItem>
                {menuFooter}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {detail}
      </div>
      {assetModule}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anthropic —— OAuth(Claude.ai 订阅),复用 maker.claudeOAuth*。
// ---------------------------------------------------------------------------

function AnthropicHeader({
  provider,
  onChanged,
}: {
  provider?: ProviderView;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider?.connected ?? false;

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.claudeOAuthLogin();
      if (r.ok) {
        toast.success(t('settings.connections.claude.toast.loggedIn'));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else if (r.reason === 'not_a_subscription') {
        toast.error(t('settings.connections.claude.toast.notSubscription'));
      } else {
        toast.error(t('settings.connections.claude.toast.loginFailed'));
      }
    } catch {
      toast.error(t('settings.connections.claude.toast.loginFailed'));
    } finally {
      setLoggingIn(false);
    }
  }, [onChanged, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.claude.logoutConfirm.title'),
      description: t('settings.connections.claude.logoutConfirm.description'),
      confirmText: t('settings.connections.claude.logoutConfirm.confirm'),
      cancelText: t('settings.connections.claude.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.claudeOAuthLogout();
      toast.success(t('settings.connections.claude.toast.loggedOut'));
      onChanged();
    } catch {
      toast.error(t('settings.connections.claude.toast.logoutFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={
        loggingIn ? t('settings.providers.button.cancel') : t('settings.providers.button.authorize')
      }
      onClick={() => {
        if (loggingIn) {
          void window.electronAPI.maker.claudeOAuthCancel();
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );

  return (
    <DetailHeader
      icon={<AnthropicMark size={18} />}
      title={t('settings.providers.anthropic.title')}
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.anthropic.modelLabel'), {
        fallback: t('settings.providers.anthropic.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
    />
  );
}

// ---------------------------------------------------------------------------
// OpenAI —— OAuth(ChatGPT 订阅 / Codex),复用 useCodexAuth()。
// ---------------------------------------------------------------------------

function OpenAiHeader({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const {
    state,
    reconnectCredentialScope,
    recoveryCheck,
    refresh,
    triggerLogin,
    cancelLogin,
    logout,
  } = useCodexAuth();
  // 图像 API key 行(2026-07 图像多来源):ChatGPT 订阅 OAuth 调不了平台 images API
  // (实测缺 scope),图像通道用独立的平台 key。仅当目录给 openai 声明了 imageModels
  // 才渲染(远端目录可能撤掉该能力)。
  const imagesKeyRow = (provider?.imageModels?.length ?? 0) > 0 && (
    <ImageApiKeyRow secretId="openai-images" provider={provider} />
  );
  const reconnectRequired = state.kind === 'reconnect-required';
  const loggingIn = state.kind === 'login-pending';
  const connected = isChatGptConnectionConnected(state, provider?.connected ?? false);
  const credentialScope = reconnectRequired
    ? (state.credentialScope ?? 'unknown')
    : (reconnectCredentialScope ?? 'unknown');

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.codex.logoutConfirm.title'),
      description: t('settings.connections.codex.logoutConfirm.description'),
      confirmText: t('settings.connections.codex.logoutConfirm.confirm'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    try {
      await logout();
      toast.success(t('settings.connections.codex.toast.loggedOut'));
    } catch {
      toast.error(t('settings.connections.codex.toast.logoutFailed'));
    } finally {
      onChanged();
    }
  }, [confirm, logout, onChanged, t]);

  const handleLogin = useCallback(async () => {
    const outcome = await triggerLogin();
    if (outcome === 'authenticated') {
      onChanged();
    } else if (outcome === 'unverified') {
      toast.error(t('chatgptAuthRecovery.verificationFailed'));
    } else if (outcome === 'failed') {
      toast.error(t('settings.connections.codex.toast.loginFailed'));
    }
  }, [triggerLogin, onChanged, t]);

  const handleRecovery = useCallback(async () => {
    if (recoveryCheck === 'checking' || loggingIn) return;
    if (recoveryCheck === 'failed') {
      await refresh();
      return;
    }
    await handleLogin();
  }, [handleLogin, loggingIn, recoveryCheck, refresh]);

  const recoveryDetail = reconnectRequired ? (
    <p className="text-12 leading-relaxed text-[var(--settings-integration-subtitle)]">
      {t(
        credentialScope === 'system-shared'
          ? 'chatgptAuthRecovery.systemSharedInvalidated'
          : credentialScope === 'instance-isolated'
            ? 'chatgptAuthRecovery.instanceIsolatedInvalidated'
            : 'chatgptAuthRecovery.unknownInvalidated',
      )}
    </p>
  ) : null;

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
      />
    </div>
  ) : reconnectRequired ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ReconnectRequiredPill />
      <PillButton
        label={t(
          recoveryCheck === 'checking' || loggingIn
            ? 'chatgptAuthRecovery.checking'
            : recoveryCheck === 'failed'
              ? 'chatgptAuthRecovery.recheck'
              : 'chatgptAuthRecovery.relogin',
        )}
        onClick={() => void handleRecovery()}
        disabled={recoveryCheck === 'checking' || loggingIn}
      />
    </div>
  ) : (
    <PillButton
      label={
        loggingIn
          ? t('settings.providers.openai.cancelConnect')
          : t('settings.providers.openai.connect')
      }
      onClick={() => {
        if (loggingIn) void cancelLogin();
        else void handleLogin();
      }}
    />
  );

  return (
    <DetailHeader
      icon={<OpenAIMark size={18} />}
      title={t('settings.providers.openai.title')}
      subtitle={t('settings.providers.openai.subtitle')}
      trailing={trailing}
      provider={provider}
      detail={
        recoveryDetail || imagesKeyRow ? (
          <div className="flex flex-col gap-3">
            {recoveryDetail}
            {imagesKeyRow}
          </div>
        ) : undefined
      }
    />
  );
}

/**
 * 「图像生成 API key」行(2026-07 图像多来源):订阅 OAuth 供应商(OpenAI/xAI)的
 * 图像通道走独立的平台 key,与登录态解耦。已配置显示掩码尾巴 + 清除;未配置显示
 * 输入 + 保存。key 是 MAIN_ONLY 键,走内置 API-key 专用 IPC(builtinApiKey*),
 * renderer 只能查存在性/写/删,通用 safeStorage 桥读不到明文。
 */
function ImageApiKeyRow({
  secretId,
  provider,
}: {
  secretId: ProviderSecretId;
  /**
   * 供应商快照(useProviders)。别的窗口保存/清除 key 会广播 PROVIDER_CHANGED →
   * 快照刷新 → 对象换新 → 本 effect 重查存在性,多窗口状态不滞留。
   */
  provider?: ProviderView;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [draftKey, setDraftKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.builtinApiKeyHas(secretId).then((has) => {
      if (!cancelled) setConfigured(has);
    });
    return () => {
      cancelled = true;
    };
  }, [secretId, provider]);

  const handleSave = useCallback(async () => {
    const key = draftKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      // 失败经统一 IPC 错误协议抛出(throwIpcError),这里 catch 即失败。
      await window.electronAPI.builtinApiKeyStore(secretId, key);
      toast.success(t('settings.providers.imagesKey.toast.saved'));
      setDraftKey('');
      setConfigured(true);
    } catch {
      toast.error(t('settings.providers.imagesKey.toast.saveFailed'));
    } finally {
      setBusy(false);
    }
  }, [draftKey, secretId, t]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    try {
      await window.electronAPI.builtinApiKeyRemove(secretId);
      toast.success(t('settings.providers.imagesKey.toast.cleared'));
      setConfigured(false);
    } catch {
      toast.error(t('settings.providers.imagesKey.toast.clearFailed'));
    } finally {
      setBusy(false);
    }
  }, [secretId, t]);

  if (configured === null) return null;
  return (
    /* 可折行:最小窗口(右栏 ~250px 内容区)下「标签 + 掩码/输入框 + 按钮」
       放不下时换行,操作始终可达(PR #1102 review 第八轮;与详情头折行同口径)。 */
    <div className="flex flex-wrap items-center gap-2 gap-y-2 pt-2">
      <span className="shrink-0 text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
        {t('settings.providers.imagesKey.label')}
      </span>
      {configured ? (
        <>
          <span className="font-mono text-12" style={{ color: 'var(--text-tertiary)' }}>
            ••••••••
          </span>
          <PillButton
            label={t('settings.providers.imagesKey.clear')}
            onClick={() => void handleClear()}
            disabled={busy}
          />
        </>
      ) : (
        <>
          <SettingsTextInput
            value={draftKey}
            onChange={setDraftKey}
            placeholder={t('settings.providers.imagesKey.placeholder')}
            size="sm"
            mono
            secret
            className="min-w-0 flex-1"
          />
          <PillButton
            label={t('settings.providers.imagesKey.save')}
            onClick={() => void handleSave()}
            disabled={busy || draftKey.trim().length === 0}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// xAI —— OAuth(SuperGrok 订阅),复用 maker.xaiOAuth*。
// ---------------------------------------------------------------------------

function formatXaiResetLabel(resetsAt: number | null | undefined, locale: string): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  try {
    return new Date(resetsAt * 1000).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

function XaiAssetModule({ connected }: { connected: boolean }) {
  const { t, i18n } = useTranslation();
  const usage = useXaiSubscriptionUsage(connected);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!connected) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [connected]);
  useEffect(() => {
    if (!connected) return;
    if (isXaiWeeklyUsageCurrent(usage, nowMs)) return;
    requestXaiSubscriptionRefresh();
  }, [connected, usage, nowMs]);
  if (!connected || !usage) return null;
  const hasWeekly = isXaiWeeklyUsageCurrent(usage, nowMs);
  if (!usage.planLabel && !hasWeekly) return null;
  const resetLabel = formatXaiResetLabel(usage.resetsAt, i18n.resolvedLanguage ?? i18n.language);
  return (
    <div
      className="flex flex-wrap justify-between gap-x-6 gap-y-4 border-t px-5 py-5"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <div className="min-w-0">
        <p className="text-12 leading-tight" style={{ color: 'var(--text-secondary)' }}>
          {usage.planLabel ?? t('settings.providers.xai.asset.weeklyTitle')}
        </p>
        {hasWeekly && (
          <p
            className="mt-1.5 text-20 font-medium leading-[1.3] tracking-[-0.02em] tabular-nums"
            style={{ color: 'var(--text-primary)' }}
          >
            {t('settings.providers.xai.asset.weeklyUsed', {
              percent: Math.round(usage.creditUsagePercent ?? 0),
            })}
          </p>
        )}
        {hasWeekly && resetLabel && (
          <p className="mt-1 text-12 leading-tight" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.xai.asset.resetsAt', { at: resetLabel })}
          </p>
        )}
        {hasWeekly && (usage.productUsage ?? []).map((product) => (
          <p
            key={product.product}
            className="mt-1 text-12 leading-tight tabular-nums"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('settings.providers.xai.asset.productLine', {
              product: formatXaiProductLabel(product.product),
              percent: Math.round(product.usagePercent),
            })}
          </p>
        ))}
      </div>
      <div className="flex shrink-0 items-center pt-3.5">
        <button
          type="button"
          onClick={() => void window.electronAPI.openExternal('https://grok.com')}
          className="text-13 transition-colors hover:text-[var(--text-primary)]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {t('settings.providers.xai.asset.openUsage')}
        </button>
      </div>
    </div>
  );
}

function XaiHeader({ provider, onChanged }: { provider?: ProviderView; onChanged: () => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider?.connected ?? false;

  const handleLogin = useCallback(async () => {
    setLoggingIn(true);
    try {
      const r = await window.electronAPI.maker.xaiOAuthLogin();
      if (r.ok) {
        toast.success(t('settings.connections.xai.toast.loggedIn'));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else {
        toast.error(t('settings.connections.xai.toast.loginFailed'));
      }
    } catch {
      toast.error(t('settings.connections.xai.toast.loginFailed'));
    } finally {
      setLoggingIn(false);
    }
  }, [onChanged, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.connections.xai.logoutConfirm.title'),
      description: t('settings.connections.xai.logoutConfirm.description'),
      confirmText: t('settings.connections.xai.logoutConfirm.confirm'),
      cancelText: t('settings.connections.xai.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.xaiOAuthLogout();
      toast.success(t('settings.connections.xai.toast.loggedOut'));
      onChanged();
    } catch {
      toast.error(t('settings.connections.xai.toast.logoutFailed'));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={
        loggingIn ? t('settings.providers.button.cancel') : t('settings.providers.button.authorize')
      }
      onClick={() => {
        if (loggingIn) {
          void window.electronAPI.maker.xaiOAuthCancel();
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );

  return (
    <DetailHeader
      icon={<ProviderLogoMark providerId="xai" size={18} />}
      title={t('settings.providers.xai.title')}
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.xai.modelLabel'), {
        fallback: t('settings.providers.xai.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
      assetModule={<XaiAssetModule connected={connected} />}
    />
  );
}

// ---------------------------------------------------------------------------
// 通用 OAuth —— 目录 auth.oauth 描述符驱动的供应商(非 bespoke 四家)。
// ---------------------------------------------------------------------------

function GenericOAuthHeader({
  provider,
  onChanged,
}: {
  provider: ProviderView;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const connected = provider.connected;
  const deviceFlow = provider.auth.oauth?.flow === 'device-code';
  const { deviceCode, clearDeviceCode, beginOwnedLogin, cancelOwnedLogin } =
    useProviderOAuthDeviceCode(provider.id, { observeProgress: deviceFlow });

  const handleLogin = useCallback(async () => {
    clearDeviceCode();
    setLoggingIn(true);
    const ownedLogin = beginOwnedLogin();
    try {
      const r = await window.electronAPI.maker.providerOAuthLogin(provider.id, {
        ownerId: ownedLogin.ownerId,
      });
      if (r.ok) {
        toast.success(t('settings.providers.genericOAuth.toast.loggedIn', { name: provider.name }));
        onChanged();
      } else if (r.reason === 'login_cancelled') {
        /* 用户取消,不弹错 */
      } else {
        toast.error(
          t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }),
        );
      }
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
    } finally {
      ownedLogin.finish();
      setLoggingIn(false);
    }
  }, [beginOwnedLogin, clearDeviceCode, onChanged, provider.id, provider.name, t]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.genericOAuth.logoutConfirm.title', { name: provider.name }),
      description: t('settings.providers.genericOAuth.logoutConfirm.description', {
        name: provider.name,
      }),
      confirmText: t('settings.providers.genericOAuth.logoutConfirm.confirm'),
      cancelText: t('settings.providers.genericOAuth.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.maker.providerOAuthLogout(provider.id);
      toast.success(t('settings.providers.genericOAuth.toast.loggedOut', { name: provider.name }));
      onChanged();
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.logoutFailed', { name: provider.name }));
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, provider.id, provider.name, t]);

  const trailing = connected ? (
    <div className="flex shrink-0 items-center gap-2.5">
      <ConnectedPill />
      <PillButton
        label={t('settings.providers.button.disconnect')}
        onClick={() => void handleLogout()}
        disabled={busy}
      />
    </div>
  ) : (
    <PillButton
      label={
        loggingIn
          ? t('settings.providers.button.cancel')
          : t(
              deviceFlow
                ? 'settings.providers.wizard.authorizeWithDeviceCode'
                : 'settings.providers.button.authorize',
            )
      }
      onClick={() => {
        if (loggingIn) {
          cancelOwnedLogin();
          clearDeviceCode();
          setLoggingIn(false);
        } else {
          void handleLogin();
        }
      }}
    />
  );
  const detail =
    loggingIn && deviceFlow ? <OAuthDeviceCodeCard deviceCode={deviceCode} /> : undefined;

  return (
    <DetailHeader
      icon={providerIcon(provider, 18)}
      title={provider.name}
      subtitle={t('settings.providers.genericOAuth.subtitle')}
      trailing={trailing}
      provider={provider}
      detail={detail}
    />
  );
}

/**
 * 内置 API-key 供应商详情头(如 Gemini 图像来源,2026-07 图像多来源)。
 * 连接态 = key 已存(provider-service builtinApiKeyConnected);「更换」重写 key,
 * 「断开」删除 key(safeStorage),断开后左栏行按既有契约消失、重连入口回向导。
 * **已存 key 永不回显**:它是 MAIN_ONLY 键,renderer 只能查存在性/写/删(见
 * ImageApiKeyRow 注释),架构上拿不到明文。输入框的明文切换只显形用户本次输入的
 * 草稿(草稿本就在 renderer state 里),不构成凭证下放。
 */
function BuiltinApiKeyHeader({
  provider,
  onChanged,
}: {
  provider: ProviderView;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState('');

  const handleSave = useCallback(async () => {
    const key = draftKey.trim();
    if (!key) return;
    setBusy(true);
    try {
      // 失败经统一 IPC 错误协议抛出(throwIpcError),这里 catch 即失败。
      await window.electronAPI.builtinApiKeyStore(provider.id, key);
      toast.success(t('settings.providers.builtinApiKey.toast.saved', { name: provider.name }));
      setEditing(false);
      setDraftKey('');
      onChanged();
    } catch {
      toast.error(t('settings.providers.builtinApiKey.toast.saveFailed', { name: provider.name }));
    } finally {
      setBusy(false);
    }
  }, [draftKey, onChanged, provider.id, provider.name, t]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.builtinApiKey.disconnectConfirm.title', { name: provider.name }),
      description: t('settings.providers.builtinApiKey.disconnectConfirm.description', {
        name: provider.name,
      }),
      confirmText: t('settings.providers.builtinApiKey.disconnectConfirm.confirm'),
      cancelText: t('settings.providers.builtinApiKey.disconnectConfirm.cancel'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await window.electronAPI.builtinApiKeyRemove(provider.id);
      toast.success(
        t('settings.providers.builtinApiKey.toast.disconnected', { name: provider.name }),
      );
      onChanged();
    } catch {
      toast.error(
        t('settings.providers.builtinApiKey.toast.disconnectFailed', { name: provider.name }),
      );
    } finally {
      setBusy(false);
    }
  }, [confirm, onChanged, provider.id, provider.name, t]);

  const trailing = (
    /* 三控件组自身可折行:最小窗口(内容区 ~235px)下「已连接 / 更换 key / 断开」
       放不下时组内换行,不再作为整体溢出被裁(PR #1102 review 第九轮)。 */
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5 gap-y-2">
      {provider.connected && <ConnectedPill />}
      <PillButton
        label={t(
          editing
            ? 'settings.providers.button.cancel'
            : 'settings.providers.builtinApiKey.replaceKey',
        )}
        onClick={() => {
          setDraftKey('');
          setEditing((v) => !v);
        }}
        disabled={busy}
      />
      {provider.connected && (
        <PillButton
          label={t('settings.providers.button.disconnect')}
          onClick={() => void handleDisconnect()}
          disabled={busy}
        />
      )}
    </div>
  );

  const detail = editing ? (
    <div className="flex items-center gap-2 pt-2">
      <SettingsTextInput
        value={draftKey}
        onChange={setDraftKey}
        placeholder={t('settings.providers.builtinApiKey.keyPlaceholder')}
        size="sm"
        mono
        secret
        className="min-w-0 flex-1"
      />
      <PillButton
        label={t('settings.providers.builtinApiKey.saveKey')}
        onClick={() => void handleSave()}
        disabled={busy || draftKey.trim().length === 0}
      />
    </div>
  ) : undefined;

  return (
    <DetailHeader
      icon={providerIcon(provider, 18)}
      title={provider.name}
      subtitle={t('settings.providers.builtinApiKey.subtitle')}
      trailing={trailing}
      provider={provider}
      detail={detail}
    />
  );
}

// ---------------------------------------------------------------------------
// XD 网关(Cindy AI)—— managed gateway key(useApiKey)。
//
// 版面口径(2026-08 计费引导 P0-1):xd 的 key 是登录后由服务端自动下发的**托管
// 凭证**,个人用户从不手动管理它(2026-07-17「无手填入口」定案)。所以主位不给
// 脱敏 key / 轮换 / 重新获取这三件用户几乎不碰的事,而给「我还剩多少钱、去哪充」:
//   - 标题行右端只留一个「···」溢出菜单(与所有供应商共用 DetailHeader 那一个),
//     凭证管理三项 + 只读脱敏 key 收在里面,各自保留原有的二次确认;
//   - 标题行下方是账户资产模块(1px 发丝线分隔):可用余额 + 查看用量 + 余额充值;
//   - 故障恢复(重试)只在凭据同步失败时浮现,正常态版面上没有重试按钮。
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (key && key.length >= 4) return `sk-••••••${key.slice(-4)}`;
  return 'sk-••••••••';
}

function XdGatewayHeader({
  provider,
  onChanged,
}: {
  provider?: ProviderView;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { mode, user } = useAuth();
  const { key, hasSavedKey, clearKey } = useApiKey();
  const syncStatus = useModelAccessStatus();
  const connected = provider?.connected ?? false;
  const [rotating, setRotating] = useState(false);

  // 余额 / 充值 / 用量入口一律走同一判据:cloud + personal。org 账号是**不渲染**
  // (不是灰置),与设置页「用量和计费」分区的可见性判定同源。
  const billingAccessible = canAccessBillingSettings({
    mode,
    membershipKind: user?.membershipKind ?? null,
  });
  // 余额取三池账本的 available —— 与计费页余额卡、状态栏用量 chip 同一口径同一币种
  // (见 TodaySpendChip 的「同一笔钱、必须同口径」注释)。该 hook 的防闪烁缓存按
  // accountId 绑定,切号当帧失效,不会把上一个账号的余额显示给新账号。
  const creditUsage = useModelAccessCreditUsage(billingAccessible);
  const assetState = resolveXdAssetModuleState({
    billingAccessible,
    syncState: syncStatus.state,
    available: creditUsage?.available ?? null,
  });

  // 凭据一律由服务端自动下发(个人 / 已接入企业),**无手填入口**(2026-07-17 定案)。
  const serverManaged = syncStatus.state === 'ok' && syncStatus.source === 'server';

  const prevSyncStateRef = useRef(syncStatus.state);
  useEffect(() => {
    if (prevSyncStateRef.current === syncStatus.state) return;
    prevSyncStateRef.current = syncStatus.state;
    if (syncStatus.state === 'ok') onChanged();
  }, [syncStatus.state, onChanged]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.xd.disconnectConfirm.title'),
      description: t('settings.providers.xd.disconnectConfirm.description'),
      confirmText: t('settings.providers.button.disconnect'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    const ok = await clearKey();
    if (ok) onChanged();
  }, [clearKey, confirm, onChanged, t]);

  const handleRetry = useCallback(() => {
    void window.electronAPI.modelAccess
      .retry()
      .then(() => onChanged())
      .catch(() => undefined);
  }, [onChanged]);

  const handleRotate = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.xd.rotateConfirm.title'),
      description: t('settings.providers.xd.rotateConfirm.description'),
      confirmText: t('settings.providers.xd.rotateConfirm.confirm'),
      cancelText: t('settings.connections.codex.logoutConfirm.cancel'),
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      await window.electronAPI.modelAccess.rotate();
      toast.success(t('settings.providers.xd.rotateSuccess'));
      onChanged();
    } catch {
      toast.error(t('settings.providers.xd.rotateFailed'));
    } finally {
      setRotating(false);
    }
  }, [confirm, onChanged, t]);

  const maskedKey = useMemo(() => maskKey(hasSavedKey ? key : ''), [hasSavedKey, key]);

  /**
   * 只读脱敏 key 的「点击复制」复制的是**明文 key**：脱敏串本身复制出去没有用途。
   * 这不构成新的凭证下放 —— gateway key 本来就在 renderer 侧可读（useApiKey，与
   * 掩码展示同一份数据），这里只是把用户已经能看到的东西按他的明确点击交给剪贴板。
   */
  const handleCopyKey = useCallback(() => {
    if (!hasSavedKey || !key) return;
    void navigator.clipboard
      .writeText(key)
      .then(() => toast.success(t('settings.providers.xd.copyKeySuccess')))
      .catch(() => toast.error(t('settings.providers.xd.copyKeyFailed')));
  }, [hasSavedKey, key, t]);

  const goToBilling = useCallback(
    (intent?: 'topup') => {
      navigate(intent ? '/settings?tab=billing&intent=topup' : '/settings?tab=billing');
    },
    [navigate],
  );

  // 标题行右端只剩状态位:「已连接」pill,或未连接/同步中的一句状态说明。凭证动作
  // 全部退进「···」菜单;故障态刻意**不显示**「已连接」—— 凭据没同步上,说已连接是假的。
  const trailing = (() => {
    switch (syncStatus.state) {
      case 'unsupported':
        return (
          <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.xd.sync.unsupported')}
          </span>
        );
      case 'syncing':
        return (
          <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.xd.sync.syncing')}
          </span>
        );
      case 'failed':
        return null;
      default:
        break;
    }
    return connected ? (
      <ConnectedPill />
    ) : (
      <span className="shrink-0 text-12" style={{ color: 'var(--text-tertiary)' }}>
        {syncStatus.state === 'disabled'
          ? t('settings.providers.xd.sync.disabled')
          : t('settings.providers.xd.sync.autoProvision')}
      </span>
    );
  })();

  // 凭证管理三项:各自保留原有的二次确认弹窗(重新获取凭据本身无确认,与改造前一致)。
  const menuItems = (
    <>
      {serverManaged && (
        <DropdownMenuItem onClick={handleRetry}>
          <RefreshCw size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
          {t('settings.providers.xd.sync.refresh')}
        </DropdownMenuItem>
      )}
      {serverManaged && (
        <DropdownMenuItem disabled={rotating} onClick={() => void handleRotate()}>
          <KeyRound size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
          {rotating
            ? t('settings.providers.xd.sync.rotating')
            : t('settings.providers.xd.sync.rotate')}
        </DropdownMenuItem>
      )}
      {connected && (
        <DropdownMenuItem onClick={() => void handleDisconnect()}>
          <LogOut size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
          {t('settings.providers.button.disconnect')}
        </DropdownMenuItem>
      )}
    </>
  );

  // 菜单末行:只读脱敏 key(点击复制)。它从主位退到这里 —— 对个人用户是纯噪音,
  // 但排障时仍需要能拿到。
  const menuFooter = hasSavedKey ? (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={handleCopyKey}
        className="font-mono text-[var(--text-secondary)]"
        aria-label={t('settings.providers.xd.copyKeyAria')}
      >
        <Copy size={14} className="mr-2.5 shrink-0 text-[var(--text-tertiary)]" />
        {maskedKey}
      </DropdownMenuItem>
    </>
  ) : null;

  const assetModule =
    assetState.kind === 'hidden' ? undefined : (
      <div
        data-testid="cindy-ai-asset-module"
        className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-t px-5 py-4"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        {assetState.kind === 'fault' ? (
          <>
            {/* 「本该有、这次拿不到」——讲清发生了什么 + 下一步,并就地给恢复入口。 */}
            <p
              className="max-w-[400px] text-13 leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('settings.providers.xd.asset.syncFailed')}
            </p>
            <PillButton label={t('settings.providers.xd.sync.retry')} onClick={handleRetry} />
          </>
        ) : (
          <>
            <div className="min-w-[120px]">
              <p className="text-12 leading-tight" style={{ color: 'var(--text-secondary)' }}>
                {t('billing.balance.title')}
              </p>
              {/* 与计费页余额卡完全同口径:20px / 500 / tabular-nums / tracking-tight。 */}
              <p
                className="mt-1.5 text-20 font-medium leading-[1.3] tracking-[-0.02em] tabular-nums"
                style={{ color: 'var(--text-primary)' }}
              >
                {formatBillingAmount(
                  assetState.available,
                  BILLING_CURRENCY,
                  i18n.resolvedLanguage ?? i18n.language,
                )}
              </p>
            </div>
            {/* 余额充值是主动作；查看用量为同区块内的次动作。 */}
            <div className="flex shrink-0 items-center gap-3">
              <PillButton
                label={t('settings.providers.xd.asset.viewUsage')}
                onClick={() => goToBilling()}
              />
              <CtaPillButton
                label={t('billing.settings.topupCard.action')}
                onClick={() => goToBilling('topup')}
              />
            </div>
          </>
        )}
      </div>
    );

  return (
    <DetailHeader
      icon={<XDIncMark size={18} />}
      title={t('settings.providers.xd.title')}
      modelCountSuffix={
        syncStatus.accountTier === 'free' ? (
          <span
            data-testid="cindy-ai-free-tier-badge"
            className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--text-secondary)]"
          >
            {t('settings.providers.xd.accountTier.free')}
          </span>
        ) : undefined
      }
      subtitle={providerSubtitleForDisplay(provider, t('settings.providers.xd.modelLabel'), {
        suffix: t('settings.providers.xd.billingLabel'),
        fallback: t('settings.providers.xd.subtitle'),
      })}
      trailing={trailing}
      provider={provider}
      menuItems={menuItems}
      menuFooter={menuFooter}
      assetModule={assetModule}
    />
  );
}

function OllamaHeader({ provider, onDelete }: { provider: ProviderView; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <DetailHeader
      icon={providerIcon(provider, 18)}
      title={t('settings.providers.local.title')}
      subtitle={t('settings.providers.local.subtitle')}
      trailing={null}
      provider={provider}
      badge={<BetaTag label={t('settings.providers.local.beta')} />}
      menuItems={
        <DropdownMenuItem onClick={onDelete}>
          <Trash2 size={14} className="mr-2.5 text-[var(--text-tertiary)]" />
          {t('settings.providers.local.deleteFromCindy')}
        </DropdownMenuItem>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// 自定义供应商详情头 —— 编辑 / 删除;OAuth 形态另有授权/登出。
// ---------------------------------------------------------------------------

function CustomProviderHeader({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [loggingIn, setLoggingIn] = useState(false);
  const isOAuth = provider.auth.method === 'oauth' && !!provider.auth.oauth;
  const deviceFlow = provider.auth.oauth?.flow === 'device-code';
  const { deviceCode, clearDeviceCode, beginOwnedLogin, cancelOwnedLogin } =
    useProviderOAuthDeviceCode(isOAuth ? provider.id : null, { observeProgress: deviceFlow });
  const handleOAuthClick = useCallback(async () => {
    if (provider.connected) {
      try {
        await window.electronAPI.maker.providerOAuthLogout(provider.id);
        toast.success(
          t('settings.providers.genericOAuth.toast.loggedOut', { name: provider.name }),
        );
      } catch {
        toast.error(
          t('settings.providers.genericOAuth.toast.logoutFailed', { name: provider.name }),
        );
      }
      return;
    }
    if (loggingIn) {
      cancelOwnedLogin();
      clearDeviceCode();
      setLoggingIn(false);
      return;
    }
    clearDeviceCode();
    setLoggingIn(true);
    const ownedLogin = beginOwnedLogin();
    try {
      const r = await window.electronAPI.maker.providerOAuthLogin(provider.id, {
        ownerId: ownedLogin.ownerId,
      });
      if (r.ok)
        toast.success(t('settings.providers.genericOAuth.toast.loggedIn', { name: provider.name }));
      else if (r.reason !== 'login_cancelled') {
        toast.error(
          t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }),
        );
      }
    } catch {
      toast.error(t('settings.providers.genericOAuth.toast.loginFailed', { name: provider.name }));
    } finally {
      ownedLogin.finish();
      setLoggingIn(false);
    }
  }, [
    beginOwnedLogin,
    cancelOwnedLogin,
    clearDeviceCode,
    loggingIn,
    provider.connected,
    provider.id,
    provider.name,
    t,
  ]);

  const trailing = (
    <div className="flex shrink-0 items-center gap-1">
      {isOAuth && (
        <PillButton
          label={
            provider.connected
              ? t('settings.providers.button.disconnect')
              : loggingIn
                ? t('settings.providers.button.cancel')
                : t(
                    deviceFlow
                      ? 'settings.providers.wizard.authorizeWithDeviceCode'
                      : 'settings.providers.button.authorize',
                  )
          }
          onClick={() => void handleOAuthClick()}
        />
      )}
      <RowIconButton
        icon={<Pencil size={16} />}
        label={t('settings.providers.custom.editAria')}
        onClick={onEdit}
      />
      <RowIconButton
        icon={<Trash2 size={16} />}
        label={t('settings.providers.custom.deleteAria')}
        onClick={onDelete}
      />
    </div>
  );
  return (
    <DetailHeader
      icon={providerIcon(provider, 18)}
      title={provider.name}
      subtitle={customProviderSubtitleForDisplay(provider)}
      trailing={trailing}
      provider={provider}
      badge={
        isLocalRuntimeBetaProviderId(provider.id) ? (
          <BetaTag label={t('settings.providers.local.beta')} />
        ) : (
          <CustomTag label={t('settings.providers.custom.tag')} />
        )
      }
      detail={loggingIn && deviceFlow ? <OAuthDeviceCodeCard deviceCode={deviceCode} /> : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// 左栏列表
// ---------------------------------------------------------------------------

/**
 * Cindy AI 登录引导行:无账号会话(local/signed-out)的目录被
 * getDesktopSelectableCatalog 过滤掉 xd 供应商,设置页会完全丢失官方服务的
 * 发现/购买入口(2026-07-24 用户反馈)。此行在 xd 缺席时置顶出现,点击右栏
 * 展示登录引导;不触碰 main 的目录过滤(无账号确实不可路由 xd)。
 */
const CINDY_SIGNIN_ID = 'xd-signin';

function CindySigninRow({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
        selected
          ? 'bg-[var(--settings-menu-bg-selected)]'
          : 'hover:bg-[var(--settings-menu-bg-hover)]',
      )}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        <XDIncMark size={14} />
      </div>
      <span
        className="min-w-0 flex-1 truncate text-13 font-medium"
        style={{ color: 'var(--settings-section-title)' }}
      >
        {t('settings.providers.xd.title')}
      </span>
      {/* 徽标不大写不加字距:224px 窄栏里 en「RECOMMENDED」会把行名挤成「Cin…」。 */}
      <span
        className="shrink-0 rounded-full border px-1.5 py-px text-10 font-medium"
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
      >
        {t('settings.providers.xdSignin.badge')}
      </span>
    </button>
  );
}

function ListRow({
  provider,
  selected,
  reconnectRequired = false,
  onSelect,
  position,
  total,
  onMove,
  sortable,
}: {
  provider: ProviderView;
  selected: boolean;
  reconnectRequired?: boolean;
  onSelect: () => void;
  position: number;
  total: number;
  onMove: (delta: -1 | 1) => void;
  sortable: boolean;
}) {
  const { t } = useTranslation();
  const [ollamaLive, setOllamaLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (provider.id !== MANAGED_OLLAMA_PROVIDER_ID) return;
    let cancelled = false;
    void window.electronAPI.maker.localModelStatus().then((next) => {
      if (!cancelled) setOllamaLive(next.kind === 'ready' || next.kind === 'pulling');
    });
    const off = window.electronAPI.maker.onLocalModelStatus((next) => {
      setOllamaLive(next.kind === 'ready' || next.kind === 'pulling');
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [provider.id]);
  const modelCount = useMemo(
    () => (providerHasModels(provider) ? buildUnionRows(provider).length : null),
    [provider],
  );
  const title = provider.id === 'xd' ? t('settings.providers.xd.title') : provider.name;
  return (
    <div
      className={cn(
        'relative flex w-full items-center rounded-lg text-left transition-colors',
        selected
          ? 'bg-[var(--settings-menu-bg-selected)]'
          : 'hover:bg-[var(--settings-menu-bg-hover)]',
      )}
    >
      {sortable && (
        <button
          type="button"
          className="provider-order-handle absolute inset-y-0 left-0 z-[1] my-auto flex h-9 w-3 cursor-grab items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]"
          aria-label={t('settings.providers.order.handle', {
            provider: title,
            position,
            total,
          })}
          aria-keyshortcuts="ArrowUp ArrowDown"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            onMove(event.key === 'ArrowUp' ? -1 : 1);
          }}
          style={{ color: 'var(--text-tertiary)' }}
        >
          <GripVertical size={12} />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 pr-2.5 text-left"
      >
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: 'var(--settings-integration-avatar-bg)',
            border: '1px solid var(--settings-integration-avatar-border)',
            color: 'var(--settings-integration-avatar-icon)',
          }}
        >
          {providerIcon(provider, 14)}
        </div>
        <span
          className="min-w-0 flex-1 truncate text-13 font-medium"
          style={{
            color: provider.suspended ? 'var(--text-tertiary)' : 'var(--settings-section-title)',
          }}
        >
          {title}
        </span>
        {reconnectRequired ? (
          <span
            className="shrink-0 select-none text-11"
            style={{ color: 'var(--settings-integration-warning)' }}
          >
            {t('settings.providers.openai.reconnectRequired')}
          </span>
        ) : provider.suspended ? (
          // 已停用比模型数更要紧:窄栏(224px)只放得下一个注记,停用时以状态取代计数。
          <span className="shrink-0 select-none text-11" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.pill.suspended')}
          </span>
        ) : (
          modelCount !== null && (
            <span
              className="shrink-0 text-11 tabular-nums"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('settings.providers.models.modelCount', { count: modelCount })}
            </span>
          )
        )}
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            backgroundColor: reconnectRequired
              ? 'var(--remote-status-failed)'
              : provider.id === MANAGED_OLLAMA_PROVIDER_ID
                ? ollamaLive
                  ? 'var(--remote-status-ready)'
                  : 'var(--border-default)'
                : provider.connected && !provider.suspended
                  ? 'var(--remote-status-ready)'
                  : 'var(--border-default)',
          }}
        />
      </button>
    </div>
  );
}

/** 检测建议行:本机 CLI 已安装且对应渠道未连接时出现;点击直达向导的授权步。 */
function SuggestionRow({
  detection,
  provider,
  onClick,
}: {
  detection: LocalCliDetection;
  provider: ProviderView;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const cliName = localCliDisplayName(detection.cli);
  const title = provider.id === 'xd' ? t('settings.providers.xd.title') : provider.name;
  return (
    <button
      type="button"
      onClick={onClick}
      title={t(
        detection.loggedIn
          ? 'settings.providers.detect.hintLoggedIn'
          : 'settings.providers.detect.hintInstalled',
        { cli: cliName },
      )}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)]"
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-70"
        style={{
          backgroundColor: 'var(--settings-integration-avatar-bg)',
          border: '1px solid var(--settings-integration-avatar-border)',
          color: 'var(--settings-integration-avatar-icon)',
        }}
      >
        {providerIcon(provider, 14)}
      </div>
      <span className="min-w-0 flex-1 truncate text-13" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </span>
      <span
        className="flex h-[22px] shrink-0 items-center rounded-full border px-2.5 text-11 font-medium"
        style={{
          borderColor: 'var(--settings-btn-secondary-border)',
          color: 'var(--text-secondary)',
        }}
      >
        {t('settings.providers.detect.action')}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function ProvidersSection() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const signInToCindy = useSignInToCindy();
  const { dataOwnerId } = useAuth();
  const { confirm } = useConfirmDialog();
  const { providers, providerOrder, ownerGeneration, loading, refetch } = useProviders();
  // OpenAI 的 reconnect-required 是 useCodexAuth 独有状态(目录 connected 此时为 false):
  // 该状态下 OpenAI 行必须留在左栏,否则「重新连接」入口不可达,用户被迫从向导重发现。
  const codexAuth = useCodexAuth();
  const openaiReconnectRequired = codexAuth.state.kind === 'reconnect-required';

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingProviderOrder, setPendingProviderOrder] = useState<{
    dataOwnerId: string | null;
    ids: string[];
    providerOrderAtMutationEnd?: string[];
  } | null>(null);
  const [orderAnnouncement, setOrderAnnouncement] = useState('');
  const providerOrderMutationRef = useRef(0);
  const latestProviderOrderRef = useRef(providerOrder);
  latestProviderOrderRef.current = providerOrder;
  const observedProviderIdsRef = useRef<{
    dataOwnerId: string | null;
    ids: Set<string>;
  }>({ dataOwnerId, ids: new Set<string>() });
  // 向导:null = 关;{ entry } = 打开(entry 指定直达的供应商,来自检测建议)。
  const [wizard, setWizard] = useState<null | { entry?: WizardEntry }>(null);
  // 自定义供应商完整表单(编辑,或从向导「自定义端点」进入新建)。
  const [dialog, setDialog] = useState<
    null | { mode: 'create' } | { mode: 'edit'; config: CustomProviderConfig }
  >(null);
  const addProviderButtonRef = useRef<HTMLButtonElement>(null);
  const [detections, setDetections] = useState<LocalCliDetection[]>([]);
  const [rediscovering, setRediscovering] = useState(false);
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  // React state 负责渲染反馈；ref 才是同一事件循环内立即生效的互斥锁，防止双击在
  // disabled 状态提交到 DOM 前启动两条刷新。
  const refreshingProviderIdRef = useRef<string | null>(null);
  const beginProviderRefresh = useCallback((providerId: string): boolean => {
    if (refreshingProviderIdRef.current !== null) return false;
    refreshingProviderIdRef.current = providerId;
    setRefreshingProviderId(providerId);
    return true;
  }, []);
  const finishProviderRefresh = useCallback((providerId: string): void => {
    if (refreshingProviderIdRef.current !== providerId) return;
    refreshingProviderIdRef.current = null;
    setRefreshingProviderId(null);
  }, []);

  // 进入「模型供应商」页时只上报一个静默刷新提示。是否真正访问上游由 Main
  // 根据连接状态、30 分钟冷却和全局 in-flight 决定，失败不打扰用户。
  useEffect(() => {
    void window.electronAPI.maker
      .requestProviderModelsAutoRefresh('providers-open')
      .catch(() => undefined);
  }, []);

  // 本机 CLI 扫描:挂载时一次(失败静默空数组;检测建议是增强,不是依赖)。
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker
      .scanLocalCli()
      .then((r) => {
        if (!cancelled) setDetections(r.detections);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // SortableJS drop 后先由 React 乐观铺左栏可见顺序，等 PROVIDER_CHANGED 回来的 main
  // 快照与目标一致再清掉覆盖；隐藏项是否有持久化槽位只由 Main 判定，Renderer 不猜。
  const pendingProviderOrderIds =
    pendingProviderOrder && pendingProviderOrder.dataOwnerId === dataOwnerId
      ? pendingProviderOrder.ids
      : null;

  const byId = useMemo(() => {
    const map = new Map<string, ProviderView>();
    providers.forEach((p) => map.set(p.id, p));
    return map;
  }, [providers]);

  // 共享 provider 快照保持目录原序，避免显示偏好影响模型来源推导；只有设置页左栏
  // 应用 Main 并列下发的 owner-scoped 显示顺序。Cindy 登录引导与检测建议是伪行，
  // 不进入持久化顺序。
  const visibleProviders = useMemo(() => {
    const rows: ProviderView[] = [];
    for (const p of providers) {
      if (p.source === 'builtin') {
        // reconnect-required 视同占行:凭证失效 ≠ 用户断开,重连入口必须保留。
        // OpenAI 图像 key 与 ChatGPT OAuth 两套凭证解耦:imageModels 已声明时,
        // 即使未做 OAuth 登录也需占行以便配置 / 管理图像 key。
        const openaiHasImageCap = p.id === 'openai' && (p.imageModels?.length ?? 0) > 0;
        if (
          p.id === 'xd' ||
          p.connected ||
          (p.id === 'openai' && openaiReconnectRequired) ||
          openaiHasImageCap
        ) {
          rows.push(p);
        }
        continue;
      }
      if (
        p.source === 'user' &&
        (p.id === MANAGED_OLLAMA_PROVIDER_ID ||
          p.id === MANAGED_LMSTUDIO_PROVIDER_ID ||
          providerHasModels(p) ||
          (p.auth.method === 'oauth' && !!p.auth.oauth))
      ) {
        rows.push(p);
      }
    }
    return rows;
  }, [providers, openaiReconnectRequired]);

  const orderedVisibleProviders = useMemo(
    () => applyProviderOrder(visibleProviders, providerOrder),
    [providerOrder, visibleProviders],
  );

  const listProviders = useMemo(
    () =>
      pendingProviderOrderIds
        ? applyProviderOrder(orderedVisibleProviders, pendingProviderOrderIds)
        : orderedVisibleProviders,
    [orderedVisibleProviders, pendingProviderOrderIds],
  );

  useEffect(() => {
    if (pendingProviderOrder && pendingProviderOrder.dataOwnerId !== dataOwnerId) {
      providerOrderMutationRef.current += 1;
      setPendingProviderOrder(null);
      return;
    }
    if (!pendingProviderOrderIds) return;
    const incomingIds = orderedVisibleProviders.map((provider) => provider.id);
    const sameCatalog =
      incomingIds.length === pendingProviderOrderIds.length &&
      incomingIds.every((id) => pendingProviderOrderIds.includes(id));
    // 每次权威快照都会携带新的 providerOrder 数组引用。写结束后首个新快照无论顺序
    // 是否仍等于本窗口目标，都要结束 pending：另一窗口可能已经成为最后写入者。
    const hasSnapshotAfterMutation =
      pendingProviderOrder?.providerOrderAtMutationEnd !== undefined &&
      providerOrder !== pendingProviderOrder.providerOrderAtMutationEnd;
    if (
      !sameCatalog ||
      incomingIds.every((id, index) => id === pendingProviderOrderIds[index]) ||
      hasSnapshotAfterMutation
    ) {
      setPendingProviderOrder(null);
    }
  }, [
    dataOwnerId,
    orderedVisibleProviders,
    pendingProviderOrder,
    pendingProviderOrderIds,
    providerOrder,
  ]);

  // Main 只持久化曾经真正进入过左栏的供应商。自动观察只逐个提交权威快照里缺失的
  // 新项：singleton 写入只会追加，另一窗口刚保存的显式排序不会被旧快照重排。
  // 已记录但暂时隐藏的项由 store 保留，因此断开重连不会丢失用户排位。
  useEffect(() => {
    if (observedProviderIdsRef.current.dataOwnerId !== dataOwnerId) {
      observedProviderIdsRef.current = { dataOwnerId, ids: new Set<string>() };
    }
    const observedProviderIds = observedProviderIdsRef.current.ids;
    const visibleIds = listProviders.map((provider) => provider.id);
    const persistedIds = new Set(providerOrder);
    const unrecordedIds = visibleIds.filter(
      (id) => !observedProviderIds.has(id) && !persistedIds.has(id),
    );
    visibleIds.forEach((id) => observedProviderIds.add(id));
    if (unrecordedIds.length === 0 || ownerGeneration === null) return;
    void Promise.all(
      unrecordedIds.map((id) =>
        window.electronAPI.maker.setProviderOrder(dataOwnerId, ownerGeneration, [id]),
      ),
    ).catch(() => toast.error(t('settings.providers.order.saveFailed')));
  }, [dataOwnerId, listProviders, ownerGeneration, providerOrder, t]);

  const persistVisibleProviderOrder = useCallback(
    (reorderedVisibleIds: string[]): void => {
      const currentIds = listProviders.map((provider) => provider.id);
      if (reorderedVisibleIds.every((id, index) => id === currentIds[index])) return;
      if (ownerGeneration === null) return;
      if (
        selectedId !== CINDY_SIGNIN_ID &&
        !listProviders.some((provider) => provider.id === selectedId) &&
        listProviders[0]
      ) {
        setSelectedId(listProviders[0].id);
      }
      const generation = ++providerOrderMutationRef.current;
      setPendingProviderOrder({ dataOwnerId, ids: reorderedVisibleIds });
      void window.electronAPI.maker
        .setProviderOrder(dataOwnerId, ownerGeneration, reorderedVisibleIds)
        .then(() => {
          if (providerOrderMutationRef.current !== generation) return;
          setPendingProviderOrder((current) =>
            current?.dataOwnerId === dataOwnerId
              ? {
                  ...current,
                  providerOrderAtMutationEnd: latestProviderOrderRef.current,
                }
              : current,
          );
          refetch();
        })
        .catch(() => {
          if (providerOrderMutationRef.current !== generation) return;
          setPendingProviderOrder(null);
          toast.error(t('settings.providers.order.saveFailed'));
        });
    },
    [dataOwnerId, listProviders, ownerGeneration, refetch, selectedId, t],
  );

  const moveProviderWithKeyboard = useCallback(
    (providerId: string, delta: -1 | 1): void => {
      const currentIds = listProviders.map((provider) => provider.id);
      const index = currentIds.indexOf(providerId);
      const nextIndex = index + delta;
      if (index < 0 || nextIndex < 0 || nextIndex >= currentIds.length) return;
      const nextIds = [...currentIds];
      const [moved] = nextIds.splice(index, 1);
      nextIds.splice(nextIndex, 0, moved!);
      persistVisibleProviderOrder(nextIds);
      const provider = byId.get(providerId);
      setOrderAnnouncement(
        t('settings.providers.order.moved', {
          provider:
            provider?.id === 'xd'
              ? t('settings.providers.xd.title')
              : (provider?.name ?? providerId),
          position: nextIndex + 1,
          total: currentIds.length,
        }),
      );
    },
    [byId, listProviders, persistVisibleProviderOrder, t],
  );

  // 检测建议:CLI 已安装 + 对应渠道存在于目录 + 未连接,且**未以任何形态占行**
  // (OpenAI reconnect-required 已在主列表时,不再重复出建议行)。
  const suggestions = useMemo(() => {
    const listedIds = new Set(listProviders.map((p) => p.id));
    return detections
      .filter((d) => d.installed && !listedIds.has(d.providerId))
      .map((d) => ({ detection: d, provider: byId.get(d.providerId) }))
      .filter(
        (s): s is { detection: LocalCliDetection; provider: ProviderView } =>
          !!s.provider && !s.provider.connected,
      );
  }, [detections, byId, listProviders]);

  /**
   * 深链定位(?connect=<id> / ?wizard=1,来自「连接供应商」引导卡等):providers
   * 就绪后一次性消费,消费即从 URL 摘除(replace,防返回/刷新重复触发)。
   *   - connect 命中左栏占行的供应商(如 xd)→ 直接选中;
   *   - connect 命中目录内置渠道 → 向导直达该渠道授权步;
   *   - 其余 id 视为 preset id → 向导 preset 直达(presets 异步匹配,未命中回落目录页);
   *   - wizard=1 → 打开向导目录第一步。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (loading) return;
    const connect = searchParams.get('connect');
    const wizardFlag = searchParams.get('wizard');
    if (!connect && !wizardFlag) return;
    // 不用一次性 ref:消费后立即删参(下方 replace)即防重放;组件常驻期间
    // 再次带参导航(如二次深链)仍应生效(review 反馈)。
    if (connect) {
      const target = byId.get(connect);
      if (listProviders.some((p) => p.id === connect)) {
        setSelectedId(connect);
      } else if (connect === 'xd') {
        // 无账号会话目录不含 xd → 落到登录引导行(不能当 preset 交给向导)。
        setSelectedId(CINDY_SIGNIN_ID);
      } else if (connect === MANAGED_OLLAMA_PROVIDER_ID) {
        setWizard({});
      } else if (target && target.source === 'builtin') {
        setWizard({ entry: { kind: 'builtin', providerId: connect } });
      } else {
        setWizard({ entry: { kind: 'preset', presetId: connect } });
      }
    } else {
      setWizard({});
    }
    const next = new URLSearchParams(searchParams);
    next.delete('connect');
    next.delete('wizard');
    setSearchParams(next, { replace: true });
  }, [loading, searchParams, setSearchParams, byId, listProviders]);

  // Cindy AI 登录引导:无账号会话目录不含 xd(见 CindySigninRow 头注释),置顶
  // 引导行;列表为空时默认选中它(右栏直接展示登录引导,不留「点击添加」空态)。
  const showCindySignin = !byId.has('xd');
  const cindySigninActive =
    showCindySignin &&
    (selectedId === CINDY_SIGNIN_ID || (selectedId == null && listProviders.length === 0));

  // 选中项:默认第一行;所选供应商被删除/消失时回退第一行(不留空详情)。
  const effectiveSelected = useMemo(() => {
    if (selectedId && listProviders.some((p) => p.id === selectedId)) {
      return listProviders.find((p) => p.id === selectedId) ?? null;
    }
    return listProviders[0] ?? null;
  }, [selectedId, listProviders]);

  const handleDelete = useCallback(
    async (p: ProviderView) => {
      const ok = await confirm({
        title: t('settings.providers.custom.deleteConfirm.title'),
        description: t('settings.providers.custom.deleteConfirm.description', { name: p.name }),
        confirmText: t('settings.providers.custom.deleteConfirm.confirm'),
        cancelText: t('settings.providers.custom.deleteConfirm.cancel'),
      });
      if (!ok) return;
      try {
        await deleteCustomProvider(p.id);
        toast.success(t('settings.providers.custom.toast.deleted'));
      } catch {
        toast.error(t('settings.providers.custom.toast.deleteFailed'));
      }
    },
    [confirm, t],
  );

  const handleDeleteOllama = useCallback(async () => {
    const ok = await confirm({
      title: t('settings.providers.local.deleteConfirmTitle'),
      description: t('settings.providers.local.deleteConfirmBody'),
      confirmText: t('settings.providers.custom.deleteConfirm.confirm'),
      cancelText: t('settings.providers.custom.deleteConfirm.cancel'),
    });
    if (!ok) return;
    try {
      await deleteCustomProvider(MANAGED_OLLAMA_PROVIDER_ID);
      toast.success(t('settings.providers.custom.toast.deleted'));
    } catch {
      toast.error(t('settings.providers.custom.toast.deleteFailed'));
    }
  }, [confirm, t]);

  /**
   * 自定义供应商「刷新模型」:读回各 runtime 密钥 → fetchProviderModels →
   * additions-only 合并进配置。新增模型默认隐藏,避免刷新扩大用户当前可用模型范围;
   * 已有模型及其显式可见性不变。
   */
  const handleRefreshModels = useCallback(
    async (p: ProviderView) => {
      if (!beginProviderRefresh(p.id)) return;
      try {
        const config = providerViewToCustomProviderConfig(p);
        let added = 0;
        let anyOk = false;
        for (const agent of p.agents) {
          const rt = config.runtimes[agent];
          if (!rt?.baseUrl) continue;
          const authMethod =
            p.auth.method === 'none' ? 'none' : p.auth.method === 'oauth' ? 'oauth' : 'apiKey';
          const apiKey = authMethod === 'apiKey' ? await readCustomProviderKey(p.id, agent) : null;
          // 鉴权请求头是 main-only 密文,renderer 不回读;交由 main 按 savedProviderId
          // 注入已存请求头(否则仅靠请求头鉴权的端点刷新会因缺头 401,codex review)。
          const r = await window.electronAPI.maker.fetchProviderModels({
            agent,
            baseUrl: rt.baseUrl,
            authMethod,
            ...(rt.wireProtocol ? { wireProtocol: rt.wireProtocol } : {}),
            modelsUrl: rt.modelsUrl ?? null,
            apiKey,
            savedProviderId: p.id,
          });
          if (!r.ok || !r.models) continue;
          anyOk = true;
          const merged = appendDiscoveredCustomProviderModels(rt.models, r.models);
          rt.models = merged.models;
          added += merged.addedIds.length;
        }
        if (!anyOk) {
          toast.error(t('settings.providers.models.refreshFailed'));
          return;
        }
        if (added > 0) {
          await updateCustomProvider(config, {});
          toast.success(t('settings.providers.models.refreshAdded', { count: added }));
        } else {
          toast.success(t('settings.providers.models.refreshNoNew'));
        }
        refetch();
      } catch {
        toast.error(t('settings.providers.models.refreshFailed'));
      } finally {
        finishProviderRefresh(p.id);
      }
    },
    [beginProviderRefresh, finishProviderRefresh, refetch, t],
  );

  /** 内置四家复用 main 已有的 provider-specific 真源刷新，不在 Renderer 复制网络逻辑。 */
  const handleRefreshBuiltinModels = useCallback(
    async (p: ProviderView) => {
      if (!isBuiltinRefreshableProviderId(p.id) || !beginProviderRefresh(p.id)) return;
      try {
        await window.electronAPI.maker.refreshBuiltinProviderModels(p.id);
        toast.success(t('settings.providers.models.refreshDone'));
        refetch();
      } catch (err) {
        // 目录拉取被禁用(XDT_DISABLE_MODELS_FETCH)时 main 根本没
        // 发起请求——这是预期内的跳过,用 info 如实提示,不和真实网络失败
        // 混为一谈地报「刷新失败,请稍后再试」。
        const ipcError = extractIpcError(err);
        if (ipcError?.code === 'MODEL_CATALOG_FETCH_DISABLED') {
          toast.info(t('settings.providers.models.refreshFetchDisabled'));
        } else {
          toast.error(t('settings.providers.models.refreshFailed'));
        }
      } finally {
        finishProviderRefresh(p.id);
      }
    },
    [beginProviderRefresh, finishProviderRefresh, refetch, t],
  );

  /**
   * 动态清单发现失败后的**用户主动**重试。
   *
   * host 只对暂时性失败(连不上 / 超时 / 上游 5xx)做有限次退避重试,地域拒绝、凭证被拒
   * 这类确定性答复一次都不重试 —— 重试只会把真正的原因藏起来。所以自动退避停手之后,
   * 这个按钮就是恢复入口:用户换好网络 / 代理出口后点一下即可,不必重启,并且会重开一轮
   * 退避。成功与否都由 main 广播 PROVIDER_CHANGED 驱动列表刷新:成功时清单直接出现在
   * 同一块区域,失败时理由就地更新 —— 两种结果都自解释,不再弹 toast 重复一遍(只有 IPC
   * 本身异常才需要额外提示)。
   */
  const handleRediscoverModels = useCallback(
    async (p: ProviderView) => {
      setRediscovering(true);
      try {
        await window.electronAPI.maker.rediscoverModels(p.id);
        // 正常路径不 refetch:main 的发现流程会广播 PROVIDER_CHANGED,App 层监听已经触发
        // refreshLocalCatalogSnapshot。这里再拉一次等于每点一下重试就多做一整轮目录 +
        // capabilities 刷新,也和上面「刷新由广播驱动」的说明自相矛盾(PR #548 review)。
      } catch {
        // IPC 本身失败 = 没有广播可等,自己补一次拉取,免得 UI 停在旧快照。
        toast.error(t('settings.providers.models.refreshFailed'));
        refetch();
      } finally {
        setRediscovering(false);
      }
    },
    [refetch, t],
  );

  // 详情头部按供应商类型分派(鉴权逻辑与重构前一致)。
  const renderDetailHeader = (p: ProviderView): ReactNode => {
    if (p.id === 'xd') return <XdGatewayHeader provider={p} onChanged={refetch} />;
    if (p.id === 'anthropic') return <AnthropicHeader provider={p} onChanged={refetch} />;
    if (p.id === 'openai') return <OpenAiHeader provider={p} onChanged={refetch} />;
    if (p.id === 'xai') return <XaiHeader provider={p} onChanged={refetch} />;
    if (
      p.source === 'builtin' &&
      p.auth.method === 'apiKey' &&
      (PROVIDER_SECRET_IDS as readonly string[]).includes(p.id)
    ) {
      return <BuiltinApiKeyHeader provider={p} onChanged={refetch} />;
    }
    if (p.source === 'builtin') return <GenericOAuthHeader provider={p} onChanged={refetch} />;
    if (p.id === MANAGED_OLLAMA_PROVIDER_ID) {
      return <OllamaHeader provider={p} onDelete={() => void handleDeleteOllama()} />;
    }
    return (
      <CustomProviderHeader
        provider={p}
        onEdit={() => setDialog({ mode: 'edit', config: providerViewToCustomProviderConfig(p) })}
        onDelete={() => void handleDelete(p)}
      />
    );
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2
          className="text-16 font-medium leading-[1.2]"
          style={{ color: 'var(--settings-section-title)' }}
        >
          {t('settings.providers.title')}
        </h2>
        <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.providers.subtitle')}
        </p>
      </div>

      {/* 先取数据再渲染卡片(规则 7:首帧即终态高度,不出现连接态翻转的跳变帧)。
          高度跟随视口(减去标题栏 + 设置页 chrome + section 标题的约 14rem),窗口越大
          卡片越高、能显示越多模型;min-h 保底小窗口不塌陷。左右栏各自内部滚动。
          原来写死 560px 会在大窗口下截断模型列表(不随框体撑高)。 */}
      {!loading && (
        <div
          className="flex h-[calc(100vh-14rem)] min-h-[460px] overflow-hidden rounded-xl border"
          style={{
            backgroundColor: 'var(--settings-theme-card-bg)',
            borderColor: 'var(--settings-theme-card-border)',
          }}
        >
          {/* 左栏 */}
          <div
            className="flex w-[224px] shrink-0 flex-col border-r"
            style={{ borderColor: 'var(--settings-theme-card-border)' }}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {showCindySignin && (
                <CindySigninRow
                  selected={cindySigninActive}
                  onSelect={() => setSelectedId(CINDY_SIGNIN_ID)}
                />
              )}
              {listProviders.length > 1 && (
                <div className="select-none px-1.5 pb-1 pt-1">
                  <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
                    {t('settings.providers.order.hint')}
                  </span>
                </div>
              )}
              <SortableList
                items={listProviders}
                getId={(provider) => provider.id}
                onReorder={persistVisibleProviderOrder}
                renderItem={(provider, index) => (
                  <ListRow
                    provider={provider}
                    selected={!cindySigninActive && effectiveSelected?.id === provider.id}
                    reconnectRequired={provider.id === 'openai' && openaiReconnectRequired}
                    onSelect={() => setSelectedId(provider.id)}
                    position={index + 1}
                    total={listProviders.length}
                    onMove={(delta) => moveProviderWithKeyboard(provider.id, delta)}
                    sortable={listProviders.length > 1}
                  />
                )}
                disabled={listProviders.length < 2}
                reducedMotion={reducedMotion}
                filter="input, textarea, select, a, [data-no-drag]"
                className="flex flex-col gap-0.5"
                rowClassName="provider-settings-sortable-row"
              />
              <span className="sr-only" aria-live="polite" aria-atomic="true">
                {orderAnnouncement}
              </span>
              {suggestions.length > 0 && (
                <>
                  <span
                    className="px-2.5 pb-1 pt-3 text-11 font-medium uppercase"
                    style={{ color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}
                  >
                    {t('settings.providers.detect.groupLabel')}
                  </span>
                  {suggestions.map((s) => (
                    <SuggestionRow
                      key={s.detection.cli}
                      detection={s.detection}
                      provider={s.provider}
                      onClick={() =>
                        setWizard({ entry: { kind: 'builtin', providerId: s.provider.id } })
                      }
                    />
                  ))}
                </>
              )}
            </div>
            <div
              className="border-t p-2"
              style={{ borderColor: 'var(--settings-theme-card-border)' }}
            >
              <button
                ref={addProviderButtonRef}
                type="button"
                onClick={() => setWizard({})}
                className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full border border-dashed text-13 font-medium transition-colors hover:bg-[var(--surface-hover)]"
                style={{
                  borderColor: 'var(--settings-btn-secondary-border)',
                  color: 'var(--settings-section-desc)',
                }}
              >
                <Plus size={15} />
                {t('settings.providers.addProvider')}
              </button>
            </div>
          </div>

          {/* 右栏详情:详情头/条带固定,仅模型列表(UnifiedModelList 内部)滚动 ——
              长清单滚动时供应商名称、连接状态与工具行不随之滚走(2026-07 定稿)。 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {cindySigninActive ? (
              /* 登录引导是 brand-scale surface(DESIGN §3):48px 标识 → 24px 名字 →
                 一行价值主张 → 赠送余额徽标 → 黑 CTA,间距走 8px 系统。底部留白比
                 顶部多,视觉重心才落在上三分之一。 */
              <div className="flex flex-1 flex-col items-center justify-center px-10 pb-14 pt-8 text-center">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl"
                  style={{
                    backgroundColor: 'var(--settings-integration-avatar-bg)',
                    border: '1px solid var(--settings-integration-avatar-border)',
                    color: 'var(--settings-integration-avatar-icon)',
                  }}
                >
                  <XDIncMark size={24} />
                </div>
                <span
                  className="mt-4 text-24 font-medium leading-[1.2]"
                  style={{ color: 'var(--settings-section-title)' }}
                >
                  {t('settings.providers.xd.title')}
                </span>
                <span
                  className="mt-3 max-w-[380px] text-14 leading-[1.5]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t('settings.providers.xdSignin.desc')}
                </span>
                {/* 赠送余额是一个安静的事实标签,不是促销文案:灰阶 chip、不写金额
                    (CN / Global 金额不同且服务端可调,数字只在计费页出现)。 */}
                <span
                  className="mt-4 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-12 font-medium"
                  style={{
                    backgroundColor: 'var(--surface-chip)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <Gift size={13} />
                  {t('settings.providers.xdSignin.grantBadge')}
                </span>
                <CtaPillButton
                  size="lg"
                  className="mt-6"
                  label={t('settings.providers.xdSignin.cta')}
                  onClick={() => void signInToCindy()}
                />
              </div>
            ) : effectiveSelected ? (
              <>
                {renderDetailHeader(effectiveSelected)}
                <>
                  {/* 供应商已停用:条带讲清「发生了什么 + 下一步」并就地给恢复入口。整个
                    模型区随之收起(2026-07-28 用户反馈:停用了就别再列模型)——停用是
                    盖在上面的一层,凭证与逐模型配置不丢,启用即原样回来。 */}
                  {effectiveSelected.suspended && (
                    <div
                      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-13"
                      style={{ borderColor: 'var(--settings-theme-card-border)' }}
                    >
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {t('settings.providers.detail.suspendedBanner')}
                      </span>
                      <PillButton
                        label={t('settings.providers.button.enableProvider')}
                        onClick={() =>
                          writeProviderDisabled(
                            effectiveSelected.id,
                            false,
                            t('settings.providers.models.accessWriteFailed'),
                          )
                        }
                      />
                    </div>
                  )}
                  {/* 发现失败与「有没有模型」是正交的:失败时刻意保留上次成功的清单(它是陈旧
                    但可溯源的真数据),于是老用户清单照常显示 —— 若把提示只放进空态分支,他
                    就完全看不到「这份清单已经不代表当前状态」,还以为供应商一切正常
                    (DESIGN.md「Errors = what happened + what to do」)。有清单时以条带形式
                    置于列表上方,无清单时走下面的空态居中版。 */}
                  {!effectiveSelected.suspended &&
                    effectiveSelected.modelDiscoveryFailure &&
                    providerHasModels(effectiveSelected) && (
                      <div
                        className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-13"
                        style={{ borderColor: 'var(--settings-theme-card-border)' }}
                      >
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {/* 有清单时必须换一套措辞:空态那套说的是「拿不到模型列表」,而列表就
                          显示在这条横幅下面 —— 照搬等于当着用户的面说一句他能一眼看穿的假话。
                          这里讲的是「没能刷新,你看到的是上次的结果」,每个归因各自的处置建议
                          照旧保留(DESIGN.md「Errors = what happened + what to do」)。 */}
                          {t(
                            `settings.providers.detail.discoveryFailedStale.${effectiveSelected.modelDiscoveryFailure.kind}`,
                          )}
                        </span>
                        <PillButton
                          label={t(
                            rediscovering
                              ? 'settings.providers.button.retrying'
                              : 'settings.providers.button.retry',
                          )}
                          onClick={() => void handleRediscoverModels(effectiveSelected)}
                          disabled={rediscovering}
                        />
                      </div>
                    )}
                  {!effectiveSelected.suspended &&
                    (providerHasModels(effectiveSelected) ||
                      (isBuiltinRefreshableProviderId(effectiveSelected.id) &&
                        !effectiveSelected.modelDiscoveryFailure) ||
                      effectiveSelected.id === MANAGED_OLLAMA_PROVIDER_ID) && (
                      <>
                        {(providerHasModels(effectiveSelected) ||
                          effectiveSelected.id !== MANAGED_OLLAMA_PROVIDER_ID) && (
                          <div
                            className="border-t"
                            style={{ borderColor: 'var(--settings-theme-card-border)' }}
                          />
                        )}
                        <UnifiedModelList
                          provider={effectiveSelected}
                          emptyMessage={
                            effectiveSelected.id === MANAGED_OLLAMA_PROVIDER_ID
                              ? t('settings.providers.local.emptyInstalled')
                              : t(
                                  effectiveSelected.connected
                                    ? 'settings.providers.detail.emptyModelsConnected'
                                    : 'settings.providers.detail.emptyModels',
                                )
                          }
                          compactWhenEmpty={effectiveSelected.id === MANAGED_OLLAMA_PROVIDER_ID}
                          compact={effectiveSelected.id === MANAGED_OLLAMA_PROVIDER_ID}
                          {...(isBuiltinRefreshableProviderId(effectiveSelected.id)
                            ? {
                                onRefresh: () => void handleRefreshBuiltinModels(effectiveSelected),
                                refreshing: refreshingProviderId === effectiveSelected.id,
                                refreshDisabled: refreshingProviderId !== null,
                                refreshIdleLabel: t('settings.providers.models.refreshBuiltinAria'),
                              }
                            : effectiveSelected.source === 'user' &&
                                effectiveSelected.auth.method !== 'oauth'
                              ? {
                                  onRefresh: () => void handleRefreshModels(effectiveSelected),
                                  refreshing: refreshingProviderId === effectiveSelected.id,
                                  refreshDisabled: refreshingProviderId !== null,
                                }
                              : {})}
                        />
                      </>
                    )}
                  {!effectiveSelected.suspended &&
                    !providerHasModels(effectiveSelected) &&
                    effectiveSelected.id !== MANAGED_OLLAMA_PROVIDER_ID &&
                    (Boolean(effectiveSelected.modelDiscoveryFailure) ||
                      !isBuiltinRefreshableProviderId(effectiveSelected.id)) && (
                      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-13">
                        {/* 已连接却无模型(如 Codex 刚登录、models_cache 未生成;或网关清单拉取失败)
                        不能沿用未连接的「授权后…」文案——那对已连接供应商自相矛盾。
                        动态发现明确失败时更进一步:讲清**发生了什么 + 下一步**并给出重试入口
                        (DESIGN.md「Errors = what happened + what to do」)——被地域拒绝或凭证
                        被拒的用户不会等来任何自动恢复,继续说「正在发现」就是假话。 */}
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          {effectiveSelected.modelDiscoveryFailure
                            ? t(
                                `settings.providers.detail.discoveryFailed.${effectiveSelected.modelDiscoveryFailure.kind}`,
                              )
                            : t(
                                effectiveSelected.connected
                                  ? 'settings.providers.detail.emptyModelsConnected'
                                  : 'settings.providers.detail.emptyModels',
                              )}
                        </span>
                        {effectiveSelected.modelDiscoveryFailure && (
                          <PillButton
                            label={t(
                              rediscovering
                                ? 'settings.providers.button.retrying'
                                : 'settings.providers.button.retry',
                            )}
                            onClick={() => void handleRediscoverModels(effectiveSelected)}
                            disabled={rediscovering}
                          />
                        )}
                      </div>
                    )}
                {effectiveSelected.id === MANAGED_OLLAMA_PROVIDER_ID && (
                  <OllamaProviderDetail onChanged={refetch} />
                )}
                </>
              </>
            ) : (
              <div
                className="flex flex-1 items-center justify-center px-8 text-center text-13"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('settings.providers.detail.emptyList')}
              </div>
            )}
          </div>
        </div>
      )}

      {wizard && (
        <AddProviderWizard
          providers={providers}
          entry={wizard.entry}
          onOpenCustomForm={() => {
            setWizard(null);
            setDialog({ mode: 'create' });
          }}
          onClose={() => setWizard(null)}
          onDone={(providerId) => {
            setWizard(null);
            if (providerId) setSelectedId(providerId);
            refetch();
          }}
        />
      )}

      {dialog && (
        <CustomProviderDialog
          initial={dialog.mode === 'edit' ? dialog.config : undefined}
          existingIds={providers.map((p) => p.id)}
          returnFocusRef={dialog.mode === 'create' ? addProviderButtonRef : undefined}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            refetch();
          }}
        />
      )}
    </div>
  );
}
