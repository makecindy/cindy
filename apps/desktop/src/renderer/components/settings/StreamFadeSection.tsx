import { appearanceSettings } from './AppearanceSection.settings-search';
/**
 * StreamFadeSection — Settings → 外观 下的「回复动效」开关。
 *
 * 控制流式输出时正文的淡入浮现动效(词段 / inline code 原子 + 列表圆点同帧
 * 浮现,见 rehypeStreamWordFade):开(默认)= 新内容淡入;关 = 文字直接显示。
 * 系统 reduced-motion 开启时动效无条件关闭,本开关不覆盖该行为。
 *
 * 存储走 useStreamFadePreference(localStorage 只存 override,切回默认即
 * 清除,规则 20)。切换即时生效,正在流式的消息也立刻应用。
 * 版式用 settings-rows 的分区/卡片/行(外观页的子分区,组名 h3)。
 */

import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useStreamFadePreference } from '@/hooks/useStreamFadePreference';

export function StreamFadeSection() {
  const { t } = useTranslation();
  const { preference, setPreference } = useStreamFadePreference();
  const enabled = preference === 'on';

  return (
    <SettingsSection title={t('settings.streamFade.title')} headingLevel={3}>
      <SettingsCard>
        <SettingsRow
          title={t(appearanceSettings.streamFadeLabel.titleKey)}
          hint={t(appearanceSettings.streamFadeLabel.descriptionKey)}
          trailing={
            <Switch data-setting-id={appearanceSettings.streamFadeLabel.id}
              checked={enabled}
              onCheckedChange={(next) => setPreference(next ? 'on' : 'off')}
              aria-label={t('settings.streamFade.toggleAria')}
            />
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
