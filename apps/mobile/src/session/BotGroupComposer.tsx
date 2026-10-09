/**
 * 群聊输入框（对照桌面 BotGroupComposer.tsx，docs/product-rules/bot-group-chat.md §4.1 / §7.2 / §8）。
 *
 * 输入 `@` 在输入框上方弹出点名候选，第一项固定是「所有人」。发送时以正文重新解析点名
 * （与桌面同一套规则，见 @cindy/maker-shared/botGroupMentions），clientId 作为幂等键：同一段
 * 文字、同一批点名目标、同一个「分工」标签、同一批附件重发沿用同一个 clientId。一轮进行中输入框为空且没有
 * 附件时，发送按钮变成停止；否则照常发送（插话本身就会作废当前一轮）。
 *
 * 附件与一对一聊天同一套（照片、拍照、文件、iOS 最近照片、粘贴图片，见
 * useBotGroupComposerAttachments）：电脑声明 `supportsAttachments` 且在线时，「+」打开与任务
 * 输入框相同的面板；旧电脑会丢掉附件，「+」保持原来的小菜单。附件托盘在输入框聚焦时显示在
 * 卡片里，收起时是一枚小徽标（与会话页一致）。附件只在发出成功后离开托盘。
 *
 * 「+」里的「安排分工」给这条消息加上可去掉的「分工」标签（`division: true`）；安排进行中
 * 或等继续时不能再安排新的：小菜单时点「+」只说明原因，面板里这一行置灰并写明原因（同桌面）。
 * 占位文字跟随未结束的安排。
 */
import { useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View, type TextInput as NativeTextInput } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Camera, Folder, Image as ImageIcon, Plus, Square, Users, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { BOT_GROUP_MESSAGE_MAX_CHARS, type BotGroupMemberView, type BotGroupMention } from '@cindy/maker-shared/botGroupChat';
import {
  filterBotGroupMentionCandidates,
  findBotGroupMentionQuery,
  insertBotGroupMention,
  resolveBotGroupMentions,
  retainBotGroupTrackedMentions,
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
import { iconStroke, motionDuration, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { BOT_GROUP_STEP_AVATAR_SIZE, BotGroupAvatar } from './BotGroupAvatars';
import { BotGroupMenu } from './BotGroupMenu';
import type { BotGroupIdentityLookup } from './BotGroupPlan';
import { ComposerAttachmentCollapsedBadge, ComposerAttachmentTray } from './ComposerAttachmentTray';
import { ContextSheet, ContextSheetGroup, ContextSheetRow } from './ContextSheet';
import { RecentPhotosStrip } from './ContextSheetMediaViews';
import { ImageLightbox } from './ImageLightbox';
import { ComposerToolbarLeftGroup, ComposerToolbarSpacer, MobileComposerInputRow } from './MobileComposerInputRow';
import { CompanionFadeIn } from './CompanionEntering';
import { nextBotGroupSendAttempt, type BotGroupSendAttempt } from './botGroupRemote';
import { canBrowsePhotoLibraryDirectly } from './photoLibraryPolicy';
import type { RemoteSerializedAttachment } from './types';
import { useBotGroupComposerAttachments } from './useBotGroupComposerAttachments';

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
  /** Uploaded attachments, in the same shape the task composer sends; empty when none. */
  attachments: RemoteSerializedAttachment[];
}

type MentionOption =
  | { kind: 'all'; label: string }
  | { kind: 'member'; label: string; member: BotGroupMemberView };

export function BotGroupComposer({
  members, identityFor, deviceId, online, running, planState, attachmentsSupported, divisionSupported = true, onSend, onStop,
}: {
  members: readonly BotGroupMemberView[];
  identityFor: BotGroupIdentityLookup;
  deviceId: string;
  online: boolean;
  running: boolean;
  planState: BotGroupComposerPlanState | null;
  /** The computer takes attachments on `send` (`BotGroupRemoteChatData.supportsAttachments`). */
  attachmentsSupported: boolean;
  divisionSupported?: boolean;
  /** Rejects with the host's error; the draft (and its tag) come back and the attachments stay. */
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
  const selectionRef = useRef({ start: 0, end: 0 });
  const sendingRef = useRef(false);
  const stoppingRef = useRef(false);
  const attemptRef = useRef<BotGroupSendAttempt | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus());
  const tray = useBotGroupComposerAttachments({
    deviceId,
    onPicked: () => { setSheetOpen(false); focusInput(); },
  });
  const attachmentsEnabled = attachmentsSupported && online;
  // Paste handlers stay mounted for the whole screen (the input would remount otherwise); they
  // check support when an image actually arrives.
  const pasteAllowedRef = useRef(attachmentsSupported);
  pasteAllowedRef.current = attachmentsSupported;
  const mediaLibraryEnabled = canBrowsePhotoLibraryDirectly(Platform.OS);

  const activeMembers = useMemo(() => members.filter(isActiveBotGroupMember), [members]);
  const mentionMembers = useMemo(() => members.filter(member => member.isSelf !== true), [members]);
  const mentionCandidates = useMemo(() => mentionMembers.filter(isActiveBotGroupMember), [mentionMembers]);
  const allLabel = t('groupChat.mention.all');
  const query = focused ? findBotGroupMentionQuery(text, caret) : null;
  const options = useMemo<MentionOption[]>(() => {
    if (!query || mentionCandidates.length === 0) return [];
    const everyone: MentionOption[] = filterBotGroupMentionCandidates(query.query, [{ name: allLabel }]).length > 0
      ? [{ kind: 'all', label: allLabel }]
      : [];
    const people = filterBotGroupMentionCandidates(query.query, mentionCandidates)
      .map((member): MentionOption => ({ kind: 'member', label: member.name, member }));
    return [...everyone, ...people];
  }, [mentionCandidates, allLabel, query]);
  const pickerOpen = query !== null && options.length > 0;

  const trimmed = text.trim();
  const tooLong = trimmed.length > BOT_GROUP_MESSAGE_MAX_CHARS;
  const hasMembers = activeMembers.length > 0;
  const hasAttachments = tray.count > 0;
  // Attachments picked while the computer said yes stay unsendable if it later says no.
  const canSend = online && (trimmed.length > 0 || hasAttachments) && !tooLong && hasMembers
    && (attachmentsSupported || !hasAttachments);
  const showStop = running && trimmed.length === 0 && !hasAttachments;
  const divisionBlocked = isBotGroupDivisionBlocked(planState);
  // Same as the task composer: the tray shows inside the focused card, a badge otherwise.
  const cardActive = focused && hasAttachments;

  const choose = (option: MentionOption) => {
    if (!query) return;
    const next = insertBotGroupMention(text, { start: query.start, end: caret }, option.label);
    setText(next.text);
    selectionRef.current = { start: next.caret, end: next.caret };
    setCaret(next.caret);
    setForcedSelection({ start: next.caret, end: next.caret });
    setTracked(current => {
      const remaining = retainBotGroupTrackedMentions(text, next.text, {
        members: members.map(member => ({ botId: member.botId, name: member.name })),
        allLabels: [allLabel], tracked: current, editStart: query.start, editEnd: caret,
      });
      return option.kind === 'member' ? [...remaining, { botId: option.member.botId, label: option.label, start: query.start }] : remaining;
    });
    inputRef.current?.focus();
  };

  const send = async () => {
    if (!canSend || sendingRef.current) return;
    const draft = text;
    const draftText = trimmed;
    const draftTracked = tracked;
    const draftDivision = division;
    sendingRef.current = true;
    setSending(true);
    // Clear at once like any chat; a failed send puts the draft back if nothing new was typed.
    setText('');
    setCaret(0);
    setTracked([]);
    setDivision(false);
    const restoreDraft = () => {
      if (textRef.current) return;
      setText(draft);
      setTracked(draftTracked);
      // The tag comes back only with its own draft, never onto newly typed text.
      if (draftDivision) setDivision(true);
    };
    let release: (() => void) | null = null;
    try {
      // A photo picked a moment ago may still be uploading; it goes with this message. A failed
      // upload stays in the tray with 重试 and nothing is sent.
      const { failedCount } = await tray.waitForPendingUploads();
      const attachments = attachmentsSupported ? [...tray.attachmentsRef.current] : [];
      if (failedCount > 0 || (!draftText && attachments.length === 0)) {
        restoreDraft();
        return;
      }
      const attachmentIds = attachments.map((attachment) => attachment.id);
      const mentions = resolveBotGroupMentions(draft, {
        members: mentionMembers.map((member) => ({ botId: member.botId, name: member.name })),
        allLabels: [allLabel],
        tracked: draftTracked,
      });
      // Targets, tag and attachments are part of the same send intent.
      const attempt = nextBotGroupSendAttempt(attemptRef.current, draftText, draftDivision, randomUUID, attachmentIds, mentions);
      attemptRef.current = attempt;
      release = tray.holdForSend(attachmentIds);
      await onSend({ text: attempt.text, mentions, clientId: attempt.clientId, division: attempt.division, attachments });
      attemptRef.current = null;
      tray.clearSent(attachmentIds);
    } catch {
      restoreDraft();
    } finally {
      release?.();
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
    : tooLong ? t('groupChat.composer.tooLong', { max: BOT_GROUP_MESSAGE_MAX_CHARS }) : tray.error;
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
  const plus = !divisionSupported && !attachmentsSupported ? null : attachmentsEnabled
    // The same panel as a 1:1 chat's 「+」: attachments, then the group's own 安排分工.
    ? plusButton(() => { tray.armMediaTap(); setSheetOpen(true); })
    : divisionBlocked
      // Nothing to pick while a plan runs or waits; say why instead of showing a dead menu.
      ? plusButton(() => Alert.alert(t('groupChat.composer.division'), t('groupChat.composer.divisionBusy')))
      : <BotGroupMenu title={moreLabel} accessibilityLabel={moreLabel} disabled={!online} testID="botGroup.composer.menu"
        sections={[{ id: 'more', options: [{ id: 'division', title: t('groupChat.composer.division'), subtitle: t('groupChat.composer.divisionDescription') }] }]}
        onSelect={(id) => { if (id === 'division') { setDivision(true); inputRef.current?.focus(); } }}>
        {(open) => plusButton(open)}
      </BotGroupMenu>;
  const leading = hasAttachments ? <View style={styles.leading}>
    {plus}
    <ComposerAttachmentCollapsedBadge attachments={tray.attachments} previews={tray.previews} pendingUploads={tray.pendingUploads}
      pastePlaceholderCount={tray.pastePlaceholderCount} onPress={() => inputRef.current?.focus()}
      testID="botGroup.attachmentCollapsedBadge" />
  </View> : plus;
  const previewUrl = previewId ? tray.galleryImages.find((image) => image.key === previewId)?.url ?? null : null;

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
        {/* M9: candidates ease in one after another, 30ms apart, fast 150ms from 4pt below. */}
        {options.map((option, index) => <CompanionFadeIn key={option.kind === 'all' ? 'all' : option.member.botId} play distance={4}
          duration={motionDuration.fast} delay={index * 30}>
          <Pressable accessibilityRole="button"
          accessibilityLabel={option.label} onPress={() => choose(option)}
          style={({ pressed }) => [styles.pickerRow, pressed && mobileInteractionStyles.pressed]}
          testID={`botGroup.mention.${option.kind === 'all' ? 'all' : option.member.botId}`}>
          {option.kind === 'all'
            ? <View style={styles.everyone}><Users size={iconSize.sm} color={colors.textSecondary} /></View>
            : <BotGroupAvatar deviceId={deviceId} identity={identityFor(option.member.botId, option.member.name)} size={BOT_GROUP_STEP_AVATAR_SIZE} online={online} />}
          <Text numberOfLines={1} style={styles.pickerName}>{option.label}</Text>
          {option.kind === 'all' ? <Text numberOfLines={1} style={styles.pickerHint}>{t('groupChat.mention.allHint')}</Text> : null}
          </Pressable>
        </CompanionFadeIn>)}
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
      onChangeText={(value) => {
        const { start: editStart, end: editEnd } = selectionRef.current;
        setText(value);
        setTracked(current => retainBotGroupTrackedMentions(text, value, {
          members: members.map(member => ({ botId: member.botId, name: member.name })),
          allLabels: [allLabel],
          tracked: current,
          editStart,
          editEnd,
        }));
      }}
      onSelectionChange={(event) => {
        selectionRef.current = event.nativeEvent.selection;
        setForcedSelection(undefined);
        setCaret(event.nativeEvent.selection.end);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyPress={(event) => {
        // Backspace in an empty input takes the 「分工」 tag off (Desktop behavior).
        if (event.nativeEvent.key === 'Backspace' && division && !textRef.current) setDivision(false);
      }}
      onPasteImages={(uris) => {
        if (pasteAllowedRef.current) void tray.addPastedImages(uris);
        else tray.dropPastedImages(uris);
      }}
      onPasteImagesLoading={(count) => { if (pasteAllowedRef.current) tray.beginPastePlaceholders(count); }}
      onPasteImagesLoadFailed={() => { if (pasteAllowedRef.current) tray.failPastePlaceholders(); }}
      cardActive={cardActive}
      accessoryAbove={hasAttachments ? <ComposerAttachmentTray attachments={tray.attachments} previews={tray.previews}
        pendingUploads={tray.pendingUploads} pastePlaceholderCount={tray.pastePlaceholderCount}
        onPreview={setPreviewId} onRemove={tray.removeAttachment} onRemovePending={tray.removePendingUpload}
        onRetryPending={tray.retryPendingUpload} removeDisabled={sending} testIDPrefix="botGroup" /> : null}
      toolbar={cardActive ? <>
        <ComposerToolbarLeftGroup>{plus}</ComposerToolbarLeftGroup>
        <ComposerToolbarSpacer />
        {trailing}
      </> : undefined}
      leading={leading}
      trailing={trailing}
      testID="botGroup.composer.row"
    />
    <ContextSheet
      visible={sheetOpen}
      onClose={() => setSheetOpen(false)}
      title={moreLabel}
      keyboardAvoidingBehavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      error={tray.error}
      // The panel only opens while attachments are possible; if the computer drops off meanwhile
      // the attachment entries go away and only 安排分工 is left.
      media={mediaLibraryEnabled && attachmentsEnabled ? <RecentPhotosStrip busyAssetIds={tray.busyAssetIds}
        enabled={sheetOpen} onToggleAsset={tray.toggleMediaAsset} selectedAssetIds={tray.selectedAssetIds}
        testID="botGroup.contextSheetPhotos" /> : null}
      testID="botGroup.contextSheet"
    >
      {attachmentsEnabled ? <ContextSheetGroup label={Platform.OS === 'ios' && mediaLibraryEnabled ? '' : t('session.common.groupAdd')}>
        <ContextSheetRow dismissBeforePress
          icon={<ImageIcon color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.common.photo')} onPress={() => void tray.addImages('library')} testID="botGroup.contextSheetPhotoRow" />
        <ContextSheetRow dismissBeforePress
          icon={<Camera color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.common.takePhoto')} onPress={() => void tray.addImages('camera')} testID="botGroup.contextSheetCameraRow" />
        <ContextSheetRow dismissBeforePress
          icon={<Folder color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('session.common.file')} onPress={() => void tray.addDocument()} testID="botGroup.contextSheetFileRow" />
      </ContextSheetGroup> : null}
      <ContextSheetGroup label={t('session.common.groupMode')}>
        <ContextSheetRow disabled={divisionBlocked} dismissBeforePress
          icon={<Users color={colors.textPrimary} size={iconSize.lg} strokeWidth={iconStroke.regular} />}
          label={t('groupChat.composer.division')}
          detail={t(divisionBlocked ? 'groupChat.composer.divisionBusy' : 'groupChat.composer.divisionDescription')}
          onPress={() => { setDivision(true); inputRef.current?.focus(); }} testID="botGroup.contextSheetDivisionRow" />
      </ContextSheetGroup>
    </ContextSheet>
    {previewUrl ? <ImageLightbox images={tray.galleryImages} initialUrl={previewUrl} onClose={() => setPreviewId(null)} /> : null}
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  wrap: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.sm },
  // The badge brings its own trailing margin (shared with the task composer).
  leading: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
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
