export type DesktopNetworkStats = {
  transport: "video" | "direct" | "relay" | "screenshots";
  bytesPerSecond: number | null;
  latencyMs: number | null;
  at: number;
};

export function formatReceiveRate(bytes: number | null): string {
  if (bytes === null) return "— KB/s";
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB/s`
    : `${Math.round(bytes / 1000)} KB/s`;
}

// Executed in the WebView; keep literal source for Hermes.
// https://www.w3.org/TR/webrtc-stats/ — received media bytes, selected ICE path, RTT.
export const DESKTOP_NETWORK_STATS_SCRIPT = String.raw`function networkStats(stats, previous) {
  const rows=[...stats.values()];
  const video=rows.find(s=>s.type==='inbound-rtp'&&(s.kind==='video'||s.mediaType==='video'));
  const transport=rows.find(s=>s.type==='transport'&&s.selectedCandidatePairId);
  const pair=transport?stats.get(transport.selectedCandidatePairId):rows.find(s=>s.type==='candidate-pair'&&s.state==='succeeded'&&s.nominated);
  const local=pair&&stats.get(pair.localCandidateId),remote=pair&&stats.get(pair.remoteCandidateId);
  const direct=['host','srflx','prflx'];
  const route=local?.candidateType==='relay'||remote?.candidateType==='relay'?'relay':direct.includes(local?.candidateType)&&direct.includes(remote?.candidateType)?'direct':'video';
  const sample=video&&Number.isFinite(video.bytesReceived)&&Number.isFinite(video.timestamp)
    ?{id:video.id,path:pair?.id,bytes:video.bytesReceived,time:video.timestamp}:null;
  let bytesPerSecond=null;
  if(sample&&previous&&sample.id===previous.id&&sample.path===previous.path&&sample.time>previous.time&&sample.bytes>=previous.bytes)
    bytesPerSecond=(sample.bytes-previous.bytes)*1000/(sample.time-previous.time);
  const latencyMs=Number.isFinite(pair?.currentRoundTripTime)&&pair.currentRoundTripTime>=0?pair.currentRoundTripTime*1000:null;
  return {transport:route,bytesPerSecond,latencyMs,sample};
}`;
