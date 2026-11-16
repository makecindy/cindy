// agent-net 第 0 阶段验证的公共工具：只用 iroh 的最小预设，不连接任何外部服务。
// 不依赖 iroh 的工具在 util.mjs，这里一并导出，旧脚本不用改。
import { Endpoint, EndpointAddr, EndpointId, RelayMode, presetMinimal } from '@number0/iroh';

export { mibPerSecond, nowMs, percentile, sleep, summarize } from './util.mjs';

export const ALPN = [...Buffer.from('cindy/agent-net/0')];

export async function bindEndpoint({ relay = null, bindAddr = '127.0.0.1:0' } = {}) {
  const builder = Endpoint.builder();
  presetMinimal(builder);
  builder.alpns([ALPN]);
  builder.relayMode(relay ? RelayMode.customFromUrls([relay]) : RelayMode.disabled());
  builder.bindAddr(bindAddr);
  return builder.bind();
}

export function addrOf(idText, sockets, relay = null) {
  return new EndpointAddr(EndpointId.fromString(idText), relay, sockets);
}
