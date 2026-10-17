import { Redirect } from "expo-router";

/** 原生气泡设置页只在 iOS 提供;其它平台在设置页内用面板调整,误入时回到设置。 */
export function UserBubblePage() {
  return <Redirect href="/settings" />;
}
