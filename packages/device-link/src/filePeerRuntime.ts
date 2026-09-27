/// <reference lib="dom" />

export interface FilePeerRuntimeBridge {
  read(connection: string, ticket: string, offset: number): Promise<string>;
  write(sink: string, offset: number, base64: string): Promise<void>;
  invoke?(connection: string, payload: string): Promise<string>;
}

/**
 * Trusted browser transport, also serialized into Mobile's isolated transport WebView.
 * Keep the factory self-contained: no credentials, paths, imports or user HTML enter it.
 * V2 keeps a bounded 1 MiB credit window in flight; disk writes replenish credit.
 * V1 remains available for peers that did not advertise streaming support.
 */
export function createFilePeerRuntime(bridge: FilePeerRuntimeBridge) {
  const peers = new Map<
    string,
    { pc: RTCPeerConnection; dc: RTCDataChannel | null; busy: boolean }
  >();
  const chunkBytes = 16384;
  const maxBytes = 2147483648;
  const rpcPeers = new Map<
    string,
    {
      channel: RTCDataChannel;
      request(payload: string): Promise<string>;
      close(): void;
    }
  >();
  function attachRpc(id: string, dc: RTCDataChannel) {
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
      { data: string; timer: ReturnType<typeof setTimeout> }
    >();
    let sequence = 0;
    let active = 0;
    const send = (key: string, response: boolean, value: string) => {
      if (value.length > 4 * 1024 * 1024 || dc.readyState !== "open")
        throw new Error("FILE_PEER_RPC_SIZE");
      for (let offset = 0; offset < Math.max(1, value.length); offset += 16384)
        dc.send(
          JSON.stringify({
            key,
            response,
            data: value.slice(offset, offset + 16384),
            last: offset + 16384 >= value.length,
          }),
        );
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
        if (typeof data !== "string" || data.length > 100000) throw new Error();
        const m = JSON.parse(data);
        if (
          typeof m.key !== "string" ||
          !/^\d{1,12}$/.test(m.key) ||
          typeof m.response !== "boolean" ||
          typeof m.last !== "boolean" ||
          typeof m.data !== "string" ||
          m.data.length > 16384
        )
          throw new Error();
        if (m.response && !pending.has(m.key)) return;
        const key = `${m.response}:${m.key}`;
        let f = fragments.get(key);
        if (!f) {
          if (fragments.size >= 8) throw new Error();
          f = { data: "", timer: setTimeout(() => close(id), 15000) };
          fragments.set(key, f);
        }
        f.data += m.data;
        if (f.data.length > 4 * 1024 * 1024) throw new Error();
        if (!m.last) return;
        clearTimeout(f.timer);
        fragments.delete(key);
        if (m.response) {
          const p = pending.get(m.key)!;
          pending.delete(m.key);
          clearTimeout(p.timer);
          p.resolve(f.data);
        } else {
          if (!bridge.invoke || active >= 4) throw new Error();
          active++;
          void bridge
            .invoke(id, f.data)
            .then((value) => {
              if (peers.has(id)) send(m.key, true, value);
            })
            .catch(() => close(id))
            .finally(() => {
              active--;
            });
        }
      } catch {
        close(id);
      }
    };
    rpcPeers.set(id, {
      channel: dc,
      close: shutdown,
      request(payload) {
        if (pending.size >= 4 || dc.readyState !== "open")
          return Promise.reject(new Error("FILE_PEER_UNAVAILABLE"));
        return new Promise((resolve, reject) => {
          const key = String(++sequence);
          const timer = setTimeout(() => {
            pending.delete(key);
            reject(new Error("FILE_PEER_TIMEOUT"));
          }, 15000);
          pending.set(key, { resolve, reject, timer });
          try {
            send(key, false, payload);
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
    const p = { pc, dc: null as RTCDataChannel | null, busy: false };
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
              const bytes = decode(
                await bridge.read(id, current.ticket, current.offset),
              );
              if (peers.get(id) !== p || channel.readyState !== "open") return;
              channel.send(bytes.buffer);
              current.offset += bytes.length;
              if (!bytes.length) source = undefined;
            }
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
            } else {
              if (!source || source.credit + r.credit > 64) throw new Error();
              source.credit += r.credit;
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
            writes = writes
              .then(async () => {
                if (settled) return;
                if (!bytes.length) {
                  done();
                  return;
                }
                let binary = "";
                for (const byte of bytes) binary += String.fromCharCode(byte);
                await bridge.write(sink, written, btoa(binary));
                if (settled) return;
                if (peers.get(id) !== p) throw new Error("FILE_PEER_CLOSED");
                written += bytes.length;
                queued--;
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
    async invoke(id: string, payload: string) {
      const rpc = rpcPeers.get(id);
      if (!rpc) throw new Error("FILE_PEER_UNAVAILABLE");
      return rpc.request(payload);
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
