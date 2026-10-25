/**
 * Shared high-confidence sensitive relative path detection.
 *
 * This is intentionally conservative: callers use it to avoid automatically
 * publishing or committing local credential stores, not as a full secret scanner.
 */

export interface SensitivePathOptions {
  /**
   * Git snapshots allow checked-in env templates; package publishers can choose
   * to reject all `.env*` files by setting this to false.
   */
  allowEnvTemplates?: boolean;
  /**
   * Skill packages should exclude whole credential config trees because they
   * are rarely intentional fixtures. Git snapshots keep this narrow so ordinary
   * checked-in CLI examples under `.config/` can still be committed.
   */
  excludeCredentialConfigDirs?: boolean;
}

const ALLOWED_ENV_BASENAMES = new Set(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_DIR_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.azure', '.kube']);

const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.yarnrc',
  '.yarnrc.yml',
  '.envrc',
  'credentials',
  'credentials.json',
  'service-account.json',
]);

const PRIVATE_KEY_BASENAME_RE = /^id_(?:rsa|dsa|ecdsa|ed25519)$/i;
const SENSITIVE_EXTENSION_RE = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;
const SENSITIVE_PATH_RE =
  /(^|\/)(?:\.gem\/credentials|\.docker\/config\.json|\.config\/gcloud\/application_default_credentials\.json|\.config\/gh\/hosts\.ya?ml|\.pip\/pip\.(?:conf|ini)|\.config\/pip\/pip\.(?:conf|ini))$/i;

const SENSITIVE_CONFIG_PREFIXES = [
  '.config/gh',
  '.config/gcloud',
];

function normalizeRelativePath(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function basenameOf(relativePath: string): string {
  const idx = relativePath.lastIndexOf('/');
  return idx >= 0 ? relativePath.slice(idx + 1) : relativePath;
}

/** Returns a detector name when a relative path is too sensitive for automation. */
export function detectSensitivePath(
  relativePath: string,
  options: SensitivePathOptions = {},
): string | null {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized || normalized === '.') return null;

  const lower = normalized.toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  const base = basenameOf(lower);
  const allowEnvTemplates = options.allowEnvTemplates ?? true;
  const excludeCredentialConfigDirs = options.excludeCredentialConfigDirs ?? false;

  if (lower === '.git' || lower.startsWith('.git/') || lower.includes('/.git/')) {
    return 'git-internal-path';
  }
  if ((base === '.env' || base.startsWith('.env.')) && !(allowEnvTemplates && ALLOWED_ENV_BASENAMES.has(base))) {
    return 'env-file';
  }
  if (parts.some((part) => SENSITIVE_DIR_SEGMENTS.has(part))) return 'sensitive-directory';
  if (SENSITIVE_BASENAMES.has(base)) return 'sensitive-basename';
  if (PRIVATE_KEY_BASENAME_RE.test(base)) return 'private-key-path';
  if (SENSITIVE_EXTENSION_RE.test(base)) return 'sensitive-extension';
  if (SENSITIVE_PATH_RE.test(lower)) return 'sensitive-path';
  if (excludeCredentialConfigDirs && SENSITIVE_CONFIG_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`) || lower.includes(`/${prefix}/`))) {
    return 'sensitive-config-directory';
  }
  if (/(^|\/)secrets?\//.test(lower)) return 'secret-directory';
  if (/(^|\/)credentials?\//.test(lower)) return 'credentials-directory';
  if (/(^|\/)(?:secrets?|credentials?)[^/]*\.(?:json|ya?ml|toml|ini|env)$/i.test(lower)) {
    return 'secret-config-path';
  }
  return null;
}
