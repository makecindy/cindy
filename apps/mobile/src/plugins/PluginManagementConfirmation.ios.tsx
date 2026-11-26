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
import { useEffect, useState } from "react";
import { useConsentSheetSizes } from "./useConsentSheetSizes";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CONSENT_FADE_HEIGHT, CONSENT_SIDE_BY_SIDE_MIN_WIDTH, consentIdentityShown, consentLayoutKey, consentRegularConfirmed, consentSheetMeasured,
  consentSummaryFadeAllowed, planConsentSheet,
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
  // Every size comes from this consent's own sheet at this window size and text size (maintainer review 18:13): another
  // consent, a rotation or another text size starts from nothing (the measured views get new identities, see
  // `forRequest`, so every size is reported again), and a late report made before is dropped.
  const layoutKey = consentLayoutKey(consent?.requestId, { width: windowWidth, height: windowHeight, fontScale });
  const layout = useConsentSheetSizes(layoutKey);
  const sizes = layout.sizes;
  const measure = (key: "identity" | "heading" | "actions" | "visible" | "content") => (frame: { y: number; height: number }) => {
    if (frame.height <= 0) return;
    layout.report(key, frame.height);
    // Where the identity block and the list end on screen (global frames): the real-layout check compares them.
    if (key === "identity") layout.reportEnd("identityBottom", frame.y + frame.height);
    if (key === "visible") layout.reportEnd("listBottom", frame.y + frame.height);
  };
  const measureLine = (index: number) => (size: { height: number }) => {
    if (size.height > 0) layout.reportLine(index, size.height);
  };
  /** A view identity for this layout key: another key's views are new views (scrolled to their top, measured again). */
  const forRequest = (name: string) => viewId(name + ":" + (layoutKey ?? ""));
  const sheetHeader = Math.ceil(64 * Math.min(Math.max(fontScale, 1), 2)) + 10;
  // Which scroll area has more below what it shows (from its own scroll geometry; display only).
  const [more, setMore] = useState({ list: false, summary: false });
  const watchMore = (key: keyof typeof more) => (geometry: { contentOffsetY: number; containerHeight: number; contentHeight: number }) => {
    const next = geometry.contentHeight > geometry.containerHeight + 1 && geometry.contentOffsetY + geometry.containerHeight < geometry.contentHeight - 2;
    setMore((current) => current[key] === next ? current : { ...current, [key]: next });
  };
  const listGeometry = useScrollGeometryChange(watchMore("list"));
  const summaryGeometry = useScrollGeometryChange(watchMore("summary"));
  const fade = (testID: string, shown: boolean) => (
    <Rectangle testID={testID} modifiers={[
      foregroundStyle({ type: "linearGradient", colors: ["transparent", colors.surfaceElevated], startPoint: { x: 0.5, y: 0 }, endPoint: { x: 0.5, y: 1 } }),
      frame({ height: CONSENT_FADE_HEIGHT }), opacity(shown ? 1 : 0), accessibilityHidden(true),
    ]} />
  );
  const lineCount = info?.highRisk?.lines.length ?? 0;
  const available = (actions: number) => Math.floor(windowHeight - insets.top - sheetHeader) - spacing.sm * 2 /* list padding */
    - spacing.sm * 3 /* footer spacing */ - spacing.xs - 12 /* footer bottom */ - insets.bottom - actions;
  const plan = planConsentSheet({
    available: available(sizes.actions), identity: sizes.identity, heading: sizes.heading,
    lines: Array.from({ length: lineCount }, (_, index) => sizes.lines[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
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
  const fitKey = layoutKey;
  const [crampedFor, setCrampedFor] = useState<string | null>(null);
  const cramped = fitKey !== null && crampedFor === fitKey;
  const compact = plan.mode === "compact" || reviewed || cramped;
  const measuredAll = consentSheetMeasured(sizes, lineCount, true);
  useEffect(() => {
    // Where the identity block ends against where the list ends, both as laid out (the list's content can start below a
    // top inset, as in landscape: reshoot m2b).
    if (fitKey && !compact && measuredAll && !consentIdentityShown(sizes, true)) setCrampedFor(fitKey);
  }, [fitKey, compact, measuredAll, sizes]);
  // Allow answers in the regular layout only once this consent's sizes have all arrived and confirm it (maintainer review
  // 18:13: on first mount, or with only some sizes, the plan can say regular before it knows). Until then Allow looks the
  // same but does not answer: pressed, the sheet goes compact (review first) instead. Read from the newest reports when
  // pressed. Not marked unavailable: SwiftUI's disabled state would dim the button for that frame.
  const confirmedNow = () => consentRegularConfirmed(layout.latest(), { lineCount, available, gap: spacing.xs, positions: true });
  const needsReview = compact && !reviewed && info?.allowBlocked !== true;
  // The pinned summary's content height, for this layout key only.
  const [summaryContent, setSummaryContent] = useState<{ for: string | null; height: number }>({ for: null, height: 0 });
  const summaryHeight = summaryContent.for === layoutKey ? summaryContent.height : 0;
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
        if (accept && !compact && !confirmedNow()) { if (fitKey) setCrampedFor(fitKey); return; }
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
        // The list's visible height (its own frame), for the real-layout check.
        onGeometryChange(measure("visible")),
        forRequest(reviewed ? "plugins.management.reviewed" : "plugins.management.list")]}
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
                  // Its own identity per consent (maintainer review 18:20): the next consent's summary starts at its top.
                  modifiers={[forRequest("plugins.management.highRiskScroll"),
                    frame({ height: plan.mode === "regular" ? Math.min(plan.summaryLines, summaryHeight || plan.summaryLines) : undefined }),
                    scrollIndicators("visible"), accessibilityHint(t("plugins.management.scrollHint")),
                    ...(summaryGeometry ? [summaryGeometry] : [])]}>
                  <VStack alignment="leading" spacing={spacing.xs}
                    modifiers={[frame({ maxWidth: Infinity, alignment: "leading" }),
                      onGeometryChange((size) => { if (size.height > 0) setSummaryContent({ for: layoutKey, height: size.height }); })]}>
                    {summaryItems}
                  </VStack>
                </ScrollView>
                <Overlay.Content>{fade("plugins.management.highRiskFade", more.summary && consentSummaryFadeAllowed(plan))}</Overlay.Content>
              </Overlay>
            </VStack>
          ) : null}
          {stacked ? (
            <VStack testID="plugins.management.actions" spacing={spacing.sm} modifiers={[forRequest("plugins.management.actions"), onGeometryChange(measure("actions"))]}>
              {[true, false].map((accept) => answerButton(accept))}
            </VStack>
          ) : (
          <HStack testID="plugins.management.actions" spacing={spacing.md} modifiers={[forRequest("plugins.management.actions"), onGeometryChange(measure("actions"))]}>
            {[false, true].map((accept) => answerButton(accept))}
          </HStack>
          )}
        </VStack>
      }
    >
      <VStack
        alignment="leading"
        spacing={spacing.md}
        modifiers={[padding({ vertical: spacing.sm }), onGeometryChange(measure("content"))]}
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
