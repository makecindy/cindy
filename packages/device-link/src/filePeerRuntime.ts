/// <reference lib="dom" />

export interface FilePeerRuntimeBridge {
  read(connection: string, ticket: string, offset: number): Promise<string>;
  write(sink: string, offset: number, base64: string): Promise<void>;
  /** `body` carries a request's binary payload (see RPC_BODY_MAX_BYTES). */
  invoke?(
    connection: string,
    payload: string,
    body?: Uint8Array,
  ): Promise<string>;
}

/**
 * A request may append up to 1 MiB of raw bytes after its JSON fragments. Peers that do
 * not advertise `caps.streamAttachments` close the channel on binary frames, so callers
 * send a body only to capable peers.
 */
export const RPC_BODY_MAX_BYTES = 1024 * 1024;

/** Diagnostics only: application-level progress of the latest receive on a peer. */
interface ReceiveProgress {
  size: number;
  startedAt: number;
  received: number;
  written: number;
  queued: number;
  queuedMax: number;
  granted: number;
  writes: number;
  writeMs: number;
  writeMaxMs: number;
  lastDataAt: number;
}
/** Diagnostics only: application-level progress of the latest files-v2 send on a peer. */
interface SendProgress {
  startedAt: number;
  sent: number;
  credit: number;
  reads: number;
  readMs: number;
  readMaxMs: number;
  creditWaitMs: number;
  waitingSince: number | null;
}
interface PeerState {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  busy: boolean;
  recv?: ReceiveProgress;
  send?: SendProgress;
}

/**
 * Trusted browser transport, also serialized into Mobile's isolated transport WebView.
 * Keep the factory self-contained: no credentials, paths, imports or user HTML enter it.
 * V2 keeps a bounded 1 MiB credit window in flight; disk writes replenish credit.
 * V1 remains available for peers that did not advertise streaming support.
 */
/** 调用方只能在默认 15 秒与 1 小时之间放宽单次 RPC 等待(大附件 finish 要整读重算摘要)。 */
function rpcTimeoutMs(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 15000
    ? Math.min(value as number, 60 * 60_000)
    : 15000;
}

export function createFilePeerRuntime(bridge: FilePeerRuntimeBridge) {
  const peers = new Map<string, PeerState>();
  const chunkBytes = 16384;
  const maxBytes = 2147483648;
  const rpcPeers = new Map<
    string,
    {
      channel: RTCDataChannel;
      request(
        payload: string,
        timeoutMs?: number,
        body?: Uint8Array,
      ): Promise<string>;
      close(): void;
    }
  >();
  function attachRpc(id: string, dc: RTCDataChannel) {
    dc.binaryType = "arraybuffer";
    const pending = new Map<
      string,
      {
        resolve(value: string): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const fragments = new Map<
      string,
      {
        data: string;
        timer: ReturnType<typeof setTimeout>;
        body?: { remaining: number; parts: Uint8Array[] };
      }
    >();
    // A body's binary frames directly follow its last JSON fragment: send() emits a whole
    // message synchronously on an ordered channel, so nothing can interleave.
    let receivingBody: string | undefined;
    // An incomplete message closes the connection only after this long without any new frame:
    // a slow but live link keeps a body alive however long it takes.
    const stallMs = 15000;
    let sequence = 0;
    let active = 0;
    const send = (
      key: string,
      response: boolean,
      value: string,
      body?: Uint8Array,
    ) => {
      if (
        value.length > 4 * 1024 * 1024 ||
        (body && (!body.length || body.length > RPC_BODY_MAX_BYTES)) ||
        dc.readyState !== "open"
      )
        throw new Error("FILE_PEER_RPC_SIZE");
      for (
        let offset = 0;
        offset < Math.max(1, value.length);
        offset += 16384
      ) {
        const last = offset + 16384 >= value.length;
        dc.send(
          JSON.stringify({
            key,
            response,
            data: value.slice(offset, offset + 16384),
            last,
            ...(last && body ? { body: body.length } : {}),
          }),
        );
      }
      if (body)
        for (let offset = 0; offset < body.length; offset += 16384)
          dc.send(body.slice(offset, offset + 16384));
    };
    const dispatch = (key: string, payload: string, body?: Uint8Array) => {
      if (!bridge.invoke || active >= 4) throw new Error();
      active++;
      void bridge
        .invoke(id, payload, body)
        .then((value) => {
          if (peers.has(id)) send(key, true, value);
        })
        .catch(() => close(id))
        .finally(() => {
          active--;
        });
    };
    const receiveBody = (data: unknown) => {
      const f = receivingBody ? fragments.get(receivingBody) : undefined;
      if (!f?.body || !(data instanceof ArrayBuffer)) throw new Error();
      const bytes = new Uint8Array(data);
      // Exactly the sender's framing (16 KiB, shorter only at the end), like the files-v2 receive
      // path: a peer cannot make the body arrive as millions of tiny frames.
      if (bytes.length !== Math.min(16384, f.body.remaining)) throw new Error();
      f.body.parts.push(bytes);
      f.body.remaining -= bytes.length;
      clearTimeout(f.timer);
      if (f.body.remaining) {
        f.timer = setTimeout(() => close(id), stallMs);
        return;
      }
      const key = receivingBody!;
      receivingBody = undefined;
      fragments.delete(key);
      const body = new Uint8Array(
        f.body.parts.reduce((sum, part) => sum + part.length, 0),
      );
      let offset = 0;
      for (const part of f.body.parts) {
        body.set(part, offset);
        offset += part.length;
      }
      dispatch(key.slice("false:".length), f.data, body);
    };
    const shutdown = () => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("FILE_PEER_CLOSED"));
      }
      for (const f of fragments.values()) clearTimeout(f.timer);
      pending.clear();
      fragments.clear();
      dc.close();
    };
    dc.onclose = shutdown;
    dc.onmessage = ({ data }) => {
      try {
        if (receivingBody !== undefined) return receiveBody(data);
        if (typeof data !== "string" || data.length > 100000) throw new Error();
        const m = JSON.parse(data);
        if (
          typeof m.key !== "string" ||
          !/^\d{1,12}$/.test(m.key) ||
          typeof m.response !== "boolean" ||
          typeof m.last !== "boolean" ||
          typeof m.data !== "string" ||
          m.data.length > 16384 ||
          (m.body !== undefined &&
            (m.response ||
              !m.last ||
              !Number.isSafeInteger(m.body) ||
              m.body < 1 ||
              m.body > RPC_BODY_MAX_BYTES))
        )
          throw new Error();
        if (m.response && !pending.has(m.key)) return;
        const key = `${m.response}:${m.key}`;
        let f = fragments.get(key);
        if (!f) {
          if (fragments.size >= 8) throw new Error();
          f = { data: "", timer: setTimeout(() => close(id), stallMs) };
          fragments.set(key, f);
        }
        f.data += m.data;
        if (f.data.length > 4 * 1024 * 1024) throw new Error();
        if (!m.last) return;
        if (m.body !== undefined) {
          clearTimeout(f.timer);
          f.timer = setTimeout(() => close(id), stallMs);
          f.body = { remaining: m.body, parts: [] };
          receivingBody = key;
          return;
        }
        clearTimeout(f.timer);
        fragments.delete(key);
        if (m.response) {
          const p = pending.get(m.key)!;
          pending.delete(m.key);
          clearTimeout(p.timer);
          p.resolve(f.data);
        } else dispatch(m.key, f.data);
      } catch {
        close(id);
      }
    };
    rpcPeers.set(id, {
      channel: dc,
      close: shutdown,
      request(payload, timeoutMs, body) {
        if (pending.size >= 4 || dc.readyState !== "open")
          return Promise.reject(new Error("FILE_PEER_UNAVAILABLE"));
        return new Promise((resolve, reject) => {
          const key = String(++sequence);
          const timer = setTimeout(() => {
            pending.delete(key);
            reject(new Error("FILE_PEER_TIMEOUT"));
          }, rpcTimeoutMs(timeoutMs));
          pending.set(key, { resolve, reject, timer });
          try {
            send(key, false, payload, body);
          } catch (error) {
            pending.delete(key);
            clearTimeout(timer);
            reject(error);
          }
        });
      },
    });
  }
  function close(id: string) {
    const rpc = rpcPeers.get(id);
    rpcPeers.delete(id);
    rpc?.close();
    const p = peers.get(id);
    peers.delete(id);
    p?.dc?.close();
    p?.pc.close();
  }
  function create(id: string, servers: RTCIceServer[]) {
    if (peers.has(id) || peers.size >= 4) throw new Error("FILE_PEER_BUSY");
    const pc = new RTCPeerConnection({ iceServers: servers });
    const p: PeerState = { pc, dc: null, busy: false };
    peers.set(id, p);
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState))
        close(id);
    };
    return p;
  }
  async function localSdp(
    pc: RTCPeerConnection,
    description: RTCSessionDescriptionInit,
  ) {
    await pc.setLocalDescription(description);
    if (pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 4000);
        function done() {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", changed);
          resolve();
        }
        function changed() {
          if (pc.iceGatheringState === "complete") done();
        }
        pc.addEventListener("icegatheringstatechange", changed);
        changed();
      });
    }
    if (!pc.localDescription?.sdp || pc.signalingState === "closed")
      throw new Error("FILE_PEER_CLOSED");
    return pc.localDescription.sdp;
  }
  function decode(text: string) {
    if (
      text.length > 22000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        text,
      )
    )
      throw new Error("FILE_PEER_BLOCK");
    const s = atob(text);
    if (s.length > chunkBytes) throw new Error("FILE_PEER_BLOCK");
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  async function offer(id: string, servers: RTCIceServer[], streaming = false) {
    const p = create(id, servers);
    p.dc = p.pc.createDataChannel(streaming ? "files-v2" : "files-v1", {
      ordered: true,
    });
    p.dc.binaryType = "arraybuffer";
    if (streaming)
      attachRpc(id, p.pc.createDataChannel("reads-v1", { ordered: true }));
    try {
      return await localSdp(p.pc, await p.pc.createOffer());
    } catch (error) {
      close(id);
      throw error;
    }
  }
  async function accept(id: string, servers: RTCIceServer[], sdp: string) {
    const p = create(id, servers);
    p.pc.ondatachannel = ({ channel }) => {
      if (channel.label === "reads-v1" && !rpcPeers.has(id)) {
        attachRpc(id, channel);
        return;
      }
      if (!["files-v1", "files-v2"].includes(channel.label) || p.dc) {
        channel.close();
        return;
      }
      p.dc = channel;
      channel.binaryType = "arraybuffer";
      if (channel.label === "files-v2") {
        let source:
          { ticket: string; offset: number; credit: number } | undefined;
        let pumping = false;
        const pump = async () => {
          if (pumping) return;
          pumping = true;
          try {
            while (source && source.credit > 0) {
              const current = source;
              current.credit--;
              const readStartedAt = Date.now();
              const bytes = decode(
                await bridge.read(id, current.ticket, current.offset),
              );
              if (peers.get(id) !== p || channel.readyState !== "open") return;
              channel.send(bytes.buffer);
              current.offset += bytes.length;
              if (p.send) {
                const ms = Date.now() - readStartedAt;
                p.send.reads++;
                p.send.readMs += ms;
                p.send.readMaxMs = Math.max(p.send.readMaxMs, ms);
                p.send.sent = current.offset;
                p.send.credit = current.credit;
              }
              if (!bytes.length) source = undefined;
            }
            // Out of credit before EOF: the receiver has not confirmed enough writes yet.
            if (source && p.send && p.send.waitingSince === null)
              p.send.waitingSince = Date.now();
          } catch {
            close(id);
          } finally {
            pumping = false;
          }
        };
        channel.onmessage = ({ data }) => {
          try {
            if (typeof data !== "string" || data.length > 256)
              throw new Error();
            const r = JSON.parse(data);
            if (
              !Number.isSafeInteger(r.credit) ||
              r.credit < 1 ||
              r.credit > 64
            )
              throw new Error();
            if (r.ticket !== undefined) {
              if (source || !/^[a-f0-9-]{36}$/.test(r.ticket) || r.offset !== 0)
                throw new Error();
              source = { ticket: r.ticket, offset: 0, credit: r.credit };
              p.send = {
                startedAt: Date.now(),
                sent: 0,
                credit: r.credit,
                reads: 0,
                readMs: 0,
                readMaxMs: 0,
                creditWaitMs: 0,
                waitingSince: null,
              };
            } else {
              if (!source || source.credit + r.credit > 64) throw new Error();
              source.credit += r.credit;
              if (p.send) {
                p.send.credit = source.credit;
                if (p.send.waitingSince !== null) {
                  p.send.creditWaitMs += Date.now() - p.send.waitingSince;
                  p.send.waitingSince = null;
                }
              }
            }
            void pump();
          } catch {
            close(id);
          }
        };
        return;
      }
      channel.onmessage = async ({ data }) => {
        try {
          if (
            peers.get(id) !== p ||
            p.busy ||
            typeof data !== "string" ||
            data.length > 256
          )
            throw new Error("FILE_PEER_BLOCK");
          const request = JSON.parse(data);
          if (
            !/^[a-f0-9-]{36}$/.test(request.ticket) ||
            !Number.isSafeInteger(request.offset) ||
            request.offset < 0 ||
            request.offset > maxBytes ||
            request.credit !== 16
          )
            throw new Error("FILE_PEER_BLOCK");
          p.busy = true;
          let offset = request.offset;
          for (let i = 0; i < 16; i++) {
            const bytes = decode(await bridge.read(id, request.ticket, offset));
            if (peers.get(id) !== p || channel.readyState !== "open") return;
            channel.send(bytes.buffer);
            offset += bytes.length;
            if (!bytes.length) break;
          }
        } catch {
          close(id);
        } finally {
          p.busy = false;
        }
      };
    };
    try {
      await p.pc.setRemoteDescription({ type: "offer", sdp });
      return await localSdp(p.pc, await p.pc.createAnswer());
    } catch (error) {
      close(id);
      throw error;
    }
  }
  async function answer(id: string, sdp: string) {
    const p = peers.get(id);
    if (!p) throw new Error("FILE_PEER_CLOSED");
    await p.pc.setRemoteDescription({ type: "answer", sdp });
    await Promise.all(
      [p.dc, rpcPeers.get(id)?.channel]
        .filter((dc): dc is RTCDataChannel => !!dc)
        .map(
          (dc) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(
                () => done(new Error("FILE_PEER_TIMEOUT")),
                8000,
              );
              function done(error?: Error) {
                clearTimeout(timer);
                dc.removeEventListener("open", opened);
                dc.removeEventListener("close", closed);
                if (error) reject(error);
                else resolve();
              }
              function opened() {
                done();
              }
              function closed() {
                done(new Error("FILE_PEER_CLOSED"));
              }
              dc.addEventListener("open", opened);
              dc.addEventListener("close", closed);
              if (dc.readyState === "open") done();
              else if (dc.readyState === "closed") closed();
            }),
        ),
    );
  }
  async function receive(
    id: string,
    ticket: string,
    size: number,
    sink: string,
  ) {
    const p = peers.get(id),
      dc = p?.dc;
    if (
      !p ||
      !dc ||
      dc.readyState !== "open" ||
      p.busy ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maxBytes
    )
      throw new Error("FILE_PEER_UNAVAILABLE");
    p.busy = true;
    try {
      if (dc.label === "files-v2") {
        await new Promise<void>((resolve, reject) => {
          let received = 0,
            written = 0,
            queued = 0,
            replenished = 0;
          const blocks = Math.ceil(size / chunkBytes) + 1;
          let granted = Math.min(64, blocks);
          let ended = false,
            settled = false;
          let writes = Promise.resolve();
          const progress: ReceiveProgress = {
            size,
            startedAt: Date.now(),
            received: 0,
            written: 0,
            queued: 0,
            queuedMax: 0,
            granted,
            writes: 0,
            writeMs: 0,
            writeMaxMs: 0,
            lastDataAt: 0,
          };
          p.recv = progress;
          let timer = setTimeout(
            () => done(new Error("FILE_PEER_TIMEOUT")),
            60000,
          );
          function done(error?: Error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            dc!.removeEventListener("message", message);
            dc!.removeEventListener("close", closed);
            error ? reject(error) : resolve();
          }
          function closed() {
            done(new Error("FILE_PEER_CLOSED"));
          }
          function message(event: MessageEvent) {
            if (
              ended ||
              !(event.data instanceof ArrayBuffer) ||
              ++queued > 64
            ) {
              done(new Error("FILE_PEER_BLOCK"));
              return;
            }
            const bytes = new Uint8Array(event.data);
            if (bytes.length !== Math.min(chunkBytes, size - received)) {
              done(new Error("FILE_PEER_SIZE"));
              return;
            }
            received += bytes.length;
            ended = bytes.length === 0;
            progress.received = received;
            progress.queued = queued;
            progress.queuedMax = Math.max(progress.queuedMax, queued);
            progress.lastDataAt = Date.now();
            writes = writes
              .then(async () => {
                if (settled) return;
                if (!bytes.length) {
                  // The zero-byte EOF block leaves the queue like any other block,
                  // so a completed receive reports no pending writes.
                  queued--;
                  progress.queued = queued;
                  done();
                  return;
                }
                const writeStartedAt = Date.now();
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                await bridge.write(sink, written, btoa(binary));
                if (settled) return;
                if (peers.get(id) !== p) throw new Error("FILE_PEER_CLOSED");
                written += bytes.length;
                queued--;
                const writeMs = Date.now() - writeStartedAt;
                progress.writes++;
                progress.writeMs += writeMs;
                progress.writeMaxMs = Math.max(progress.writeMaxMs, writeMs);
                progress.written = written;
                progress.queued = queued;
                clearTimeout(timer);
                timer = setTimeout(
                  () => done(new Error("FILE_PEER_TIMEOUT")),
                  60000,
                );
                // Count EOF in the window; never send late credit after it was sent.
                if (++replenished === 32 && granted < blocks) {
                  const credit = Math.min(32, blocks - granted);
                  dc!.send(JSON.stringify({ credit }));
                  granted += credit;
                  progress.granted = granted;
                  replenished = 0;
                }
              })
              .catch((error) => done(error));
          }
          dc.addEventListener("message", message);
          dc.addEventListener("close", closed);
          try {
            dc.send(JSON.stringify({ ticket, offset: 0, credit: granted }));
          } catch {
            closed();
          }
        });
        return;
      }
      let offset = 0;
      // Also request a zero-byte EOF block: the source rechecks size/mtime before completion.
      while (offset <= size) {
        const batch = await new Promise<Uint8Array[]>((resolve, reject) => {
          const blocks: Uint8Array[] = [];
          let received = offset;
          const timer = setTimeout(
            () => done(new Error("FILE_PEER_TIMEOUT")),
            60000,
          );
          function done(error?: Error) {
            clearTimeout(timer);
            dc!.removeEventListener("message", message);
            dc!.removeEventListener("close", closed);
            if (error) reject(error);
            else resolve(blocks);
          }
          function closed() {
            done(new Error("FILE_PEER_CLOSED"));
          }
          function message(event: MessageEvent) {
            if (!(event.data instanceof ArrayBuffer)) {
              done(new Error("FILE_PEER_BLOCK"));
              return;
            }
            const b = new Uint8Array(event.data);
            if (b.length !== Math.min(chunkBytes, size - received)) {
              done(new Error("FILE_PEER_SIZE"));
              return;
            }
            blocks.push(b);
            received += b.length;
            if (!b.length || blocks.length === 16) done();
          }
          dc!.addEventListener("message", message);
          dc!.addEventListener("close", closed);
          try {
            dc!.send(JSON.stringify({ ticket, offset, credit: 16 }));
          } catch {
            closed();
          }
        });
        for (const bytes of batch) {
          if (!bytes.length) return;
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          await bridge.write(sink, offset, btoa(binary));
          if (peers.get(id) !== p) throw new Error("FILE_PEER_CLOSED");
          offset += bytes.length;
        }
      }
    } catch (error) {
      close(id);
      throw error;
    } finally {
      p.busy = false;
    }
  }
  return {
    /** `body` is base64 so string-only bridges (Mobile WebView) can pass it; it travels as raw bytes. */
    async invoke(
      id: string,
      payload: string,
      timeoutMs?: number,
      body?: string,
    ) {
      const rpc = rpcPeers.get(id);
      if (!rpc) throw new Error("FILE_PEER_UNAVAILABLE");
      if (body === undefined) return rpc.request(payload, timeoutMs);
      if (
        typeof body !== "string" ||
        body.length > Math.ceil(RPC_BODY_MAX_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          body,
        )
      )
        throw new Error("FILE_PEER_RPC_SIZE");
      return rpc.request(
        payload,
        timeoutMs,
        Uint8Array.from(atob(body), (c) => c.charCodeAt(0)),
      );
    },
    async stats(id: string) {
      const p = peers.get(id);
      if (!p) throw new Error("FILE_PEER_CLOSED");
      const report = await p.pc.getStats();
      const entries = new Map<string, RTCStats & Record<string, any>>();
      report.forEach((entry) => entries.set(entry.id, entry));
      let pair: RTCStats | undefined;
      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId)
          pair = entries.get(entry.selectedCandidatePairId);
      });
      const selected = pair as
        | (RTCStats & {
            localCandidateId?: string;
            remoteCandidateId?: string;
            currentRoundTripTime?: number;
          })
        | undefined;
      const local = selected?.localCandidateId
        ? entries.get(selected.localCandidateId)
        : undefined;
      const remote = selected?.remoteCandidateId
        ? entries.get(selected.remoteCandidateId)
        : undefined;
      // Diagnostics beyond the original four fields: counters, candidate kinds and
      // application progress only. Addresses, ports, URLs and payloads never leave here.
      // Engines expose different subsets; absent metrics are omitted, never reported as 0.
      const pick = (
        source: Record<string, unknown> | undefined,
        keys: string[],
      ) => {
        if (!source) return undefined;
        const out: Record<string, number | string> = {};
        for (const key of keys) {
          const value = source[key];
          if (typeof value === "number" && Number.isFinite(value))
            out[key] = Math.round(value);
          else if (typeof value === "string" && value.length <= 32)
            out[key] = value;
        }
        return Object.keys(out).length ? out : undefined;
      };
      let transport: Record<string, unknown> | undefined;
      let channel: Record<string, unknown> | undefined;
      // Gathered candidate kinds and pair states explain why ICE settled on relay.
      const count = (bucket: Record<string, number>, key: unknown) => {
        const name =
          typeof key === "string" && key.length <= 16 ? key : "other";
        bucket[name] = (bucket[name] ?? 0) + 1;
      };
      const candidates = {
        local: {} as Record<string, number>,
        remote: {} as Record<string, number>,
        pairs: {} as Record<string, number>,
        // Client→TURN transport of each gathered relay candidate (udp / tcp / tls).
        localRelay: {} as Record<string, number>,
      };
      report.forEach((entry) => {
        if (entry.type === "transport" && entry.selectedCandidatePairId)
          transport = entry;
        if (entry.type === "data-channel" && entry.label === p.dc?.label)
          channel = entry;
        if (entry.type === "local-candidate") {
          count(candidates.local, entry.candidateType);
          if (entry.candidateType === "relay")
            count(candidates.localRelay, entry.relayProtocol);
        }
        if (entry.type === "remote-candidate")
          count(candidates.remote, entry.candidateType);
        if (entry.type === "candidate-pair")
          count(candidates.pairs, entry.state);
      });
      const now = Date.now();
      const recv = p.recv;
      const send = p.send;
      return JSON.stringify({
        path: !selected
          ? "unknown"
          : local?.candidateType === "relay" ||
              remote?.candidateType === "relay"
            ? "relay"
            : "direct",
        protocol: local?.protocol ?? "unknown",
        rttMs:
          typeof selected?.currentRoundTripTime === "number"
            ? Math.round(selected.currentRoundTripTime * 1000)
            : null,
        streaming: p.dc?.label === "files-v2",
        local: pick(local, [
          "candidateType",
          "protocol",
          "relayProtocol",
          "networkType",
        ]),
        remote: pick(remote, ["candidateType", "protocol"]),
        candidates,
        pair: pick(selected as Record<string, unknown> | undefined, [
          "state",
          "bytesSent",
          "bytesReceived",
          "packetsSent",
          "packetsReceived",
          "packetsDiscardedOnSend",
          "availableOutgoingBitrate",
          "availableIncomingBitrate",
          "requestsSent",
          "responsesReceived",
          "consentRequestsSent",
        ]),
        transport: pick(transport, [
          "dtlsState",
          "bytesSent",
          "bytesReceived",
          "packetsSent",
          "packetsReceived",
          "selectedCandidatePairChanges",
        ]),
        channel: {
          ...pick(channel, [
            "messagesSent",
            "bytesSent",
            "messagesReceived",
            "bytesReceived",
          ]),
          bufferedAmount: p.dc?.bufferedAmount,
        },
        receive: recv && {
          size: recv.size,
          elapsedMs: now - recv.startedAt,
          received: recv.received,
          written: recv.written,
          queued: recv.queued,
          queuedMax: recv.queuedMax,
          granted: recv.granted,
          writes: recv.writes,
          writeAvgMs: recv.writes
            ? Math.round(recv.writeMs / recv.writes)
            : null,
          writeMaxMs: recv.writeMaxMs,
          idleMs: recv.lastDataAt ? now - recv.lastDataAt : null,
        },
        send: send && {
          elapsedMs: now - send.startedAt,
          sent: send.sent,
          credit: send.credit,
          reads: send.reads,
          readAvgMs: send.reads ? Math.round(send.readMs / send.reads) : null,
          readMaxMs: send.readMaxMs,
          creditWaitMs:
            send.creditWaitMs +
            (send.waitingSince === null ? 0 : now - send.waitingSince),
        },
      });
    },
    offer,
    accept,
    answer,
    receive,
    close,
    dispose: () => {
      for (const id of peers.keys()) close(id);
    },
  };
}
