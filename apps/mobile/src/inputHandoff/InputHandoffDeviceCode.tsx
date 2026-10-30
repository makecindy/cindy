/**
 * Device-code sign-in on the phone: the screen only shows a code and a link.
 * The owner copies the code and opens the link here, where their browser is
 * already signed in; nothing is typed into the window. The link is checked
 * again (https, shown origin) before it is opened.
 */
import { useState } from "react";
import { Linking, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import {
  isInputHandoffDeviceCode,
  type InputHandoffSnapshot,
} from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { MainWindowActionGroup } from "@/components/MobilePrimitives";
import { useThemedStyles } from "@/theme";
import { makeInputHandoffStyles } from "./inputHandoffStyles";

type Status = "copied" | "copyFailed" | "openFailed" | null;

export function InputHandoffDeviceCode({
  snapshot,
}: {
  snapshot: InputHandoffSnapshot;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const [status, setStatus] = useState<Status>(null);
  const deviceCode = snapshot.deviceCode;
  if (!isInputHandoffDeviceCode(deviceCode)) return null;
  return (
    <View
      style={styles.deviceCode}
      testID="interaction.inputHandoff.deviceCode"
    >
      <Text style={styles.note}>
        {t("interaction.inputHandoff.deviceCode.prompt")}
      </Text>
      <Text style={styles.deviceCodeText} selectable>
        {deviceCode.code}
      </Text>
      <Text style={styles.mono}>{deviceCode.origin}</Text>
      <MainWindowActionGroup
        density="compact"
        primaryActions={[
          {
            label: t("interaction.inputHandoff.deviceCode.copy"),
            tone: "secondary",
            testID: "interaction.inputHandoff.deviceCode.copy",
            onPress: () =>
              void Clipboard.setStringAsync(deviceCode.code)
                .then(() => setStatus("copied"))
                .catch(() => setStatus("copyFailed")),
          },
          {
            label: t("interaction.inputHandoff.deviceCode.open"),
            tone: "secondary",
            testID: "interaction.inputHandoff.deviceCode.open",
            onPress: () =>
              void Linking.openURL(deviceCode.url).then(
                () => setStatus(null),
                () => setStatus("openFailed"),
              ),
          },
        ]}
      />
      <Text style={styles.note}>
        {status
          ? t(`interaction.inputHandoff.deviceCode.${status}`)
          : t("interaction.inputHandoff.deviceCode.then")}
      </Text>
    </View>
  );
}
