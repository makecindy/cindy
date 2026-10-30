import { useContext, useEffect, useRef } from 'react';
import { Linking, type StyleProp, type TextStyle } from 'react-native';
import { Text } from '@/components/AppText';
import { useRouter } from 'expo-router';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource } from '@/device-link/remoteResources';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { ChatFilePathContext } from './chatFilePathContext';

/** All mail providers use Host-declared link recognition; unknown/old hosts keep OS links. */
export function MailLinkSpan({ url, children, style, SpanText }: {
  url: string; children: string; style: StyleProp<TextStyle>; SpanText: typeof Text;
}) {
  const context = useContext(ChatFilePathContext);
  const { invoke } = useDeviceLink();
  const router = useRouter();
  const busy = useRef(false);
  const current = useRef(context); current.current = context;
  useEffect(() => () => { current.current = null; }, []);
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    const owner = getMobileAuthOwner(), source = context;
    try {
      if (source && url.startsWith('https://')) {
        let supported = false;
        try {
          const resource = await getRemoteResource(invoke, { deviceId: source.deviceId, deviceName: source.deviceId },
            { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify([source.sessionId, url, false]) }, undefined, ['mail-message']);
          supported = (resource.blocks?.[0]?.data as { supported?: unknown })?.supported === true;
        } catch { /* Legacy hosts open the original link. */ }
        if (current.current !== source || !isMobileAuthOwnerCurrent(owner)) return;
        if (supported) {
          router.push({ pathname: '/mail-preview', params: { deviceId: source.deviceId, sessionId: source.sessionId, url } });
          return;
        }
      }
      await Linking.openURL(url);
    } finally { busy.current = false; }
  };
  return <SpanText onPress={() => { void open().catch(() => undefined); }} style={style}>{children}</SpanText>;
}
