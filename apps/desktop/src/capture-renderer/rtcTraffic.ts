/** These peer connections carry data only. One transport includes every data channel on the connection,
 * including file bytes, RPC, retransmissions and changes of ICE route. Never forward candidate details. */
function observeRtcTraffic(pc: RTCPeerConnection, report: (sent: number, received: number) => void): () => Promise<void> {
  let sent = 0, received = 0, pending = false;
  const sample = async (final = false) => {
    if (!final && (pending || pc.connectionState !== 'connected')) return;
    pending = true;
    try {
      const stats = await pc.getStats();
      stats.forEach(entry => {
        if (entry.type !== 'transport' || !Number.isSafeInteger(entry.bytesSent) || !Number.isSafeInteger(entry.bytesReceived)) return;
        // A final read can finish ahead of an earlier one. Cumulative counters never go backwards.
        const nextSent = Math.max(sent, entry.bytesSent), nextReceived = Math.max(received, entry.bytesReceived);
        if (nextSent > sent || nextReceived > received) report(nextSent - sent, nextReceived - received);
        sent = nextSent;
        received = nextReceived;
      });
    } catch { /* Closing the data host can cancel a read. Measurement never affects the connection. */ }
    finally { pending = false; }
  };
  const timer = setInterval(() => void sample(), 2_000);
  return () => {
    clearInterval(timer);
    return sample(true);
  };
}

/** The window's last report covers peers closed before the shutdown command and readings still in flight. */
export function createRtcTrafficObserver(report: (sent: number, received: number) => void) {
  let sent = 0, received = 0;
  const closing = new Set<Promise<void>>();
  let finishing = false;
  return {
    observe(pc: RTCPeerConnection) {
      const finish = observeRtcTraffic(pc, (up, down) => {
        sent += up;
        received += down;
        if (!finishing) report(sent, received);
      });
      return () => {
        // Chromium can return an empty report if the PC is closed while getStats is in flight.
        // The runtime has already revoked the session and closed all application channels.
        let timeout: ReturnType<typeof setTimeout>;
        const deadline = new Promise<void>(resolve => { timeout = setTimeout(resolve, 800); });
        const read = Promise.race([finish(), deadline]).finally(() => {
          clearTimeout(timeout);
          pc.close();
        });
        closing.add(read);
        void read.finally(() => closing.delete(read));
      };
    },
    async finish(dispose: () => void) {
      finishing = true;
      dispose();
      await Promise.all(closing);
      return { sent, received };
    },
  };
}
