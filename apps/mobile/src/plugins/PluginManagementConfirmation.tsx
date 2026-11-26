import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { SheetModal } from "@/session/SheetModal";
import { Text } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  usePluginConsent,
  type PluginManagementConfirmationProps,
} from "./usePluginConsent";
import { useEffect, useRef, useState } from "react";
import { ScrollFade, ScrollThumb, useScrollOverflow } from "@/components/ScrollOverflow";
import { CONSENT_FADE_HEIGHT, CONSENT_SIDE_BY_SIDE_MIN_WIDTH, consentIdentityShown, consentSummaryFadeAllowed, planConsentSheet,
  pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.controller.consentAllowance?.() ?? undefined) : undefined;
  const { height: windowHeight, width: windowWidth, fontScale } = useWindowDimensions();
  // Two layouts by one rule (`planConsentSheet`, the same as iOS), from measured content heights only: regular, with the
  // summary pinned above the buttons, when the identity block (titles, computer, source, repository, source notes) and
  // the summary's heading with two items fit; compact otherwise, with everything in one scroll area above fixed buttons.
  // A scroll area with more below shows a text-free fade over its lower edge, with the scrollbar always visible
  // (dispatcher J-1, K-2): neither takes room, so neither can change the plan.
  const [measured, setMeasured] = useState({ identity: 0, heading: 0, actions: 0 });
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  // The newest layout, as it arrives (read when Allow is pressed; the state above can be a render behind).
  const laidOut = useRef({ identity: 0, visible: 0, content: 0 });
  const measure = (key: keyof typeof measured) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    if (key === "identity") laidOut.current.identity = height;
    setMeasured((current) => current[key] === height ? current : { ...current, [key]: height });
  };
  const measureLine = (index: number) => (event: { nativeEvent: { layout: { height: number } } }) => {
    const height = Math.ceil(event.nativeEvent.layout.height);
    setLineHeights((current) => current[index] === height ? current : Object.assign([...current], { [index]: height }));
  };
  const sheetPadding = spacing.lg + spacing.xs;
  const lineCount = info?.highRisk?.lines.length ?? 0;
  const plan = planConsentSheet({
    available: Math.floor(windowHeight * 0.85) - sheetPadding * 2 - spacing.md /* list bottom padding */
      - (info?.highRisk ? spacing.md * 2 + spacing.xs : 0) /* summary padding, gap under its heading */ - measured.actions,
    identity: measured.identity, heading: measured.heading,
    lines: Array.from({ length: lineCount }, (_, index) => lineHeights[index] ?? 0) /* 0 = not measured yet */, gap: spacing.xs,
  });
  // Compact (maintainer review 16:35 #2, the same as iOS): Allow comes after an explicit "Review source and permissions"
  // step, which shows the source and this consent's high-risk summary first (the list starts again at its top); the
  // sheet stays compact once reviewed. Regular is unchanged.
  const [reviewedFor, setReviewedFor] = useState<string | null>(null);
  const reviewed = !!consent && reviewedFor === consent.requestId;
  // Checked on the real layout (Android reshoot 2026-11-26, 1080×1600 at text size 2.0: the estimate above said the
  // identity block fits, while the native bottom sheet caps its content at 85% of the window and this sheet takes 85% of
  // that, so the list got far less than planned): when the regular list shows
  // less than the whole identity block (where it installs, where it comes from) without scrolling, this consent goes
  // compact. Kept for this consent at this window and text size, so the compact layout cannot flip it back.
  const fitKey = consent ? JSON.stringify([consent.requestId, windowWidth, windowHeight, fontScale]) : null;
  const [crampedFor, setCrampedFor] = useState<string | null>(null);
  const cramped = fitKey !== null && crampedFor === fitKey;
  const compact = plan.mode === "compact" || reviewed || cramped;
  const needsReview = compact && !reviewed && info?.allowBlocked !== true;
  const list = useScrollOverflow(), summary = useScrollOverflow();
  const shown = consentIdentityShown({ identity: measured.identity, visible: list.area.visible, content: list.area.content });
  useEffect(() => {
    if (!fitKey || compact || measured.identity <= 0 || list.area.visible <= 0) return;
    if (!shown) setCrampedFor(fitKey);
  }, [fitKey, compact, measured.identity, list.area.visible, shown]);
  // Allow in the regular layout answers only when the newest layout shows the whole identity block (dispatcher
  // 2026-11-26: the frame before the check lands must not let it through). Pressed before that, or when it does not show,
  // the sheet goes compact (review first) instead of answering; nothing is drawn differently before then.
  const allowNow = () => compact || consentIdentityShown(laidOut.current);
  const listRef = useRef<ScrollViewInstance>(null);
  // Back to the list's top after "Review", and for each new consent (another requestId), so a second consent does not
  // open where the previous one was scrolled to (iOS: its new view id does the same).
  useEffect(() => { listRef.current?.scrollTo({ y: 0, animated: false }); }, [reviewed, consent?.requestId]);
  // Large text on a narrow screen: the buttons stack so each label shows in full (as the plugin notices do). Wide enough
  // (landscape, tablets) they stay side by side, labels wrapping inside them, so the text keeps more room (K-3).
  const stacked = fontScale > 1.2 && windowWidth < CONSENT_SIDE_BY_SIDE_MIN_WIDTH;
  const heading = info?.highRisk ? (
    // The heading wraps rather than truncates.
    <Text testID="plugins.management.highRiskTitle" style={styles.highRiskTitle} onLayout={measure("heading")}>{info.highRisk.title}</Text>
  ) : null;
  const summaryLines = info?.highRisk?.lines.map((line, index) => (
    <Text key={index} style={styles.highRiskBody} onLayout={measureLine(index)}>{line}</Text>
  ));
  // Over the scroll area's lower edge while more is below: the sheet's own surface color (one token, so it follows light
  // and dark mode), with a scroll thumb in the `borderStrong` token that stays visible in both (dispatcher Q-1).
  const fade = (testID: string) => <ScrollFade testID={testID} color={colors.surfaceElevated} height={FADE_HEIGHT} />;
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      <View style={styles.sheet} testID="plugins.managementConfirmation">
        <View style={styles.listArea}>
          <ScrollView ref={listRef} contentContainerStyle={[styles.content, list.thumbGutter]} testID="plugins.management.list" showsVerticalScrollIndicator={false}
            accessibilityHint={t("plugins.management.scrollHint")}
            onLayout={(event) => { laidOut.current.visible = Math.ceil(event.nativeEvent.layout.height); list.onLayout(event); }}
            onContentSizeChange={(width, height) => { laidOut.current.content = Math.ceil(height); list.onContentSizeChange(width, height); }}
            onScroll={list.onScroll}
            scrollEventThrottle={64}>
            {/* The identity block: where it goes and where it comes from first, in primary text; the first thing shown
                in either layout. The explanations follow in secondary text. */}
            {/* Reviewed (compact): the source and this consent's high-risk summary come first, then the rest as before. */}
            {reviewed ? (
              <View testID="plugins.management.reviewLead" style={styles.identity}>
                {[info?.origin, info?.repository, info?.originSourceChanged, info?.sourceChanged, info?.trust].filter(Boolean).map((text, index) => (
                  <Text key={"review" + index} style={styles.lead}>{text}</Text>
                ))}
              </View>
            ) : null}
            {reviewed && info?.highRisk ? (
              <View testID="plugins.management.highRisk" style={[styles.highRisk, styles.highRiskInline]}>
                {heading}
                <View style={styles.highRiskLines}>{summaryLines}</View>
              </View>
            ) : null}
            <View testID="plugins.management.identity" style={[styles.identity, reviewed && styles.reviewedIdentity]} onLayout={measure("identity")}>
              <Text style={styles.title}>
                {t("plugins.notice.title.confirmation")}
              </Text>
              <Text style={styles.title}>{info?.title}</Text>
              {[info?.device, ...(reviewed ? [] : [info?.origin, info?.repository, info?.originSourceChanged, info?.sourceChanged, info?.trust])]
                .filter(Boolean)
                .map((text, index) => (
                  <Text key={"lead" + index} style={styles.lead}>
                    {text}
                  </Text>
                ))}
            </View>
            {/* Compact: the whole summary right after the identity block, in the same scroll area. */}
            {compact && !reviewed && info?.highRisk ? (
              <View testID="plugins.management.highRisk" style={[styles.highRisk, styles.highRiskInline]}>
                {heading}
                <View style={styles.highRiskLines}>{summaryLines}</View>
              </View>
            ) : null}
            {[info?.sourceNotice, info?.version, info?.identity]
              .filter(Boolean)
              .map((text, index) => (
                <Text key={"note" + index} style={styles.body}>
                  {text}
                </Text>
              ))}
            {info?.permissions.map((permission, index) => (
              <View key={index} style={styles.permission}>
                <Text style={styles.label}>{permission.title}</Text>
                {permission.detail ? (
                  <Text style={styles.body}>{permission.detail}</Text>
                ) : null}
              </View>
            ))}
            {[info?.unchanged, info?.oauth].filter(Boolean).map((text, index) => (
              <Text key={index} style={styles.body}>
                {text}
              </Text>
            ))}
          </ScrollView>
          {list.more ? fade("plugins.management.listFade") : null}
          <ScrollThumb overflow={list} testID="plugins.management.listThumb" />
        </View>
        {/* Regular: outside the scroll area, always visible above the buttons. */}
        {!compact && info?.highRisk ? (
          <View testID="plugins.management.highRisk" style={styles.highRisk}>
            {heading}
            <View>
              {/* Scrolls inside its height; the bar stays visible and the fade shows while items are hidden below. */}
              <ScrollView testID="plugins.management.highRiskScroll" nestedScrollEnabled showsVerticalScrollIndicator={false}
                accessibilityHint={t("plugins.management.scrollHint")}
                style={{ maxHeight: plan.mode === "regular" ? plan.summaryLines : undefined }}
                onLayout={summary.onLayout} onContentSizeChange={summary.onContentSizeChange} onScroll={summary.onScroll}
                scrollEventThrottle={64}
                contentContainerStyle={[styles.highRiskLines, summary.thumbGutter]}>
                {summaryLines}
              </ScrollView>
              {summary.more && consentSummaryFadeAllowed(plan) ? fade("plugins.management.highRiskFade") : null}
              <ScrollThumb overflow={summary} testID="plugins.management.highRiskThumb" />
            </View>
          </View>
        ) : null}
        <View testID="plugins.management.actions" style={[styles.actions, stacked && styles.stackedActions]} onLayout={measure("actions")}>
          {[false, true].map((accept) => (
            <Pressable
              key={String(accept)}
              testID={"plugins.management." + (accept && needsReview ? "review" : accept ? "allow" : "reject")}
              accessibilityRole="button"
              disabled={
                !props.active || props.state.busy || !!props.state.answerHeld || !props.state.online
                || (accept && info?.allowBlocked === true)
              }
              // Screen readers hear it unavailable until the check shows the identity block (no visual change).
              accessibilityState={{ disabled: !props.active || props.state.busy || !!props.state.answerHeld || !props.state.online
                || (accept && (info?.allowBlocked === true || (!compact && !shown))) }}
              onPress={() => {
                if (accept && needsReview) { setReviewedFor(consent!.requestId); return; }
                if (accept && !allowNow()) { if (fitKey) setCrampedFor(fitKey); return; }
                answer(accept);
              }}
              style={[styles.button, stacked && styles.stackedButton, accept && styles.primary, accept && info?.allowBlocked && styles.unavailable]}
            >
              <Text style={[styles.label, styles.buttonLabel, accept && styles.primaryText]}>
                {t("plugins.management." + (accept && needsReview ? "review" : accept ? "allow" : "reject"))}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </SheetModal>
  );
}
const FADE_HEIGHT = CONSENT_FADE_HEIGHT;
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    sheet: {
      maxHeight: "85%",
      backgroundColor: c.surfaceElevated,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      padding: spacing.lg + spacing.xs,
    },
    content: { gap: spacing.md, paddingBottom: spacing.md },
    identity: { gap: spacing.md },
    permission: { gap: spacing.xs },
    title: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    label: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.medium,
      color: c.textPrimary,
    },
    body: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textSecondary,
    },
    lead: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textPrimary,
    },
    // A hairline separates the scrolled list from the pinned summary, so a list title resting right above it
    // does not read as a repeat.
    highRisk: {
      gap: spacing.xs,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    // Same size as the list's permission titles, one step heavier.
    highRiskTitle: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.semibold,
      color: c.textPrimary,
    },
    highRiskLines: { gap: spacing.xs },
    highRiskBody: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      color: c.textPrimary,
    },
    actions: { flexDirection: "row", gap: spacing.sm },
    // Large text: Allow first, each button the full width, labels wrapping instead of truncating.
    stackedActions: { flexDirection: "column-reverse" },
    stackedButton: { flex: 0, paddingVertical: spacing.sm },
    // The list takes what the pinned summary and the buttons leave (flex, from their real heights: K-1); the fade floats
    // over its lower edge.
    listArea: { flexShrink: 1 },
    // Compact: the summary inside the scroll area, separated by the same hairline.
    highRiskInline: { paddingBottom: 0 },
    // Reviewed: the plugin and its computer follow the summary, under the same hairline.
    reviewedIdentity: { paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    unavailable: { opacity: 0.5 },
    button: {
      flex: 1,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceChip,
    },
    primary: { backgroundColor: c.cta },
    primaryText: { color: c.ctaText },
    buttonLabel: { textAlign: "center" },
  });
