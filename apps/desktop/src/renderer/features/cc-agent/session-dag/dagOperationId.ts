/** Native requests need a stable opaque ID, including on non-HTTPS development origins. */
export function nextDagId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
