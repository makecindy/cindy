import { BUNDLED_ENGINES } from './catalog.js';
import { EngineError, type EngineKind, type EngineRelease, type EngineAsset } from './types.js';

export const enginePlatform = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
const triples: Record<string, string> = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl', 'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc' };

async function json(url: string, signal?: AbortSignal): Promise<any> {
  const token = process.env.CINDY_GITHUB_API_TOKEN;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), headers: {
    Accept: 'application/json', 'User-Agent': 'Cindy-Terminal',
    ...(new URL(url).origin === 'https://api.github.com' && token ? { Authorization: `Bearer ${token}` } : {}),
  } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new EngineError(response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0' ? 'release_rate_limited' : `release_http_${response.status}`);
  }
  if (Number(response.headers.get('content-length') ?? 0) > 4_000_000) { await response.body?.cancel(); throw new EngineError('release_response_too_large'); }
  const data = await response.text();
  if (data.length > 4_000_000) throw new EngineError('release_unavailable');
  return JSON.parse(data);
}

/** Same official sources as ensure-agent-binaries; repository pins are never
 * modified. Missing official digests fail closed, rather than downloading an
 * unverifiable executable or the legacy single-file Codex distribution. */
export async function latestEngineRelease(kind: EngineKind, signal?: AbortSignal, requestedVersion?: string): Promise<EngineRelease> {
  if (requestedVersion && !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(requestedVersion)) throw new EngineError('invalid_release');
  const assets: Record<string, EngineAsset> = {};
  if (kind === 'claude-code') {
    const meta = await json(`https://registry.npmjs.org/@anthropic-ai/claude-code/${requestedVersion ?? 'latest'}`, signal);
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(meta.version)) throw new EngineError('invalid_release');
    const release = await json(`https://downloads.claude.ai/claude-code-releases/${meta.version}/manifest.json`, signal);
    for (const key of Object.keys(triples)) {
      const item = release.platforms?.[key];
      if (!item || !/^[a-f0-9]{64}$/i.test(item.checksum) || !Number.isSafeInteger(item.size) || item.size <= 0) continue;
      const entrypoint = key.startsWith('win32') ? 'claude.exe' : 'claude';
      assets[key] = { url: `https://downloads.claude.ai/claude-code-releases/${meta.version}/${key}/${entrypoint}`, sha256: item.checksum.toLowerCase(), size: item.size, format: 'raw', entrypoint };
    }
    return { version: meta.version, assets };
  }
  const repo = kind === 'codex' ? 'openai/codex' : 'earendil-works/pi';
  const tag = `${kind === 'codex' ? 'rust-v' : 'v'}${requestedVersion}`;
  const release = await json(`https://api.github.com/repos/${repo}/releases/${requestedVersion ? `tags/${tag}` : 'latest'}`, signal);
  const version = String(release.tag_name ?? '').replace(kind === 'codex' ? /^rust-v/ : /^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) || !Array.isArray(release.assets)) throw new EngineError('invalid_release');
  for (const [key, target] of Object.entries(triples)) {
    const windows = key.startsWith('win32');
    const name = kind === 'codex' ? `codex-package-${target}.tar.gz` : `pi-${key.replace('win32', 'windows')}.${windows ? 'zip' : 'tar.gz'}`;
    const asset = release.assets.find((item: any) => item.name === name);
    if (!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    const expected = `https://github.com/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
    if (asset.browser_download_url !== expected) throw new EngineError('invalid_release');
    assets[key] = { url: expected, sha256: asset.digest.slice(7).toLowerCase(), size: asset.size, format: kind === 'pi' && windows ? 'zip' : 'tar.gz', entrypoint: `${kind === 'codex' ? 'bin/' : ''}${kind === 'codex' ? 'codex' : 'pi'}${windows ? '.exe' : ''}`, ...(kind === 'codex' ? { target } : {}) };
  }
  if (!Object.keys(assets).length) throw new EngineError('release_unavailable');
  return { version, assets };
}

export function bundledEngineRelease(kind: EngineKind): EngineRelease { return BUNDLED_ENGINES[kind]; }
