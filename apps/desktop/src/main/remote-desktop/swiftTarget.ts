import type { ForgeArch } from '@electron-forge/shared-types';

export function swiftTargetTriple(
  cpuArch: 'arm64' | 'x86_64',
  deploymentTarget: string,
): string {
  return `${cpuArch}-apple-${deploymentTarget}`;
}

export function swiftTargetTriplesForForgeArch(
  arch: ForgeArch,
  deploymentTarget: string,
): string[] {
  switch (arch) {
    case 'x64':
      return [swiftTargetTriple('x86_64', deploymentTarget)];
    case 'arm64':
      return [swiftTargetTriple('arm64', deploymentTarget)];
    case 'universal':
      return [
        swiftTargetTriple('x86_64', deploymentTarget),
        swiftTargetTriple('arm64', deploymentTarget),
      ];
    default:
      throw new Error(`[forge] unsupported macOS Swift helper arch: ${arch}`);
  }
}
