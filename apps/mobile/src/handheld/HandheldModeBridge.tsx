import { useEffect, useRef } from 'react';

import { useTheme } from '@/theme/ThemeProvider';
import { cindyHandheld, type HandheldDisplay } from '../../modules/cindy-handheld/src';
import {
  dispatchHandheldVoiceKey,
  hydrateHandheldSettings,
  isHandheldModeSupported,
  useHandheldSettings,
} from './handheldMode';

/** 双屏掌机的副屏:第一块非默认屏(AYN Thor 等的下屏)。 */
export function pickSecondaryDisplay(displays: readonly HandheldDisplay[]): HandheldDisplay | null {
  return displays.find((display) => !display.isDefault) ?? null;
}

/**
 * 把掌机模式偏好同步给原生层,并把语音键事件分发给当前页面。不渲染 UI。
 *
 * 换屏只在「想放副屏」这一意图变化时执行一次(启动时开着也算一次):用户之后手动
 * 把 Cindy 拖回主屏时不会被反复拉走;关闭掌机模式时回到主屏。
 */
export function HandheldModeBridge() {
  const supported = isHandheldModeSupported();
  const { hydrated, settings } = useHandheldSettings();
  const { colors } = useTheme();
  const placementRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!supported) return undefined;
    void hydrateHandheldSettings();
    const subscription = cindyHandheld!.addListener('onVoiceKey', (event) => dispatchHandheldVoiceKey(event.phase));
    return () => subscription.remove();
  }, [supported]);

  useEffect(() => {
    if (!supported || !hydrated) return;
    void cindyHandheld!.configure({
      enabled: settings.enabled,
      voiceKeyCode: settings.voiceKeyCode,
      focusColor: colors.inputCaret,
    }).catch((error: unknown) => {
      console.warn('[handheld]', 'configure failed', String(error));
    });
  }, [colors.inputCaret, hydrated, settings.enabled, settings.voiceKeyCode, supported]);

  const wantsSecondary = settings.enabled && settings.useSecondaryDisplay;
  useEffect(() => {
    if (!supported || !hydrated) return;
    const previous = placementRef.current;
    placementRef.current = wantsSecondary;
    // 首次读到偏好且不需要副屏:保持系统给的位置,不主动挪动。
    if (previous === null && !wantsSecondary) return;
    if (previous === wantsSecondary) return;
    const target = wantsSecondary ? pickSecondaryDisplay(cindyHandheld!.getDisplays()) : null;
    const targetId = target?.id ?? 0;
    void cindyHandheld!.moveToDisplay(targetId).catch(() => false);
  }, [hydrated, supported, wantsSecondary]);

  return null;
}
