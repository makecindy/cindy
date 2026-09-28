/**
 * 群聊输入框（对照桌面 BotGroupComposer.tsx，docs/product-rules/bot-group-chat.md §4.1 / §7.2）。
 *
 * 纯文本；输入 `@` 在输入框上方弹出点名候选，第一项固定是「所有人」。发送时以正文重新
 * 解析点名（与桌面同一套规则，见 @cindy/maker-shared/botGroupMentions），clientId 作为幂等
 * 键：同一段文字、同一个「分工」标签重发沿用同一个 clientId。一轮进行中输入框为空时，
 * 发送按钮变成停止；有文字时照常发送（插话本身就会作废当前一轮）。
 *
 * 「+」里的「安排分工」给这条消息加上可去掉的「分工」标签（`division: true`）；安排进行中
 * 或等继续时不能再安排新的，点「+」只说明原因。占位文字跟随未结束的安排。
 */
import { useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View, type TextInput as NativeTextInput } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Plus, Square, Users, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { BOT_GROUP_MESSAGE_MAX_CHARS, type BotGroupMemberView, type BotGroupMention } from '@cindy/maker-shared/botGroupChat';
import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  type BotGroupTrackedMention,
} from '@cindy/maker-shared/botGroupMentions';
import {
  isActiveBotGroupMember,
  isBotGroupDivisionBlocked,
  type BotGroupComposerPlanState,
} from '@cindy/maker-shared/botGroupPresentation';
import { Text } from '@/components/AppText';
import { PaperPlaneIcon } from '@/components/PaperPlaneIcon';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { iconStroke, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_STEP_AVATAR_SIZE, BotGroupAvatar } from './BotGroupAvatars';
import { BotGroupMenu } from './BotGroupMenu';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { MobileComposerInputRow } from './MobileComposerInputRow';
import { nextBotGroupSendAttempt, type BotGroupSendAttempt } from './botGroupRemote';

const CONTROL_SIZE = 34;
const CONTROL_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
const TAG_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 12 } as const;
/** Five candidate rows stay visible above the keyboard; the rest scroll. */
const PICKER_MAX_HEIGHT = 5 * 44;

export interface BotGroupSendInput {
  text: string;
  mentions: BotGroupMention;
  clientId: string;
  division: boolean;
}

type MentionOption =
  | { kind: 'all'; label: string }
  | { kind: 'member'; label: string; member: BotGroupMemberView };

export function BotGroupComposer({
  members, identityFor, deviceId, online, running, planState, onSend, onStop,
}: {
  members: readonly BotGroupMemberView[];
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  running: boolean;
  planState: BotGroupComposerPlanState | null;
  /** Rejects with the host's error; the draft (and its tag) come back. */
  onSend(input: BotGroupSendInput): Promise<void>;
  onStop(): Promise<void>;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [forcedSelection, setForcedSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const [tracked, setTracked] = useState<BotGroupTrackedMention[]>([]);
  const [division, setDivision] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<NativeTextInput>(null);
  const textRef = useRef(text); textRef.current = text;
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const attemptRef = useRef<BotGroupSendAttempt | null>(null);

  const activeMembers = useMemo(() => members.filter(isActiveBotGroupMember), [members]);
  const allLabel = t('groupChat.mention.all');
  const query = focused ? findBotGroupMentionQuery(text, caret) : null;
  const options = useMemo<MentionOption[]>(() => {
    if (!query || activeMembers.length === 0) return [];
    const everyone: MentionOption[] = filterBotGroupMentionCandidates(query.query, [{ name: allLabel }]).length > 0
      ? [{ kind: 'all', label: allLabel }]
      : [];
    const people = filterBotGroupMentionCandidates(query.query, activeMembers)
      .map((member): MentionOption => ({ kind: 'member', label: member.name, member }));
    return [...everyone, ...people];
  }, [activeMembers, allLabel, query]);
  const pickerOpen = query !== null && options.length > 0;

  const trimmed = text.trim();
  const tooLong = trimmed.length > BOT_GROUP_MESSAGE_MAX_CHARS;
  const hasMembers = activeMembers.length > 0;
  const canSend = online && trimmed.length > 0 && !tooLong && hasMembers;
  const showStop = running && trimmed.length === 0;
  const divisionBlocked = isBotGroupDivisionBlocked(planState);

  const choose = (option: MentionOption) => {
    if (!query) return;
    const next = insertBotGroupMention(text, { start: query.start, end: caret }, option.label);
    setText(next.text);
    setCaret(next.caret);
    setForcedSelection({ start: next.caret, end: next.caret });
    if (option.kind === 'member') {
      setTracked((current) => [
        ...current.filter((mention) => mention.botId !== option.member.botId),
        { botId: option.member.botId, label: option.label },
      ]);
    }
    inputRef.current?.focus();
  };

  const send = async () => {
    if (!canSend || sendingRef.current) return;
    // The tag changes what the host does with the text, so it is part of the idempotency key.
    const attempt = nextBotGroupSendAttempt(attemptRef.current, trimmed, division, randomUUID);
    attemptRef.current = attempt;
    const mentions = resolveBotGroupMentions(trimmed, {
      members: members.map((member) => ({ botId: member.botId, name: member.name })),
      allLabels: [allLabel],
      tracked,
    });
    const draft = text;
    const draftTracked = tracked;
    sendingRef.current = true;
    setSending(true);
    // Clear at once like any chat; a failed send puts the draft back if nothing new was typed.
    setText('');
    setCaret(0);
    setTracked([]);
    setDivision(false);
    try {
      await onSend({ text: attempt.text, mentions, clientId: attempt.clientId, division: attempt.division });
      attemptRef.current = null;
    } catch {
      if (!textRef.current) {
        setText(draft);
        setTracked(draftTracked);
        // The tag comes back only with its own draft, never onto newly typed text.
        if (attempt.division) setDivision(true);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const stop = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try { await onStop(); } catch { /* the screen reports the failure */ } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const hint = !hasMembers
    ? t('groupChat.composer.noMembers')
    : tooLong ? t('groupChat.composer.tooLong', { max: BOT_GROUP_MESSAGE_MAX_CHARS }) : null;
  const placeholder = !hasMembers
    ? t('groupChat.composer.noMembers')
    : division
      ? t('groupChat.composer.placeholderDivision')
      : planState?.kind === 'proposed'
        ? t('groupChat.composer.placeholderPlanProposed')
        : planState?.kind === 'running' && planState.botName
          ? t('groupChat.composer.placeholderPlanRunning', { name: planState.botName })
          : planState?.kind === 'waiting' && planState.stepDone && planState.botName
            ? t('groupChat.composer.placeholderPlanWaiting', { name: planState.botName })
            : t('groupChat.composer.placeholder');

  const moreLabel = t('groupChat.composer.more');
  const plusButton = (onPress: (() => void) | undefined) => <Pressable accessibilityRole="button" accessibilityLabel={moreLabel}
    hitSlop={CONTROL_HIT_SLOP} disabled={!online} onPress={onPress}
    style={({ pressed }) => [styles.control, styles.plus, pressed && mobileInteractionStyles.pressed, !online && styles.disabled]}
    testID="botGroup.composer.more">
    <Plus size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
  </Pressable>;
  const leading = divisionBlocked
    // Nothing to pick while a plan runs or waits; say why instead of showing a dead menu.
    ? plusButton(() => Alert.alert(t('groupChat.composer.division'), t('groupChat.composer.divisionBusy')))
    : <BotGroupMenu title={moreLabel} accessibilityLabel={moreLabel} disabled={!online} testID="botGroup.composer.menu"
      sections={[{ id: 'more', options: [{ id: 'division', title: t('groupChat.composer.division'), subtitle: t('groupChat.composer.divisionDescription') }] }]}
      onSelect={(id) => { if (id === 'division') { setDivision(true); inputRef.current?.focus(); } }}>
      {(open) => plusButton(open)}
    </BotGroupMenu>;

  const actionDisabled = showStop ? stopping : !canSend || sending;
  const trailing = <Pressable accessibilityRole="button"
    accessibilityLabel={showStop ? t('groupChat.composer.stop') : t('groupChat.composer.send')}
    accessibilityState={{ disabled: actionDisabled, busy: sending || stopping || undefined }}
    disabled={actionDisabled} hitSlop={CONTROL_HIT_SLOP} onPress={() => void (showStop ? stop() : send())}
    style={({ pressed }) => [styles.control, styles.send, actionDisabled && styles.sendInactive, pressed && mobileInteractionStyles.pressed]}
    testID={showStop ? 'botGroup.composer.stop' : 'botGroup.composer.send'}>
    {showStop
      ? <Square size={iconSize.xs} color={actionDisabled ? colors.textSecondary : colors.ctaText}
        fill={actionDisabled ? colors.textSecondary : colors.ctaText} strokeWidth={iconStroke.thin} />
      : <PaperPlaneIcon color={actionDisabled ? colors.textSecondary : colors.ctaText} size={iconSize.lg} />}
  </Pressable>;

  return <View style={styles.wrap} testID="botGroup.composer">
    {pickerOpen && query ? <View style={styles.picker} accessibilityLabel={t('groupChat.mention.label')} testID="botGroup.mentionPicker">
      <ScrollView keyboardShouldPersistTaps="always" style={styles.pickerScroll}>
        {options.map((option) => <Pressable key={option.kind === 'all' ? 'all' : option.member.botId} accessibilityRole="button"
          accessibilityLabel={option.label} onPress={() => choose(option)}
          style={({ pressed }) => [styles.pickerRow, pressed && mobileInteractionStyles.pressed]}
          testID={`botGroup.mention.${option.kind === 'all' ? 'all' : option.member.botId}`}>
          {option.kind === 'all'
            ? <View style={styles.everyone}><Users size={iconSize.sm} color={colors.textSecondary} /></View>
            : <BotGroupAvatar deviceId={deviceId} identity={identityFor(option.member.botId, option.member.name)} size={BOT_GROUP_STEP_AVATAR_SIZE} online={online} />}
          <Text numberOfLines={1} style={styles.pickerName}>{option.label}</Text>
          {option.kind === 'all' ? <Text numberOfLines={1} style={styles.pickerHint}>{t('groupChat.mention.allHint')}</Text> : null}
        </Pressable>)}
      </ScrollView>
    </View> : null}
    {hint ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{hint}</Text> : null}
    {division ? <View style={styles.tagRow}>
      <View style={styles.tag} testID="botGroup.divisionTag">
        <Users size={iconSize.xs} color={colors.textSecondary} />
        <Text style={styles.tagText}>{t('groupChat.composer.divisionTag')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('groupChat.composer.removeDivision')} hitSlop={TAG_HIT_SLOP}
          onPress={() => setDivision(false)} testID="botGroup.divisionTag.remove">
          <X size={iconSize.xs} color={colors.textTertiary} />
        </Pressable>
      </View>
    </View> : null}
    <MobileComposerInputRow
      accessibilityLabel={t('groupChat.composer.label')}
      inputRef={inputRef}
      inputTestID="botGroup.composer.input"
      value={text}
      editable={online && hasMembers}
      placeholder={placeholder}
      placeholderTextColor={colors.textPlaceholder}
      cursorColor={colors.inputCaret}
      selectionColor={colors.inputCaret}
      selection={forcedSelection}
      onChangeText={setText}
      onSelectionChange={(event) => {
        setForcedSelection(undefined);
        setCaret(event.nativeEvent.selection.end);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyPress={(event) => {
        // Backspace in an empty input takes the 「分工」 tag off (Desktop behavior).
        if (event.nativeEvent.key === 'Backspace' && division && !textRef.current) setDivision(false);
      }}
      leading={leading}
      trailing={trailing}
      testID="botGroup.composer.row"
    />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  wrap: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  control: { width: CONTROL_SIZE, height: CONTROL_SIZE, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth },
  plus: { backgroundColor: colors.sheetActionSurface, borderColor: colors.sheetActionBorder },
  send: { backgroundColor: colors.cta, borderColor: colors.cta },
  sendInactive: { backgroundColor: colors.surfaceChip, borderColor: colors.border },
  disabled: { opacity: 0.46 },
  hint: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.xs },
  tagRow: { flexDirection: 'row' },
  tag: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 28, paddingLeft: spacing.sm, paddingRight: spacing.sm,
    borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  tagText: { color: colors.textPrimary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium },
  picker: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.container, paddingVertical: spacing.xs, overflow: 'hidden' },
  pickerScroll: { maxHeight: PICKER_MAX_HEIGHT },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md },
  everyone: { width: BOT_GROUP_STEP_AVATAR_SIZE, height: BOT_GROUP_STEP_AVATAR_SIZE, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceChip },
  pickerName: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  pickerHint: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
});
