import { nodeRuntimeArtifact } from '../managed-tools/nodeArtifact.js';
import type { ToolArtifact } from '../managed-tools/types.js';
import type { MakeToolId } from '../../shared/cindyMakeDoctor.js';
import { isSupportedMakeHost } from './doctor.js';

/** Pinned publisher artifacts. URLs, hashes and layouts are never supplied by Renderer.
 * Node: nodejs.org SHASUMS256.txt; other hashes: publisher release asset digests.
 * Refresh these together with the repository's engine/packageManager requirements.
 */
export interface MakeToolArtifact extends ToolArtifact {
  id: MakeToolId;
}
const pnpmHashes: Record<string, string> = {
  'win32-x64': '3d1af71e9da7081efd58f95942e1f7e2107bf8fcdae03eb2331c0b6cea59510b',
  'darwin-arm64': 'a99a4d5d0e6bd3728949c24ff74a2f2f2d07f73bc48fd308e4eea75d8e72acdc',
  'darwin-x64': '3b66abb865f4e7a82393861f0f3784d67a704a31a4021739874d4b7910793dca',
  'linux-arm64': '0828e5ee23be89d22bd53cc36e93c181ce9d5c47d75f9fe9bf4bdc7a65c66322',
  'linux-x64': '39d7b6600239712bc9581ea219b17ffef46ba60998779cb717be2e068be029ef',
};
const lfsHashes: Record<string, string> = {
  'win32-x64': 'b62e7b8ceddee635f691233d77de8eaa4b213e9209e0173811d8cfa77f7882c1',
  'darwin-arm64': 'caff76a7d070d8160c89bc39b6e85d98f24135b6fed038a3b4de2590d25102d8',
  'darwin-x64': 'f1c17aeca0b4eaab9ea606226477dbed3b84b56fe0811a9f967d2ea2b2393c53',
  'linux-arm64': 'ac9c8efac980bb0505ead384d087e2acb6486fd8498691a2165fa174ec6118c2',
  'linux-x64': 'e455e00f15d9b95661b8d53498ffb0c3367962cf1ec73c31ab7369516cd6ab8d',
};
const pythonAssets: Record<string, [string, string]> = {
  'win32-x64': [
    'x86_64-pc-windows-msvc',
    '63d263ab0162f34a241a56dc5b283c22d6e131f5516117e6a921350c69ba7d4f',
  ],
  'darwin-arm64': [
    'aarch64-apple-darwin',
    'd3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc',
  ],
  'darwin-x64': [
    'x86_64-apple-darwin',
    'f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137',
  ],
  'linux-arm64': [
    'aarch64-unknown-linux-gnu',
    '01ce0ce9189feaead3298abf10d4efe998c55a489b3d5d38ca4f83dda7e7977e',
  ],
  'linux-x64': [
    'x86_64-unknown-linux-gnu',
    '8a689a077337bea6d1c4bc0b7df1d52fcaa28f5f67e50df8bf417c1e3f9d8874',
  ],
};

export function makeToolCatalog(platform: string, arch: string): MakeToolArtifact[] {
  if (!isSupportedMakeHost(platform, arch)) return [];
  const node = nodeRuntimeArtifact(platform, arch);
  if (!node) return [];
  const host = `${platform}-${arch}`;
  const windows = platform === 'win32';
  const pnpmPlatform = windows ? 'win' : platform === 'darwin' ? 'macos' : 'linux';
  const lfsPlatform = windows ? 'windows' : platform;
  const lfsFormat = platform === 'linux' ? 'tar.gz' : 'zip';
  const [pythonTriple, pythonHash] = pythonAssets[host];
  const artifacts: MakeToolArtifact[] = [
    { ...node, id: 'node' },
    {
      id: 'pnpm',
      version: '10.33.2',
      host,
      sha256: pnpmHashes[host],
      format: 'binary',
      url: `https://github.com/pnpm/pnpm/releases/download/v10.33.2/pnpm-${pnpmPlatform}-${arch}${windows ? '.exe' : ''}`,
      executable: windows ? 'pnpm.exe' : 'pnpm',
    },
    {
      id: 'python',
      version: '3.13.15-20260901',
      host,
      sha256: pythonHash,
      format: 'tar.gz',
      url: `https://github.com/astral-sh/python-build-standalone/releases/download/20260901/cpython-3.13.15%2B20260901-${pythonTriple}-install_only_stripped.tar.gz`,
      executable: windows ? 'python/python.exe' : 'python/bin/python3.13',
    },
    {
      id: 'gitLfs',
      version: '3.8.0',
      host,
      sha256: lfsHashes[host],
      format: lfsFormat,
      url: `https://github.com/git-lfs/git-lfs/releases/download/v3.8.0/git-lfs-${lfsPlatform}-${arch === 'x64' ? 'amd64' : arch}-v3.8.0.${lfsFormat}`,
      executable: `git-lfs-3.8.0/git-lfs${windows ? '.exe' : ''}`,
    },
  ];
  // macOS Git is supplied by CLT; Linux Git by the distribution's package manager.
  if (windows)
    artifacts.unshift({
      id: 'git',
      version: '2.55.0.5',
      host,
      format: 'zip',
      url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip',
      sha256: '56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e',
      executable: 'cmd/git.exe',
    });
  return artifacts;
}
