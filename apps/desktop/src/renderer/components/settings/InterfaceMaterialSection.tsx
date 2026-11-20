import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsField, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import {
  APPEARANCE_LIMITS,
  DEFAULT_LIQUID_GLASS_CLARITY,
  isLiquidGlassEnabled,
  supportsLiquidGlass,
  type AppearanceSettings,
} from '../../../shared/appearanceSettings';
import { personalizationSettings } from './PersonalizationSettings.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

// A neighboring integer snaps in either direction. The two integers between
// detents remain reachable with the pointer.
function snapClarity(value: number): number {
  const detent = Math.round(value / 5) * 5;
  return Math.abs(value - detent) <= 1 ? detent : value;
}

export function InterfaceMaterialSection() {
  const platform = window.electronAPI?.platform;
  return supportsLiquidGlass(platform) && <LiquidGlassSetting platform={platform} />;
}

function LiquidGlassSetting({ platform }: { platform: string | undefined }) {
  const { t, i18n } = useTranslation();
  const bridge = window.electronAPI?.appearanceSettings;
  const setting = useSettingDefinition(personalizationSettings.liquidGlass);
  const claritySetting = useSettingDefinition(personalizationSettings.liquidGlassClarity);
  const initial = () => bridge?.getSync?.();
  const [settings, setSettings] = useState(initial);
  const [preview, setPreview] = useState<number>();
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const enabled = isLiquidGlassEnabled(platform, settings?.liquidGlass);
  const clarity = settings?.liquidGlassClarity ?? DEFAULT_LIQUID_GLASS_CLARITY;
  const displayed = enabled ? preview ?? clarity : clarity;
  const percent = new Intl.NumberFormat(i18n.language, { style: 'percent' }).format(displayed / 100);

  useEffect(() => bridge?.onChanged?.(setSettings), [bridge]);

  useLayoutEffect(() => {
    if (!enabled || preview === undefined) return;
    const style = document.documentElement.style;
    style.setProperty('--glass-clarity-preview', String(preview / 100));
    return () => { style.removeProperty('--glass-clarity-preview'); };
  }, [enabled, preview]);

  async function save(patch: Partial<AppearanceSettings>) {
    if (!bridge?.setPatch || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = await bridge.setPatch(patch);
      setSettings(saved);
    } catch {
      toast.error(t('settings.personalization.liquidGlass.saveFailed'));
    } finally {
      inFlight.current = false;
      setPreview(undefined);
      setSaving(false);
    }
  }

  const unavailable = !bridge?.setPatch || saving;
  return (
    <SettingsSection title={t('settings.personalization.liquidGlass.section')}>
      <SettingsCard>
        <SettingsRow
          {...setting.anchorProps}
          title={setting.title}
          hint={setting.description}
          trailing={<Switch
            {...setting.controlProps}
            aria-label={setting.title}
            checked={enabled}
            disabled={unavailable}
            onCheckedChange={(liquidGlass) => void save({ liquidGlass })}
          />}
        />
        <SettingsField
          {...claritySetting.anchorProps}
          title={claritySetting.title}
          hint={<span id={personalizationSettings.liquidGlassClarity.targetId + '-hint'}>{claritySetting.description}</span>}
          action={<span className="text-12 tabular-nums text-[var(--text-secondary)]" aria-hidden>{percent}</span>}
        >
          <Slider
            {...claritySetting.controlProps}
            {...APPEARANCE_LIMITS.liquidGlassClarity}
            snapPointerValue={snapClarity}
            aria-label={claritySetting.title}
            aria-describedby={personalizationSettings.liquidGlassClarity.targetId + '-hint'}
            aria-valuetext={percent}
            value={[displayed]}
            disabled={!enabled || unavailable}
            onValueChange={([value]) => setPreview(value === clarity ? undefined : value)}
            onValueCommit={([value]) => {
              if (enabled && value !== undefined && value !== clarity) void save({ liquidGlassClarity: value });
            }}
          />
        </SettingsField>
      </SettingsCard>
    </SettingsSection>
  );
}
