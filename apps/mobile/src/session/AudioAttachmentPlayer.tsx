import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Airplay, AudioLines, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { AnchoredPullDownMenu } from '@/platform/chrome/AnchoredPullDownMenu';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome';
import { fontWeight, iconSize, iconStroke, radius, spacing, textStyles, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { AudioPlayerSymbol } from './AudioPlayerSymbol';
import { AudioPlayerButton } from './AudioPlayerButton';
import { AudioPlayerToolbar } from './AudioPlayerToolbar';
import { AudioPlayerScrubber } from './AudioPlayerScrubber';
import { RemoteMediaPlayerWebView, type AudioPlaybackControls } from './mediaPlayerWebView';
import { AUDIO_PLAYBACK_RATES, type MobileMediaPlayerStatus } from './mediaPlayerWebViewHtml';

const SKIP_SECONDS = 10;

export function AudioAttachmentPlayer({
  name,
  source,
  readFailed,
  onStatusChange,
  onRetry,
}: {
  name: string;
  source: { url: string; mimeType?: string } | null;
  readFailed: boolean;
  onStatusChange(status: MobileMediaPlayerStatus): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const controls = useRef<AudioPlaybackControls>(null);
  const [status, setStatus] = useState<MobileMediaPlayerStatus | null>(null);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const failed = readFailed || status?.state === 'error';
  const playing = status?.state === 'playing' || (status?.state === 'waiting' && status.paused === false);
  // iOS can stop preloading at metadata until the user requests play.
  const loading = !status || (status.state === 'waiting' && !playing && !status.canStart);
  const duration = status?.duration ?? 0;
  const canSeek = !failed && status?.canSeek === true && duration > 0;
  const clampTime = (seconds: number) => Math.max(0, Math.min(seconds, duration));
  const currentTime = status?.currentTime ?? 0;
  const time = duration > 0 ? clampTime((canSeek ? dragTime : null) ?? currentTime) : currentTime;
  const elapsed = formatAudioTime(time);
  const total = duration > 0 ? formatAudioTime(duration) : '––:––';
  const progressLabel = t('message.attachmentPreview.audioProgress');
  const progressValue = `${elapsed} / ${total}`;
  const audioLabel = t('message.payloadPresentation.audio');
  const ToggleIcon = playing ? Pause : Play;
  const MutedIcon = status?.muted ? VolumeX : Volume2;
  const muteColor = loading ? colors.textTertiary : status?.muted ? colors.textPrimary : colors.textSecondary;
  const rate = status?.rate ?? 1;
  const showRoute = Platform.OS === 'ios' && status?.canRoute === true && !loading;
  const routeLabel = t('message.attachmentPreview.audioOutput');
  const RateMenu = usesNativePullDownMenu() ? NativePullDownMenu : AnchoredPullDownMenu;
  const speedLabel = t('message.attachmentPreview.audioSpeed');
  const speedButton = (
    <Pressable accessibilityRole="button"
      accessibilityLabel={speedLabel}
      accessibilityValue={{ text: `${rate}×` }}
      disabled={loading} style={styles.auxControl} testID="message.audioSpeed"
    >
      <Text style={[styles.speed, loading && styles.disabledText]}>{rate}×</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.panel}>
          <View style={styles.identity}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
              <AudioPlayerSymbol name="waveform" size={iconSize.glyph} color={colors.borderStrong}>
                <AudioLines size={iconSize.glyph} color={colors.borderStrong} strokeWidth={iconStroke.bold} absoluteStrokeWidth />
              </AudioPlayerSymbol>
            </View>
            <Text testID="message.audioTitle" accessibilityRole="header" accessibilityLabel={name}
              numberOfLines={3} style={styles.title}>{name}</Text>
          </View>
          {failed ? (
            <View style={styles.failure}>
              <Text accessibilityLiveRegion="polite" style={styles.status}>
                {readFailed ? t('files.preview.readFailed')
                  : t('message.renderer.mediaError', { label: audioLabel, error: '' })}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
                testID="message.attachmentPreviewRetry"
              >
                <Text style={styles.retryText}>{t('message.attachmentPreview.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View style={styles.timeline}>
                <AudioPlayerScrubber
                  enabled={canSeek}
                  time={time}
                  duration={duration}
                  label={progressLabel}
                  valueText={progressValue}
                  onPreview={setDragTime}
                  onSeek={(target) => controls.current?.seek(clampTime(target))}
                />
                <View style={styles.times}>
                  <Text testID="message.audioElapsed" style={styles.time}>{elapsed}</Text>
                  <Text testID="message.audioDuration" style={styles.time}>{total}</Text>
                </View>
              </View>
              <View style={styles.primaryControls}>
                <SkipButton direction="back" disabled={!canSeek}
                  onPress={() => controls.current?.skip(-SKIP_SECONDS)} />
                <AudioPlayerButton
                  label={t(loading ? 'message.renderer.loading' :
                    playing ? 'message.attachmentPreview.pauseAudio' : 'message.renderer.playAudio')}
                  symbol={playing ? 'pause.fill' : 'play.fill'} size={iconSize.xxl}
                  width={64} height={64} primary loading={loading}
                  disabled={loading}
                  onPress={() => playing ? controls.current?.pause() : controls.current?.play()}
                  style={loading ? { ...styles.toggle, ...styles.loading } : styles.toggle}
                  testID="message.audioToggle"
                >
                  {loading
                    ? <ActivityIndicator size="small" color={colors.textSecondary} />
                    : <ToggleIcon size={iconSize.xxl} color={colors.ctaText} fill={colors.ctaText}
                        style={playing ? undefined : styles.playGlyph} />}
                </AudioPlayerButton>
                <SkipButton direction="forward" disabled={!canSeek}
                  onPress={() => controls.current?.skip(SKIP_SECONDS)} />
              </View>
              {status?.state === 'waiting' && playing ? (
                <Text accessibilityLiveRegion="polite" style={styles.status}>
                  {t('message.renderer.mediaBuffering', { label: audioLabel, progress: '' })}
                </Text>
              ) : null}
            </>
          )}
        </View>
      </ScrollView>
      {!failed && (
        <AudioPlayerToolbar>
          {loading ? speedButton : (
            <RateMenu
              accessibilityLabel={speedLabel}
              actions={AUDIO_PLAYBACK_RATES.map((choice) => ({
                id: String(choice), title: `${choice}×`, state: choice === rate ? 'on' : 'off',
              }))}
              onAction={(id) => controls.current?.rate(Number(id))}
              testID="message.audioSpeedMenu"
            >
              {speedButton}
            </RateMenu>
          )}
          <AudioPlayerButton
            label={t(status?.muted ? 'message.attachmentPreview.audioUnmute' : 'message.attachmentPreview.audioMute')}
            symbol={status?.muted ? 'speaker.slash' : 'speaker.wave.2'} size={iconSize.action}
            width={48} height={44}
            disabled={loading}
            onPress={() => controls.current?.mute(!status?.muted)}
            style={styles.auxControl}
            testID="message.audioMute"
          >
            <MutedIcon size={iconSize.action} color={muteColor} />
          </AudioPlayerButton>
          {source ? (
            <View
              accessibilityElementsHidden={!showRoute}
              importantForAccessibility={showRoute ? 'auto' : 'no-hide-descendants'}
              pointerEvents={showRoute ? 'auto' : 'none'}
              style={showRoute ? styles.auxControl : styles.hiddenTransport}
              testID="message.audioRoute"
            >
              <RemoteMediaPlayerWebView
                kind="audio"
                audioControlsRef={controls}
                audioRouteLabel={Platform.OS === 'ios' ? routeLabel : undefined}
                url={source.url}
                mimeType={source.mimeType?.startsWith('audio/') ? source.mimeType : undefined}
                title={name}
                testID="message.attachmentAudioPlayer"
                style={StyleSheet.absoluteFill}
                onStatusChange={(next) => {
                  setStatus((previous) => previous?.state === 'error' ? previous : next);
                  if (!next.canSeek) setDragTime(null);
                  onStatusChange(next);
                }}
              />
              {showRoute ? (
                <View pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
                  <AudioPlayerSymbol name="airplay.audio" size={iconSize.action} color={status?.wireless ? colors.textPrimary : colors.textSecondary}>
                    <Airplay size={iconSize.action} color={status?.wireless ? colors.textPrimary : colors.textSecondary} />
                  </AudioPlayerSymbol>
                </View>
              ) : null}
            </View>
          ) : null}
        </AudioPlayerToolbar>
      )}
    </View>
  );
}

function SkipButton({ direction, disabled, onPress }: {
  direction: 'back' | 'forward';
  disabled: boolean;
  onPress(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const back = direction === 'back';
  const Icon = back ? RotateCcw : RotateCw;
  const color = disabled ? colors.textTertiary : colors.textPrimary;
  return (
    <AudioPlayerButton
      label={t(back ? 'message.attachmentPreview.audioBackTen' : 'message.attachmentPreview.audioForwardTen')}
      symbol={back ? 'gobackward.10' : 'goforward.10'} size={iconSize.xxl} width={48} height={48}
      disabled={disabled}
      onPress={onPress}
      style={styles.skip}
      testID={back ? 'message.audioBackTen' : 'message.audioForwardTen'}
    >
      <Icon size={iconSize.xxl} color={color} />
      <Text style={[styles.skipNumber, disabled && styles.disabledText]}>{SKIP_SECONDS}</Text>
    </AudioPlayerButton>
  );
}

function formatAudioTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const clock = [minutes % 60, whole % 60].map((part) => String(part).padStart(2, '0')).join(':');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${clock}` : clock;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  hiddenTransport: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  content: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  panel: { width: '100%', maxWidth: 368, alignItems: 'center', gap: spacing.xl, paddingVertical: spacing.lg },
  identity: { alignSelf: 'stretch', alignItems: 'center', gap: spacing.lg },
  title: { ...textStyles.headline, fontWeight: fontWeight.semibold, color: colors.textPrimary, textAlign: 'center' },
  timeline: { alignSelf: 'stretch' },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { ...textStyles.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  toggle: {
    width: 64, height: 64, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.pill, backgroundColor: colors.cta,
  },
  playGlyph: { transform: [{ translateX: 1 }] },
  primaryControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  auxControl: { width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  skip: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  skipNumber: {
    ...textStyles.micro, position: 'absolute', marginTop: 4, color: colors.textPrimary, fontWeight: fontWeight.medium,
  },
  speed: { ...textStyles.bodySmall, color: colors.textSecondary, fontWeight: fontWeight.medium, fontVariant: ['tabular-nums'] },
  disabledText: { color: colors.textTertiary, fontWeight: fontWeight.regular },
  loading: { backgroundColor: colors.surfaceChip },
  failure: { alignItems: 'center', gap: spacing.sm },
  status: { ...textStyles.footnote, color: colors.textSecondary, textAlign: 'center' },
  retry: {
    minHeight: 44, paddingHorizontal: spacing.xl, justifyContent: 'center',
    borderRadius: radius.pill, backgroundColor: colors.surfaceChip,
  },
  retryText: { ...textStyles.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  pressed: { opacity: 0.72 },
});
