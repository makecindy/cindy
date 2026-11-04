// agent-net 第 0 阶段验证的公共工具：只用 iroh 的最小预设，不连接任何外部服务。
import { Endpoint, EndpointAddr, EndpointId, RelayMode, presetMinimal } from '@number0/iroh';

export const ALPN = [...Buffer.from('cindy/agent-net/0')];
const MIB = 1024 * 1024;

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

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function summarize(values) {
  const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(Math.max(...values)),
  };
}

export const nowMs = () => performance.now();
export const mibPerSecond = (bytes, ms) => Math.round((bytes / MIB / (ms / 1000)) * 10) / 10;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
