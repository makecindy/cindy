import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { Airplay, AudioLines, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/AppText';
import { AnchoredPullDownMenu } from '@/platform/chrome/AnchoredPullDownMenu';
import { NativePullDownMenu, usesNativePullDownMenu } from '@/platform/chrome';
import { fontWeight, radius, spacing, textStyles, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { RemoteMediaPlayerWebView, type AudioPlaybackControls } from './mediaPlayerWebView';
import { AUDIO_PLAYBACK_RATES, type MobileMediaPlayerStatus } from './mediaPlayerWebViewHtml';

const THUMB_SIZE = 12;
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
  const [trackWidth, setTrackWidth] = useState(0);
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
  const trackLength = Math.max(0, trackWidth - THUMB_SIZE);
  const position = duration > 0 ? (time / duration) * trackLength : 0;
  const timeAtTouch = (event: GestureResponderEvent) =>
    clampTime(((event.nativeEvent.locationX - THUMB_SIZE / 2) / trackLength) * duration);
  const elapsed = formatAudioTime(time);
  const total = duration > 0 ? formatAudioTime(duration) : '––:––';
  const audioLabel = t('message.payloadPresentation.audio');
  const ToggleIcon = playing ? Pause : Play;
  const MutedIcon = status?.muted ? VolumeX : Volume2;
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
          <View style={styles.mark} accessible={false}>
            <AudioLines size={34} color={colors.textSecondary} />
          </View>
          <Text testID="message.audioTitle" accessibilityRole="header" accessibilityLabel={name}
            numberOfLines={3} style={styles.title}>{name}</Text>
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
                <View
                  accessible={canSeek}
                  accessibilityRole="adjustable"
                  accessibilityLabel={t('message.attachmentPreview.audioProgress')}
                  accessibilityValue={{ text: `${elapsed} / ${total}` }}
                  accessibilityActions={canSeek ? [{ name: 'increment' }, { name: 'decrement' }] : undefined}
                  onAccessibilityAction={({ nativeEvent: { actionName } }) => {
                    if (canSeek && (actionName === 'increment' || actionName === 'decrement')) {
                      const step = Math.min(10, duration / 10);
                      controls.current?.seek(clampTime(time + (actionName === 'increment' ? step : -step)));
                    }
                  }}
                  onLayout={({ nativeEvent }) => setTrackWidth(nativeEvent.layout.width)}
                  onStartShouldSetResponder={() => canSeek && trackLength > 0}
                  onResponderTerminationRequest={() => false}
                  onResponderGrant={(event) => setDragTime(timeAtTouch(event))}
                  onResponderMove={(event) => setDragTime(timeAtTouch(event))}
                  onResponderRelease={(event) => {
                    setDragTime(null);
                    if (canSeek && trackLength > 0) controls.current?.seek(timeAtTouch(event));
                  }}
                  onResponderTerminate={() => setDragTime(null)}
                  style={styles.trackHit}
                  testID="message.audioProgress"
                >
                  <View pointerEvents="none" style={styles.rail}>
                    <View style={[styles.fill, { width: position }]} />
                  </View>
                  {canSeek && trackLength > 0
                    ? <View pointerEvents="none" style={[styles.thumb, { left: position }]} />
                    : null}
                </View>
                <View style={styles.times}>
                  <Text testID="message.audioElapsed" style={styles.time}>{elapsed}</Text>
                  <Text testID="message.audioDuration" style={styles.time}>{total}</Text>
                </View>
              </View>
              <View style={styles.primaryControls}>
                <SkipButton direction="back" disabled={!canSeek}
                  onPress={() => controls.current?.skip(-SKIP_SECONDS)} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(loading ? 'message.renderer.loading' :
                    playing ? 'message.attachmentPreview.pauseAudio' : 'message.renderer.playAudio')}
                  accessibilityState={{ disabled: loading, busy: loading }}
                  disabled={loading}
                  onPress={() => playing ? controls.current?.pause() : controls.current?.play()}
                  style={({ pressed }) => [styles.toggle, loading && styles.loading, pressed && styles.pressed]}
                  testID="message.audioToggle"
                >
                  {loading
                    ? <ActivityIndicator color={colors.textSecondary} />
                    : <ToggleIcon size={26} color={colors.ctaText} fill={colors.ctaText} />}
                </Pressable>
                <SkipButton direction="forward" disabled={!canSeek}
                  onPress={() => controls.current?.skip(SKIP_SECONDS)} />
              </View>
              <View style={styles.secondaryControls}>
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(status?.muted ? 'message.attachmentPreview.audioUnmute' : 'message.attachmentPreview.audioMute')}
                  disabled={loading}
                  onPress={() => controls.current?.mute(!status?.muted)}
                  style={({ pressed }) => [styles.auxControl, pressed && styles.pressed]}
                  testID="message.audioMute"
                >
                  <MutedIcon size={20} color={loading ? colors.textTertiary : colors.textSecondary} />
                </Pressable>
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
                        <Airplay size={20} color={status?.wireless ? colors.textPrimary : colors.textSecondary} />
                      </View>
                    ) : null}
                  </View>
                ) : null}
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(back ? 'message.attachmentPreview.audioBackTen' : 'message.attachmentPreview.audioForwardTen')}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.skip, pressed && styles.pressed]}
      testID={back ? 'message.audioBackTen' : 'message.audioForwardTen'}
    >
      <Icon size={29} color={disabled ? colors.textTertiary : colors.textPrimary} />
      <Text style={[styles.skipNumber, disabled && styles.disabledText]}>{SKIP_SECONDS}</Text>
    </Pressable>
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
  mark: {
    width: 80, height: 80, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.container, backgroundColor: colors.surfaceChip,
  },
  title: { ...textStyles.headline, fontWeight: fontWeight.semibold, color: colors.textPrimary, textAlign: 'center' },
  timeline: { alignSelf: 'stretch' },
  trackHit: { height: 44, justifyContent: 'center' },
  rail: { marginHorizontal: THUMB_SIZE / 2, height: 4, borderRadius: radius.pill, backgroundColor: colors.borderStrong },
  fill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.textPrimary },
  thumb: { position: 'absolute', width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: radius.pill, backgroundColor: colors.textPrimary },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  time: { ...textStyles.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'] },
  toggle: {
    width: 64, height: 64, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.pill, backgroundColor: colors.cta,
  },
  primaryControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  secondaryControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
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
