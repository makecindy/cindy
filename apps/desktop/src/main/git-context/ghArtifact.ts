import type { ToolArtifact } from '../managed-tools/types.js';

// Official cli/cli v2.101.0 release asset SHA-256 digests. Update version,
// digests and archive layouts together; Renderer cannot select an executable.
export const GH_VERSION = '2.101.0';
const hashes: Record<string, string> = {
  'darwin-arm64': 'e4303e39d8f07141c4bad4b99b01079f05029c59b27076e8fbc825c985ecdd8b',
  'darwin-x64': 'a6fd66c88e2f07d6e4e058173db341d07dd74d58cf8f19ae668293d2bb614ca3',
  'linux-arm64': 'b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f',
  'linux-x64': '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8',
  'win32-arm64': 'e6cbb2d4afdad3e70f3d38b8d1ebaa3a0870a897cfc0e4cf569826710b96b4fd',
  'win32-x64': 'bc6c814367b193cd8e713611d61e36013c0ef843b8f516458fe3eda039192794',
};
export function ghArtifact(platform: string, arch: string): ToolArtifact | undefined {
  const host = `${platform}-${arch}`;
  const sha256 = hashes[host];
  if (!sha256) return;
  const os = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'windows' : 'linux';
  const name = `gh_${GH_VERSION}_${os}_${arch === 'x64' ? 'amd64' : arch}`;
  const format = platform === 'linux' ? 'tar.gz' : 'zip';
  return {
    id: 'gh',
    version: GH_VERSION,
    host,
    sha256,
    format,
    url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${name}.${format}`,
    executable: platform === 'win32' ? 'bin/gh.exe' : `${name}/bin/gh`,
  };
}
