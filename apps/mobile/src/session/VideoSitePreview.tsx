import { useIsFocused } from 'expo-router';
import { typeScale, lineHeight } from '@/theme/tokens';
import { useEffect, useState } from 'react';
import { Image, Linking, Pressable, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Application from 'expo-application';
import { useTranslation } from 'react-i18next';
import { youtubeVideo } from '@cindy/maker-shared/rich-answer';
import { Text } from '@/components/AppText';
import { useTheme } from '@/theme';
import { allowWebsiteNavigation } from './browserAddress';
import { registerMobileMessageWebView } from './mobileMessageWebViewMetrics';

export function VideoSitePreview({ src, title }: { src: string; title: string }) {
  const video = youtubeVideo(src);
  return video ? <YoutubePreview key={video.embed} video={video} title={title} /> : null;
}
function YoutubePreview({ video, title }: { video: NonNullable<ReturnType<typeof youtubeVideo>>; title: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const focused = useIsFocused();
  const [active, setActive] = useState(false);
  const [width, setWidth] = useState(0);
  useEffect(() => active ? registerMobileMessageWebView('media') : undefined, [active]);
  useEffect(() => { if (!focused) setActive(false); }, [focused]);
  const textStyle = { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall };
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {active ? <WebView
      key={video.embed}
      source={{ uri: video.embed, headers: { Referer: `https://${Application.applicationId ?? 'com.xd.cindy'}/` } }}
      style={{ width: '100%', height: Math.max(200, width * 9 / 16), backgroundColor: colors.surface }}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      javaScriptEnabled
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      mediaPlaybackRequiresUserAction
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      originWhitelist={['*']}
      setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={request => allowWebsiteNavigation(request.url)}
      onError={() => setActive(false)}
      onContentProcessDidTerminate={() => setActive(false)}
    /> : <Pressable accessibilityRole="button" accessibilityLabel={t('message.richAnswer.playVideo')} onPress={() => setActive(true)}>
      <Image source={{ uri: video.poster }} accessibilityLabel={title} style={{ width: '100%', aspectRatio: 16 / 9 }} resizeMode="contain" />
      <Text style={textStyle}>{t('message.richAnswer.playVideo')}</Text>
    </Pressable>}
    <Pressable style={{ minHeight: 44, justifyContent: 'center' }} accessibilityRole="link" onPress={() => { void Linking.openURL(video.watch).catch(() => undefined); }}>
      <Text style={[textStyle, { textDecorationLine: 'underline' }]}>{t('message.richAnswer.openVideoSource')}</Text>
    </Pressable>
  </View>;
}
