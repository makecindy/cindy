import { NativeChromeBackButton } from "@/platform/chrome/NativeChromeBackButton.ios";

export function RemoteDesktopBackButton(props: { label: string; onPress(): void }) {
  return <NativeChromeBackButton {...props} testID="remoteDesktop.back" glassVariant="clear" />;
}
