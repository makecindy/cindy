import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { NativeVideoPlayer } from './NativeVideoPlayer';
import { useMessageHistoryActive } from './messageHistoryActivity';
import { isDirectPreviewableMediaUrl, type ResolveRemoteMediaFn } from './remoteMedia';

/** Resolve on explicit play, including files outside the task directory. The
 * existing Host file service still validates origin, path and media type. */
export function InlineVideoPlayer({ url, label, width, visible, resolve }: {
  url: string;
  label: string;
  width: number;
  visible: boolean;
  resolve?: ResolveRemoteMediaFn;
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

  const play = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    const forceRefresh = failed;
    setFailed(false);
    try {
      let next = url;
      let protectLocalFile: (() => () => void) | undefined;
      if (!isDirectPreviewableMediaUrl(url)) {
        if (!resolve) throw new Error('No media resolver');
        const media = await resolve({ kind: 'video', url, previewable: false },
          { front: true, forceRefresh, signal: controller.signal });
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
  };
  const ratio = videoSize ? videoSize.width / videoSize.height : 16 / 9;
  // Fit the actual picture, rather than putting every movie in a black 16:9 box.
  // Tall clips shrink proportionally instead of consuming the entire message list.
  const height = Math.min(width / ratio, width * 4 / 3);
  const frame = { width: Math.min(width, height * ratio), height, borderRadius: radius.container, overflow: 'hidden' as const };
  if (source) return <NativeVideoPlayer key={source} url={source} visible={active} autoPlay
    onVideoSize={setVideoSize}
    style={[frame, { flex: 0, backgroundColor: colors.surface }]} testID="message.inlineVideo"
    onError={() => { releaseSource.current?.(); releaseSource.current = undefined; setSource(null); setFailed(true); }} />;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${t('message.richAnswer.playVideo')} ${label}`}
    disabled={loading} onPress={() => { void play(); }} testID="message.inlineVideoPlay"
    style={[frame, { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.surface }]}>
    {loading ? <ActivityIndicator color={colors.textSecondary} />
      : <Play size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textPrimary} />}
    <View><Text style={{ color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall }}>
      {t(loading ? 'message.renderer.loading' : failed ? 'message.renderer.retryPreview' : 'message.richAnswer.playVideo')}
    </Text></View>
  </Pressable>;
}
