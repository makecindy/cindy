/**
 * Credential-bearing path patterns shared by every harness permission adapter.
 *
 * Keep the serializable `{ source, flags }` form as the source of truth: the Pi
 * bridge runs in a standalone child process and embeds these specs into its
 * generated extension instead of maintaining a second handwritten regex list.
 */
export const SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS = [
  { source: String.raw`(?:^|[\\/\s'"~])\.(?:ssh|aws|gnupg|kube|docker|azure|claude|codex)\b`, flags: 'i' },
  { source: String.raw`(?:^|[\\/\s'"~])\.(?:netrc|npmrc|pgpass|pypirc|git-credentials)\b`, flags: 'i' },
  { source: String.raw`[\\/]\.cargo[\\/]credentials(?:\.toml)?\b`, flags: 'i' },
  { source: String.raw`[\\/]\.m2[\\/]settings(?:-security)?\.xml\b`, flags: 'i' },
  { source: String.raw`\bapplication_default_credentials\b`, flags: 'i' },
  { source: String.raw`\bcredentials\.json\b`, flags: 'i' },
  { source: String.raw`[\\/](?:codex|claude|gcloud|containers)[\\/]auth\.json\b`, flags: 'i' },
  { source: String.raw`[\\/]\.config[\\/](?:gh|hub|glab|op|gcloud)\b`, flags: 'i' },
  { source: String.raw`/proc/[^\s]*/environ\b`, flags: 'i' },
  { source: String.raw`\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|\.pem\b|\.p12\b`, flags: 'i' },
] as const;

export const SENSITIVE_CREDENTIAL_PATH_PATTERNS: readonly RegExp[] =
  SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS.map(({ source, flags }) => new RegExp(source, flags));

export function isSensitiveCredentialPath(target: string): boolean {
  return typeof target === 'string'
    && SENSITIVE_CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(target));
}
