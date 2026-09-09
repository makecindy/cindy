import { useEffect, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import type { RemoteResourceAvatar } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { resolveMobileRemoteMedia, type MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { useTheme } from '@/theme';
import { radius, typeScale } from '@/theme/tokens';

const presets: Record<string, number> = {
  'cindy://avatar/preset/cindy': require('../../assets/bot-presets/cindy.png'),
  'cindy://avatar/preset/dash': require('../../assets/bot-presets/dash.png'),
  'cindy://avatar/preset/lizi': require('../../assets/bot-presets/lizi.png'),
};

export function RemoteCompanionAvatar({ avatar, deviceId, name, online }: { avatar?: RemoteResourceAvatar; deviceId: string; name: string; online: boolean }) {
  const { colors } = useTheme();
  const auth = useAuth();
  const { invoke } = useDeviceLink();
  const value = avatar?.value || '';
  const binding = `${auth.accountGeneration}:${deviceId}:${value}`;
  const [image, setImage] = useState<{ binding: string; uri: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (avatar?.kind !== 'media' || !online) return;
    const maker = createMobileMakerTransport({ deviceId, invoke });
    void resolveMobileRemoteMedia({ kind: 'image', url: value }, {
      fetchRemoteMedia: maker.fetchRemoteMedia,
      presignGet: (key) => auth.apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', { baseUrl: DEVICE_LINK_API_BASE_URL, method: 'POST', body: { key } }),
    }, { thumbnail: true }).then((result) => {
      if (!cancelled && result.previewable && result.mimeType.startsWith('image/')) setImage({ binding, uri: result.url });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [auth.apiFetch, avatar?.kind, binding, deviceId, invoke, online, value]);
  const source = presets[value] || (image?.binding === binding ? { uri: image.uri } : null);
  if (source && !failed) return <Image source={source} onError={() => setFailed(true)} style={styles.image} />;
  return <Text style={{ color: colors.textPrimary, fontSize: typeScale.body }}>{avatar?.kind === 'emoji' ? value : avatar?.fallbackText || Array.from(name)[0]}</Text>;
}
const styles = StyleSheet.create({ image: { width: 40, height: 40, borderRadius: radius.pill } });
