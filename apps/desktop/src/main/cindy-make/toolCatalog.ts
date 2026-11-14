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

const nodeHashes: Record<string, string> = {
  'win32-x64': '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
  'darwin-arm64': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  'darwin-x64': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
  'linux-arm64': '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30',
  'linux-x64': 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
};
const pnpmHashes: Record<string, string> = {
  'win32-x64': 'd4e81b5e957bd0a46e154eb68c1139eae61a9697e818d9cc138dfa2eed29ab38',
  'darwin-arm64': '93efa89cca09006a3dec7c5e5b902a6679e1e7dd21400007b738f8cb3e802e5e',
  'darwin-x64': 'e54b07e5634b7bf4352153e0c8c25bcef2930a29e3d1bdc42a9eaf2ffd4436df',
  'linux-arm64': '2da5106f94a6b34b8ed59c8a9b8223c0f32621f4494b4d7644b672b8aac1ba4f',
  'linux-x64': '44588952c6e0e2c25f5b3363c5736d7a176ce8dc6200ae8179bd688e60a212a7',
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
  const host = `${platform}-${arch}`;
  const windows = platform === 'win32';
  const nodeDir = `node-v22.23.2-${windows ? 'win' : platform}-${arch}`;
  const nodeFormat = windows ? 'zip' : 'tar.gz';
  // The publisher no longer ships an Intel Mac standalone executable.
  // Its official Node package runs under the same managed Node as the build.
  const pnpmNodePackage = platform === 'darwin' && arch === 'x64';
  const lfsPlatform = windows ? 'windows' : platform;
  const lfsFormat = platform === 'linux' ? 'tar.gz' : 'zip';
  const [pythonTriple, pythonHash] = pythonAssets[host];
  const artifacts: MakeToolArtifact[] = [
    {
      id: 'node',
      version: '22.23.2',
      host,
      sha256: nodeHashes[host],
      format: nodeFormat,
      url: `https://nodejs.org/dist/v22.23.2/${nodeDir}.${nodeFormat}`,
      executable: `${nodeDir}/${windows ? 'node.exe' : 'bin/node'}`,
    },
    {
      id: 'pnpm',
      version: '11.28.9',
      host,
      sha256: pnpmHashes[host],
      format: windows ? 'zip' : 'tar.gz',
      url: pnpmNodePackage
        ? 'https://registry.npmjs.org/pnpm/-/pnpm-11.28.9.tgz'
        : `https://github.com/pnpm/pnpm/releases/download/v11.28.9/pnpm-${platform}-${arch}.${windows ? 'zip' : 'tar.gz'}`,
      executable: pnpmNodePackage ? 'package/bin/pnpm' : windows ? 'pnpm.exe' : 'pnpm',
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
