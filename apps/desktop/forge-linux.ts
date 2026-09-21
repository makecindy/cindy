import fs from 'node:fs';
import path from 'node:path';

/** Release identity outside ASAR for the unprivileged Linux installer. */
export function stageLinuxBuildInfo(
  buildPath: string, platform: string, arch: string, version: string, region: string,
): void {
  if (platform !== 'linux') return;
  if (!['x64', 'arm64'].includes(arch) || !['global', 'cn', 'dev'].includes(region)
    || !/^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error('Invalid Linux build identity');
  }
  fs.writeFileSync(path.join(buildPath, 'resources', 'linux-build-info'),
    `cindy-linux-v1\n${version}\n${arch}\n${region}\n${region === 'dev' ? 'CindyDev' : 'Cindy'}\n`);
}
