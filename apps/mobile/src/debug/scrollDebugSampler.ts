/** Per-list sampling: retain interaction changes/final drag samples, at most 4 Hz otherwise. */
export function createScrollDebugSampler(now = () => performance.now()) {
  let lastAt = -Infinity;
  let lastFlags = -1;
  return (flags: number, finalSample: boolean): boolean => {
    const at = now();
    if (!finalSample && flags === lastFlags && at - lastAt < 250) return false;
    lastAt = at;
    lastFlags = flags;
    return true;
  };
}
