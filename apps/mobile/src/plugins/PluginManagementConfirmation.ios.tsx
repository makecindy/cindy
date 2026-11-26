import { Button, Divider, Overlay, Rectangle, ScrollView, Text, VStack, HStack } from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  accessibilityHint,
  buttonStyle,
  disabled,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  id as viewId,
  onGeometryChange,
  opacity,
  padding,
  scrollIndicators,
  tint,
  useScrollGeometryChange,
} from "@expo/ui/swift-ui/modifiers";
import { useTranslation } from "react-i18next";
import { ComposerSheet } from "@/session/ComposerSheet";
import { spacing, useTheme } from "@/theme";
import {
  usePluginConsent,
  type PluginManagementConfirmationProps,
} from "./usePluginConsent";
import { useEffect, useRef, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CONSENT_FADE_HEIGHT, CONSENT_SIDE_BY_SIDE_MIN_WIDTH, consentIdentityShown, consentSummaryFadeAllowed, planConsentSheet,
  pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.controller.consentAllowance?.() ?? undefined) : undefined;
  const { height: windowHeight, width: windowWidth, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Two layouts by one rule (`planConsentSheet`, the same as Android), from measured content heights only: regular,
  // with the summary pinned in the footer above the buttons, when the identity block (title, computer, source,
  // repository, source notes) and the summary's heading with two items fit; compact otherwise, with the whole summary in
  // the scrolled list right after the identity block and only the buttons in the footer. The usable height is the
  // window minus the top inset and the sheet's own header (title row and drag handle, which grow with text size).
  // A scroll area with more below shows a text-free fade over its lower edge (the same rule as Android; dispatcher K-2):
  // it takes no room. SwiftUI shows scroll indicators only while scrolling, so the fade is what says there is more.
  // A SwiftUI ScrollView takes all the height it is offered, so the pinned summary gets an explicit height: its
  // measured content height, capped by the plan.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  // The newest layout, as it arrives (read when Allow is pressed; the state above can be a render behind).
  const laidOut = useRef({ identity: 0, visible: 0, content: 0 });
  const measure = (key: keyof typeof measured) => (size: { height: number }) => {
    const height = Math.ceil(size.height);
    if (key === "identity" && height > 0) laidOut.current.identity = height;
    if (height > 0) setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const measureLine = (index: number) => (size: { height: number }) => {
    const height = Math.ceil(size.height);
    if (height > 0) setLineHeights((current) => current[index] === height ? current : Object.assign([...current], { [index]: height }));
  };
  const sheetHeader = Math.ceil(64 * Math.min(Math.max(fontScale, 1), 2)) + 10;
  // Which scroll area has more below what it shows (from its own scroll geometry; display only).
  const [more, setMore] = useState({ list: false, summary: false });
  const watchMore = (key: keyof typeof more) => (geometry: { contentOffsetY: number; containerHeight: number; contentHeight: number }) => {
    const next = geometry.contentHeight > geometry.containerHeight + 1 && geometry.contentOffsetY + geometry.containerHeight < geometry.contentHeight - 2;
    setMore((current) => current[key] === next ? current : { ...current, [key]: next });
  };
  // The list's visible height and whether it scrolls, from its own geometry (the real-layout check below).
  const [listArea, setListArea] = useState({ visible: 0, content: 0 });
  const listGeometry = useScrollGeometryChange((geometry: { contentOffsetY: number; containerHeight: number; contentHeight: number }) => {
    watchMore("list")(geometry);
    const visible = Math.floor(geometry.containerHeight), content = Math.ceil(geometry.contentHeight);
    laidOut.current.visible = visible; laidOut.current.content = content;
    setListArea((current) => current.visible === visible && current.content === content ? current : { visible, content });
  });
  const summaryGeometry = useScrollGeometryChange(watchMore("summary"));
  const fade = (testID: string, shown: boolean) => (
    <Rectangle testID={testID} modifiers={[
      foregroundStyle({ type: "linearGradient", colors: ["transparent", colors.surfaceElevated], startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } }),
      frame({ height: CONSENT_FADE_HEIGHT }), opacity(shown ? 1 : 0), accessibilityHidden(true),
    ]} />
  );
  const lineCount = info?.highRisk?.lines.length ?? 0;
  const plan = planConsentSheet({
    available: Math.floor(windowHeight - insets.top - sheetHeader) - spacing.sm * 2 /* list padding */
      - spacing.sm * 3 /* footer spacing */ - spacing.xs - 12 /* footer bottom */ - insets.bottom - measured.actions,
    identity: measured.identity, heading: measured.heading,
    lines: Array.from({ length: lineCount }, (_, index) => lineHeights[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
  });
  // Compact (maintainer review 16:35 #2): Allow comes after an explicit "Review source and permissions" step, which shows
  // the source and this consent's high-risk summary first; the sheet stays compact once reviewed (the reordered list
  // would measure differently). Regular is unchanged: there the summary is pinned above the buttons.
  const [reviewedFor, setReviewedFor] = useState<string | null>(null);
  const reviewed = !!consent && reviewedFor === consent.requestId;
  // Checked on the real layout, as on Android (reshoot 2026-11-26): the usable height above is an estimate (header and
  // footer constants). When the regular list shows less than the whole identity block (where it installs, where it
  // comes from) without scrolling, this consent goes compact; kept for this consent at this window and text size, so
  // the compact layout cannot flip it back.
  const fitKey = consent ? JSON.stringify([consent.requestId, windowWidth, windowHeight, fontScale]) : null;
  const [crampedFor, setCrampedFor] = useState<string | null>(null);
  const cramped = fitKey !== null && crampedFor === fitKey;
  const compact = plan.mode === "compact" || reviewed || cramped;
  // The list's top padding comes before the identity block.
  const shown = consentIdentityShown({ identity: measured.identity, visible: listArea.visible, content: listArea.content, top: spacing.sm });
  useEffect(() => {
    if (!fitKey || compact || measured.identity <= 0 || listArea.visible <= 0) return;
    if (!shown) setCrampedFor(fitKey);
  }, [fitKey, compact, measured.identity, listArea.visible, shown]);
  // Allow in the regular layout answers only when the newest layout shows the whole identity block (dispatcher
  // 2026-11-26: the frame before the check lands must not let it through). Pressed before that, or when it does not show,
  // the sheet goes compact (review first) instead of answering. Nothing is drawn differently before then: SwiftUI's
  // disabled state would dim the button for that frame.
  const allowNow = () => compact || consentIdentityShown({ ...laidOut.current, top: spacing.sm });
  const needsReview = compact && !reviewed && info?.allowBlocked !== true;
  const [summaryHeight, setSummaryHeight] = useState(0);
  // Large text on a narrow screen: the buttons stack so each label shows in full; wide enough (landscape, iPad) they stay
  // side by side, labels wrapping inside them (K-3).
  const stacked = fontScale > 1.2 && windowWidth < CONSENT_SIDE_BY_SIDE_MIN_WIDTH;
  const body = (text?: string, lead = false) =>
    text ? (
      <Text
        modifiers={[
          font({ textStyle: "footnote" }),
          foregroundStyle(lead ? colors.textPrimary : colors.textSecondary),
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        {text}
      </Text>
    ) : null;
  const answerButton = (accept: boolean) => (
    <Button
      key={String(accept)}
      testID={"plugins.management." + (accept && needsReview ? "review" : accept ? "allow" : "reject")}
      onPress={() => {
        if (accept && needsReview) { setReviewedFor(consent!.requestId); return; }
        if (accept && !allowNow()) { if (fitKey) setCrampedFor(fitKey); return; }
        answer(accept);
      }}
      modifiers={[
        buttonStyle(accept ? "borderedProminent" : "bordered"),
        ...(accept ? [tint(colors.cta), foregroundStyle(colors.ctaText)] : []),
        disabled(
          !props.active || props.state.busy || !!props.state.answerHeld || !props.state.online
            || (accept && info?.allowBlocked === true),
        ),
        frame({ maxWidth: Infinity, minHeight: 44 }),
      ]}
    >
      <Text
        modifiers={[
          font({ textStyle: "subheadline", weight: "medium" }),
          ...(accept ? [foregroundStyle(colors.ctaText)] : []),
          // The label wraps rather than truncates at large text sizes.
          fixedSize({ horizontal: false, vertical: true }),
        ]}
      >
        {t("plugins.management." + (accept && needsReview ? "review" : accept ? "allow" : "reject"))}
      </Text>
    </Button>
  );
  const summaryHeading = info?.highRisk ? (
    <Text
      testID="plugins.management.highRiskTitle"
      modifiers={[
        // Same size as the list's permission titles, one step heavier.
        font({ textStyle: "subheadline", weight: "semibold" }),
        foregroundStyle(colors.textPrimary),
        // Wraps rather than truncates.
        fixedSize({ horizontal: false, vertical: true }),
        onGeometryChange(measure("heading")),
      ]}
    >
      {info.highRisk.title}
    </Text>
  ) : null;
  const summaryItems = info?.highRisk?.lines.map((line, index) => (
    <Text
      key={index}
      modifiers={[
        font({ textStyle: "footnote" }),
        foregroundStyle(colors.textPrimary),
        fixedSize({ horizontal: false, vertical: true }),
        onGeometryChange(measureLine(index)),
      ]}
    >
      {line}
    </Text>
  ));
  return (
    <ComposerSheet
      visible={visible}
      onClose={() => answer(false)}
      // Compact: the sheet's title moves into the scrolled list, ahead of the plugin's name (K-3), so only the buttons
      // are fixed and the first screen shows the title and the plugin in full.
      title={compact ? "" : t("plugins.notice.title.confirmation")}
      nativeContent
      // A new identity for the reviewed list, so it opens at its top (the source) rather than where the first list was.
      nativeContentModifiers={[...(listGeometry ? [listGeometry] : []), accessibilityHint(t("plugins.management.scrollHint")),
        viewId(reviewed ? "plugins.management.reviewed" : "plugins.management.list")]}
      nativeContentOverlay={fade("plugins.management.listFade", more.list)}
      // Open large when the summary, a source-change notice or an accessibility text size needs the room (at the medium
      // detent an upward swipe expands the sheet instead of scrolling the list).
      largeOnly={!!info?.highRisk || !!info?.originSourceChanged || fontScale >= 1.35}
      testID="plugins.managementConfirmation"
      footer={
        // The pinned high-risk text lives in the footer, which stays visible at the medium detent too. The footer always
        // gets its full height (K-1): its labels wrap at their real size, so if SwiftUI offered it less, they would draw
        // past its top edge over the list. The list takes what is left.
        <VStack alignment="leading" spacing={spacing.sm} modifiers={[fixedSize({ horizontal: false, vertical: true })]}>
          {/* Regular: a separator, then the pinned summary (every item in full, scrolling inside its height with the
              indicator visible; full details are in the scrolled list). Compact: only the buttons stay here. */}
          {!compact && info?.highRisk ? <Divider /> : null}
          {!compact && info?.highRisk ? (
            <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
              {summaryHeading}
              <Overlay alignment="bottom">
                <ScrollView testID="plugins.management.highRiskScroll"
                  modifiers={[frame({ height: plan.mode === "regular" ? Math.min(plan.summaryLines, summaryHeight || plan.summaryLines) : undefined }),
                    scrollIndicators("visible"), accessibilityHint(t("plugins.management.scrollHint")),
                    ...(summaryGeometry ? [summaryGeometry] : [])]}>
                  <VStack alignment="leading" spacing={spacing.xs}
                    modifiers={[frame({ maxWidth: Infinity, alignment: "leading" }),
                      onGeometryChange((size) => { if (size.height > 0) setSummaryHeight(size.height); })]}>
                    {summaryItems}
                  </VStack>
                </ScrollView>
                <Overlay.Content>{fade("plugins.management.highRiskFade", more.summary && consentSummaryFadeAllowed(plan))}</Overlay.Content>
              </Overlay>
            </VStack>
          ) : null}
          {stacked ? (
            <VStack testID="plugins.management.actions" spacing={spacing.sm} modifiers={[onGeometryChange(measure("actions"))]}>
              {[true, false].map((accept) => answerButton(accept))}
            </VStack>
          ) : (
          <HStack testID="plugins.management.actions" spacing={spacing.md} modifiers={[onGeometryChange(measure("actions"))]}>
            {[false, true].map((accept) => answerButton(accept))}
          </HStack>
          )}
        </VStack>
      }
    >
      <VStack
        alignment="leading"
        spacing={spacing.md}
        modifiers={[padding({ vertical: spacing.sm })]}
      >
        {/* Reviewed (compact): the source and this consent's high-risk summary come first, then the rest as before. */}
        {reviewed ? (
          <VStack testID="plugins.management.reviewLead" alignment="leading" spacing={spacing.md}>
            {body(info?.origin, true)}
            {body(info?.repository, true)}
            {body(info?.originSourceChanged, true)}
            {body(info?.sourceChanged, true)}
            {body(info?.trust, true)}
          </VStack>
        ) : null}
        {reviewed && info?.highRisk ? <Divider /> : null}
        {reviewed && info?.highRisk ? (
          <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
            {summaryHeading}
            {summaryItems}
          </VStack>
        ) : null}
        {reviewed ? <Divider /> : null}
        {/* The identity block: where it goes and where it comes from first, in primary text, kept in view with the
            pinned summary (measured for its bound); the explanations follow in secondary text. */}
        <VStack testID="plugins.management.identity" alignment="leading" spacing={spacing.md}
          modifiers={[onGeometryChange(measure("identity"))]}>
          {compact ? (
            <Text testID="plugins.management.sheetTitle" modifiers={[font({ textStyle: "headline" }), foregroundStyle(colors.textPrimary),
              fixedSize({ horizontal: false, vertical: true })]}>
              {t("plugins.notice.title.confirmation")}
            </Text>
          ) : null}
          <Text
            modifiers={[
              font({ textStyle: "headline" }),
              foregroundStyle(colors.textPrimary),
            ]}
          >
            {info?.title ?? ""}
          </Text>
          {body(info?.device, true)}
          {reviewed ? null : body(info?.origin, true)}
          {reviewed ? null : body(info?.repository, true)}
          {reviewed ? null : body(info?.originSourceChanged, true)}
          {reviewed ? null : body(info?.sourceChanged, true)}
          {reviewed ? null : body(info?.trust, true)}
        </VStack>
        {/* Compact: the whole summary right after the identity block, in the same scrolled list. */}
        {compact && !reviewed && info?.highRisk ? <Divider /> : null}
        {compact && !reviewed && info?.highRisk ? (
          <VStack testID="plugins.management.highRisk" alignment="leading" spacing={spacing.xs}>
            {summaryHeading}
            {summaryItems}
          </VStack>
        ) : null}
        {body(info?.sourceNotice)}
        {body(info?.version)}
        {body(info?.identity)}
        {info?.permissions.map((permission, index) => (
          <VStack key={index} alignment="leading" spacing={spacing.xs}>
            <Text
              modifiers={[
                font({ textStyle: "subheadline", weight: "medium" }),
                foregroundStyle(colors.textPrimary),
                fixedSize({ horizontal: false, vertical: true }),
              ]}
            >
              {permission.title}
            </Text>
            {body(permission.detail)}
          </VStack>
        ))}
        {body(info?.unchanged)}
        {body(info?.oauth)}
      </VStack>
    </ComposerSheet>
  );
}
