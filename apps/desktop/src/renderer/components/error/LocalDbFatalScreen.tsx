import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { resolveLocalDbFatalView } from './localDbFatalView';

/**
 * LocalDbFatalScreen — 本地数据库启动失败（LocalDbGate fatal）的全屏恢复界面。
 *
 * 取代旧行为「main 弹原生阻塞对话框 + renderer 渲染 null 黑屏」：典型场景是
 * MIGRATE_FAILED（旧版本打开被更新代码升级过的共享库），此时更新补丁通常已
 * 下载暂存，本界面按更新状态给出恢复路径（见 localDbFatalView.ts 的三态映射）。
 *
 * 形态沿用 SplashScreen 的不可逃逸错误模式：不透明 --surface 全屏底（盖住
 * 半残 UI，可拖拽移动窗口）+ 常开的 ConfirmDialog（无取消、ESC/外点不可关）。
 */
export function LocalDbFatalScreen({
  code,
  message,
  onBackToLogin,
}: {
  code?: string;
  message?: string;
  onBackToLogin?: () => void;
}) {
  const { t } = useTranslation();
  const { status, progress } = useUpdateStatus();
  // 点了「重启并安装更新」后应用即将退出重启，期间锁住按钮防止重复触发。
  const [installing, setInstalling] = useState(false);

  const view = resolveLocalDbFatalView(status);

  const handleConfirm = () => {
    if (view === 'install-update') {
      if (installing) return;
      setInstalling(true);
      const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      window.electronAPI.relaunchToUpdate(theme);
      return;
    }
    if (view === 'no-update') {
      // 检查会把 update-status 推成 checking/downloading → 视图自动切到 preparing。
      void window.electronAPI.checkForUpdate().catch(() => {});
    }
  };

  const title =
    view === 'no-update' ? t('localDbFatal.noUpdate.title') : t('localDbFatal.updateReady.title');
  const description =
    view === 'install-update'
      ? t('localDbFatal.updateReady.description')
      : view === 'preparing-update'
        ? t('localDbFatal.preparing.description')
        : t('localDbFatal.noUpdate.description');
  const confirmText =
    view === 'install-update'
      ? t('localDbFatal.updateReady.confirm')
      : t('localDbFatal.noUpdate.checkUpdate');

  return (
    <div
      className="fixed inset-0 z-[9999]"
      style={{ background: 'var(--surface)', WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title={title}
        description={description}
        showCancel={onBackToLogin !== undefined}
        cancelText={t('localDbGate.backToLogin')}
        onCancel={onBackToLogin}
        autoFocusConfirm
        loading={(installing && view === 'install-update') || view === 'preparing-update'}
        confirmText={confirmText}
        onConfirm={handleConfirm}
        content={
          <>
            {view === 'preparing-update' && typeof progress === 'number' && (
              <p className="text-13 text-[var(--confirm-desc)]">
                {t('localDbFatal.preparing.progress', { progress: Math.round(progress) })}
              </p>
            )}
            {(message || code) && (
              <details className="mt-1 w-full">
                <summary className="cursor-pointer text-12 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]">
                  {t('localDbFatal.details')}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--surface-chip)] p-3 font-mono text-11 leading-relaxed whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                  {[code, message].filter(Boolean).join('\n')}
                </pre>
              </details>
            )}
          </>
        }
      />
    </div>
  );
}
