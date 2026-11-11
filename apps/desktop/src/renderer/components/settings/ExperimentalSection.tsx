import { generalSettings } from './GeneralSettings.settings-search';
import { Button } from '@/components/ui/button';
/**
 * ExperimentalSection — Settings → General 的"实验功能"区块。
 *
 * 各项是同一张 SettingsCard 里的设置行,每行外层是不带内边距的 SettingsBlock,分割线只出现在可见行之间。
 *
 * LSP 这类实验能力有专用 IPC 行；普通实验功能由 EXPERIMENTAL_FEATURES 驱动。
 * 全员可见(2026-07 与 Lizi 定案):原 admin 门控随产品级 role 退役——实验
 * 开关都是本地 flag、默认关闭,对普通用户无破坏性。
 */

import { type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import {
  EXPERIMENTAL_FEATURES,
  useExperimentalFlag,
  type ExperimentalFeatureMeta,
} from '@/hooks/useExperimentalFeatures';
import { SettingsBlock, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { LspBetaCell } from './LspBetaCell';
import { BetaChannelCell } from './BetaChannelCell';
import { additionalSettings } from './AdditionalSettings.settings-search';

export function ExperimentalSection() {
  const { t } = useTranslation();
  const betaChannelSupported = additionalSettings.betaChannel.isVisible({
    platform: window.electronAPI?.platform ?? '',
    supportsBetaUpdateChannel: window.electronAPI?.supportsBetaUpdateChannel,
  });
  const rows: { key: string; node: ReactNode }[] = [
    { key: 'lsp', node: <LspBetaCell /> },
    ...(betaChannelSupported ? [{ key: 'beta-channel', node: <BetaChannelCell /> }] : []),
    ...EXPERIMENTAL_FEATURES.map((feature) => ({
      key: feature.key,
      node: <ExperimentalFeatureRow feature={feature} />,
    })),
  ];

  return (
    <SettingsSection title={t('settings.experimental.title')}>
      <SettingsCard>
        {rows.map((row) => (
          <SettingsBlock key={row.key} className="p-0">
            {row.node}
          </SettingsBlock>
        ))}
      </SettingsCard>
    </SettingsSection>
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
    <>
      <SettingsRow
        title={title}
        hint={description}
        trailing={
          <Switch data-setting-id={generalSettings.experimental.id}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t('settings.experimental.toggleAria', { title })}
          />
        }
      />

      {/* toggle on 后才显示入口按钮,和开关同属一行,不画分割线 */}
      {enabled && feature.openAction && (
        <div className="flex items-center justify-end px-4 pb-4">
          <Button data-settings-search-action="Open the enabled experimental feature"
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
    </>
  );
}
