// 被测对端：独立进程，避免收发两端共用事件循环。
// 流的第一个字节选择模式：E 回显 64 字节；S 收完后回总字节数。
import { bindEndpoint } from './lib.mjs';

const bindAddr = process.argv[2] ?? '127.0.0.1:0';
const relay = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : null;
const endpoint = await bindEndpoint({ bindAddr, relay });
if (relay) await endpoint.online();
const CHUNK = 256 * 1024;

async function serveStream(stream) {
  const mode = String.fromCharCode((await stream.recv.readExact(1))[0]);
  if (mode === 'E') {
    for (;;) {
      let body;
      try { body = await stream.recv.readExact(64); } catch { return; }
      await stream.send.writeAll(body);
    }
  }
  if (mode === 'S') {
    let total = 0;
    for (;;) {
      const part = await stream.recv.read(CHUNK).catch(() => []);
      if (part.length === 0) break;
      total += part.length;
    }
    await stream.send.writeAll([...Buffer.from(String(total))]);
    await stream.send.finish();
  }
}

async function serveConnection(incoming) {
  const connection = await (await incoming.accept()).connect();
  for (;;) {
    const stream = await connection.acceptBi().catch(() => null);
    if (!stream) return;
    serveStream(stream).catch(() => undefined);
  }
}

console.log(JSON.stringify({
  id: endpoint.id().toString(),
  sockets: endpoint.boundSockets(),
  relay: endpoint.addr().relayUrl(),
}));
for (;;) {
  const incoming = await endpoint.acceptNext();
  if (!incoming) break;
  serveConnection(incoming).catch(() => undefined);
}
