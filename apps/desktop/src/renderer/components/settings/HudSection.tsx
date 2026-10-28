import { AppShortcutBindings } from './AppShortcutBindings';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/lib/toast';
import { HUD_TRANSPARENCY_KEYS, HUD_PASS_THROUGH_KEYS } from '../../../shared/hud';
import { useHud, updateHudSettings, resetHudSettings } from '@/features/hud/store';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

export function HudSection() {
  const { settings } = useHud();
  const { t } = useTranslation();
  const report = (promise: Promise<unknown>) => {
    void promise.catch(() => toast.error(t('hud.failed')));
  };
  return (
    <section id="settings-hud" className="space-y-4">
      <h2 className={SETTINGS_SECTION_TITLE_CLASS}>{t('hud.settings')}</h2>
      <p className="text-13 text-muted-foreground">{t('hud.description')}</p>
      <div className={SETTINGS_CARD_CLASS}>
        {HUD_TRANSPARENCY_KEYS.map((key) => (
          <div key={key} className={SETTINGS_ROW_CLASS}>
            <label className={SETTINGS_ROW_LABEL_CLASS} htmlFor={`hud-${key}`}>
              {t(`hud.${key}`)}
            </label>
            <div className="flex items-center gap-3">
              <input
                id={`hud-${key}`}
                type="range"
                min="0"
                max="100"
                step="1"
                value={settings[key]}
                onChange={(event) =>
                  report(updateHudSettings({ [key]: Number(event.target.value) }))
                }
                className="w-32 accent-[var(--text-primary)]"
              />
              <output htmlFor={`hud-${key}`} className="w-10 text-right text-12 tabular-nums">
                {settings[key]}%
              </output>
            </div>
          </div>
        ))}
      </div>
      <p className="text-12 text-muted-foreground">{t('hud.transparencyHint')}</p>
      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <label className={SETTINGS_ROW_LABEL_CLASS} htmlFor="hud-position">
            {t('hud.position')}
          </label>
          <SegmentedControl
            aria-label={t('hud.position')}
            value={settings.inputPosition}
            options={[
              { value: 'top', label: t('hud.top') },
              { value: 'bottom', label: t('hud.bottom') },
            ]}
            onValueChange={(inputPosition) => report(updateHudSettings({ inputPosition }))}
          />
        </div>
        <div className={SETTINGS_ROW_CLASS}>
          <label className={SETTINGS_ROW_LABEL_CLASS} htmlFor="hud-screen">
            {t('hud.allowScreen')}
          </label>
          <Switch
            id="hud-screen"
            checked={settings.allowScreen}
            onCheckedChange={(allowScreen) => report(updateHudSettings({ allowScreen }))}
          />
        </div>
        <p className="px-4 pb-3 text-12 text-muted-foreground">
          {t('hud.screenHint', { screenAction: t('hud.thisScreen') })}
        </p>
        <button
          type="button"
          className="self-start px-4 pb-4 text-13 underline"
          onClick={() => report(window.electronAPI.hud.openScreenPermission())}
        >
          {t('hud.openPermission')}
        </button>
      </div>
      <div className="space-y-2" id="settings-hud-pass-through">
        <h3 className={SETTINGS_SECTION_TITLE_CLASS}>{t('hud.passThrough')}</h3>
        <p className="text-12 text-muted-foreground">{t('hud.passThroughHint')}</p>
        <AppShortcutBindings ids={['hud-toggle-pass-through']} />
        <div className={SETTINGS_CARD_CLASS}>
          {HUD_PASS_THROUGH_KEYS.map((key) => (
            <div key={key} className={SETTINGS_ROW_CLASS}>
              <label className={SETTINGS_ROW_LABEL_CLASS} htmlFor={`hud-${key}`}>
                {t(`hud.${key}`)}
              </label>
              <Switch
                id={`hud-${key}`}
                checked={settings[key]}
                onCheckedChange={(value) => report(updateHudSettings({ [key]: value }))}
              />
            </div>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="rounded-md border border-border px-3 py-2 text-13 hover:bg-muted"
        onClick={() => report(resetHudSettings())}
      >
        {t('hud.reset')}
      </button>
    </section>
  );
}
