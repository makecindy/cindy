import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ArrowDown, Play, RefreshCw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { fontWeight, iconSize, iconStroke, radius, spacing, textStyles, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { MessageContentOpenButton } from './MessageContentOpenButton';
import type { AudioAttachmentPhase } from './messagePayload';
import type { ResolvedPreviewFile } from './RemoteAttachmentPreview';

const MIN_AUDIO_CARD_WIDTH = 152;
const MAX_AUDIO_CARD_WIDTH = 320;

export function AudioAttachmentCard({ title, needsFetch, availableWidth, align = 'left', presentationOnly, prepare, onOpen }: {
  title: string;
  needsFetch: boolean;
  availableWidth: number;
  align?: 'left' | 'right';
  presentationOnly?: boolean;
  prepare?: (signal: AbortSignal, forceRefresh: boolean) => Promise<ResolvedPreviewFile>;
  onOpen?: (reportPhase: (phase: AudioAttachmentPhase) => void, source?: ResolvedPreviewFile) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [phase, setPhase] = useState<AudioAttachmentPhase>('idle');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const loading = phase === 'loading';
  const failed = phase === 'error';
  const fetchNeeded = needsFetch && phase !== 'ready';
  const open = async () => {
    if (!onOpen || pending.current) return;
    if (!prepare) {
      onOpen(setPhase);
      return;
    }
    const request = new AbortController();
    pending.current = request;
    setPhase('loading');
    mobileDebugLog('debug', 'files', 'audio attachment card fetch start', { retry: failed });
    try {
      const source = await prepare(request.signal, failed);
      if (!request.signal.aborted) onOpen(setPhase, source);
    } catch {
      if (!request.signal.aborted) {
        setPhase('error');
        mobileDebugLog('warn', 'files', 'audio attachment card fetch failed', { retry: failed });
      }
    } finally {
      pending.current = null;
    }
  };
  const action = loading ? t('message.renderer.loading')
    : failed ? t('message.attachmentPreview.retry')
    : fetchNeeded ? t('message.attachmentPreview.fetchAudio')
    : t('message.renderer.playAudio');
  const Icon = failed ? RefreshCw : fetchNeeded ? ArrowDown : Play;
  const filled = !loading && !failed && !fetchNeeded;
  const maxWidth = Math.min(MAX_AUDIO_CARD_WIDTH, availableWidth);
  return (
    <MessageContentOpenButton
      presentationOnly={presentationOnly}
      accessibilityLabel={`${title}, ${action}`}
      busy={loading}
      onPress={onOpen ? open : undefined}
      style={[styles.card, {
        alignSelf: align === 'right' ? 'flex-end' : 'flex-start',
        minWidth: Math.min(MIN_AUDIO_CARD_WIDTH, maxWidth),
        maxWidth,
      }]}
      testID="message.audioAttachmentCard"
    >
      <View style={[styles.control, filled && styles.filledControl]} accessible={false}>
        {loading ? <ActivityIndicator color={colors.textSecondary} /> : (
          <Icon size={iconSize.lg} strokeWidth={iconStroke.regular} color={filled ? colors.ctaText : colors.textPrimary}
            fill={filled ? colors.ctaText : 'none'} />
        )}
      </View>
      <View style={styles.information}>
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">{title}</Text>
        <Text style={styles.status} numberOfLines={1}>{action}</Text>
      </View>
    </MessageContentOpenButton>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  control: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  filledControl: { backgroundColor: colors.cta },
  information: { flexShrink: 1, minWidth: 0, gap: spacing.xs },
  title: { ...textStyles.bodySmall, color: colors.textPrimary, fontWeight: fontWeight.medium },
  status: { ...textStyles.footnote, color: colors.textSecondary },
});
