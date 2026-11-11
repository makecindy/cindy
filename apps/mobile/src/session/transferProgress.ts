import { formatByteSize } from "@/session/filePreview";

export interface TransferProgress {
  loaded: number;
  total: number;
  /** 采样不足半秒时为 null,显示时省略速度,不编造数字。 */
  bytesPerSecond: number | null;
}

/** 按最近约 3 秒的真实字节差测速;字节回退(重新上传)时重新开始采样。 */
export function createTransferProgressMeter(
  windowMs = 3000,
  now: () => number = Date.now,
) {
  let samples: Array<{ at: number; loaded: number }> = [];
  return (loaded: number, total: number): TransferProgress => {
    const at = now();
    const last = samples[samples.length - 1];
    if (last && loaded < last.loaded) samples = [];
    samples.push({ at, loaded });
    while (samples.length > 2 && at - samples[1].at >= windowMs)
      samples.shift();
    const first = samples[0];
    const elapsed = at - first.at;
    return {
      loaded,
      total,
      bytesPerSecond:
        elapsed >= 500 ? ((loaded - first.loaded) * 1000) / elapsed : null,
    };
  };
}

export function transferPercent(
  progress: Pick<TransferProgress, "loaded" | "total">,
): number {
  if (!(progress.total > 0)) return 0;
  return Math.max(
    0,
    Math.min(100, Math.floor((progress.loaded / progress.total) * 100)),
  );
}

/** 例:「42% · 2.4 MB/s」;速度未知时只显示百分比。 */
export function formatTransferProgress(progress: TransferProgress): string {
  const percent = `${transferPercent(progress)}%`;
  if (progress.bytesPerSecond === null) return percent;
  return `${percent} · ${formatByteSize(Math.round(progress.bytesPerSecond))}/s`;
}
