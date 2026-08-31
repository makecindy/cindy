export const OLLAMA_GITHUB_API_LATEST = 'https://api.github.com/repos/ollama/ollama/releases/latest';
export const OLLAMA_DARWIN_ASSET_NAME = 'ollama-darwin.tgz';
export const OLLAMA_WINDOWS_AMD64_ASSET_NAME = 'ollama-windows-amd64.zip';
export const OLLAMA_WINDOWS_ARM64_ASSET_NAME = 'ollama-windows-arm64.zip';

const VERSION_RE = /^v?(\d+\.\d+\.\d+)$/;
const ALLOWED_GITHUB_ASSET_RE =
  /^\/ollama\/ollama\/releases\/download\/v\d+\.\d+\.\d+\/(?:ollama-darwin\.tgz|ollama-windows-amd64\.zip|ollama-windows-arm64\.zip)$/;
const DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

export interface OfficialOllamaAsset {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  assetName: string;
}

export function parseOllamaVersionTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value.trim());
  return match?.[1] ?? null;
}

export function parseGithubSha256Digest(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

export function sidecarAssetNameFor(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  if (platform === 'darwin') return OLLAMA_DARWIN_ASSET_NAME;
  if (platform === 'win32' && arch === 'arm64') return OLLAMA_WINDOWS_ARM64_ASSET_NAME;
  if (platform === 'win32' && arch === 'x64') return OLLAMA_WINDOWS_AMD64_ASSET_NAME;
  return null;
}

export function isAllowedOllamaDownloadUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!DOWNLOAD_HOSTS.has(host)) return false;
  if (host === 'github.com') return ALLOWED_GITHUB_ASSET_RE.test(parsed.pathname);
  return true;
}

export function pickOfficialSidecarAsset(
  release: unknown,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture = process.arch,
): OfficialOllamaAsset | null {
  const wanted = sidecarAssetNameFor(platform, arch);
  if (!wanted) return null;
  if (!release || typeof release !== 'object') return null;
  const record = release as { tag_name?: unknown; assets?: unknown };
  const version = parseOllamaVersionTag(record.tag_name);
  if (!version || !Array.isArray(record.assets)) return null;
  for (const asset of record.assets) {
    if (!asset || typeof asset !== 'object') continue;
    const item = asset as {
      name?: unknown;
      browser_download_url?: unknown;
      digest?: unknown;
      size?: unknown;
    };
    if (item.name !== wanted) continue;
    if (typeof item.browser_download_url !== 'string') return null;
    if (!isAllowedOllamaDownloadUrl(item.browser_download_url)) return null;
    const sha256 = parseGithubSha256Digest(item.digest);
    if (!sha256) return null;
    if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size <= 0) return null;
    return {
      version,
      url: item.browser_download_url,
      sha256,
      sizeBytes: item.size,
      assetName: wanted,
    };
  }
  return null;
}

export function pickOfficialDarwinAsset(release: unknown): OfficialOllamaAsset | null {
  return pickOfficialSidecarAsset(release, 'darwin');
}

export function supportsManagedOllamaInstall(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  return sidecarAssetNameFor(platform, arch) !== null;
}
