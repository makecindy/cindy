/**
 * Beta update-channel availability is a build capability, not a renderer-only
 * visibility choice. Keep every caller on the same platform/architecture rule.
 */
export function supportsBetaUpdateChannel(platform: string, arch: string): boolean {
  return platform !== 'linux' || arch === 'x64';
}
