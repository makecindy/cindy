import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { Check } from "lucide-react-native";
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, useThemedStyles, type ThemeColors } from "@/theme";
import { iconSize, iconStroke, radius, spacing } from "@/theme/tokens";
import {
  shareSelectionStore,
  useIsMessageSelected,
} from "@/session/shareSelectionStore";
import {
  shareSelectionTapMoved,
  shouldCommitShareSelectionTap,
  type ShareSelectionTapPoint,
} from "@/session/shareSelectionTap";

interface ShareSelectionRowGesture {
  consumed: boolean;
  moved: boolean;
  start: ShareSelectionTapPoint;
  startedAt: number;
}

const ShareSelectionRowInteractionContext = createContext<(() => void) | null>(null);

export function useCancelShareSelectionRowTap(): (() => void) | null {
  return useContext(ShareSelectionRowInteractionContext);
}

function tapPoint(event: GestureResponderEvent): ShareSelectionTapPoint {
  return {
    pageX: event.nativeEvent.pageX,
    pageY: event.nativeEvent.pageY,
  };
}

export function ShareCheckboxMark({ checked }: { checked: boolean }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={[styles.mark, checked && styles.selected]}>
      {checked ? (
        <Check
          color={colors.ctaText}
          size={iconSize.sm}
          strokeWidth={iconStroke.bold}
        />
      ) : null}
    </View>
  );
}

export function ShareMessageCheckbox({
  children,
  clientId,
  disabled = false,
  fill = false,
}: {
  children?: ReactNode;
  clientId: string;
  disabled?: boolean;
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const selected = useIsMessageSelected(clientId);
  const rowGestureRef = useRef<ShareSelectionRowGesture | null>(null);
  const pendingCommitFrameRef = useRef<number | null>(null);
  const toggle = () => shareSelectionStore.toggle(clientId);
  const cancelRowTap = useCallback(() => {
    if (rowGestureRef.current) rowGestureRef.current.consumed = true;
  }, []);
  useEffect(() => () => {
    if (pendingCommitFrameRef.current !== null) {
      cancelAnimationFrame(pendingCommitFrameRef.current);
    }
  }, []);

  if (fill) {
    return (
      <View
        onResponderGrant={(event) => {
          rowGestureRef.current = {
            consumed: false,
            moved: false,
            start: tapPoint(event),
            startedAt: Date.now(),
          };
          // Keep native descendants (selectable text, scroll views) eligible
          // to own their gestures while this row observes a plain short tap.
          return false;
        }}
        onResponderMove={(event) => {
          const gesture = rowGestureRef.current;
          if (!gesture || gesture.moved) return;
          if (shareSelectionTapMoved(gesture.start, tapPoint(event))) {
            gesture.moved = true;
          }
        }}
        onResponderRelease={(event) => {
          const gesture = rowGestureRef.current;
          if (
            !disabled
            && gesture
            && shouldCommitShareSelectionTap({
              durationMs: Date.now() - gesture.startedAt,
              moved: gesture.moved || shareSelectionTapMoved(gesture.start, tapPoint(event)),
            })
          ) {
            // UITextView child links emit their native onPress after responder release.
            // Wait through the native event turn so that handler can consume this gesture.
            pendingCommitFrameRef.current = requestAnimationFrame(() => {
              pendingCommitFrameRef.current = null;
              if (rowGestureRef.current === gesture) rowGestureRef.current = null;
              if (!gesture.consumed) toggle();
            });
          } else {
            rowGestureRef.current = null;
          }
        }}
        onResponderTerminate={() => {
          rowGestureRef.current = null;
        }}
        onResponderTerminationRequest={() => true}
        onStartShouldSetResponder={() => !disabled}
        style={styles.rowButton}
        testID={`session.shareImage.row.${clientId}`}
      >
        <View style={styles.rowMarkGutter}>
          <Pressable
            accessibilityLabel={t("session.shareImage.checkboxLabel")}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled }}
            disabled={disabled}
            onPress={toggle}
            style={({ pressed }) => [styles.rowMarkButton, pressed && styles.pressed]}
            testID={`session.shareImage.checkbox.${clientId}`}
          >
            <ShareCheckboxMark checked={selected} />
          </Pressable>
        </View>
        <ShareSelectionRowInteractionContext.Provider value={cancelRowTap}>
          {children}
        </ShareSelectionRowInteractionContext.Provider>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityLabel={t("session.shareImage.checkboxLabel")}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={toggle}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
      testID={`session.shareImage.checkbox.${clientId}`}
    >
      <ShareCheckboxMark checked={selected} />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    button: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    rowButton: {
      alignItems: "flex-start",
      flexDirection: "row",
      gap: spacing.sm,
      minWidth: 0,
      width: "100%",
    },
    rowMarkGutter: {
      alignItems: "center",
      width: spacing.xl * 2,
    },
    rowMarkButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "flex-start",
      paddingTop: spacing.sm,
      width: 44,
    },
    mark: {
      alignItems: "center",
      borderColor: colors.borderStrong,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      height: 22,
      justifyContent: "center",
      width: 22,
    },
    selected: {
      backgroundColor: colors.cta,
      borderColor: colors.cta,
    },
    pressed: { opacity: 0.72 },
  });
