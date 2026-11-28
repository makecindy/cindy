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
import { useConsentAnswerGate } from "./consentAnswerGate";
import { CONSENT_FADE_HEIGHT, CONSENT_SIDE_BY_SIDE_MIN_WIDTH, pluginConsentPresentation } from "./pluginConsentPresentation";
export function PluginManagementConfirmation(
  props: PluginManagementConfirmationProps,
) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles), { colors } = useTheme();
  const { consent, visible, answer } = usePluginConsent(props);
  const info = consent ? pluginConsentPresentation(consent, t, props.deviceName, props.controller.consentAllowance?.() ?? undefined) : undefined;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  // Review first, always (maintainer review 08:37, the same as iOS): Allow answers only after an explicit "Review source
  // and permissions" step for this consent, which puts the source and this consent's high-risk summary first, at the top
  // of the list. No layout reading decides anything: the sizes React Native reports come in separate `onLayout` events,
  // and nothing in JavaScript can show they belong to one native layout pass, so a sheet laid out "regular" (Allow at
  // once when the source showed) could always be fooled by some order of those events. One layout: a single scroll area
  // (the identity block, the whole high-risk summary, the full details) above fixed buttons.
  // Buttons: review and Allow are separate controls that never share a place (maintainer review 06:44, by layout alone).
  // The bottom row is Cancel and "Review source and permissions" (stacked: Review above Cancel); "Allow and continue" is
  // its own row above them, unavailable until this consent is reviewed; reviewed, the review button stays where it was,
  // unavailable, with the same label. They sit at the bottom edge of a sheet the review step does not resize.
  // Whether a press may answer is judged when it is pressed, from the sheet's current state (`useConsentAnswerGate`, the
  // same for both sheets: maintainer review 07:30), never from what the callback captured.
  const requestId = consent?.requestId ?? null;
  const gate = useConsentAnswerGate({ requestId, allowBlocked: info?.allowBlocked === true });
  const [reviewedFor, setReviewedFor] = useState<string | null>(null);
  const reviewed = requestId !== null && reviewedFor === requestId;
  const allowReady = reviewed && info?.allowBlocked !== true;
  const list = useScrollOverflow();
  const listRef = useRef<ScrollViewInstance>(null);
  // Back to the list's top after "Review", and for each new consent (another requestId), so a second consent does not
  // open where the previous one was scrolled to (iOS: its new view id does the same).
  useEffect(() => { listRef.current?.scrollTo({ y: 0, animated: false }); }, [reviewed, requestId]);
  // Large text on a narrow screen: the buttons stack so each label shows in full (as the plugin notices do). Wide enough
  // (landscape, tablets) they stay side by side, labels wrapping inside them, so the text keeps more room (K-3).
  const stacked = fontScale > 1.2 && windowWidth < CONSENT_SIDE_BY_SIDE_MIN_WIDTH;
  const summary = info?.highRisk ? (
    <View testID="plugins.management.highRisk" style={[styles.highRisk, styles.highRiskInline]}>
      {/* The heading wraps rather than truncates. */}
      <Text testID="plugins.management.highRiskTitle" style={styles.highRiskTitle}>{info.highRisk.title}</Text>
      <View style={styles.highRiskLines}>
        {info.highRisk.lines.map((line, index) => <Text key={index} style={styles.highRiskBody}>{line}</Text>)}
      </View>
    </View>
  ) : null;
  // Over the scroll area's lower edge while more is below: the sheet's own surface color (one token, so it follows light
  // and dark mode), with a scroll thumb in the `borderStrong` token that stays visible in both (dispatcher Q-1).
  const fade = (testID: string) => <ScrollFade testID={testID} color={colors.surfaceElevated} height={FADE_HEIGHT} />;
  const answerable = props.active && !props.state.busy && !props.state.answerHeld && props.state.online;
  /** One answer control: `allow` (its own row), `review` / `reviewed` (one place), `reject` (labelled Cancel). */
  const answerButton = (kind: "allow" | "review" | "reviewed" | "reject") => {
    const prominent = kind !== "reject";
    const unavailable = !answerable || kind === "reviewed" || (kind === "allow" && !allowReady);
    return (
      <Pressable
        key={kind === "reviewed" ? "review" : kind}
        testID={"plugins.management." + kind}
        accessibilityRole="button"
        disabled={unavailable}
        accessibilityState={{ disabled: unavailable }}
        onPress={() => {
          if (kind === "reject") { answer(false); return; }
          if (kind === "review") { if (gate.review()) setReviewedFor(requestId); return; }
          // Allow: judged now, from the current state (this consent reviewed, never one that can only be rejected).
          if (kind === "allow" && gate.allow()) answer(true);
        }}
        style={[styles.button, (stacked || kind === "allow") && styles.stackedButton, prominent && styles.primary,
          prominent && unavailable && styles.unavailable]}
      >
        <Text style={[styles.label, styles.buttonLabel, prominent && styles.primaryText]}>
          {t("plugins.management." + (kind === "reviewed" ? "review" : kind))}
        </Text>
      </Pressable>
    );
  };
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={() => answer(false)}
      onBackdropPress={() => answer(false)}
    >
      {/* Drawn anew for each consent (maintainer review 18:20): the list starts at its top; redrawing the same consent
          keeps where the person was reading. */}
      <View key={requestId ?? "none"} style={styles.sheet} testID="plugins.managementConfirmation">
        <View testID="plugins.management.listArea" style={styles.listArea}>
          <ScrollView ref={listRef} contentContainerStyle={[styles.content, list.thumbGutter]} testID="plugins.management.list" showsVerticalScrollIndicator={false}
            accessibilityHint={t("plugins.management.scrollHint")}
            onLayout={list.onLayout}
            onContentSizeChange={list.onContentSizeChange}
            onScroll={list.onScroll}
            scrollEventThrottle={64}>
            {/* Reviewed: the source and this consent's high-risk summary come first, then the rest as before. */}
            {reviewed ? (
              <View testID="plugins.management.reviewLead" style={styles.identity}>
                {[info?.origin, info?.repository, info?.originSourceChanged, info?.sourceChanged, info?.trust].filter(Boolean).map((text, index) => (
                  <Text key={"review" + index} style={styles.lead}>{text}</Text>
                ))}
              </View>
            ) : null}
            {reviewed ? summary : null}
            {/* The identity block: where it goes and where it comes from first, in primary text. The explanations follow
                in secondary text. */}
            <View testID="plugins.management.identity" style={[styles.identity, reviewed && styles.reviewedIdentity]}>
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
            {/* Not yet reviewed: the whole summary right after the identity block, in the same scroll area. */}
            {reviewed ? null : summary}
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
        <View testID="plugins.management.actions" style={styles.footer}>
          {answerButton("allow")}
          <View testID="plugins.management.answerRow" style={[styles.actions, stacked && styles.stackedActions]}>
            {answerButton("reject")}
            {answerButton(reviewed ? "reviewed" : "review")}
          </View>
        </View>
      </View>
    </SheetModal>
  );
}
const FADE_HEIGHT = CONSENT_FADE_HEIGHT;
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // The buttons stay at the sheet's bottom edge whatever the list holds, so the review step (which reorders the list)
    // cannot move them. Where the sheet has a definite height (the centered sheet) it fills its maximum and the list takes
    // all the room above the buttons; the native bottom sheet sizes itself to its content from its bottom edge.
    sheet: {
      height: "85%",
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
    // A hairline separates the summary from the block above it, so a title resting right above it does not read as a
    // repeat.
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
    footer: { gap: spacing.sm },
    actions: { flexDirection: "row", gap: spacing.sm },
    // Large text: Review above Cancel, each button the full width, labels wrapping instead of truncating.
    stackedActions: { flexDirection: "column-reverse" },
    stackedButton: { flex: 0, paddingVertical: spacing.sm },
    // The list takes all the room the buttons leave (flex, from their real heights: K-1); the fade floats over its lower
    // edge.
    listArea: { flexShrink: 1, flexGrow: 1 },
    // The summary inside the scroll area, separated by the same hairline.
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
