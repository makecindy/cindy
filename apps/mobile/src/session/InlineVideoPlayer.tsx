import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { NativeVideoPlayer } from './NativeVideoPlayer';
import { useMessageHistoryActive } from './messageHistoryActivity';
import { isDirectPreviewableMediaUrl, type ResolveRemoteMediaFn } from './remoteMedia';

/** Message cover only: prepare a paused first frame, keep a visible play mark,
 * and open the existing image/video gallery. Playback and export live there. */
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
  const [source, setSource] = useState<string | null>(null);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
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
    if (!active) { pending.current?.abort(); pending.current = null; setLoading(false); }
  }, [active]);

  const prepare = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      let next = url;
      let protectLocalFile: (() => () => void) | undefined;
      if (!isDirectPreviewableMediaUrl(url)) {
        if (!resolve) throw new Error('No media resolver');
        const media = await resolve({ kind: 'video', url, previewable: false },
          { front: false, signal: controller.signal });
        if (!media.previewable || !media.mimeType.startsWith('video/')) throw new Error('Not video');
        next = media.url;
        protectLocalFile = media.protectLocalFile;
      }
      if (!controller.signal.aborted) {
        releaseSource.current?.();
        releaseSource.current = protectLocalFile?.();
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
  return <Pressable accessibilityRole="button" accessibilityLabel={`${t('message.richAnswer.playVideo')} ${label}`}
    onPress={onOpen} testID="message.inlineVideoPlay"
    style={[frame, { alignSelf: 'flex-start', backgroundColor: colors.surface }]}>
    {source ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <NativeVideoPlayer key={source} url={source} visible={active} autoPlay={false} nativeControls={false}
        onVideoSize={setVideoSize}
        style={[frame, { flex: 0, backgroundColor: colors.surface }]} testID="message.inlineVideo"
        onError={() => { releaseSource.current?.(); releaseSource.current = undefined; setSource(null); setFailed(true); }} />
    </View> : null}
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: spacing.sm }]}>
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
    </View>
  </Pressable>;
}
