import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { RemoteResourceAvatar } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { createMobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { resolveMobileRemoteMedia, type MobileRemoteMediaPresignResult } from '@/session/remoteMedia';
import { DEVICE_LINK_API_BASE_URL, getActiveMobileSessionRealm } from '@/config/env';
import { createPeerFileCache } from '@/device-link/peerFileCache';
import { useTheme } from '@/theme';
import { lineHeight, radius, typeScale } from '@/theme/tokens';

const presets: Record<string, number> = {
  'cindy://avatar/preset/cindy': require('../../assets/bot-presets/cindy.png'),
  'cindy://avatar/preset/dash': require('../../assets/bot-presets/dash.png'),
  'cindy://avatar/preset/lizi': require('../../assets/bot-presets/lizi.png'),
};

/** `framed` draws its own circle for callers without an avatar container (inline rows and status lines). */
export function RemoteCompanionAvatar({ avatar, imageUrl, deviceId, name, online, size = 40, framed = false }: { avatar?: RemoteResourceAvatar; imageUrl?: string | null; deviceId: string; name: string; online: boolean; size?: number; framed?: boolean }) {
  const { colors } = useTheme();
  const auth = useAuth();
  const { invoke } = useDeviceLink();
  const value = avatar?.value || '';
  const realm = getActiveMobileSessionRealm();
  const owner = JSON.stringify([realm, auth.user?.id ?? '']);
  const identity = JSON.stringify([imageUrl ? '' : deviceId, imageUrl || value]);
  const binding = JSON.stringify([owner, auth.accountGeneration, identity]);
  const current = useRef(binding); current.current = binding;
  const [image, setImage] = useState<{ binding: string; uri: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    if (!imageUrl && avatar?.kind !== 'media') return;
    const active = () => !cancelled && current.current === binding && getActiveMobileSessionRealm() === realm;
    void (async () => {
      const cache = auth.user?.id ? await createPeerFileCache(owner).catch(() => null) : null;
      const hit = await cache?.lookupAvatar(identity).catch(() => null);
      if (!active()) return;
      if (hit) { setImage({ binding, uri: hit.uri }); return; }
      // Only a cache miss needs a live computer. Public URLs do not depend on it.
      if (!imageUrl && !online) return;
      const maker = createMobileMakerTransport({ deviceId, invoke, isCurrent: active });
      const result = imageUrl ? { url: imageUrl, mimeType: 'image/png', previewable: true } : await resolveMobileRemoteMedia({ kind: 'image', url: value }, {
        fetchRemoteMedia: maker.fetchRemoteMedia,
        presignGet: (key) => auth.apiFetch<MobileRemoteMediaPresignResult>('/api/device-link/media/presign-get', { baseUrl: DEVICE_LINK_API_BASE_URL, method: 'POST', body: { key } }),
      }, { thumbnail: true });
      if (!active() || !result.previewable || !result.mimeType.startsWith('image/')) return;
      setImage({ binding, uri: result.url });
      if (await cache?.storeAvatar(identity, result.url, result.mimeType, active).catch(() => false)) {
        const saved = await cache?.lookupAvatar(identity);
        if (active() && saved) setImage({ binding, uri: saved.uri });
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [auth.apiFetch, auth.user?.id, avatar?.kind, binding, deviceId, identity, imageUrl, invoke, online, owner, realm, value]);
  const source = (!imageUrl && presets[value]) || (image?.binding === binding ? { uri: image.uri } : null);
  if (source && !failed) return <Image source={source} onError={() => setFailed(true)} style={[styles.image, { width: size, height: size }]} />;
  const glyph = avatar?.kind === 'emoji' ? value : avatar?.fallbackText || Array.from(name)[0];
  if (!framed) return <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>{glyph}</Text>;
  return <View style={[styles.frame, { width: size, height: size, backgroundColor: colors.surfaceChip }]}>
    <Text style={{ color: colors.textPrimary, fontSize: Math.round(size / 2), lineHeight: Math.round(size * 0.7) }}>{glyph}</Text>
  </View>;
}
const styles = StyleSheet.create({
  image: { width: 40, height: 40, borderRadius: radius.pill },
  frame: { alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, overflow: 'hidden' },
});
