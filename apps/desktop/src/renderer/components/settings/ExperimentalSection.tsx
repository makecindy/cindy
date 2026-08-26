/**
 * ExperimentalSection — Settings → General 的"实验功能"区块。
 *
 * 风格对齐 NotificationSection：rounded-xl card、相同的 settings CSS variables。
 *
 * LSP 这类实验能力有专用 IPC 行；普通实验功能由 EXPERIMENTAL_FEATURES 驱动。
 * 全员可见(2026-07 与 Lizi 定案):原 admin 门控随产品级 role 退役——实验
 * 开关都是本地 flag、默认关闭,对普通用户无破坏性。
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  EXPERIMENTAL_FEATURES,
  useExperimentalFlag,
  type ExperimentalFeatureMeta,
} from '@/hooks/useExperimentalFeatures';
import { LspBetaCell } from './LspBetaCell';
import { BetaChannelCell } from './BetaChannelCell';

export function ExperimentalSection() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.experimental.title')}
      </h2>

      <div className="flex flex-col gap-3">
        <LspBetaCell />
        {window.electronAPI?.platform !== 'linux' ? <BetaChannelCell /> : null}
        {EXPERIMENTAL_FEATURES.map((feature) => (
          <ExperimentalFeatureRow key={feature.key} feature={feature} />
        ))}
      </div>
    </div>
  );
}

function ExperimentalFeatureRow({ feature }: { feature: ExperimentalFeatureMeta }) {
  const { enabled, setEnabled } = useExperimentalFlag(feature.key);
  const navigate = useNavigate();
  const { t } = useTranslation();
  // i18n 优先按 feature.key 查表; 表里没有时 fallback 到 registry 里的英文原值,
  // 这样新加 feature 时哪怕忘了在 i18n 加 key 也不会显示空白或 'settings.xxx.xxx'。
  const title = t(`settings.experimental.features.${feature.key}.title`, {
    defaultValue: feature.title,
  });
  const description = t(`settings.experimental.features.${feature.key}.description`, {
    defaultValue: feature.description,
  });

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className="text-13 font-medium text-[var(--settings-section-sublabel)]"
            style={{ letterSpacing: '0.12px' }}
          >
            {title}
          </p>
          <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
            {description}
          </p>
        </div>

        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('settings.experimental.toggleAria', { title })}
        />
      </div>

      {/* toggle on 后才显示入口按钮 */}
      {enabled && feature.openAction && (
        <div className="flex items-center justify-end pt-1">
          <button
            type="button"
            onClick={() => navigate(feature.openAction!.routePath)}
            className={cn(
              'rounded-md px-3 py-1.5 text-12 font-medium',
              'bg-[var(--settings-menu-bg-selected)] text-[var(--settings-menu-text-selected)]',
              'border border-[var(--settings-menu-border-selected)]',
              'transition-colors hover:opacity-80',
            )}
          >
            {feature.openAction.label}
          </button>
        </div>
      )}
    </div>
  );
}
