// agent-net 验证脚本的公共工具，不依赖任何网络库。
const MIB = 1024 * 1024;

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
