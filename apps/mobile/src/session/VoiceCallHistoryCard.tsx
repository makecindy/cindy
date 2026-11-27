import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { formatShortDateTime } from '@/i18n/dateFormatters';
import type { VoiceCallRecord } from '@cindy/maker-shared/voice-call-record';
import { fontWeight, iconSize, radius, spacing, textStyles, useThemedStyles, type ThemeColors } from '@/theme';
import { useFoldableExpandedState } from './expandedBlockMemory';
import { formatLocalizedSeconds, formatVoiceRecordingTime } from './sessionDurationFormat';

export function VoiceCallHistoryCard({ record }: { record: VoiceCallRecord }) {
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [expanded, toggle] = useFoldableExpandedState('voice-call:' + record.callId, false);
  const title = t('message.voiceCall.title');
  const time = formatShortDateTime(record.startedAt, i18n.language);
  const seconds = record.endedAt === undefined ? undefined : Math.max(0, Math.floor((record.endedAt - record.startedAt) / 1000));
  const duration = seconds === undefined ? t('message.voiceCall.saved')
    : seconds >= 3600 ? formatLocalizedSeconds(seconds)
    : formatVoiceRecordingTime(seconds);
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={[title, duration, time].join(', ')}
        onPress={toggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.summary}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.metadata}>{duration}</Text>
        </View>
        <Text style={[styles.metadata, styles.time]}>{time}</Text>
        <Chevron size={iconSize.sm} color={styles.metadata.color} />
      </Pressable>
      {expanded && <VoiceCallTranscript record={record} />}
    </View>
  );
}

function VoiceCallTranscript({ record }: { record: VoiceCallRecord }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const handoffs = new Map(record.handoffs.map(handoff => [handoff.inputId, handoff]));
  const entries = record.turns.map(turn => {
    const handoff = handoffs.get(turn.id);
    handoffs.delete(turn.id);
    const text = turn.text.trim() ? turn.text : handoff?.text;
    if (!text?.trim() && !handoff) return null;
    return (
      <View key={turn.id} style={styles.turn}>
        <Text style={styles.speaker}>{t(turn.role === 'user' ? 'message.voiceCall.you' : 'message.voiceCall.companion')}</Text>
        {!!text && <Text selectable style={styles.body}>{text}</Text>}
        {handoff ? <Text style={styles.speaker}>{t('message.voiceCall.handoff.' + handoff.state)}</Text>
          : turn.failed && turn.role === 'user' && <Text style={styles.speaker}>{t('message.voiceCall.sendFailed')}</Text>}
      </View>
    );
  });
  return (
    <View style={styles.transcript}>
      {entries}
      {Array.from(handoffs.values(), handoff => (
        <View key={handoff.id} style={styles.turn}>
          <Text style={styles.speaker}>{t('message.voiceCall.you')}</Text>
          <Text selectable style={styles.body}>{handoff.text}</Text>
          <Text style={styles.speaker}>{t('message.voiceCall.handoff.' + handoff.state)}</Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: { alignSelf: 'center', width: '100%', maxWidth: 580, borderRadius: radius.container,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, gap: spacing.sm },
  pressed: { backgroundColor: colors.surfaceChip },
  summary: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: spacing.sm },
  title: { ...textStyles.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  metadata: { ...textStyles.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  time: { maxWidth: '45%', textAlign: 'right' },
  transcript: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.md },
  turn: { gap: spacing.xs },
  speaker: { ...textStyles.footnote, color: colors.textSecondary },
  body: { ...textStyles.bodyLarge, color: colors.textPrimary },
});
