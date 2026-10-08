/**
 * DingTalkDwsPanel —— 钉钉「钉钉账号（dws CLI）」连接方式的设置面板。
 *
 * 按 dws 的实际状态逐步引导：未安装 → 给安装命令；未登录 → 提示 `dws auth login`；
 * 已登录 → 显示账号并可连接；已连接 → 显示主人绑定与断开。dws 的登录凭证
 * 由 dws 自己保管，本面板只展示账号显示名与组织名。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2Off, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { useDingTalkDws } from '@/hooks/useDingTalkDws';
import { cn } from '@/lib/utils';

const DWS_REPO_URL = 'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli';
// DWS_NO_SKILLS=1：只装 CLI 本体，不往本机其他 Agent 的目录写入 dws Skills。
const INSTALL_COMMAND_WINDOWS =
  '$env:DWS_NO_SKILLS="1"; irm https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.ps1 | iex';
const INSTALL_COMMAND_POSIX =
  'curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh | DWS_NO_SKILLS=1 sh';
const LOGIN_COMMAND = 'dws auth login';

type DwsController = ReturnType<typeof useDingTalkDws>;

export function DingTalkDwsPanel({ dws }: { dws: DwsController }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { state } = dws;
  const connected = state.enabled && state.status.kind === 'connected';

  const disconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.dingtalkBot.dws.disconnectConfirm.title'),
      description: t('settings.dingtalkBot.dws.disconnectConfirm.description'),
      confirmText: t('settings.dingtalkBot.dws.disconnectConfirm.confirm'),
      cancelText: t('settings.dingtalkBot.dws.disconnectConfirm.cancel'),
    });
    if (confirmed) await dws.disconnect();
  }, [confirm, dws, t]);

  const recheck = (
    <Button
      variant="secondary"
      size="lg"
      type="button"
      loading={dws.isProbing}
      disabled={dws.isProbing}
      onClick={() => void dws.probe()}
    >
      <RefreshCw size={13} />
      {t('settings.dingtalkBot.dws.recheck')}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-12 leading-[1.6] text-[var(--settings-section-desc)]">
        {t('settings.dingtalkBot.dws.intro')}
      </p>

      {!state.installed ? (
        <StepCard
          title={t('settings.dingtalkBot.dws.notInstalled.title')}
          description={t('settings.dingtalkBot.dws.notInstalled.description')}
        >
          <CommandLine
            command={
              window.electronAPI.platform === 'win32'
                ? INSTALL_COMMAND_WINDOWS
                : INSTALL_COMMAND_POSIX
            }
          />
          <div className="flex items-center gap-3">
            {recheck}
            <button
              type="button"
              onClick={() => window.electronAPI.openExternal?.(DWS_REPO_URL)}
              className="w-fit bg-transparent p-0 text-12 font-medium text-[var(--settings-source-link)] underline underline-offset-2"
            >
              {t('settings.dingtalkBot.dws.openRepo')}
            </button>
          </div>
        </StepCard>
      ) : !state.identity ? (
        <StepCard
          title={t('settings.dingtalkBot.dws.notLoggedIn.title')}
          description={t('settings.dingtalkBot.dws.notLoggedIn.description')}
        >
          <CommandLine command={LOGIN_COMMAND} />
          <div>{recheck}</div>
        </StepCard>
      ) : connected ? (
        <div
          className={cn(
            'flex flex-col gap-3 rounded-xl p-5',
            'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
          )}
        >
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--settings-badge-border)] bg-[var(--settings-badge-bg)] text-[var(--settings-badge-connected)]">
              <Check size={16} />
            </div>
            <div>
              <div className="text-13 font-medium text-[var(--settings-section-title)]">
                {t('settings.dingtalkBot.dws.connected.heading')}
              </div>
              <div className="mt-1 text-12 text-[var(--settings-section-desc)]">
                {state.ownerName
                  ? t('settings.dingtalkBot.dws.connected.ownerBound')
                  : t('settings.dingtalkBot.dws.connected.waitingOwner')}
              </div>
            </div>
          </div>
          {!state.ownerName && state.pairingCode && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3.5 py-2.5">
              <span className="text-12 text-[var(--settings-section-desc)]">
                {t('settings.dingtalkBot.dws.pairingCodeLabel')}
              </span>
              <span
                className="font-mono text-16 font-medium tracking-[0.2em] text-[var(--settings-section-title)]"
                style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
              >
                {state.pairingCode}
              </span>
            </div>
          )}
          <IdentityRows identity={state.identity} />
          <InfoRow
            label={t('settings.dingtalkBot.dws.ownerLabel')}
            value={state.ownerName || t('settings.dingtalkBot.connected.notBound')}
          />
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              type="button"
              className="flex-1"
              loading={dws.isDisconnecting}
              disabled={dws.isDisconnecting}
              onClick={() => void disconnect()}
            >
              <Link2Off size={13} />
              {t('settings.dingtalkBot.disconnect')}
            </Button>
            {state.ownerName && (
              <Button
                variant="secondary"
                size="lg"
                type="button"
                onClick={() => void dws.clearOwner()}
              >
                {t('settings.dingtalkBot.dws.clearOwner')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <StepCard
          title={t('settings.dingtalkBot.dws.ready.title')}
          description={t('settings.dingtalkBot.dws.ready.description')}
        >
          <IdentityRows identity={state.identity} />
          {state.status.kind === 'error' && (
            <span className="text-12 text-[var(--settings-error-text)]" role="alert">
              {t('settings.dingtalkBot.dws.errorHint')}
            </span>
          )}
          <Button
            variant="cta"
            size="lg"
            type="button"
            loading={dws.isConnecting || state.status.kind === 'connecting'}
            disabled={dws.isConnecting || state.status.kind === 'connecting'}
            onClick={() => void dws.connect()}
          >
            {t('settings.dingtalkBot.connect')}
          </Button>
        </StepCard>
      )}
    </div>
  );
}

function StepCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl p-5',
        'border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div>
        <div className="text-13 font-medium text-[var(--settings-section-title)]">{title}</div>
        <div className="mt-1 text-12 leading-[1.6] text-[var(--settings-section-desc)]">
          {description}
        </div>
      </div>
      {children}
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时用户仍可手动选中复制。
    }
  }, [command]);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-2">
      <code
        className="min-w-0 flex-1 break-all font-mono text-12 leading-[1.6] text-[var(--settings-input-text)]"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-transparent text-[var(--settings-section-desc)] hover:text-[var(--settings-section-title)]"
        aria-label={t('settings.dingtalkBot.dws.copyCommand')}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

function IdentityRows({ identity }: { identity: { corpName: string; userName: string } }) {
  const { t } = useTranslation();
  return (
    <>
      <InfoRow label={t('settings.dingtalkBot.dws.accountLabel')} value={identity.userName} />
      <InfoRow label={t('settings.dingtalkBot.dws.orgLabel')} value={identity.corpName} />
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-12 text-[var(--settings-section-desc)]">
      <span>{label}</span>
      <span className="max-w-[65%] truncate font-medium text-[var(--settings-section-title)]">
        {value}
      </span>
    </div>
  );
}
