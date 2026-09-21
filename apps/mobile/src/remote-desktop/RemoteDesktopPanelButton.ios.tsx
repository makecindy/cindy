import { NativeChromeButton } from '@/platform/chrome/NativeChromeButton.ios';
import type { PanelButtonProps } from './RemoteDesktopPanelButton';

export function RemoteDesktopPanelButton({ back, label, onPress }: PanelButtonProps) {
  return <NativeChromeButton label={label} onPress={onPress}
    systemImage={back ? 'chevron.backward' : 'xmark'} testID="remoteDesktop.panel.back" />;
}
