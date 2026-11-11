/** Set only by the verified early startup handoff, before database/updater bootstrap. */
let personal = false;
let lockScope: 'profile' | 'dev' | null = null;
/** Public service configuration only; no account tokens or provider credentials. */
export interface CindyVersionEndpointSnapshot {
  manifestText: string;
  local: boolean;
}
let endpointOverride: CindyVersionEndpointSnapshot | undefined;
let originEndpoints: { snapshot?: CindyVersionEndpointSnapshot } | undefined;
export function setCindyVersionEndpointOverride(
  value: CindyVersionEndpointSnapshot | undefined,
): void {
  endpointOverride = value;
}
export function getCindyVersionEndpointOverride(): CindyVersionEndpointSnapshot | undefined {
  return personal ? endpointOverride : undefined;
}
export function captureCindyVersionOriginEndpoints(
  snapshot: CindyVersionEndpointSnapshot | undefined,
): void {
  originEndpoints = { snapshot };
}
export function getCindyVersionOriginEndpoints() {
  return originEndpoints;
}
export function setCindyVersionLockScope(value: 'profile' | 'dev' | null): void {
  lockScope = value;
}
export function getCindyVersionLockScope(): 'profile' | 'dev' | null {
  return lockScope;
}
export function setCindyPersonalRuntime(value: boolean): void {
  personal = value;
}
export function isCindyPersonalRuntime(): boolean {
  return personal;
}
