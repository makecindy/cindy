/// <reference lib="dom" />

export interface FilePeerRuntimeBridge {
  read(connection: string, ticket: string, offset: number): Promise<string>;
  write(sink: string, offset: number, base64: string): Promise<void>;
}

/**
 * Trusted browser transport, also serialized into Mobile's isolated transport WebView.
 * Keep the factory self-contained: no credentials, paths, imports or user HTML enter it.
 * Pull at most 256 KiB per round; the next batch waits for the sink's disk writes.
 */
export function createFilePeerRuntime(bridge: FilePeerRuntimeBridge) {
  const peers = new Map<
    string,
    { pc: RTCPeerConnection; dc: RTCDataChannel | null; busy: boolean }
  >();
  const chunkBytes = 16384;
  const maxBytes = 104857600;
  function close(id: string) {
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
  async function offer(id: string, servers: RTCIceServer[]) {
    const p = create(id, servers);
    p.dc = p.pc.createDataChannel("files-v1", { ordered: true });
    p.dc.binaryType = "arraybuffer";
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
      if (channel.label !== "files-v1" || p.dc) {
        channel.close();
        return;
      }
      p.dc = channel;
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
    await new Promise<void>((resolve, reject) => {
      const dc = p.dc!;
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
    });
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
      let offset = 0;
      // Also request a zero-byte EOF block: the source rechecks size/mtime before completion.
      while (offset <= size) {
        const batch = await new Promise<Uint8Array[]>((resolve, reject) => {
          const blocks: Uint8Array[] = [];
          let received = offset;
          const timer = setTimeout(
            () => done(new Error("FILE_PEER_TIMEOUT")),
            15000,
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
