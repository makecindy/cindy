import metadata from '../../../resources/node-runtime-artifacts.json';
import type { ToolArtifact } from './types.js';

/** One publisher pin shared by Make and the scheduler's packaged native Node. */
export function nodeRuntimeArtifact(platform: string, arch: string): ToolArtifact | undefined {
  const host = platform + '-' + arch;
  const sha256 = (metadata.hashes as Record<string, string>)[host];
  if (!sha256) return undefined;
  const windows = platform === 'win32';
  const directory = 'node-v' + metadata.version + '-' + (windows ? 'win' : platform) + '-' + arch;
  const format = windows ? 'zip' : 'tar.gz';
  return {
    id: 'node', version: metadata.version, host, sha256, format,
    url: 'https://nodejs.org/dist/v' + metadata.version + '/' + directory + '.' + format,
    executable: directory + (windows ? '/node.exe' : '/bin/node'),
  };
}
