import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { download } from '../downloader/index.js';
import { extractMakeToolArchive } from '../cindy-make/toolArchive.js';
import { isBinaryVersionNotOlder, probeBinaryVersion } from './binary-version-probe.js';

export interface PiBinaryUpdateDeps {
  fetchRelease(signal: AbortSignal): Promise<unknown>;
  download: typeof download;
  extract: typeof extractMakeToolArchive;
  probe: typeof probeBinaryVersion;
}
const defaults: PiBinaryUpdateDeps = {
  fetchRelease: async signal => {
    const response = await fetch('https://api.github.com/repos/earendil-works/pi/releases/latest', {
      signal, headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`Pi release lookup failed (${response.status})`);
    return response.json();
  },
  download, extract: extractMakeToolArchive, probe: probeBinaryVersion,
};

export function parsePiRelease(value: unknown, platform: string, arch: string) {
  const release = value as { tag_name?: unknown; assets?: Array<{ name?: unknown; digest?: unknown; browser_download_url?: unknown }> } | null;
  if (!release || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid Pi release version');
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported Pi host platform');
  const format = platform === 'win32' ? 'zip' as const : 'tar.gz' as const;
  const name = `pi-${platform}-${arch}.${format}`;
  const url = `https://github.com/earendil-works/pi/releases/download/${release.tag_name}/${name}`;
  const asset = Array.isArray(release.assets) ? release.assets.find(asset => asset.name === name) : undefined;
  if (!asset || asset.browser_download_url !== url || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Pi release has no verified asset for this platform');
  return { version: release.tag_name.slice(1), url, sha256: asset.digest.slice(7), format,
    executable: platform === 'win32' ? 'pi.exe' : 'pi' };
}

/** The standalone upstream CLI cannot self-update. Install its official release
 * beside the running distribution, verify it, then let the caller publish it.
 * Never replace/delete a directory backing an active Pi process. */
export async function installPiBinaryUpdate(
  root: string, currentBinary: string, force: boolean,
  deps: PiBinaryUpdateDeps = defaults,
  platform = process.platform, arch = process.arch,
): Promise<{ binaryPath: string; version: string }> {
  const signal = AbortSignal.timeout(180_000);
  const release = parsePiRelease(await deps.fetchRelease(signal), platform, arch);
  const current = await deps.probe(currentBinary, signal);
  if (!force && current && isBinaryVersionNotOlder(current, release.version)) return { binaryPath: currentBinary, version: current };
  await fs.mkdir(root, { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(root), '.pi-update-'));
  const destination = path.join(root, `${release.version}-${randomUUID()}`);
  let published = false;
  try {
    const archive = path.join(stage, `release.${release.format}`);
    const unpacked = path.join(stage, 'unpacked');
    await fs.mkdir(unpacked);
    await deps.download({ url: release.url, sha256: release.sha256, targetPath: archive, signal });
    await deps.extract(archive, unpacked, release, signal);
    const nested = path.join(unpacked, 'pi', release.executable);
    const distribution = await fs.stat(nested).then(s => s.isFile()).catch(() => false)
      ? path.join(unpacked, 'pi') : unpacked;
    const binary = path.join(distribution, release.executable);
    if (platform !== 'win32') await fs.chmod(binary, 0o755);
    if (await deps.probe(binary, signal) !== release.version) throw new Error('Downloaded Pi version verification failed');
    await fs.rename(distribution, destination);
    const finalBinary = path.join(destination, release.executable);
    if (await deps.probe(finalBinary, signal) !== release.version) throw new Error('Installed Pi version verification failed');
    await fs.writeFile(path.join(destination, '.verified'), release.sha256, { mode: 0o600 });
    published = true;
    return { binaryPath: finalBinary, version: release.version };
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (!published) await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
}
