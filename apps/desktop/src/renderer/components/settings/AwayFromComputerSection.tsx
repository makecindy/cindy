/**
 * AwayFromComputerSection —— 设置 → 通用 →「离开电脑时」(docs/product-rules/privacy-screen.md)。
 *
 * 本机决定“怎么保护”:
 *  - 保持电脑唤醒(keepAwake,全平台):电脑不休眠,屏幕照常熄屏锁屏。
 *  - 用隐私屏代替锁屏(awayGuard,支持的平台):AI 需要屏幕时不熄屏不锁屏,隐私屏遮住,
 *    有人碰就锁屏;远程结束后也用它保护。开着时「保持电脑唤醒」显示为已包含。
 *  - 离开多久后打开隐私屏:上一项开着才出现;Cindy 自己的选项加「跟随系统」。
 * 遥控端只决定这一次连接什么时候保护,不在这里设置。
 */

import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SETTINGS_HINT, SettingsCard, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { useAwayGuardSetting } from '@/hooks/useAwayGuardSetting';
import { useKeepAwakeSetting } from '@/hooks/useKeepAwakeSetting';
import { isAwayGuardDelaySeconds } from '../../../shared/awayGuard';
import { awayFromComputerSettings } from './AwayFromComputerSection.settings-search';
import { BehaviorRow } from './BehaviorRow';

export function AwayFromComputerSection() {
  const { t } = useTranslation();
  const { keepAwake, setKeepAwake } = useKeepAwakeSetting();
  const awayGuard = useAwayGuardSetting();
  const privacyOn = awayGuard.available && awayGuard.state?.enabled === true;
  const platform = window.electronAPI?.platform;
  // Hyprland draws its cover in the compositor; there is no preview there yet.
  const canPreview = platform !== 'linux';

  const rows: { key: string; node: ReactNode }[] = [
    {
      key: 'keep-awake',
      node: (
        <BehaviorRow
          id={awayFromComputerSettings.devicesKeepAwake.targetId}
          data-setting-id={awayFromComputerSettings.devicesKeepAwake.id}
          label={t(awayFromComputerSettings.devicesKeepAwake.titleKey)}
          hint={t(
            privacyOn
              ? 'settings.devices.keepAwakeIncluded'
              : awayFromComputerSettings.devicesKeepAwake.descriptionKey,
          )}
          // The privacy screen keeps the computer awake; the user's own choice returns
          // when it is turned off.
          checked={keepAwake || privacyOn}
          disabled={privacyOn}
          onCheckedChange={(v) => void setKeepAwake(v)}
          ariaLabel={t(awayFromComputerSettings.devicesKeepAwake.titleKey)}
        />
      ),
    },
  ];

  if (awayGuard.available) {
    rows.push({
      key: 'away-guard',
      node: (
        <BehaviorRow
          id={awayFromComputerSettings.awayGuard.targetId}
          data-setting-id={awayFromComputerSettings.awayGuard.id}
          label={t(awayFromComputerSettings.awayGuard.titleKey)}
          hint={t(
            platform === 'win32'
              ? 'settings.windowBehavior.awayGuard.hintWindows'
              : platform === 'linux'
                ? 'settings.windowBehavior.awayGuard.hintLinux'
                : awayFromComputerSettings.awayGuard.descriptionKey,
          )}
          checked={privacyOn}
          disabled={awayGuard.busy}
          onCheckedChange={(enabled) => void awayGuard.setEnabled(enabled)}
          ariaLabel={t(awayFromComputerSettings.awayGuard.titleKey)}
          note={
            <div className="flex flex-col items-start gap-2 pt-1">
              {awayGuard.preview === 'permission' ||
              (privacyOn && awayGuard.state?.permission === 'missing') ? (
                <p className={SETTINGS_HINT} role="status">
                  {t('settings.windowBehavior.awayGuard.permission')}
                </p>
              ) : null}
              {canPreview && (
              <div className="flex flex-wrap items-center gap-2" aria-live="polite">
                <Button
                  data-settings-search-action="Shows the privacy screen now so the owner can check locking and unlocking"
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={awayGuard.preview === 'starting'}
                  onClick={() => void awayGuard.startPreview()}
                >
                  {t('settings.windowBehavior.awayGuard.preview')}
                </Button>
                {awayGuard.preview === 'starting' ? (
                  <p className={SETTINGS_HINT}>
                    {t('settings.windowBehavior.awayGuard.previewStarting')}
                  </p>
                ) : awayGuard.preview === 'unavailable' ? (
                  <p className={SETTINGS_HINT} role="alert">
                    {t('settings.windowBehavior.awayGuard.previewUnavailable')}
                  </p>
                ) : null}
              </div>
              )}
            </div>
          }
        />
      ),
    });
  }

  if (privacyOn && awayGuard.state) {
    const state = awayGuard.state;
    rows.push({
      key: 'away-guard-delay',
      node: (
        <SettingsRow
          className="cindy-segmented-row"
          title={
            <span id={awayFromComputerSettings.awayGuardDelay.targetId}>
              {t(awayFromComputerSettings.awayGuardDelay.titleKey)}
            </span>
          }
          hint={t(awayFromComputerSettings.awayGuardDelay.descriptionKey)}
          trailing={
            <SegmentedControl
              data-setting-id={awayFromComputerSettings.awayGuardDelay.id}
              aria-label={t(awayFromComputerSettings.awayGuardDelay.titleKey)}
              value={String(state.delaySeconds ?? 'system')}
              onValueChange={(value) => {
                const seconds = Number(value);
                void awayGuard.setDelay(isAwayGuardDelaySeconds(seconds) ? seconds : null);
              }}
              options={awayFromComputerSettings.awayGuardDelay.options.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            />
          }
        />
      ),
    });
  }

  return (
    <SettingsSection title={t('settings.awayFromComputer.title')}>
      <SettingsCard>
        {rows.map((row) => (
          <Fragment key={row.key}>{row.node}</Fragment>
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
