/// <reference lib="dom" />
export interface NodeRtcModule {
  RTCPeerConnection: new (configuration: RTCConfiguration) => RTCPeerConnection;
}

/** @roamhq/wrtc 0.10's native accessors expose the uint16 -1 sentinel
 * (65535) for BOTH absent limits, rather than WebIDL null. Normalize only
 * that pair. An explicit retransmit/lifetime limit stays unreliable.
 * Upstream: WonderInventions/node-webrtc v0.10.0,
 * src/interfaces/rtc_data_channel.cc GetMaxPacketLifeTime/GetMaxRetransmits.
 * This is local to an injected native peer; browser validation is unchanged. */
function normalizeNativeChannel(channel: RTCDataChannel): void {
  if (channel.maxRetransmits !== 65535 || channel.maxPacketLifeTime !== 65535) return;
  Object.defineProperties(channel, {
    maxRetransmits: { value: null },
    maxPacketLifeTime: { value: null },
  });
}

export function createNodeRtcPeerConnection(native: NodeRtcModule, configuration: RTCConfiguration): RTCPeerConnection {
  const peer = new native.RTCPeerConnection(configuration);
  const create = peer.createDataChannel.bind(peer);
  peer.createDataChannel = (label, options) => {
    const channel = create(label, options);
    normalizeNativeChannel(channel);
    return channel;
  };
  // wrtc EventTarget runs registered listeners before its ondatachannel handler.
  // Install before shared runtime binds its receiver so strict reliable checks
  // see WebIDL semantics for incoming channels as well as outgoing channels.
  peer.addEventListener('datachannel', event => normalizeNativeChannel(event.channel));
  return peer;
}
