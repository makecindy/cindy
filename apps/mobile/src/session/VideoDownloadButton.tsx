import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react-native';
import { useIsFocused } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, spacing, typeScale } from '@/theme/tokens';
import { shareMimeForFileName } from './fileBrowserActions';
import { extOfMime } from './remoteMediaDiskCache';
import { downloadRemoteMediaShareTemp } from './remoteMediaDiskCacheExpo';
import { createTransferProgressMeter, formatTransferProgress } from './transferProgress';

/** Export a separate local copy so the OS sheet outlives the preview's cache lease. */
export function VideoDownloadButton({ source, mimeType, active = true, immersive = false }: {
  source: string | null;
  mimeType?: string;
  active?: boolean;
  immersive?: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { accountGeneration } = useAuth();
  const focused = useIsFocused();
  const enabled = active && focused;
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  useEffect(() => {
    setBusy(false);
    setProgress('');
    return () => { pending.current?.abort(); pending.current = null; };
  }, [source, enabled, accountGeneration]);

  const download = async () => {
    if (!source || !enabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setProgress('');
    const meter = createTransferProgressMeter();
    const sourcePath = source.split(/[?#]/, 1)[0];
    const inferred = shareMimeForFileName(sourcePath);
    const inlineMime = /^data:(video\/[\w.+-]+);/i.exec(source)?.[1].toLowerCase();
    const mime = mimeType?.split(';', 1)[0].trim().toLowerCase()
      || inlineMime
      || (inferred.startsWith('video/') ? inferred : 'video/mp4');
    const ext = mime === 'video/x-m4v' ? 'm4v' : extOfMime(mime);
    try {
      // File export cannot turn a streaming playlist into a standalone video.
      // Keep the existing failure path rather than handing the OS a fake MP4.
      if (/\.(?:m3u8?|mpd)$/i.test(sourcePath)
        || /^(?:(?:application|audio|video)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|application\/dash\+xml)$/.test(mime)) {
        throw new Error('STREAMING_MANIFEST_NOT_DOWNLOADABLE');
      }
      const local = await downloadRemoteMediaShareTemp(source, mime, `video.${ext === 'img' ? 'mp4' : ext}`,
        controller.signal, (loaded, total) => {
          const sample = meter(loaded, total);
          if (!controller.signal.aborted && total > 0) setProgress(formatTransferProgress(sample));
        });
      if (controller.signal.aborted) return;
      if (!local) throw new Error('DOWNLOAD_FAILED');
      const Sharing = await import('expo-sharing');
      if (controller.signal.aborted) return;
      await Sharing.shareAsync(local, { mimeType: mime });
    } catch {
      if (!controller.signal.aborted) Alert.alert(t('files.preview.downloadFailed'));
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); setProgress(''); }
    }
  };
  // Lightbox is an intentionally black immersive surface, like its other controls.
  const color = immersive ? '#ffffff' : colors.textPrimary;
  return <Pressable accessibilityRole="button" accessibilityLabel={t('message.richAnswer.downloadVideo')}
    accessibilityState={{ busy, disabled: !source || !enabled || busy }}
    disabled={!source || !enabled || busy} onPress={() => { void download(); }} testID="message.videoDownload"
    style={{ minHeight: 44, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center',
      justifyContent: 'center', gap: spacing.sm, opacity: source ? 1 : 0.5 }}>
    {busy ? <ActivityIndicator color={color} /> : <Download color={color} size={iconSize.action} strokeWidth={iconStroke.regular} />}
    <Text style={{ color, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium }}>
      {busy ? progress || t('message.renderer.loading') : t('message.richAnswer.downloadVideo')}
    </Text>
  </Pressable>;
}
