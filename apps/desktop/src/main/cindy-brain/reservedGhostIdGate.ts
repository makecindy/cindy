/**
 * Hidden development override for reproducing the packaged reserved-prefix gate.
 *
 * Schema: only the exact value `1` enables the gate in an unpackaged build.
 * Packaged builds always keep the gate enabled; the override can only tighten
 * development behavior and can never weaken production behavior.
 */
export const GHOST_RESERVED_PREFIX_GATE_ENV = 'XDT_GHOST_RESERVED_PREFIX_GATE';

export function shouldRejectReservedGhostIds(
  isPackaged: boolean,
  envValue = process.env[GHOST_RESERVED_PREFIX_GATE_ENV],
): boolean {
  return isPackaged || envValue === '1';
}
