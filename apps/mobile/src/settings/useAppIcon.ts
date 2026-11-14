import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appIconFromNativeName,
  nativeNameForAppIcon,
  writeAppIconPreference,
  type AppIconChoice,
} from './appIconPreference';
import { getAppIconNative } from './appIconNative';

export type AppIconSwitchResult = 'ok' | 'unsupported' | 'set-failed' | 'save-failed';

export type UseAppIcon = {
  choice: AppIconChoice;
  supported: boolean;
  pending: boolean;
  select(next: AppIconChoice): Promise<AppIconSwitchResult>;
};

/**
 * 系统里的 `alternateIconName` 是唯一真值：挂载时以原生值对齐本地缓存，启动时不主动 set，
 * 避免重装/恢复备份后无端弹出系统提示。
 */
export function useAppIcon(): UseAppIcon {
  const [choice, setChoice] = useState<AppIconChoice>('default');
  const [supported, setSupported] = useState(false);
  const [pending, setPending] = useState(false);
  const choiceRef = useRef<AppIconChoice>('default');

  useEffect(() => {
    let active = true;
    const native = getAppIconNative();
    if (!native) return undefined;
    void (async () => {
      try {
        const canSwitch = await native.supportsAlternateIcons();
        if (!active) return;
        setSupported(canSwitch);
        if (!canSwitch) return;
        const current = appIconFromNativeName(await native.getAlternateIconName());
        if (!active) return;
        choiceRef.current = current;
        setChoice(current);
        // 对账：系统已回落主图标时清掉过期缓存；写失败不影响展示。
        void writeAppIconPreference(current).catch(() => undefined);
      } catch {
        // 能力查询失败等同于不支持；不影响其它设置。
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const select = useCallback(async (next: AppIconChoice): Promise<AppIconSwitchResult> => {
    const native = getAppIconNative();
    if (!native) return 'unsupported';
    const previous = choiceRef.current;
    if (next === previous) return 'ok';

    choiceRef.current = next;
    setChoice(next);
    setPending(true);
    try {
      await native.setAlternateIconName(nativeNameForAppIcon(next));
    } catch {
      choiceRef.current = previous;
      setChoice(previous);
      setPending(false);
      return 'set-failed';
    }
    try {
      await writeAppIconPreference(next);
    } catch {
      setPending(false);
      return 'save-failed';
    }
    setPending(false);
    return 'ok';
  }, []);

  return { choice, supported, pending, select };
}
