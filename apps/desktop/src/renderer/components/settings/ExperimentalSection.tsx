import { Button } from '@/components/ui/button';
/**
 * ExperimentalSection — Settings → General 的"实验功能"区块。
 *
 * 各项是同一张卡片里的设置行(settingsRowClasses),行间分割线只出现在可见行之间。
 *
 * LSP 这类实验能力有专用 IPC 行；普通实验功能由 EXPERIMENTAL_FEATURES 驱动。
 * 全员可见(2026-07 与 Lizi 定案):原 admin 门控随产品级 role 退役——实验
 * 开关都是本地 flag、默认关闭,对普通用户无破坏性。
 */

import { Fragment, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import {
  EXPERIMENTAL_FEATURES,
  useExperimentalFlag,
  type ExperimentalFeatureMeta,
} from '@/hooks/useExperimentalFeatures';
import { LspBetaCell } from './LspBetaCell';
import { SETTINGS_CARD_CLASS, SETTINGS_ROW_DIVIDER_CLASS } from './settingsRowClasses';
import { BetaChannelCell } from './BetaChannelCell';

export function ExperimentalSection() {
  const { t } = useTranslation();
  const betaChannelSupported =
    window.electronAPI?.supportsBetaUpdateChannel ?? window.electronAPI?.platform !== 'linux';
  const rows: { key: string; node: ReactNode }[] = [
    { key: 'lsp', node: <LspBetaCell /> },
    ...(betaChannelSupported ? [{ key: 'beta-channel', node: <BetaChannelCell /> }] : []),
    ...EXPERIMENTAL_FEATURES.map((feature) => ({
      key: feature.key,
      node: <ExperimentalFeatureRow feature={feature} />,
    })),
  ];

  return (
    <div className="flex flex-col gap-[14px]">
      <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
        {t('settings.experimental.title')}
      </h2>

      <div className={SETTINGS_CARD_CLASS}>
        {rows.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? <div className={SETTINGS_ROW_DIVIDER_CLASS} /> : null}
            {row.node}
          </Fragment>
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
    <div className="flex flex-col gap-3 px-4 py-4">
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
          <Button
            variant="cta"
            size="md"
            compact
            type="button"
            onClick={() => navigate(feature.openAction!.routePath)}
          >
            {feature.openAction.label}
          </Button>
        </div>
      )}
    </div>
  );
}
