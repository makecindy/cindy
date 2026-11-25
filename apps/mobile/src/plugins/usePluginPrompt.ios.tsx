import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { Button, HStack, Text, VStack } from "@expo/ui/swift-ui";
import { buttonStyle, fixedSize, font, foregroundStyle, frame, tint } from "@expo/ui/swift-ui/modifiers";
import { ComposerSheet } from "@/session/ComposerSheet";
import { spacing, useTheme } from "@/theme";
import { CONSENT_SIDE_BY_SIDE_MIN_WIDTH } from "./pluginConsentPresentation";

/** A confirmation, or (no `cancelLabel`) a notice with one button that only closes it. */
export interface PluginPromptRequest {
  title: string;
  message?: string;
  cancelLabel?: string;
  confirmLabel: string;
  destructive?: boolean;
  cancelable?: boolean;
  /** Runs in the tap that confirms, before the promise settles (for work that must start in that frame). */
  onConfirm?: () => void;
}

/**
 * The plugin page's prompts on iOS (dispatcher M-2): the system alert cuts its buttons at the largest text sizes (the
 * message scrolls, the buttons do not fit), so the page uses a native sheet with the same rule as the confirmation
 * sheet: the title and the message scroll, the buttons sit in a footer that always gets its full height. Same API as
 * the Android card (useSharedTaskConfirmation), so the page calls one `confirm` on both.
 */
export function usePluginPrompt() {
  const { colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [request, setRequest] = useState<PluginPromptRequest | null>(null);
  const resolver = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  const settle = useCallback((accepted: boolean) => {
    const resolve = resolver.current;
    resolver.current = null; setRequest(null); resolve?.(accepted);
  }, []);
  const confirm = useCallback((next: PluginPromptRequest): Promise<boolean> => {
    if (resolver.current) return Promise.resolve(false);
    return new Promise((resolve) => { resolver.current = resolve; setRequest(next); });
  }, []);
  const stacked = fontScale > 1.2 && width < CONSENT_SIDE_BY_SIDE_MIN_WIDTH;
  const button = (accept: boolean) => {
    const label = accept ? request?.confirmLabel ?? "" : request?.cancelLabel ?? "";
    const color = request?.destructive ? colors.sharedTaskConfirmBackground : colors.cta;
    return (
      <Button key={String(accept)} testID={accept ? "plugins.prompt.confirm" : "plugins.prompt.cancel"}
        onPress={() => { if (accept) request?.onConfirm?.(); settle(accept); }}
        modifiers={[buttonStyle(accept ? "borderedProminent" : "bordered"), ...(accept ? [tint(color)] : []),
          frame({ maxWidth: Infinity, minHeight: 44 })]}>
        <Text modifiers={[font({ textStyle: "subheadline", weight: "medium" }),
          ...(accept ? [foregroundStyle(request?.destructive ? colors.sharedTaskConfirmForeground : colors.ctaText)] : []),
          // Wraps rather than truncates at large text sizes.
          fixedSize({ horizontal: false, vertical: true })]}>{label}</Text>
      </Button>
    );
  };
  const buttons = request?.cancelLabel !== undefined ? [false, true] : [true];
  const dialog = (
    <ComposerSheet visible={!!request} onClose={() => settle(false)} title="" nativeContent testID="plugins.prompt"
      preventDismiss={request?.cancelable === false}
      footer={
        // The footer always gets its full height; the title and the message scroll above it.
        <VStack spacing={spacing.sm} modifiers={[fixedSize({ horizontal: false, vertical: true })]}>
          {stacked || buttons.length === 1 ? (
            <VStack testID="plugins.prompt.actions" spacing={spacing.sm}>{[...buttons].reverse().map(button)}</VStack>
          ) : (
            <HStack testID="plugins.prompt.actions" spacing={spacing.md}>{buttons.map(button)}</HStack>
          )}
        </VStack>
      }>
      <VStack alignment="leading" spacing={spacing.md}>
        <Text testID="plugins.prompt.title" modifiers={[font({ textStyle: "headline" }), foregroundStyle(colors.textPrimary),
          fixedSize({ horizontal: false, vertical: true })]}>{request?.title ?? ""}</Text>
        {request?.message ? (
          <Text testID="plugins.prompt.message" modifiers={[font({ textStyle: "body" }), foregroundStyle(colors.textPrimary),
            fixedSize({ horizontal: false, vertical: true })]}>{request.message}</Text>
        ) : null}
      </VStack>
    </ComposerSheet>
  );
  return { confirm, dialog };
}
