import { useTranslation } from "react-i18next";
import { ActionInfoRow } from "@/session/SettingsGroupRows";
import { useUserBubbleAppearance } from "@/theme/userBubblePreference";
import { useGuardedPush } from "@/utils/useGuardedPush";

/** iOS 设置行:复用设置页的进入子页行,点按推入原生「我的消息气泡颜色」页。 */
export function UserBubbleSettings() {
  const { t } = useTranslation();
  const push = useGuardedPush();
  const { preference } = useUserBubbleAppearance();
  const title = t("settings.appearance.userBubble.title");
  const value = t(
    `settings.appearance.userBubble.${preference.startsWith("#") ? "custom" : preference}`,
  );
  return (
    <ActionInfoRow
      accessibilityLabel={`${title}: ${value}`}
      label={title}
      onPress={() => push("/settings/user-bubble")}
      testID="settings.userBubble.open"
      value={value}
    />
  );
}
