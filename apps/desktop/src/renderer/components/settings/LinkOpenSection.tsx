import { personalizationDetailsSettings } from './PersonalizationDetails.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
/**
 * LinkOpenSection — Settings → 个性化 下的「链接打开方式」偏好。
 *
 * 控制消息流里左键点击时的默认打开位置,拆成两个互不影响的开关:
 *   - 外部网页:互联网链接。默认系统默认浏览器。
 *   - 内部网页:本地硬盘 HTML 与本机地址(localhost)。默认内置侧边栏浏览器。
 * 右键菜单里始终两种都可临时选,本设置只决定左键直开走哪个。
 *
 * 存储走 useLinkOpenPreference(localStorage 只存 override,选回默认即清除,
 * 规则 20);每个开关各自「恢复默认」,复用 DefaultOverrideControls。
 *
 * 版式用 settings-rows 的分区/卡片/行:一张卡、两行、控件贴右,
 * 避免两张独立卡把分段控件单独占一整行。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SegmentedControl } from '@/components/ui/segmented-control';

import { toast } from '@/lib/toast';
import {
  LINK_OPEN_DEFAULTS,
  useLinkOpenPreference,
  type LinkOpenKind,
} from '@/hooks/useLinkOpenPreference';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { DefaultOverrideControls } from './DefaultOverrideControls';

function LinkOpenPreferenceRow({ kind }: { kind: LinkOpenKind }) {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference } = useLinkOpenPreference(kind);
  const setting = useSettingDefinition(
    kind === 'web'
      ? personalizationDetailsSettings.linkOpenWebLabel
      : personalizationDetailsSettings.linkOpenLocalLabel,
  );

  const onReset = useCallback(() => {
    setPreference(LINK_OPEN_DEFAULTS[kind]);
    toast.success(t('settings.defaults.restored'));
  }, [kind, setPreference, t]);

  return (
    <SettingsRow
      {...setting.anchorProps}
      className="cindy-segmented-row"
      title={setting.title}
      hint={setting.description}
      trailing={
        <div className="cindy-segmented-row-actions">
          <DefaultOverrideControls isCustomized={isCustomized} onReset={onReset} />
          <SegmentedControl
            {...setting.controlProps}
            aria-label={t(`settings.linkOpen.${kind}.ariaLabel`)}
            value={preference}
            onValueChange={setPreference}
            options={setting.options}
          />
        </div>
      }
    />
  );
}

export function LinkOpenSection() {
  const { t } = useTranslation();

  return (
    <SettingsSection title={t('settings.linkOpen.title')} description={t('settings.linkOpen.description')}>
      <SettingsCard>
        <LinkOpenPreferenceRow kind="web" />
        <LinkOpenPreferenceRow kind="local" />
      </SettingsCard>
    </SettingsSection>
  );
}
