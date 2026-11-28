import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CHAT_REACTION_EMOJIS, type ChatReaction } from '@cindy/maker-shared/optimistic-reactions';
import { Text } from '@/components/AppText';
import { playHaptic } from '@/platform/haptics';
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSheet } from './CompanionSheet';

export type BotGroupReactor = {
  actorId: string;
  name: string | null;
  isSelf: boolean;
  formerMember: boolean;
};

const MAX_INLINE_REACTIONS = 4;

export function BotGroupReactionBar({ messageId, reactions, align = 'left', canToggle = true, onToggle, onInspect }: {
  messageId: string;
  reactions: readonly ChatReaction[] | undefined;
  align?: 'left' | 'right';
  /** Controls tap-to-toggle only; long-press inspection stays available in read-only/offline groups. */
  canToggle?: boolean;
  onToggle(emoji: string, nextPresent: boolean): void;
  onInspect(initialEmoji?: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  if (!reactions?.length) return null;
  const overflow = reactions.length > MAX_INLINE_REACTIONS;
  const visible = overflow ? reactions.slice(0, MAX_INLINE_REACTIONS - 1) : reactions;
  const hiddenCount = reactions.length - visible.length;
  return (
    <View style={[styles.bar, align === 'right' && styles.barRight]} testID={`botGroup.reactions.${messageId}`}>
      {visible.map(reaction => (
        <Pressable
          key={reaction.emoji}
          accessibilityRole="button"
          accessibilityLabel={t('groupChat.reactions.badgeLabel', { emoji: reaction.emoji, count: reaction.count })}
          accessibilityState={{ selected: reaction.me }}
          hitSlop={spacing.xs}
          onPressIn={() => { if (canToggle) playHaptic('selection'); }}
          onPress={() => { if (canToggle) { playHaptic('commit'); onToggle(reaction.emoji, !reaction.me); } }}
          onLongPress={() => { playHaptic('commit'); onInspect(reaction.emoji); }}
          style={({ pressed }) => [styles.pill, reaction.me && styles.pillMine, pressed && canToggle && styles.pillPressed]}
          testID={`botGroup.reaction.${messageId}.${reaction.emoji}`}
        >
          <Text style={styles.emoji}>{reaction.emoji}</Text>
          <Text style={[styles.count, reaction.me && styles.countMine]}>{reaction.count}</Text>
        </Pressable>
      ))}
      {overflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('groupChat.reactions.moreLabel', { count: hiddenCount })}
          hitSlop={spacing.xs}
          onPressIn={() => playHaptic('selection')}
          onPress={() => { playHaptic('commit'); onInspect(reactions[0]?.emoji); }}
          style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
          testID={`botGroup.reactions.more.${messageId}`}
        >
          <Text style={styles.count}>+{hiddenCount}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function BotGroupEmojiPickerSheet({ visible, mode, messageId, reactions, initialEmoji, readOnly, onSelect, onLoadReactors, onClose }: {
  visible: boolean;
  mode: 'pick' | 'details';
  messageId: string | null;
  reactions: readonly ChatReaction[] | undefined;
  initialEmoji?: string;
  readOnly: boolean;
  onSelect(emoji: string, nextPresent: boolean): void;
  onLoadReactors?: (messageId: string, emoji: string, signal?: AbortSignal) => Promise<BotGroupReactor[]>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [selectedEmoji, setSelectedEmoji] = useState<string | undefined>(initialEmoji);
  const [reactors, setReactors] = useState<{ loading: boolean; list: BotGroupReactor[]; failed: boolean } | null>(null);

  // Initialize tab selection only when opening the sheet or switching target message/initial emoji.
  useEffect(() => {
    if (visible) setSelectedEmoji(initialEmoji ?? reactions?.[0]?.emoji);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, messageId, initialEmoji]);

  // Keep current tab across optimistic reaction updates; only fall back if that emoji disappears.
  useEffect(() => {
    if (!visible || mode !== 'details') return;
    if (!reactions?.length) { setSelectedEmoji(undefined); return; }
    if (!selectedEmoji || !reactions.some(item => item.emoji === selectedEmoji)) {
      setSelectedEmoji(reactions[0]?.emoji);
    }
  }, [visible, mode, reactions, selectedEmoji]);

  useEffect(() => {
    if (!visible || mode !== 'details' || !messageId || !selectedEmoji || !onLoadReactors) {
      setReactors(null);
      return;
    }
    const controller = new AbortController();
    setReactors({ loading: true, list: [], failed: false });
    void onLoadReactors(messageId, selectedEmoji, controller.signal).then(
      list => { if (!controller.signal.aborted) setReactors({ loading: false, list, failed: false }); },
      () => { if (!controller.signal.aborted) setReactors({ loading: false, list: [], failed: true }); },
    );
    return () => { controller.abort(); };
  }, [visible, mode, messageId, selectedEmoji, onLoadReactors]);

  const activeSet = new Set((reactions ?? []).filter(item => item.me).map(item => item.emoji));
  return (
    <CompanionSheet
      visible={visible}
      title={t(mode === 'details' ? 'groupChat.reactions.detailsTitle' : 'groupChat.reactions.pickerTitle')}
      onClose={onClose}
      initialSnap="half"
      testID={mode === 'details' ? 'botGroup.reactions.detailsSheet' : 'botGroup.reactions.pickerSheet'}
    >
      {mode === 'details' && reactions?.length ? (
        <View style={styles.sheetContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabRow}>
            {reactions.map(reaction => {
              const active = reaction.emoji === selectedEmoji;
              return (
                <Pressable
                  key={reaction.emoji}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  onPress={() => { playHaptic('selection'); setSelectedEmoji(reaction.emoji); }}
                  style={({ pressed }) => [styles.tabPill, active && styles.pillMine, pressed && styles.pressed]}
                  testID={`botGroup.reactions.tab.${reaction.emoji}`}
                >
                  <Text style={styles.emoji}>{reaction.emoji}</Text>
                  <Text style={[styles.count, active && styles.countMine]}>{reaction.count}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {selectedEmoji && !readOnly ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => { playHaptic('selection'); onSelect(selectedEmoji, !activeSet.has(selectedEmoji)); }}
              style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}
              testID="botGroup.reactions.detailsToggle"
            >
              <Text style={styles.toggleText}>
                {t(activeSet.has(selectedEmoji) ? 'groupChat.reactions.removeMine' : 'groupChat.reactions.addMine', { emoji: selectedEmoji })}
              </Text>
            </Pressable>
          ) : null}
          {reactors?.loading ? (
            <View style={styles.reactorEmpty}><ActivityIndicator color={colors.textSecondary} /></View>
          ) : reactors?.failed ? (
            <Text style={styles.reactorNote}>{t('groupChat.reactions.loadReactorsFailed')}</Text>
          ) : reactors?.list.length ? (
            <View style={styles.reactorList}>
              {reactors.list.map(reactor => (
                <View key={reactor.actorId} style={styles.reactorRow}>
                  <Text numberOfLines={1} style={styles.reactorName}>{reactor.name || t('groupChat.reactions.unknownMember')}</Text>
                  {reactor.isSelf ? <Text style={styles.reactorTag}>{t('groupChat.reactions.you')}</Text>
                    : reactor.formerMember ? <Text style={styles.reactorTag}>{t('groupChat.reactions.formerMember')}</Text>
                    : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.pickerGrid} testID="botGroup.reactions.pickerGrid">
          {CHAT_REACTION_EMOJIS.map(emoji => {
            const mine = activeSet.has(emoji);
            return (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={emoji}
                accessibilityState={{ selected: mine }}
                disabled={readOnly}
                onPressIn={() => { if (!readOnly) playHaptic('selection'); }}
                onPress={() => { if (!readOnly) { playHaptic('commit'); onSelect(emoji, !mine); onClose(); } }}
                style={({ pressed }) => [styles.emojiCell, (mine || pressed) && styles.pillMine, pressed && !readOnly && styles.cellPressed]}
                testID={`botGroup.reactions.pick.${emoji}`}
              >
                <Text style={styles.pickerEmoji}>{emoji}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </CompanionSheet>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  barRight: { justifyContent: 'flex-end' },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, minHeight: 28, paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.xs, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, borderWidth: 1, borderColor: 'transparent' },
  pillMine: { backgroundColor: `${colors.botUnread}1F`, borderColor: `${colors.botUnread}80` },
  pillPressed: { opacity: 0.82, transform: [{ scale: 0.94 }] },
  cellPressed: { transform: [{ scale: 0.9 }] },
  pressed: { opacity: 0.82 },
  emoji: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  count: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  countMine: { color: colors.groupMentionText, fontWeight: fontWeight.medium },
  sheetContent: { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.xl },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tabPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceChip, borderWidth: 1, borderColor: 'transparent' },
  toggleRow: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.container, backgroundColor: colors.surfaceChip, alignItems: 'center' },
  toggleText: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: colors.textPrimary },
  reactorEmpty: { paddingVertical: spacing.lg, alignItems: 'center' },
  reactorNote: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textTertiary, textAlign: 'center', paddingVertical: spacing.md },
  reactorList: { gap: spacing.xs },
  reactorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm, paddingHorizontal: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  reactorName: { flex: 1, minWidth: 0, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.regular, color: colors.textPrimary },
  reactorTag: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, color: colors.textTertiary, marginLeft: spacing.sm },
  pickerGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.xl },
  emojiCell: { width: '14%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: 'transparent' },
  pickerEmoji: { fontSize: typeScale.headline, lineHeight: lineHeight.headline },
});
