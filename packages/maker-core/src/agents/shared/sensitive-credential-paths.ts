/**
 * Credential-bearing path patterns shared by every harness permission adapter.
 *
 * Keep the serializable `{ source, flags }` form as the source of truth: the Pi
 * bridge runs in a standalone child process and embeds these specs into its
 * generated extension instead of maintaining a second handwritten regex list.
 */
export const SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS = [
  // 结尾用 `(?![-\w])` 而不是 `\b`:`\b` 把连字符也当成词边界,于是 `.codex-tools`、
  // `.claude-backup` 这类**名字只是以凭证目录开头**的普通目录会被判成凭证路径 —— 实机
  // 语料里 `ls ~/Documents/Github/.codex-tools/…` 因此变成必问红线。`.codex` / `.codex/auth.json`
  // / `~/.ssh/id_rsa` 仍照常命中(后随 `/`、`.` 或结尾)。
  // 代价:`.aws-backup` 这类以连字符续写的目录不再命中本规则 —— 它落回灰区由审阅器判,
  // 不是静默放行;而误报的代价是每次 ls 都弹一张不可跳过的卡。
  { source: String.raw`(?:^|[\\/\s'"~])\.(?:ssh|aws|gnupg|kube|docker|azure|claude|codex)(?![-\w])`, flags: 'i' },
  { source: String.raw`(?:^|[\\/\s'"~])\.(?:netrc|npmrc|pgpass|pypirc|git-credentials)(?![-\w])`, flags: 'i' },
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
