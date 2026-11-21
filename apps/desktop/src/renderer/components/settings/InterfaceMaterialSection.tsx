import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsField, SettingsRow, SettingsSection } from '@/components/ui/settings-rows';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import {
  APPEARANCE_LIMITS,
  DEFAULT_LIQUID_GLASS_CLARITY,
  isLiquidGlassEnabled,
  supportsLiquidGlass,
  type AppearanceSettings,
} from '../../../shared/appearanceSettings';
import { personalizationSettings } from './PersonalizationSettings.settings-search';
import { DefaultOverrideControls } from './DefaultOverrideControls';
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
  const percentFormat = new Intl.NumberFormat(i18n.language, { style: 'percent' });
  const percent = percentFormat.format(displayed / 100);
  const defaultMarkLabel = `${t('settings.defaults.restore')} (${percentFormat.format(DEFAULT_LIQUID_GLASS_CLARITY / 100)})`;

  useEffect(() => bridge?.onChanged?.(setSettings), [bridge]);

  useLayoutEffect(() => {
    if (!enabled || preview === undefined) return;
    const style = document.documentElement.style;
    style.setProperty('--glass-clarity-preview', String(preview / 100));
    return () => { style.removeProperty('--glass-clarity-preview'); };
  }, [enabled, preview]);

  async function apply(write: () => Promise<AppearanceSettings>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const saved = await write();
      setSettings(saved);
    } catch {
      toast.error(t('settings.personalization.liquidGlass.saveFailed'));
    } finally {
      inFlight.current = false;
      setPreview(undefined);
      setSaving(false);
    }
  }

  function reset(field: 'liquidGlass' | 'liquidGlassClarity') {
    const resetFields = bridge?.resetFields;
    if (resetFields) void apply(() => resetFields([field]));
  }

  function changeGlass(liquidGlass: boolean) {
    if (liquidGlass === isLiquidGlassEnabled(platform) && bridge?.resetFields) reset('liquidGlass');
    else if (bridge?.setPatch) void apply(() => bridge.setPatch({ liquidGlass }));
  }

  function commitClarity(value: number | undefined) {
    if (!enabled || value === undefined || value === clarity) return;
    if (value === DEFAULT_LIQUID_GLASS_CLARITY && bridge?.resetFields) reset('liquidGlassClarity');
    else if (bridge?.setPatch) void apply(() => bridge.setPatch({ liquidGlassClarity: value }));
  }

  const unavailable = !bridge?.setPatch || saving;
  const canResetClarity = settings?.liquidGlassClarity !== undefined && !!bridge?.resetFields && !saving;
  return (
    <SettingsSection title={t('settings.personalization.liquidGlass.section')}>
      <SettingsCard>
        <SettingsRow
          {...setting.anchorProps}
          title={setting.title}
          hint={setting.description}
          trailing={
            <div className="flex items-center gap-2">
              <DefaultOverrideControls
                isCustomized={settings?.liquidGlass !== undefined}
                showCustomizedBadge={false}
                disabled={!bridge?.resetFields || saving}
                onReset={() => reset('liquidGlass')}
              />
              <Switch
                {...setting.controlProps}
                aria-label={setting.title}
                checked={enabled}
                disabled={unavailable}
                onCheckedChange={changeGlass}
              />
            </div>
          }
        />
        <SettingsField
          {...claritySetting.anchorProps}
          title={claritySetting.title}
          hint={<span id={personalizationSettings.liquidGlassClarity.targetId + '-hint'}>{claritySetting.description}</span>}
          action={<span className="text-12 tabular-nums text-[var(--text-secondary)]" aria-hidden>{percent}</span>}
        >
          <div className="relative [&_span:has(>_.cindy-slider-thumb)]:z-20">
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
              onValueCommit={([value]) => commitClarity(value)}
            />
            <Tip text={defaultMarkLabel}>
              <button
                type="button"
                data-settings-search-action="Restore the slider's default value"
                aria-label={defaultMarkLabel}
                disabled={!canResetClarity}
                className="group absolute inset-y-0 left-1/2 z-10 grid w-7 -translate-x-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none"
                onClick={() => reset('liquidGlassClarity')}
              >
                <span aria-hidden className="h-1.5 w-0.5 rounded-full bg-[var(--slider-thumb)] opacity-70 ring-1 ring-[var(--slider-track)] group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            </Tip>
          </div>
        </SettingsField>
      </SettingsCard>
    </SettingsSection>
  );
}
