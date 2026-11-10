import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { encodeBase64Url, decodeBase64Url } from '@cindy/device-link';
import { agentNetNative } from '../../modules/cindy-agent-net/src';
import { File, Paths } from 'expo-file-system';
import { notificationPayload } from '@cindy/agent-net-protocol';
import { openNativeMediaStream, concatBytes, type NativeMediaApi } from '@cindy/agent-net/portable';
import { createVideoPlayer } from 'expo-video';
import { AGENT_NET_PROBE_VIDEO } from './agentNetProbeVideo';

/** Explicit, mock-only simulator probe. No account, persisted settings, remote
 * service, authentication override or user keys are involved. Its receipt
 * contains only booleans; both native handles are always destroyed. */
export async function runAgentNetNativeSmoke(): Promise<void> {
  if (!__DEV__ || process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK !== '1'
    || process.env.EXPO_PUBLIC_CINDY_AGENT_NET_SMOKE !== '1') return;
  const native = agentNetNative, handles: string[] = [];
  let stage = 'create';
  const receipt = (value: object) => {
    // Public test booleans only, in the OS cache. The simulator gate reads this
    // rather than treating an app launch or a screenshot as native ABI proof.
    new File(Paths.cache, 'agent-net-native-smoke.json').write(JSON.stringify({ version: 1, at: Date.now(), ...value }));
  };
  try {
    if (!native) throw new Error('NATIVE_MODULE_MISSING');
    const context = 'unit-native-simulator';
    async function create(seed: number, deviceId: string) {
      const id = await native!.create(JSON.stringify({ seed: encodeBase64Url(new Uint8Array(32).fill(seed)), context, deviceId }));
      handles.push(id); return id;
    }
    async function command<T = any>(handle: string, value: object): Promise<T> {
      const result = JSON.parse(await native!.command(handle, JSON.stringify(value)));
      if (!result.ok) throw new Error(typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{1,70}$/.test(result.code) ? result.code : 'COMMAND_FAILED');
      return result.value;
    }
    const a = await create(31, 'sim-native-unit-a'), b = await create(32, 'sim-native-unit-b');
    stage = 'identity';
    const ia = await command(a, { op: 'identity' }), ib = await command(b, { op: 'identity' });
    const ascii = (value: string) => Uint8Array.from(value, ch => ch.charCodeAt(0));
    const decode = (value: string) => { const bytes = decodeBase64Url(value); if (!bytes) throw new Error('INVALID_NATIVE_BYTES'); return bytes; };
    const signing = hkdf(sha256, new Uint8Array(32).fill(31), ascii(context), ascii('cindy-agent-net/device-signing/2'), 32);
    const identityMatches = encodeBase64Url(ed25519.getPublicKey(signing)) === ia.signingKey;
    signing.fill(0);
    const message = 'public-native-bridge-proof';
    const signature = await command<string>(a, { op: 'sign', text: message });
    const signatureVerified = ed25519.verify(decode(signature), ascii(message), decode(ia.signingKey), { zip215: false });
    stage = 'udp';
    await command(a, { op: 'admit', peers: [{ key: ib.transportKey, link: 1 }] });
    await command(b, { op: 'admit', peers: [{ key: ia.transportKey, link: 1 }] });
    const connection = await command(a, { op: 'connect', key: ib.transportKey, address: { address: '127.0.0.1', port: ib.udpPort } });
    async function until(check: (left: any, right: any) => boolean) {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if (check(await command(a, { op: 'poll' }), await command(b, { op: 'poll' }))) return;
        await new Promise(resolve => setTimeout(resolve, 8));
      }
      throw new Error('NATIVE_UDP_DEADLINE');
    }
    await until((left, right) => left.connections.some((c: any) => c.established) && right.connections.some((c: any) => c.established));
    const stream = await command(a, { op: 'openStream', id: connection });
    const payload = encodeBase64Url(ascii(message));
    await command(a, { op: 'write', id: connection, stream, data: payload });
    const received: number[] = [];
    await until((_left, right) => {
      for (const c of right.connections) for (const chunk of c.data) received.push(...decode(chunk.data));
      return received.length === message.length;
    });
    const udpVerified = encodeBase64Url(Uint8Array.from(received)) === payload;
    if (!identityMatches || !signatureVerified || !udpVerified) throw new Error('NATIVE_MISMATCH');
    stage = 'media';
    const plainMedia = new Uint8Array(1024 * 1024).fill(37), mediaData = encodeBase64Url(plainMedia);
    const binding = 'cindy-agent-net/media-scope/3/native-smoke';
    const upload = await command(a, { op: 'mediaCreateUpload', recipientKey: ib.transportKey, size: plainMedia.length, binding });
    const encryptedMedia = await command<string>(a, { op: 'mediaEncrypt', id: upload.id, data: mediaData });
    const download = await command(b, { op: 'mediaOpen', header: upload.header, headerSha256: upload.headerSha256, binding });
    let mediaVerified = false;
    try {
      mediaVerified = upload.binding === binding && download.binding === binding
        && await command<string>(b, { op: 'mediaDecrypt', id: download.id, index: 0, data: encryptedMedia }) === mediaData;
      const changed = decode(encryptedMedia); changed[changed.length - 1] ^= 1;
      let tamperRejected = false;
      try { await command(b, { op: 'mediaDecrypt', id: download.id, index: 0, data: encodeBase64Url(changed) }); }
      catch { tamperRejected = true; }
      let scopeRejected = false;
      try { await command(b, { op: 'mediaOpen', header: upload.header, headerSha256: upload.headerSha256, binding: binding + '-other' }); }
      catch { scopeRejected = true; }
      mediaVerified = mediaVerified && tamperRejected && scopeRejected;
      if (!mediaVerified) throw new Error('NATIVE_MEDIA_MISMATCH');
    } finally {
      await command(a, { op: 'mediaClose', id: upload.id }); await command(b, { op: 'mediaClose', id: download.id });
    }
    stage = 'media-stream';
    let mediaStreamVerified = false;
    let nativeVideoVerified = false;
    const player = await create(32, 'sim-native-unit-b');
    const video = decode(AGENT_NET_PROBE_VIDEO);
    const clip = await command(a, { op: 'mediaCreateUpload', recipientKey: ib.transportKey, size: video.length, binding });
    const clipCipher = await command<string>(a, { op: 'mediaEncrypt', id: clip.id, data: encodeBase64Url(video) });
    await command(a, { op: 'mediaClose', id: clip.id });
    const stored = concatBytes([decode(clip.header), decode(clipCipher)]);
    const mediaApi: NativeMediaApi = {
      request: async () => { throw new Error('NATIVE_UNEXPECTED_MEDIA_REQUEST'); },
      putMediaChunk: async () => { throw new Error('NATIVE_UNEXPECTED_MEDIA_UPLOAD'); },
      async withMediaResponse(_id, range, consume) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) throw new Error('INVALID_MEDIA_RANGE');
        const start = Number(match[1]), end = Number(match[2]);
        const bytes = stored.slice(start, end + 1);
        return consume({ status: 206, headers: new Headers({ 'content-range': `bytes ${start}-${end}/${stored.length}` }),
          arrayBuffer: async () => bytes.buffer } as Response);
      },
    };
    const preview = await openNativeMediaStream(mediaApi, { command: value => command(player, value),
      destroy: async () => { await native.destroy(player); } }, 'unit-video', clip.headerSha256, 'video/mp4', { binding });
    try {
      const response = await fetch(preview.url, { headers: { Range: 'bytes=17-49' } });
      const decoded = new Uint8Array(await response.arrayBuffer());
      const bad = await fetch(preview.url.replace(/\/[A-Za-z0-9_-]{43}$/, '/wrong-token'));
      mediaStreamVerified = response.status === 206 && decoded.length === 33 && decoded.every((byte, i) => byte === video[17 + i]) && bad.status === 404;
      if (!mediaStreamVerified) throw new Error('NATIVE_MEDIA_STREAM_MISMATCH');
      stage = 'video-player';
      const systemPlayer = createVideoPlayer(null);
      try {
        systemPlayer.muted = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([systemPlayer.replaceAsync(preview.url), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('NATIVE_VIDEO_PLAYER_LOAD')), 8000);
        })]); } finally { clearTimeout(timer); }
        let deadline = Date.now() + 4000;
        while (systemPlayer.status !== 'readyToPlay' && Date.now() < deadline) {
          if (systemPlayer.status === 'error') throw new Error('NATIVE_VIDEO_PLAYER_LOAD');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (systemPlayer.status !== 'readyToPlay' || systemPlayer.duration < 1) throw new Error('NATIVE_VIDEO_PLAYER_LOAD');
        systemPlayer.currentTime = 0.5; systemPlayer.play(); deadline = Date.now() + 4000;
        while (systemPlayer.currentTime < 0.75 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        nativeVideoVerified = systemPlayer.currentTime >= 0.75;
        if (!nativeVideoVerified) throw new Error('NATIVE_VIDEO_PLAYER_SEEK');
      } finally { systemPlayer.release(); }
    } finally { await preview.close(); }
    let notificationVerified = false;
    stage = 'notifications';
    if (native.beginNotificationScope && native.configureNotifications && native.openNotification) {
      const kb = await command<{ secret: string; encryptionKey: string }>(b, { op: 'notificationKey' });
      const now = Date.now(), ticket = native.beginNotificationScope();
      const notice = { category: 'session-done', title: 'Public native fixture',
        body: 'public notification fixture', deepLink: '/sessions/unit', collapseId: 'unit' };
      try {
        await native.configureNotifications(ticket, JSON.stringify({ version: 2, secret: kb.secret,
          networkId: 'private:unit', deviceId: ib.deviceId, peers: { [ia.deviceId]: ia.signingKey },
          scope: 'unit-native-notification-scope', preview: true, expiresAt: now + 60_000 }));
        const envelope = await command<string>(a, { op: 'notificationSeal', recipientKey: kb.encryptionKey,
          // Native replay history intentionally survives process restarts.
          text: notificationPayload('private:unit', ia.deviceId, ib.deviceId, 'unit-notification-' + now, now, notice) });
        const bad = decode(envelope); bad[bad.length - 1] ^= 1;
        if (native.openNotification('cindy://agent-net-notification?envelope=' + encodeBase64Url(bad)) !== null) throw new Error('NATIVE_NOTIFICATION_TAMPER');
        const uri = 'cindy://agent-net-notification?envelope=' + envelope;
        const result = native.openNotification(uri);
        notificationVerified = !!result && JSON.parse(result).body === notice.body && native.openNotification(uri) === null;
        if (!notificationVerified) throw new Error('NATIVE_NOTIFICATION_MISMATCH');
      } finally { native.beginNotificationScope(); }
    }
    let bonjourVerified = false;
    stage = 'discovery';
    if (native.startLan && native.stopLan) {
      const lan: string[] = [], seen = new Set<string>();
      const listener = native.addListener('onLanService', event => {
        if (event.id === lan[0] && event.txt.b0 === 'unit-native-b' && event.port === ib.udpPort && event.addresses.length) seen.add('a');
        if (event.id === lan[1] && event.txt.b0 === 'unit-native-a' && event.port === ia.udpPort && event.addresses.length) seen.add('b');
      });
      try {
        lan.push(await native.startLan(ia.udpPort, JSON.stringify({ b0: 'unit-native-a' })));
        lan.push(await native.startLan(ib.udpPort, JSON.stringify({ b0: 'unit-native-b' })));
        const deadline = Date.now() + 8_000;
        while (seen.size !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        bonjourVerified = seen.size === 2;
        if (!bonjourVerified) throw new Error('NATIVE_BONJOUR_DEADLINE');
      } finally { listener.remove(); for (const id of lan) await native.stopLan(id); }
    }
    receipt({ ok: true, identityMatches, signatureVerified, udpVerified, bonjourVerified, mediaVerified, mediaStreamVerified, nativeVideoVerified, notificationVerified });
    console.info('AGENT_NET_NATIVE_SMOKE', JSON.stringify({ ok: true, identityMatches, signatureVerified, udpVerified, bonjourVerified, mediaVerified, mediaStreamVerified, nativeVideoVerified, notificationVerified }));
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,70}$/.test(error.message) ? error.message : 'NATIVE_PROBE_FAILED';
    receipt({ ok: false, stage, code });
    console.error('AGENT_NET_NATIVE_SMOKE_FAILED', stage, code);
  }
  finally { for (const id of handles) await native?.destroy(id).catch(() => undefined); }
}
