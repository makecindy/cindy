import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { VideoDownloadButton } from './VideoDownloadButton';
import { NativeVideoPlayer } from './NativeVideoPlayer';
import { useMessageHistoryActive } from './messageHistoryActivity';
import { isDirectPreviewableMediaUrl, type ResolveRemoteMediaFn } from './remoteMedia';

/** Prepare a paused first frame; an explicit tap starts playback in the message. */
export function InlineVideoPlayer({ url, label, width, visible, resolve, onOpen }: {
  url: string;
  label: string;
  width: number;
  visible: boolean;
  resolve?: ResolveRemoteMediaFn;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const focused = useIsFocused();
  const historyActive = useMessageHistoryActive();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [mimeType, setMimeType] = useState<string | undefined>();
  const [source, setSource] = useState<string | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const releaseSource = useRef<(() => void) | undefined>(undefined);
  const active = visible && focused && historyActive && foreground;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => { subscription.remove(); pending.current?.abort(); releaseSource.current?.(); };
  }, []);
  useEffect(() => {
    if (!active) {
      pending.current?.abort(); pending.current = null; setLoading(false);
      // A cancelled preparation must not hand an old play tap to a future source.
      if (!source) setStarted(false);
    }
  }, [active, source]);

  const prepare = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      let next = url;
      let nextMime: string | undefined;
      let protectLocalFile: (() => () => void) | undefined;
      if (!isDirectPreviewableMediaUrl(url)) {
        if (!resolve) throw new Error('No media resolver');
        const media = await resolve({ kind: 'video', url, previewable: false },
          { front: false, signal: controller.signal });
        if (!media.previewable || !media.mimeType.startsWith('video/')) throw new Error('Not video');
        next = media.url;
        nextMime = media.mimeType;
        protectLocalFile = media.protectLocalFile;
      }
      if (!controller.signal.aborted) {
        releaseSource.current?.();
        releaseSource.current = protectLocalFile?.();
        setMimeType(nextMime);
        setSource(next);
      }
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [resolve, url]);
  const canPreparePreview = isDirectPreviewableMediaUrl(url) || /^(?:cindy-(?:remote-)?media|xdt-video):\/\//i.test(url);
  useEffect(() => {
    if (active && canPreparePreview && !source && !failed) void prepare();
  }, [active, canPreparePreview, source, failed, prepare]);
  const ratio = videoSize ? videoSize.width / videoSize.height : 16 / 9;
  // Fit the actual picture, rather than putting every movie in a black 16:9 box.
  // Tall clips shrink proportionally instead of consuming the entire message list.
  const previewWidth = Math.min(width, 480);
  const height = Math.min(previewWidth / ratio, previewWidth * 4 / 3);
  const frame = { width: Math.min(previewWidth, height * ratio), height, borderRadius: radius.container, overflow: 'hidden' as const };
  return <View style={{ alignSelf: 'flex-start' }}>
    <View style={[frame, { backgroundColor: colors.surface }]}>
    {source ? <View pointerEvents={started ? 'auto' : 'none'} accessibilityElementsHidden={!started}
      importantForAccessibility={started ? 'auto' : 'no-hide-descendants'}>
      <NativeVideoPlayer key={source} url={source} visible={active} autoPlay={started} nativeControls={started}
        onVideoSize={setVideoSize}
        style={[frame, { flex: 0, backgroundColor: colors.surface }]} testID="message.inlineVideo"
        onError={() => { releaseSource.current?.(); releaseSource.current = undefined; setSource(null); setFailed(true); }} />
    </View> : null}
    {!started || !source ? <Pressable accessibilityRole="button"
      accessibilityLabel={`${t('message.richAnswer.playVideo')} ${label}`}
      testID="message.inlineVideoPlay" onPress={() => {
        if (failed) { onOpen?.(); return; }
        setStarted(true);
        if (!source) void prepare();
      }} style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: spacing.sm }]}>
      {/* Media-overlay contrast stays readable over either a light or dark frame. */}
      <View style={{ width: 56, height: 56, borderRadius: radius.pill, backgroundColor: colors.mediaPlayBackground, alignItems: 'center', justifyContent: 'center' }}>
        <Play size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.mediaPlayForeground} fill={colors.mediaPlayForeground} />
      </View>
      {!source ? <View style={{ alignItems: 'center', gap: spacing.sm }}>
        {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
        <Text style={{ color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall }}>
          {t(loading ? 'message.renderer.loading' : 'message.richAnswer.playVideo')}
        </Text>
      </View> : null}
    </Pressable> : null}
    </View>
    {source ? <VideoDownloadButton source={source} mimeType={mimeType} active={active} /> : null}
  </View>;
}
