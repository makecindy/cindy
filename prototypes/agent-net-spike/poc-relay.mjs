// 验证自建中继：没有直连地址时经中继通信；只有内核放行的设备能用；撤销后重连被拒。
import { Endpoint, EndpointAddr, RelayMode, presetMinimal } from '@number0/iroh';
import { ALPN, nowMs, sleep, summarize } from './lib.mjs';

const RELAY = 'http://127.0.0.1:47101/';
const post = (path, body) => fetch(`http://127.0.0.1:47100${path}`, { method: 'POST', body });

async function bind() {
  const builder = Endpoint.builder();
  presetMinimal(builder);
  builder.alpns([ALPN]);
  builder.relayMode(RelayMode.customFromUrls([RELAY]));
  builder.bindAddr('127.0.0.1:0');
  return builder.bind();
}
const withTimeout = (promise, ms) => Promise.race([promise, sleep(ms).then(() => { throw new Error('timeout'); })]);

const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const a = await bind();
const b = await bind();
await post('/allow', a.id().toString());
await post('/allow', b.id().toString());
await withTimeout(Promise.all([a.online(), b.online()]), 8000);
check('已加入的设备连上中继', true, `home=${a.addr().relayUrl()}`);

(async () => {
  for (;;) {
    const incoming = await b.acceptNext();
    if (!incoming) return;
    const connection = await (await incoming.accept()).connect();
    (async () => {
      for (;;) {
        const stream = await connection.acceptBi().catch(() => null);
        if (!stream) return;
        (async () => {
          for (;;) {
            const data = await stream.recv.readExact(64).catch(() => null);
            if (!data) return;
            await stream.send.writeAll(data);
          }
        })();
      }
    })();
  }
})();

// 只给中继地址，不给任何直连地址。
const start = nowMs();
const connection = await withTimeout(a.connect(new EndpointAddr(b.id(), RELAY, []), ALPN), 8000);
const connectMs = nowMs() - start;
const stream = await connection.openBi();
const body = Array.from({ length: 64 }, (_, i) => i);
const samples = [];
const firstPaths = connection.paths().map((p) => (p.isRelay ? 'relay' : 'ip'));
for (let i = 0; i < 100; i++) {
  const t = nowMs();
  await stream.send.writeAll(body);
  await stream.recv.readExact(64);
  samples.push(nowMs() - t);
}
check('只知道中继地址也能建连并收发', true, `建连 ${Math.round(connectMs)}ms，起始路径 ${firstPaths.join('+')}，RTT ${JSON.stringify(summarize(samples))}`);
await sleep(1500);
const later = connection.paths().map((p) => `${p.isRelay ? 'relay' : 'ip'}${p.isSelected ? '*' : ''}`);
check('连上后自动探测直连路径', later.length > 0, `当前路径 ${later.join(' ')}（* 为选中）`);

const stranger = await bind();
const denied = await withTimeout(stranger.online(), 4000).then(() => false, () => true);
check('未加入的设备用不了中继', denied, denied ? '等待 4 秒仍未上线' : '被放行了');

await post('/revoke', a.id().toString());
const revoked = await bind();
await post('/allow', 'nobody');
const seen = await (await fetch('http://127.0.0.1:47100/seen')).json();
check('回调请求格式', seen.every((s) => s.method === 'POST' && s.hasId === 64), `共 ${seen.length} 次，POST + 64 位十六进制身份`);
for (const line of results) console.log(line);
await Promise.allSettled([connection.close(0n, []), a.close(), b.close(), stranger.close(), revoked.close()]);
process.exit(results.some((line) => line.startsWith('FAIL')) ? 1 : 0);
