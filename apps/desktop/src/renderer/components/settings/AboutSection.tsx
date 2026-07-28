/**
 * AboutSection — Settings → About tab content.
 *
 * 版本号:
 *   - 应用版本号:仅国内版显示,值由 window.electronAPI.appDisplayVersion 同步注入
 *   - Claude Code 版本号: spawn 当前应用使用的 binary `--version`
 *   - Codex 版本号: 同上
 *
 * 卡片样式与 NotificationSection / FeishuBotSection 同级 (rounded-xl / Board border)。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FolderOpen } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Switch } from '@/components/ui/switch';
import { useExperimentalFlag } from '@/hooks/useExperimentalFeatures';
import { useAutoUpdateSettings } from '@/hooks/useAutoUpdateSettings';
import { useAnalyticsSettings } from '@/hooks/useAnalyticsSettings';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { StorageManagementCard } from './StorageManagementCard';
import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion';
import { LEGAL_LINKS } from '../../../shared/legalLinks';

interface AgentVersionState {
  loading: boolean;
  version: string | null;
  error?: string;
}

const INITIAL: AgentVersionState = { loading: true, version: null };

const DESKTOP_SOCIAL_LINKS = [
  {
    id: 'discord',
    labelKey: 'settings.about.social.discordLabel',
    descriptionKey: 'settings.about.social.discordDescription',
    url: 'https://discord.gg/V4yKguac7K',
  },
  {
    id: 'x',
    labelKey: 'settings.about.social.xLabel',
    descriptionKey: 'settings.about.social.xDescription',
    url: 'https://x.com/making_cindy',
  },
  {
    id: 'xiaohongshu',
    labelKey: 'settings.about.social.xiaohongshuLabel',
    descriptionKey: 'settings.about.social.xiaohongshuDescription',
    url: 'https://xhslink.com/m/XmfveHjLlL',
  },
] as const;

function useAgentBinaryVersion(kind: 'claude-code' | 'codex'): AgentVersionState {
  const [state, setState] = useState<AgentVersionState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.agent
      .getBinaryVersion(kind)
      .then((res) => {
        if (cancelled) return;
        setState({ loading: false, version: res.version, error: res.error });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ loading: false, version: null, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  return state;
}

const SEMVER_RE = /\d+\.\d+\.\d+(?:[-+.\w]*)?/;

function extractSemver(raw: string): string {
  return SEMVER_RE.exec(raw)?.[0] ?? raw;
}

function renderVersion(state: AgentVersionState, t: (key: string) => string): string {
  if (state.loading) return t('settings.about.version.loading');
  if (state.version) return extractSemver(state.version);
  if (state.error === 'binary_not_ready') return t('settings.about.version.notReady');
  return t('settings.about.version.unknown');
}

export function AboutSection() {
  const { t } = useTranslation();
  const claudeCode = useAgentBinaryVersion('claude-code');
  const codex = useAgentBinaryVersion('codex');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.about.title')}
        </h2>
        <p className="text-13 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.about.description')}
        </p>
      </div>

      {/* Info Card */}
      <div
        className={cn(
          'flex flex-col rounded-xl',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        {CURRENT_CINDY_REGION === 'cn' && (
          <>
            <InfoRow
              label={t('settings.about.appVersionLabel')}
              value={window.electronAPI.appDisplayVersion}
              title={window.electronAPI.appDisplayVersionDetail}
            />
            <Divider />
          </>
        )}
        <AutoUpdateToggleRow />
        <Divider />
        <AnalyticsToggleRow />
        <Divider />
        <InfoRow
          label={t('settings.about.claudeCodeVersionLabel')}
          value={renderVersion(claudeCode, t)}
          dim={!claudeCode.version}
        />
        <Divider />
        <InfoRow
          label={t('settings.about.codexVersionLabel')}
          value={renderVersion(codex, t)}
          dim={!codex.version}
        />
        <Divider />
        <DebugLogToggleRow />
        <Divider />
        <OpenLogsRow />
        <Divider />
        <LegalLinksRows />
      </div>

      {/* 存储空间(媒体总仓占用 / 清理 / 体检) */}
      <h3 className="mt-2 text-13 font-medium text-[var(--settings-section-title)]">
        {t('settings.about.storage.title')}
      </h3>
      <StorageManagementCard />

      <SocialLinksPanel />
    </div>
  );
}

export function LegalLinksRows() {
  const { t } = useTranslation();

  return (
    <>
      <LegalLinkRow
        label={t('settings.about.legal.termsOfServiceLabel')}
        url={LEGAL_LINKS.termsOfService}
      />
      <Divider />
      <LegalLinkRow
        label={t('settings.about.legal.privacyPolicyLabel')}
        url={LEGAL_LINKS.privacyPolicy}
      />
    </>
  );
}

function LegalLinkRow({ label, url }: { label: string; url: string }) {
  const { t } = useTranslation();

  const handleOpen = async () => {
    try {
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) {
        toast.error(t('settings.about.legal.openFailed'));
      }
    } catch {
      toast.error(t('settings.about.legal.openFailed'));
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-[18px] py-4">
      <span className="select-none text-13 text-[var(--settings-section-sublabel)]">{label}</span>
      <button
        aria-label={t('settings.about.legal.viewDocument', { document: label })}
        className={cn(
          '-mr-1 flex select-none items-center gap-1.5 rounded-full px-6 py-2.5',
          'text-12 font-medium text-[var(--settings-section-title)]',
          'border border-[var(--settings-theme-card-border)]',
          'transition-colors hover:bg-[var(--surface-hover)] active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
        )}
        onClick={() => void handleOpen()}
        title={url}
        type="button"
      >
        {t('settings.about.legal.viewDocument', { document: label })}
        <ExternalLink aria-hidden size={13} strokeWidth={1.7} />
      </button>
    </div>
  );
}

function SocialLinksPanel() {
  const { t } = useTranslation();

  const handleSocialLinkClick = async (url: string) => {
    try {
      const result = await window.electronAPI.openExternal(url);
      if (!result.success) {
        toast.error(t('settings.about.social.openFailed'));
      }
    } catch {
      toast.error(t('settings.about.social.openFailed'));
    }
  };

  return (
    <div className="mt-5 flex flex-col gap-2.5">
      <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
        {t('settings.about.social.title')}
      </h3>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2.5">
        {DESKTOP_SOCIAL_LINKS.map((link) => (
          <button
            className={cn(
              'group flex min-h-[68px] min-w-0 select-none items-center gap-3 rounded-full px-6 py-2.5 text-left',
              'border border-[var(--settings-theme-card-border)]',
              'bg-[var(--settings-theme-card-bg)]',
              'transition-colors hover:bg-[var(--surface-hover)] active:scale-[0.98] active:bg-[var(--settings-social-card-pressed-bg)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
            )}
            key={link.id}
            onClick={() => void handleSocialLinkClick(link.url)}
            title={link.url}
            type="button"
          >
            <SocialPlatformIcon id={link.id} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-13 font-medium text-[var(--settings-section-title)]">
                {t(link.labelKey)}
              </span>
              <span className="truncate text-12 text-[var(--settings-section-sublabel)]">
                {t(link.descriptionKey)}
              </span>
            </span>
            <ExternalLink
              aria-hidden
              className="shrink-0 text-[var(--settings-section-sublabel)] opacity-65 transition-opacity duration-[var(--motion-fast,150ms)] group-hover:opacity-100"
              size={13}
              strokeWidth={1.7}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function SocialPlatformIcon({ id }: { id: (typeof DESKTOP_SOCIAL_LINKS)[number]['id'] }) {
  const iconClassName = 'h-[20px] w-[20px] shrink-0 text-[var(--settings-section-sublabel)]';

  if (id === 'discord') {
    return (
      <svg aria-hidden className={iconClassName} fill="currentColor" viewBox="0 0 24 24">
        <path d="M19.6361 4.42782C18.212 3.76079 16.6893 3.27603 15.0973 3C14.9018 3.35386 14.6734 3.82981 14.5159 4.20842C12.8236 3.95365 11.1469 3.95365 9.48573 4.20842C9.32828 3.82981 9.09468 3.35386 8.89741 3C7.30374 3.27603 5.77928 3.76257 4.35518 4.43135C1.48276 8.77666 0.70409 13.014 1.09342 17.1912C2.99856 18.6155 4.84487 19.4807 6.66003 20.0468C7.1082 19.4294 7.50791 18.773 7.85225 18.0812C7.19644 17.8317 6.56832 17.5239 5.97482 17.1665C6.13227 17.0497 6.28628 16.9276 6.43508 16.802C10.055 18.497 13.9882 18.497 17.5648 16.802C17.7154 16.9276 17.8694 17.0497 18.0251 17.1665C17.4299 17.5256 16.8 17.8335 16.1442 18.083C16.4886 18.773 16.8865 19.4311 17.3364 20.0486C19.1533 19.4824 21.0014 18.6173 22.9065 17.1912C23.3633 12.3488 22.1261 8.15033 19.6361 4.42782ZM8.34541 14.6223C7.25874 14.6223 6.36759 13.6067 6.36759 12.37C6.36759 11.1333 7.23972 10.116 8.34541 10.116C9.45114 10.116 10.3423 11.1315 10.3232 12.37C10.325 13.6067 9.45114 14.6223 8.34541 14.6223ZM15.6545 14.6223C14.5678 14.6223 13.6767 13.6067 13.6767 12.37C13.6767 11.1333 14.5488 10.116 15.6545 10.116C16.7602 10.116 17.6514 11.1315 17.6323 12.37C17.6323 13.6067 16.7602 14.6223 15.6545 14.6223Z" />
      </svg>
    );
  }

  if (id === 'xiaohongshu') {
    return (
      <svg aria-hidden className={iconClassName} fill="currentColor" viewBox="0 0 24 24">
        <path
          clipRule="evenodd"
          d="M18.1894 7.49403C18.7133 7.48949 19.2372 7.48946 19.7611 7.49392L19.7492 7.9958C19.9604 7.99675 20.1729 7.99939 20.3839 8.00189C21.2954 8.01266 22.0692 8.65369 22.1913 9.56744C22.2509 10.0111 22.2321 10.4537 22.2147 10.8991C23.3595 10.9176 24.0591 11.5844 23.9821 12.7594C23.9405 13.3955 24.065 14.3247 23.95 14.919C23.9092 15.1236 23.8186 15.315 23.6864 15.4765C23.4406 15.781 23.1173 15.9416 22.7282 15.9837C21.7545 16.0891 20.9431 15.7434 20.8444 14.649L22.3771 14.6506L22.3749 12.9554C22.3801 12.3815 21.6226 12.5229 21.2121 12.523L19.7548 12.5228C19.784 13.6396 19.7565 14.8614 19.7624 15.9896C19.2645 15.9728 18.694 15.985 18.1906 15.985L18.1927 12.5263L16.5985 12.5249C16.5702 12.0555 16.594 11.3836 16.6007 10.8979C17.0033 10.9284 17.7591 10.9075 18.1899 10.9148L18.192 9.63481C17.8569 9.621 17.5213 9.62233 17.1864 9.63887C17.1693 9.1158 17.1816 8.53295 17.1814 8.0054C17.5146 7.99882 17.8622 8.00399 18.1966 8.00467L18.1894 7.49403ZM19.7583 9.62207C20.0471 9.62272 20.2742 9.61742 20.5593 9.67016C20.6128 9.93698 20.6158 10.6197 20.5908 10.9092L19.7559 10.9099L19.7583 9.62207Z"
          fillRule="evenodd"
        />
        <path d="M12.3625 8.01013L16.0376 8.01239L16.0398 9.66914L15.0051 9.66557L15.0067 14.4409L16.5776 14.4387L16.5769 15.9907C16.1688 15.975 15.6998 15.9852 15.2871 15.9846L12.5545 15.9833C12.1898 15.9831 11.428 15.9627 11.0908 16.0019C11.3545 15.4795 11.6047 14.9534 11.874 14.4325C12.375 14.446 12.9165 14.4369 13.4206 14.4379L13.422 9.66612L12.3635 9.67071C12.3496 9.13465 12.3619 8.5499 12.3625 8.01013Z" />
        <path d="M3.10738 7.49112C3.64361 7.48797 4.17987 7.48979 4.71607 7.49664C4.69129 9.18045 4.71362 10.9197 4.714 12.6081L4.71422 13.9959C4.71427 14.7912 4.77784 15.8682 3.71047 15.9847C2.68215 16.0101 2.14377 15.8236 2.04102 14.6805C2.39332 14.6732 2.74571 14.6715 3.09808 14.6754C3.10102 12.3028 3.06549 9.85575 3.10738 7.49112Z" />
        <path d="M9.77661 7.4856L11.3216 7.49696C10.9484 8.14626 10.6076 8.84533 10.2581 9.50814C10.1946 9.6285 10.1815 9.86682 10.349 9.9179C10.4165 9.87865 10.4758 9.76504 10.5203 9.69399C10.8849 9.64996 11.6761 9.67387 12.0728 9.6755C11.9051 10.0744 10.6608 12.306 10.7505 12.4937C10.9298 12.5724 11.5573 12.5481 11.7795 12.5473C11.6438 12.7747 11.5178 13.0131 11.3913 13.2462L11.0527 13.8496C8.5795 13.8222 8.26684 14.1877 9.62875 11.5422C9.69199 11.4193 9.75809 11.2902 9.82361 11.1677C8.93102 11.1783 7.84899 11.4147 8.46736 10.1164C8.5891 9.86075 8.71699 9.60519 8.84257 9.35159C9.15073 8.72799 9.46208 8.10598 9.77661 7.4856Z" />
        <path d="M5.80664 9.6782C6.35231 9.67213 6.89803 9.67205 7.4437 9.67793C7.41057 11.1935 7.44495 12.0326 7.82843 13.4954C7.74321 13.7142 7.36466 14.3735 7.23486 14.6121L6.93513 15.1565C5.86185 14.2884 5.81194 10.996 5.80664 9.6782Z" />
        <path d="M0.394686 9.67566L2.02073 9.67585C1.99173 11.1948 1.95474 13.387 1.26402 14.7592C1.14592 14.9245 1.04349 15.0266 0.902274 15.1729C0.609367 14.6179 0.295409 14.0698 0 13.5141C0.378774 11.9432 0.41873 11.2816 0.394686 9.67566Z" />
        <path d="M8.60402 14.2864C8.89157 14.4466 9.36451 14.4027 9.69622 14.4015L11.0633 14.3967C10.7832 14.9277 10.4988 15.4565 10.2103 15.9829L10.1933 15.9947C10.0744 16.011 9.6891 16.0034 9.55588 15.9946C9.03817 15.9603 8.2661 16.0811 7.80176 15.8737C8.04459 15.37 8.39298 14.7815 8.60402 14.2864Z" />
        <path d="M23.0022 8.01733C23.2013 7.99764 23.3161 8.00088 23.4964 8.08816C23.6958 8.18325 23.8489 8.3537 23.9224 8.56188C23.9882 8.7501 23.9757 8.957 23.8876 9.13589C23.7766 9.3589 23.5963 9.47778 23.3681 9.555C23.1524 9.60325 22.6424 9.58873 22.3984 9.58702C22.3922 8.86412 22.2445 8.36961 23.0022 8.01733Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden className={iconClassName} fill="currentColor" viewBox="0 0 24 24">
      <path d="M5.03544 20.6025L10.3112 13.1079L4 3H9.00462L12.9738 9.36055L17.4361 3H19.0385L13.7134 10.5686L20 20.6025H14.9954L11.0755 14.3405L6.6379 20.6025H5.03544ZM15.7103 19.2958H17.6579L8.28968 4.30663H6.34206L15.7103 19.2958Z" />
    </svg>
  );
}

function AutoUpdateToggleRow() {
  const { t } = useTranslation();
  const { state, setAutoRelaunchOnIdle, reset } = useAutoUpdateSettings();
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setAutoRelaunchOnIdle(next);
      toast.success(
        next
          ? t('settings.about.autoUpdateEnabledToast')
          : t('settings.about.autoUpdateDisabledToast'),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.autoUpdateSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await reset();
      toast.success(t('settings.defaults.restored'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.defaults.restoreFailed'));
    } finally {
      setSaving(false);
    }
  };

  const disabled = state.loading || saving;

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.autoUpdateLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.autoUpdateDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DefaultOverrideControls
            isCustomized={state.isCustomized}
            disabled={disabled}
            onReset={handleReset}
          />
          <Switch
            checked={state.autoRelaunchOnIdle}
            disabled={disabled}
            onCheckedChange={handleToggle}
            aria-label={t('settings.about.autoUpdateLabel')}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 使用统计(TapDB)开关。
 *
 * 语义是 opt-out:用户在登录页同意《隐私政策》后默认开启,这里可以随时关掉。
 * 关掉即时生效(main 广播 → tapdbClient 走 SDK optOutTracking,连 autoTrack 的
 * 自动事件也会停),不需要重启。
 *
 * 「恢复默认」只删掉开关这条 override,让它重新跟随版本默认值;同意状态是事实记录、
 * 不是配置项,不会被它清掉(configuration-and-overrides §4)。没有这个入口的话,
 * 用户把开关拨回当前默认值写入的是一个显式 true,此后再也跟不上默认值的变化。
 */
function AnalyticsToggleRow() {
  const { t } = useTranslation();
  const { state, setAnalyticsEnabled, resetAnalyticsEnabled } = useAnalyticsSettings();
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    setSaving(true);
    try {
      await setAnalyticsEnabled(next);
      toast.success(
        next
          ? t('settings.about.analyticsEnabledToast')
          : t('settings.about.analyticsDisabledToast'),
      );
    } catch {
      // 不透传 err.message:main 侧的 IPC 错误串是英文技术串(`[INTERNAL] ...`),
      // 直接 toast 出去会让非中文用户看到不可读的内部信息。错误码只用于分支,
      // 展示一律走本地化文案。
      toast.error(t('settings.about.analyticsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await resetAnalyticsEnabled();
      toast.success(t('settings.defaults.restored'));
    } catch {
      toast.error(t('settings.defaults.restoreFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-13 text-[var(--settings-section-sublabel)]">
            {t('settings.about.analyticsLabel')}
          </span>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {t('settings.about.analyticsDescription')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DefaultOverrideControls
            isCustomized={state.analyticsEnabledCustomized}
            disabled={state.loading || saving}
            onReset={handleReset}
          />
          <Switch
            checked={state.analyticsEnabled}
            disabled={state.loading || saving}
            onCheckedChange={handleToggle}
            aria-label={t('settings.about.analyticsLabel')}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Debug 日志开关。
 *
 * 之前挂在 admin-only 的 ExperimentalSection 下，普通用户看不见也用不上;
 * 排查问题时只能让对方手改 localStorage。搬到 About (所有人可见) 后:
 *   - localStorage key 仍是 'experimental.debug-network',已开启的用户无感迁移
 *   - dev 模式下 main 侧硬开 (bootstrap-electron.ts), UI 同步锁死 on+disabled,
 *     避免开发者点了 toggle 看似关掉但日志还在写的诡异体验
 *   - main-side 副作用 (process.env.XDT_CC_DEBUG_NET) 通过 ccSetDebugNet IPC
 *     在 mount 时同步一次,toggle 变化时立即同步
 */
function DebugLogToggleRow() {
  const { t } = useTranslation();
  const { enabled, setEnabled } = useExperimentalFlag('debug-network');
  const lockedOn = import.meta.env.DEV;
  const effectiveEnabled = lockedOn ? true : enabled;

  useEffect(() => {
    void window.electronAPI?.ccSetDebugNet?.(effectiveEnabled);
  }, [effectiveEnabled]);

  return (
    <div className="flex flex-col gap-1.5 px-[18px] py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-13 text-[var(--settings-section-sublabel)]">
          {t('settings.about.debugLogLabel')}
        </span>
        <Switch
          checked={effectiveEnabled}
          disabled={lockedOn}
          onCheckedChange={setEnabled}
          aria-label={t('settings.about.debugLogLabel')}
        />
      </div>
      <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70 pr-12">
        {t('settings.about.debugLogDescription')}
      </p>
    </div>
  );
}

function OpenLogsRow() {
  const { t } = useTranslation();
  const handleOpen = async () => {
    try {
      const res = await window.electronAPI.openLogsDir();
      if (!res.success) toast.error(res.error || t('settings.about.openLogsDirError'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.about.openLogsDirError'));
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-[18px] py-4">
      <span className="text-13 text-[var(--settings-section-sublabel)]">
        {t('settings.about.logsDirLabel')}
      </span>
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2.5 py-1 -mr-1',
          'text-12 font-medium text-[var(--settings-section-title)]',
          'border border-[var(--settings-theme-card-border)]',
          'hover:bg-[var(--settings-theme-card-border)]/40',
          'transition-colors',
        )}
        title={t('settings.about.openLogsDirTooltip')}
      >
        <FolderOpen size={13} />
        {t('settings.about.openLogsDir')}
      </button>
    </div>
  );
}

function InfoRow({
  label,
  value,
  title = value,
  dim = false,
}: {
  label: string;
  value: string;
  title?: string;
  dim?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-[18px] py-4" title={title}>
      <span className="text-13 text-[var(--settings-section-sublabel)]">{label}</span>
      <span
        className={cn(
          'truncate text-13 font-medium',
          dim
            ? 'text-[var(--settings-section-sublabel)] opacity-70'
            : 'text-[var(--settings-section-title)]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden
      className="h-px w-full"
      style={{ background: 'var(--settings-theme-card-border)' }}
    />
  );
}
