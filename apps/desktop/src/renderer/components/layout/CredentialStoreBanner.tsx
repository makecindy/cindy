/**
 * CredentialStoreBanner —— 持久凭证库(safeStorage)故障全局警示条(#1687)。
 *
 * main 侧 authManager 在连续多个刷新周期读不出 refresh token(文件仍在但钥匙串
 * 拒绝 / 加密不可用)后,把 AuthState.credentialStoreUnavailable 置 true 广播;
 * 本组件挂在 MainLayout 主内容区顶部(ContentHeader 之下、路由内容之上),
 * 显示一条 warning 色横幅 + 「查看解决方法」dialog,给用户可操作的恢复路径——
 * 此前这种半死状态(界面看似已登录、所有鉴权请求持续 401)没有任何提示。
 *
 * 行为约定:
 *  - 状态由 main 驱动,凭证库恢复(成功读写一次)后 flag 回 false,横幅自动消失;
 *  - ✕ 关闭是**进程内**记忆(模块级,与 ControlledBanner 的模块级缓存同模式):
 *    路由切换 / remount 不复活,重启后若仍故障会重新出现;flag 回 false 时清除
 *    dismiss 记忆,下次再故障必须重新提示;
 *  - 解决步骤按平台分支:macOS 给钥匙串检查指引,其它平台给通用重启/重登指引。
 *
 * 颜色走既有语义豁免 token(--warning-fg / --warning-bg-soft,双模式同值/自适配),
 * 不引入新 token,无需 DESIGN.md §10 豁免表登记。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert, X } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tip } from '@/components/ui/tooltip';

// 进程内 dismiss 记忆:MainLayout 在路由切换间会重挂本组件,用组件态存 dismiss
// 会导致每次导航横幅复活。模块级变量的生命周期 = 渲染进程,语义正好。
let dismissedInProcess = false;

/** 测试钩子:重置模块级 dismiss 记忆(仅测试使用)。 */
export function __resetCredentialStoreBannerDismissForTest(): void {
  dismissedInProcess = false;
}

export function CredentialStoreBanner() {
  const { t } = useTranslation();
  const { credentialStoreUnavailable } = useAuth();
  const [helpOpen, setHelpOpen] = useState(false);
  // dismiss 后触发一次重渲染让横幅立即消失;真值存模块级变量。
  const [, setDismissTick] = useState(0);

  const isMac = window.electronAPI?.platform === 'darwin';

  // 凭证库恢复后清 dismiss 记忆:下次再故障必须重新出现,不能被上次的 ✕ 吞掉。
  useEffect(() => {
    if (!credentialStoreUnavailable) dismissedInProcess = false;
  }, [credentialStoreUnavailable]);

  if (!credentialStoreUnavailable || dismissedInProcess) return null;

  const handleDismiss = () => {
    dismissedInProcess = true;
    setDismissTick((n) => n + 1);
  };

  // 恢复步骤:macOS 多一条钥匙串检查;两个平台都以「重启 → 仍不行再重登」收尾,
  // 与 main 侧「首次失败不 clearAuth」的取向一致——不引导用户上来就丢登录态。
  const steps = [
    ...(isMac ? [t('credentialStore.dialog.stepMacKeychain')] : []),
    t('credentialStore.dialog.stepRestart'),
    t('credentialStore.dialog.stepRelogin'),
  ];

  return (
    <>
      <div
        role="alert"
        className="flex shrink-0 select-none items-center gap-2 border-b border-[var(--border-default)] bg-[var(--warning-bg-soft)] px-4 py-2"
      >
        <TriangleAlert
          className="h-4 w-4 shrink-0 text-[var(--warning-fg)]"
          strokeWidth={2}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-primary)]">
          {t('credentialStore.banner.message')}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full text-xs underline underline-offset-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {t('credentialStore.banner.viewHelp')}
        </button>
        <Tip text={t('credentialStore.banner.dismiss')}>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={t('credentialStore.banner.dismiss')}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </Tip>
      </div>
      <ConfirmDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title={t('credentialStore.dialog.title')}
        description={t('credentialStore.dialog.intro')}
        content={
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-[var(--text-secondary-mid)]">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        }
        confirmText={t('credentialStore.dialog.confirm')}
        showCancel={false}
        onConfirm={() => setHelpOpen(false)}
      />
    </>
  );
}
