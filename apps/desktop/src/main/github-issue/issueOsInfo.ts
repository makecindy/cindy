import os from 'node:os';

export function getIssueOsInfo(
  platform = process.platform,
  arch = process.arch,
  kernelVersion = os.release(),
  productVersion = platform === 'darwin' ? process.getSystemVersion?.() : undefined,
) {
  if (platform !== 'darwin') return { platform, arch, osVersion: kernelVersion };

  const version = productVersion?.trim();
  const kernelLabel = `Darwin ${kernelVersion}`;
  return {
    platform: 'macOS',
    arch,
    osVersion: version ? `${version} · ${kernelLabel}` : kernelLabel,
  };
}
