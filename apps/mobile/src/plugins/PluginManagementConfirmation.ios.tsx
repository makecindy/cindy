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
import { useState } from "react";
import { useConsentSheetSizes } from "./useConsentSheetSizes";
import { useConsentAnswerGate } from "./consentAnswerGate";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CONSENT_FADE_HEIGHT, CONSENT_SIDE_BY_SIDE_MIN_WIDTH, consentLayoutKey, consentSummaryFadeAllowed, planConsentSheet,
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
  // The sizes below only lay the sheet out (which layout, how high the pinned summary is); none of them lets Allow answer
  // (see `reviewedFor`). They come from this consent's own sheet at this window size and text size: another consent, a
  // rotation or another text size starts from nothing (the measured views get new identities, see `forRequest`).
  const layoutKey = consentLayoutKey(consent?.requestId, { width: windowWidth, height: windowHeight, fontScale });
  const layout = useConsentSheetSizes(layoutKey);
  const sizes = layout.sizes;
  const measure = (key: "identity" | "heading" | "actions") => (frame: { height: number }) => {
    if (frame.height > 0) layout.report(key, frame.height);
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
  // The native list's own scroll range, for the fade over its lower edge (display only; iOS 18 and later report it).
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
  // iOS: review first, always (maintainer review 19:34). Allow answers only after an explicit "Review source and
  // permissions" step for this consent, which puts the source and this consent's high-risk summary first, at the top of
  // a new list. On Android the decision reads one layout pass (`onLayout`); here the native callbacks are separate events
  // (each view's global frame, the list's scroll geometry on iOS 18 and later only), with nothing that ties a frame and an
  // offset to the same layout pass, and a correction can come at any later time. Without a consistent sample the
  // measured layout cannot show the source was on screen, so it never lets Allow answer: from the first display, in
  // every orientation, text size and iOS version, the main button is "Review source and permissions".
  // Whether a press may answer is judged when it is pressed, from the sheet's current state (`useConsentAnswerGate`, the
  // same for both sheets: maintainer review 07:30), never from what the callback captured: Allow answers only for the
  // consent reviewed, and a callback from before another consent or another layout answers nothing.
  // Reviewed stays with the requestId: turning the phone or changing the text size afterwards keeps it reviewed (the
  // reviewed list is drawn anew for the new size, from its top: the source first); another consent starts again from the
  // review step.
  // Review and Allow are separate controls that never share a place (maintainer review 06:44, by layout alone): the
  // buttons are the same before and after the review step, in a footer at the bottom of a sheet whose height the step
  // does not change. The bottom row is Reject and "Review source and permissions" (stacked: Review above Reject);
  // "Allow and continue" is its own row above them (a centered button), unavailable until this consent is reviewed. Reviewed, the
  // review button stays where it was, unavailable, with the same label (so the same size), so a second tap there, however
  // soon, does nothing; Reject never moves.
  const requestId = consent?.requestId ?? null;
  const gate = useConsentAnswerGate({ requestId, mode: "review", layoutKey, allowBlocked: info?.allowBlocked === true });
  const [reviewedFor, setReviewedFor] = useState<string | null>(null);
  const reviewed = requestId !== null && reviewedFor === requestId;
  // Layout only: reviewed, the list is reordered (source and summary first, the whole summary in it); in landscape the
  // regular layout would leave the list a short strip under the pinned summary.
  const landscape = windowWidth > windowHeight;
  const compact = plan.mode === "compact" || reviewed || landscape;
  const allowReady = reviewed && info?.allowBlocked !== true;
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
  const answerable = props.active && !props.state.busy && !props.state.answerHeld && props.state.online;
  /** One answer control: `allow` (its own row), `review` / `reviewed` (the same place), `reject`. */
  const answerButton = (kind: "allow" | "review" | "reviewed" | "reject") => {
    const prominent = kind !== "reject";
    return (
      <Button
        key={kind === "reviewed" ? "review" : kind}
        testID={"plugins.management." + kind}
        onPress={() => {
          if (kind === "reject") { answer(false); return; }
          if (kind === "review") {
            if (gate.review()) setReviewedFor(requestId);
            return;
          }
          // Allow: judged now, from the current state (this consent reviewed, never one that can only be rejected).
          if (kind === "allow" && gate.allow() === "answer") answer(true);
        }}
        modifiers={[
          buttonStyle(prominent ? "borderedProminent" : "bordered"),
          ...(prominent ? [tint(colors.cta), foregroundStyle(colors.ctaText)] : []),
          disabled(!answerable || kind === "reviewed" || (kind === "allow" && !allowReady)),
          frame({ maxWidth: Infinity, minHeight: 44 }),
        ]}
      >
        <Text
          modifiers={[
            font({ textStyle: "subheadline", weight: "medium" }),
            ...(prominent ? [foregroundStyle(colors.ctaText)] : []),
            // The label wraps rather than truncates at large text sizes.
            fixedSize({ horizontal: false, vertical: true }),
          ]}
        >
          {t("plugins.management." + (kind === "reviewed" ? "review" : kind))}
        </Text>
      </Button>
    );
  };
  const reviewSlot = answerButton(reviewed ? "reviewed" : "review");
  const summaryHeading = info?.highRisk ? (
    <Text
      testID="plugins.management.highRiskTitle"
      modifiers={[
        // Same size as the list's permission titles, one step heavier.
        font({ textStyle: "subheadline", weight: "semibold" }),
        foregroundStyle(colors.textPrimary),
        // Wraps rather than truncates.
        fixedSize({ horizontal: false, vertical: true }),
        // Its own identity per layout key, as every measured view (iOS reshoot 60a054a9a5): opened in portrait and turned
        // to landscape, the heading kept its height, so SwiftUI did not report it again under the new key; the sizes
        // never all arrived, and the sheet stayed regular from the estimate. Shown in one place at a time.
        forRequest("plugins.management.highRiskTitle"),
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
          <VStack testID="plugins.management.actions" spacing={spacing.sm} modifiers={[forRequest("plugins.management.actions"), onGeometryChange(measure("actions"))]}>
            {answerButton("allow")}
            {stacked ? (
              <VStack testID="plugins.management.answerRow" spacing={spacing.sm}>{reviewSlot}{answerButton("reject")}</VStack>
            ) : (
              <HStack testID="plugins.management.answerRow" spacing={spacing.md}>{answerButton("reject")}{reviewSlot}</HStack>
            )}
          </VStack>
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
