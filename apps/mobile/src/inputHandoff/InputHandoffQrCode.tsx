/**
 * The QR code from the computer, large and square on the 代输入 sheet. A tap
 * taps the same place on the code in the window (for example "tap to
 * refresh" on an expired code). The image is the computer's own pixels.
 */
import { useRef } from "react";
import { ActivityIndicator, Image, Pressable, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { useTheme, useThemedStyles } from "@/theme";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import type { InputHandoffQrView } from "./useInputHandoffQr";

export function InputHandoffQrCode({ view, side }: { view: InputHandoffQrView; side: number }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const layout = useRef({ width: 0, height: 0 });
  const box = { width: side, height: side };
  const { picture, state } = view;
  if (picture && (state === "shown" || state === "sending")) {
    return (
      <View style={styles.qrWrap}>
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={t("interaction.inputHandoff.qr.alt")}
          disabled={state !== "shown"}
          testID="interaction.inputHandoff.qr.code"
          onLayout={(e: LayoutChangeEvent) => {
            layout.current = e.nativeEvent.layout;
          }}
          onPress={(event) => {
            const { width, height } = layout.current;
            if (width > 0 && height > 0) view.tap(event.nativeEvent.locationX / width, event.nativeEvent.locationY / height);
          }}
          style={[styles.qrCode, box, state !== "shown" && styles.pictureDisabled]}
        >
          <Image
            source={{ uri: `data:${picture.mime};base64,${picture.data}` }}
            resizeMode="contain"
            style={styles.pictureImage}
            accessibilityIgnoresInvertColors
          />
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.qrWrap}>
      <View style={[styles.qrPlaceholder, box]}>
        {state === "failed" ? (
          <Pressable accessibilityRole="button" onPress={view.load} style={styles.quietLink} testID="interaction.inputHandoff.qr.retry">
            <Text style={[styles.body, styles.centered]}>{t("interaction.inputHandoff.qr.failed")}</Text>
          </Pressable>
        ) : (
          <>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.meta}>{t("interaction.inputHandoff.qr.loading")}</Text>
          </>
        )}
      </View>
    </View>
  );
}
