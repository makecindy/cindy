import { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { DIRECT_LINK_RUNTIME_SOURCE, MAX_FRAME_BYTES, type createDirectRuntimeBridge } from '@cindy/device-link';
import { mobileDebugLog } from '@/debug/mobileDebugLog';

const origin = 'https://cindy-device-link.invalid';
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none';"><script>
${DIRECT_LINK_RUNTIME_SOURCE}
const host=CindyDirectLink.create(event=>window.ReactNativeWebView.postMessage(JSON.stringify(event)));
window.directLinkCommand=command=>host.command(command);
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
</script>`;

/** Data-only WebView, separate from previews and media transfers. Closing this
 * process immediately releases its paths; DeviceLink replays pending frames via relay. */
export function DirectLinkTransport({ bridge, enabled, owner }: {
  bridge: ReturnType<typeof createDirectRuntimeBridge>;
  enabled: boolean;
  owner: string;
}) {
  const view = useRef<WebView>(null);
  const detach = useRef<(() => void) | undefined>(undefined);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [crashes, setCrashes] = useState(0);
  const [lifecycle, setLifecycle] = useState(0);
  const key = `${owner}:${crashes}:${lifecycle}`;
  const live = useRef(key);
  live.current = key;
  const active = enabled && foreground && crashes < 2;
  const activeRef = useRef(active);
  activeRef.current = active;
  const release = () => { detach.current?.(); detach.current = undefined; };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { activeRef.current = false; release(); setLifecycle(n => n + 1); }
      setForeground(state === 'active');
    });
    return () => { activeRef.current = false; live.current = 'disposed'; subscription.remove(); release(); };
  }, []);
  useEffect(() => () => release(), [key, active, bridge]);
  const terminated = () => {
    if (live.current !== key) return;
    release();
    setCrashes((n) => Math.min(2, n + 1));
    mobileDebugLog('warn', 'device-link', 'LAN transport process stopped; using relay');
  };
  if (!active) return null;
  return <View pointerEvents="none" accessible={false}
    style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
    <WebView ref={view} key={key} source={{ html, baseUrl: origin }} javaScriptEnabled
      originWhitelist={[origin]}
      onShouldStartLoadWithRequest={(r) => r.url === origin || r.url === `${origin}/` || r.url === 'about:blank'}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
      setSupportMultipleWindows={false} mixedContentMode="never" mediaCapturePermissionGrantType="deny" incognito
      onContentProcessDidTerminate={terminated} onRenderProcessGone={terminated}
      onMessage={(event) => {
        if (live.current !== key || !activeRef.current || event.nativeEvent.data.length > 6 * MAX_FRAME_BYTES) return;
        try {
          const message = JSON.parse(event.nativeEvent.data);
          if (message.type === 'ready') {
            if (detach.current) return;
            detach.current = bridge.attach((command) => {
              if (live.current !== key || !activeRef.current || !view.current) throw new Error('DIRECT_RUNTIME_CLOSED');
              view.current.injectJavaScript(`window.directLinkCommand(${JSON.stringify(command)});true;`);
            });
          } else bridge.receive(message);
        } catch { /* Malformed local bridge messages never reach DeviceLink. */ }
      }} />
  </View>;
}
