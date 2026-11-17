/**
 * 真实网络测试用的中转：在服务器上起一个自建中转内核（打开 agent-net 转发），走加入流程登记测试设备，
 * 把设备凭证写进只有自己能读的 JSON 文件，然后一直运行到被关掉。只用于测试，测完连同数据目录一起删掉。
 * 打包：见 real/README.md。运行：node relay-server.mjs <端口> <凭证文件> <设备号…>
 */
import { writeFile } from 'node:fs/promises';
import { startRelay } from '../relay-fixture.ts';

const [port, out, ...devices] = process.argv.slice(2);
if (!port || !out || devices.length < 2) throw new Error('usage: relay-server <port> <credentials.json> <device> <device>...');
const relay = await startRelay(devices, { port: Number(port), agentNet: true });
await writeFile(out, JSON.stringify({ credentials: Object.fromEntries(relay.credentials) }), { mode: 0o600 });
console.log(`relay listening on ${relay.url} with ${devices.length} devices`);
const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
