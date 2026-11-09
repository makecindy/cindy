import { useEffect, useState } from 'react';
import { Cpu, Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';

/** 关闭只在本次运行内隐藏；转译运行是需要用户换装才能解决的状态，下次启动仍提醒。 */
let dismissedThisRun = false;

/** 官网下载页的「全部版本」区：浏览器本身是 Intel 版时，页首推荐可能仍是 Intel 包。 */
export function resolveNativeBuildDownloadUrl(websiteUrl: string): string | null {
  try {
    const url = new URL('/download', websiteUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = 'all-versions';
    return url.toString();
  } catch {
    return null;
  }
}

interface NativeBuildBannerProps {
  isCollapsed: boolean;
}

/** Apple 芯片 Mac 上运行 Intel 包时提示换装原生版本。 */
export function NativeBuildBanner({ isCollapsed }: NativeBuildBannerProps) {
  const { t } = useTranslation();
  const { status: updateStatus } = useUpdateStatus();
  const { dismissed: updateDismissed } = useUpdateBannerDismiss();
  const [translated, setTranslated] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedThisRun);

  useEffect(() => {
    if (window.electronAPI?.platform !== 'darwin') return undefined;
    let cancelled = false;
    window.electronAPI.getArm64Translation?.()
      .then((value) => {
        if (!cancelled) setTranslated(value === true);
      })
      .catch(() => {
        // 判定失败时不打扰用户。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const downloadUrl = resolveNativeBuildDownloadUrl(
    window.electronAPI?.clientEndpoints?.websiteUrl ?? '',
  );
  const updateHasPriority =
    (updateStatus === 'ready' || updateStatus === 'superseding') && !updateDismissed;
  if (isCollapsed || !translated || dismissed || updateHasPriority || !downloadUrl) return null;

  const handleDismiss = () => {
    dismissedThisRun = true;
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        'relative mx-2 mb-2 flex flex-col gap-2 rounded-xl p-3',
        'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        'text-[var(--text-primary)]',
      )}
      role="status"
    >
      {/* 与 UpdateBanner 同款右上角关闭；只留一个主按钮，任何语言都不会把按钮挤出卡片。 */}
      <Tip text={t('sidebar.nativeBuild.dismiss')} side="left">
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t('sidebar.nativeBuild.dismiss')}
          className={cn(
            'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full',
            'text-sidebar-muted transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </Tip>
      <div className="flex items-start gap-2 pr-5">
        <span
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-[var(--warning-bg-soft)]"
          aria-hidden
        >
          <Cpu className="h-3.5 w-3.5 text-[var(--warning-fg)]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-12 font-medium leading-[1.35]">
            {t('sidebar.nativeBuild.title')}
          </p>
          <p className="mt-0.5 text-12 leading-[1.35] text-[var(--text-secondary)]">
            {t('sidebar.nativeBuild.description')}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end">
        <Button
          variant="cta"
          size="md"
          onClick={() => window.open(downloadUrl, '_blank')}
        >
          <Download className="h-3 w-3" aria-hidden />
          {t('sidebar.nativeBuild.download')}
        </Button>
      </div>
    </div>
  );
}
