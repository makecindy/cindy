import { lazy, Suspense, useCallback, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";
import { ChevronDown, ChevronUp, Globe2, Pencil } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import {
  fontWeight,
  lineHeight,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { iconSize, radius, spacing, typeScale } from "@/theme/tokens";
import { buildMessageContentLayout } from "./messageContentLayout";
import {
  readIssueConfirmDraft,
  saveIssueConfirmDraft,
  type IssueConfirmDraft,
} from "./interactionDraftStore";

// MessageRenderer also hosts authorization cards. Load its Markdown view after
// module initialization so this card does not introduce a renderer import cycle.
const MarkdownBody = lazy(async () => ({
  default: (await import("./MessageRenderer")).MarkdownBody,
}));

type Identity = { kind: "platform" | "github-user"; login: string };
export interface MobileIssueConfirmRequest {
  requestId: string;
  draft: { title: string; body: string; type: "bug" | "feature" };
  env: Record<string, string>;
  submissionIdentity: Identity;
  githubUserIdentity?: Identity;
  suggestedPublicName?: string;
}

/** Preview the public payload first. Editing never submits: return to preview to publish. */
export function IssueConfirmCard({
  request,
  busy,
  onDecision,
  onCollapse,
  inline = false,
}: {
  request: MobileIssueConfirmRequest;
  busy: boolean;
  inline?: boolean;
  onCollapse?(): void;
  onDecision(decision: Record<string, unknown>): void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollOffset = useRef(0);
  const focusedInput = useRef<TextInputInstance | null>(null);
  // The keyboard resizes the body while the footer stays pinned. Reveal the
  // focused field within that body, rather than scrolling the whole card away.
  const revealFocusedInput = useCallback(() => {
    const input = focusedInput.current;
    if (!input?.isFocused()) return;
    input.measureInWindow((_x, y, _width, height) => {
      scrollRef.current?.measureInWindow((_sx, top, _sw, available) => {
        if (focusedInput.current !== input || !input.isFocused()) return;
        const bottom = y + Math.min(height, available - spacing.sm * 2);
        const delta =
          y < top
            ? y - top - spacing.sm
            : bottom > top + available
              ? bottom - top - available + spacing.sm
              : 0;
        if (delta)
          scrollRef.current?.scrollTo({
            y: Math.max(0, scrollOffset.current + delta),
            animated: false,
          });
      });
    });
  }, []);
  const [draft, setDraft] = useState<IssueConfirmDraft>(
    () =>
      readIssueConfirmDraft(request.requestId) ?? {
        ...request.draft,
        publicName:
          request.suggestedPublicName ??
          t("interaction.issueConfirm.anonymous"),
        identityKind: request.submissionIdentity.kind,
      },
  );
  const [editing, setEditing] = useState(false);
  const [environmentExpanded, setEnvironmentExpanded] = useState(false);
  const update = (patch: Partial<IssueConfirmDraft>) => {
    const next = { ...draft, ...patch };
    saveIssueConfirmDraft(request.requestId, next);
    setDraft(next);
  };
  const identity =
    request.submissionIdentity.kind === "github-user"
      ? request.submissionIdentity
      : draft.identityKind === "github-user" && request.githubUserIdentity
        ? request.githubUserIdentity
        : request.submissionIdentity;
  const publicName = draft.publicName.trim();
  const validName =
    publicName.length > 0 &&
    publicName.length <= 100 &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(publicName);
  const [showIdentity, setIdentityExpanded] = useState(
    () => identity.kind === "platform" && !validName,
  );
  const canSubmit =
    !busy &&
    !editing &&
    !!draft.title.trim() &&
    !!draft.body.trim() &&
    (identity.kind !== "platform" || validName);
  const button = (
    id: string,
    label: string,
    action: () => void,
    primary = false,
    disabled = busy,
  ) => (
    <Pressable
      testID={`interaction.issue.${id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action}
      style={[
        styles.button,
        primary && styles.primary,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>
        {label}
      </Text>
    </Pressable>
  );
  const disclosure = (
    id: string,
    label: string,
    expanded: boolean,
    action: () => void,
    detail?: string,
  ) => (
    <Pressable
      testID={`interaction.issue.${id}`}
      accessibilityRole="button"
      accessibilityState={{ expanded, disabled: busy }}
      disabled={busy}
      onPress={action}
      style={styles.disclosure}
    >
      <View style={styles.disclosureText}>
        <Text style={detail ? styles.label : styles.hint}>{label}</Text>
        {detail && <Text style={styles.hint}>{detail}</Text>}
      </View>
      {expanded ? (
        <ChevronUp size={iconSize.md} color={colors.textSecondary} />
      ) : (
        <ChevronDown size={iconSize.md} color={colors.textSecondary} />
      )}
    </Pressable>
  );
  return (
    <View style={styles.root}>
      <ScrollView
        scrollEnabled={!inline}
        ref={scrollRef}
        onFocus={(event) => {
          focusedInput.current = event.target as unknown as TextInputInstance;
          revealFocusedInput();
        }}
        onBlur={() => {
          focusedInput.current = null;
        }}
        onLayout={revealFocusedInput}
        onScroll={(event) => {
          scrollOffset.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        style={styles.scroll}
      >
        <View style={styles.header}>
          <View style={styles.eyebrow}>
            <Globe2 size={iconSize.sm} color={colors.textSecondary} />
            <Text style={styles.hint}>
              {t("interaction.issueConfirm.previewLabel")}
            </Text>
          </View>
          <View style={styles.row}>
            {!editing && (
              <Pressable
                testID="interaction.issue.edit"
                accessibilityRole="button"
                disabled={busy}
                onPress={() => setEditing(!editing)}
                style={styles.edit}
              >
                {!editing && <Pencil size={iconSize.sm} color={colors.textPrimary} />}
                <Text style={styles.buttonText}>
                  {t(
                    editing
                      ? "interaction.issueConfirm.doneEditing"
                      : "interaction.issueConfirm.edit",
                  )}
                </Text>
              </Pressable>
            )}
            {onCollapse && (
              <Pressable
                testID="interaction.panel.collapseButton"
                accessibilityRole="button"
                accessibilityLabel={t("interaction.panel.collapsePendingCard")}
                onPress={onCollapse}
                style={styles.edit}
              >
                <Text style={styles.hint}>
                  {t("interaction.panel.collapse")}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
        {editing ? (
          <View style={styles.editor}>
            <View style={styles.row}>
              {(["bug", "feature"] as const).map((type) => (
                <Pressable
                  key={type}
                  testID={`interaction.issue.${type}`}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: draft.type === type,
                    disabled: busy,
                  }}
                  disabled={busy}
                  onPress={() => update({ type })}
                  style={[
                    styles.button,
                    styles.option,
                    draft.type === type && styles.optionSelected,
                  ]}
                >
                  <Text style={styles.buttonText}>
                    {t(
                      type === "bug"
                        ? "interaction.issueConfirm.typeBug"
                        : "interaction.issueConfirm.typeFeature",
                    )}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.label}>
              {t("interaction.issueConfirm.titleLabel")}
            </Text>
            <TextInput
              testID="interaction.issue.title"
              accessibilityLabel={t("interaction.issueConfirm.titleLabel")}
              style={styles.input}
              value={draft.title}
              editable={!busy}
              maxLength={200}
              onChangeText={(title) => update({ title })}
            />
            <Text style={styles.label}>
              {t("interaction.issueConfirm.bodyLabel")}
            </Text>
            <TextInput
              testID="interaction.issue.body"
              accessibilityLabel={t("interaction.issueConfirm.bodyLabel")}
              style={[styles.input, styles.body]}
              multiline
              value={draft.body}
              editable={!busy}
              maxLength={4500}
              onChangeText={(body) => update({ body })}
            />
          </View>
        ) : (
          <View style={styles.preview}>
            <Text style={styles.title}>{draft.title}</Text>
            <Suspense
              fallback={<Text style={styles.previewBody}>{draft.body}</Text>}
            >
              <MarkdownBody
                text={draft.body}
                layout={buildMessageContentLayout({ screenWidth: width })}
                selectable
                publicMediaOnly
                codeCopyEnabled={false}
                allowIosUITextView={false}
              />
            </Suspense>
          </View>
        )}
        {draft.body.includes("## 相关日志") && (
          <Text style={styles.hint}>
            {t("interaction.issueConfirm.relatedLogsHint")}
          </Text>
        )}
        <View style={styles.details}>
          {disclosure(
            "identity",
            identity.kind === "platform"
              ? t("interaction.issueConfirm.attribution", { name: publicName })
              : `@${identity.login}`,
            showIdentity,
            () => setIdentityExpanded(!showIdentity),
            t("interaction.issueConfirm.identitySettings"),
          )}
          {showIdentity && (
            <View style={styles.editor}>
              {[
                request.submissionIdentity,
                ...(request.submissionIdentity.kind === "platform" &&
                request.githubUserIdentity
                  ? [request.githubUserIdentity]
                  : []),
              ].map((option) => (
                <Pressable
                  key={option.kind}
                  testID={`interaction.issue.${option.kind}`}
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: identity.kind === option.kind,
                    disabled: busy,
                  }}
                  disabled={busy}
                  onPress={() => update({ identityKind: option.kind })}
                  style={[
                    styles.button,
                    styles.option,
                    identity.kind === option.kind && styles.optionSelected,
                  ]}
                >
                  <Text style={styles.buttonText}>
                    {t(
                      option.kind === "platform"
                        ? "interaction.issueConfirm.identityPlatform"
                        : "interaction.issueConfirm.identityGithubUser",
                      { login: option.login },
                    )}
                  </Text>
                </Pressable>
              ))}
              <Text style={styles.hint}>
                {t(
                  identity.kind === "platform"
                    ? "interaction.issueConfirm.identityPlatformHint"
                    : "interaction.issueConfirm.identityGithubUserHint",
                )}
              </Text>
              {identity.kind === "platform" && (
                <>
                  <Text style={styles.label}>
                    {t("interaction.issueConfirm.publicNameLabel")}
                  </Text>
                  <TextInput
                    testID="interaction.issue.publicName"
                    accessibilityLabel={t(
                      "interaction.issueConfirm.publicNameLabel",
                    )}
                    style={styles.input}
                    value={draft.publicName}
                    editable={!busy}
                    maxLength={100}
                    onChangeText={(publicName) => update({ publicName })}
                  />
                  {button(
                    "anonymous",
                    t("interaction.issueConfirm.useAnonymous"),
                    () =>
                      update({
                        publicName: t("interaction.issueConfirm.anonymous"),
                      }),
                  )}
                  <Text style={styles.hint}>
                    {t("interaction.issueConfirm.publicNameHint")}
                  </Text>
                </>
              )}
            </View>
          )}
        </View>
        <View style={styles.details}>
          {disclosure(
            "environment",
            t("interaction.issueConfirm.environment"),
            environmentExpanded,
            () => setEnvironmentExpanded(!environmentExpanded),
          )}
          {environmentExpanded && (
            <View style={styles.editor}>
              <Text style={styles.hint}>
                {t("interaction.issueConfirm.envLine", {
                  ...request.env,
                  uiLanguage: i18n.language,
                })}
              </Text>
              {!!request.env.harness && (
                <Text style={styles.hint}>
                  {t("interaction.issueConfirm.runtimeLine", request.env)}
                </Text>
              )}
              {(request.env.region === "cn" ||
                request.env.region === "dev") && (
                <Text style={styles.hint}>
                  {t("interaction.issueConfirm.regionLine", {
                    region: request.env.region === "cn" ? "CN" : "Dev",
                  })}
                </Text>
              )}
            </View>
          )}
        </View>
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.hint}>
          {t("interaction.issueConfirm.publicationNotice")}
        </Text>
        <View style={styles.actions}>
          {button("cancel", t("interaction.issueConfirm.cancel"), () =>
            onDecision({ kind: "issue_confirm", confirmed: false }),
          )}
          <View style={styles.submit}>
            {editing
              ? button(
                  "done",
                  t("interaction.issueConfirm.doneEditing"),
                  () => setEditing(false),
                  true,
                )
              : button(
                  "submit",
                  t("interaction.issueConfirm.publicSubmit"),
                  () => {
                    if (canSubmit)
                      onDecision({
                        kind: "issue_confirm",
                        confirmed: true,
                        title: draft.title.trim(),
                        body: draft.body.trim(),
                        type: draft.type,
                        submissionIdentity: identity,
                        ...(identity.kind === "platform" ? { publicName } : {}),
                        uiLanguage: i18n.language,
                      });
                  },
                  true,
                  !canSubmit,
                )}
          </View>
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: {
      flexShrink: 1,
      minHeight: 0,
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.container,
      overflow: "hidden",
    },
    scroll: { flexShrink: 1 },
    content: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
    },
    header: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: spacing.sm,
    },
    eyebrow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      flexShrink: 1,
    },
    edit: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      minHeight: 44,
      paddingHorizontal: spacing.sm,
    },
    preview: {
      gap: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.lg,
    },
    previewBody: {
      fontSize: typeScale.bodyLarge,
      lineHeight: lineHeight.bodyLarge,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    editor: { gap: spacing.sm, paddingVertical: spacing.sm },
    row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    label: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.caption,
      fontWeight: fontWeight.regular,
      color: colors.textSecondary,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.control,
      padding: spacing.md,
      fontSize: typeScale.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    body: {
      minHeight: 180,
      lineHeight: lineHeight.body,
      textAlignVertical: "top",
    },
    button: {
      minHeight: 44,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.pill,
      justifyContent: "center",
      alignItems: "center",
    },
    buttonText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    primary: { backgroundColor: colors.cta },
    primaryText: { color: colors.ctaText },
    option: { borderWidth: 1, borderColor: colors.border },
    optionSelected: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.textPrimary,
    },
    disabled: { opacity: 0.5 },
    details: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    disclosure: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    disclosureText: { flex: 1, gap: spacing.xs },
    footer: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      gap: spacing.sm,
    },
    actions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
    submit: { flex: 1 },
  });
