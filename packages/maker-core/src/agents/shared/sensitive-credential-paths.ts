/**
 * Credential-bearing path patterns shared by every harness permission adapter.
 *
 * Keep the serializable `{ source, flags }` form as the source of truth: the Pi
 * bridge runs in a standalone child process and embeds these specs into its
 * generated extension instead of maintaining a second handwritten regex list.
 */
export const SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS = [
  {
    source: String.raw`(?:^|[\\/\s'"~])\.(?:ssh|aws|gnupg|kube|docker|azure|claude|codex)\b`,
    flags: "i",
  },
  {
    source: String.raw`(?:^|[\\/\s'"~])\.(?:netrc|npmrc|pgpass|pypirc|git-credentials)\b`,
    flags: "i",
  },
  { source: String.raw`[\\/]\.cargo[\\/]credentials(?:\.toml)?\b`, flags: "i" },
  {
    source: String.raw`[\\/]\.m2[\\/]settings(?:-security)?\.xml\b`,
    flags: "i",
  },
  { source: String.raw`\bapplication_default_credentials\b`, flags: "i" },
  { source: String.raw`\bcredentials\.json\b`, flags: "i" },
  {
    source: String.raw`[\\/](?:codex|claude|gcloud|containers)[\\/]auth\.json\b`,
    flags: "i",
  },
  {
    source: String.raw`[\\/]\.config[\\/](?:gh|hub|glab|op|gcloud)\b`,
    flags: "i",
  },
  { source: String.raw`/proc/[^\s]*/environ\b`, flags: "i" },
  {
    // 轮 30 HIGH-1:补 .key(TLS 私钥标配)与 .pfx(PKCS#12 Windows 习惯)。
    // 自定义命名 SSH 私钥(无扩展名、非 id_*)无法靠文件名可靠区分, 属已知
    // 盲区 —— 依赖 .ssh/ 目录规则与 magic-byte 检测(未来)。
    source: String.raw`\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\bid_dsa\b|\.pem\b|\.p12\b|\.pfx\b|\.key\b`,
    flags: "i",
  },
  // 远端 agent home(CC/Codex 的 ~/.xdt-server/v1/ 亦然)由 Cindy 托管,内含
  // daemon env-file、codex-home 凭证、cc-manager 配置等真值 —— LLM 无合法
  // 读取场景,任一 harness 一律拦截(R5 安全审计 C-1)。
  { source: String.raw`(?:^|[\\/\s'"~])\.xdt-server\b`, flags: "i" },
] as const;

/**
 * Review tools receive structured file paths rather than arbitrary shell
 * source, so they can safely treat dotenv files as credentials without
 * misclassifying data expressions such as `jq .env`.
 */
export const REVIEW_SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS = [
  ...SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS,
  { source: String.raw`(?:^|[\\/])\.env(?:\.[^\\/]+)?$`, flags: "i" },
  // Git config can contain credential-bearing remote URLs, while object storage
  // can reconstruct a sensitive tracked file even when its worktree path is
  // denied. Review receives a sanitized diff and never needs raw .git access.
  { source: String.raw`(?:^|[\\/])\.git(?:[\\/]|$)`, flags: "i" },
  // Generated dependency trees are not delivery artifacts. Keeping them out of
  // the Review read scope also keeps the full-workspace freshness fingerprint
  // bounded without leaving readable ignored content outside that baseline.
  { source: String.raw`(?:^|[\\/])node_modules(?:[\\/]|$)`, flags: "i" },
  // Cindy's managed harness binaries and local build cache are executable
  // runtime inputs, not reviewable source artifacts. A real Cindy worktree is
  // larger than the bounded content fingerprint if these generated payloads
  // remain readable, so every harness excludes the same paths.
  {
    source: String.raw`(?:^|[\\/])apps[\\/](?:claude-code|codex|pi|ripgrep)-bin(?:[\\/]|$)`,
    flags: "i",
  },
  {
    source: String.raw`(?:^|[\\/])tools[\\/]pi[\\/]updates(?:[\\/]|$)`,
    flags: "i",
  },
  { source: String.raw`(?:^|[\\/])\.vite(?:[\\/]|$)`, flags: "i" },
] as const;

/**
 * File-search deny globs shared by Review harnesses.
 *
 * Path regexes protect explicit reads and symlink targets. Directory-wide
 * Grep/Glob/Find tools need a second, execution/result-level boundary because
 * their input can be only a granted directory with no concrete file selector.
 */
export const REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/.git",
  "**/.git/**",
  "**/node_modules",
  "**/node_modules/**",
  "**/apps/claude-code-bin/**",
  "**/apps/codex-bin/**",
  "**/apps/pi-bin/**",
  "**/apps/ripgrep-bin/**",
  "**/tools/pi/updates/**",
  "**/.vite/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.docker/**",
  "**/.azure/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.netrc",
  "**/.npmrc",
  "**/.pgpass",
  "**/.pypirc",
  "**/.git-credentials",
  "**/.cargo/credentials",
  "**/.cargo/credentials.toml",
  "**/.m2/settings.xml",
  "**/.m2/settings-security.xml",
  "**/application_default_credentials*",
  "**/credentials.json",
  "**/auth.json",
  "**/.config/gh/**",
  "**/.config/hub/**",
  "**/.config/glab/**",
  "**/.config/op/**",
  "**/.config/gcloud/**",
  "**/environ",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/id_dsa",
  "**/.xdt-server",
  "**/.xdt-server/**",
] as const;

export const SENSITIVE_CREDENTIAL_PATH_PATTERNS: readonly RegExp[] =
  SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS.map(
    ({ source, flags }) => new RegExp(source, flags),
  );

export function isSensitiveCredentialPath(target: string): boolean {
  return (
    typeof target === "string" &&
    SENSITIVE_CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(target))
  );
}

const REVIEW_SENSITIVE_CREDENTIAL_PATH_PATTERNS: readonly RegExp[] =
  REVIEW_SENSITIVE_CREDENTIAL_PATH_PATTERN_SPECS.map(
    ({ source, flags }) => new RegExp(source, flags),
  );

export function isReviewSensitiveCredentialPath(target: string): boolean {
  return (
    typeof target === "string" &&
    REVIEW_SENSITIVE_CREDENTIAL_PATH_PATTERNS.some((pattern) =>
      pattern.test(target),
    )
  );
}

/**
 * File selectors are not concrete paths: glob metacharacters can hide a
 * sensitive basename from an otherwise path-shaped check. Inspect each
 * alternative and a metacharacter-free form before a Review search runs.
 */
export function isReviewSensitiveCredentialSelector(selector: string): boolean {
  if (typeof selector !== "string") return false;
  const candidates = [selector, ...selector.split(/[{},|]/)];
  return candidates.some((candidate) => {
    if (isReviewSensitiveCredentialPath(candidate)) return true;
    const literalized = candidate.replace(/[*?[\]{}()!+@]/g, "");
    return (
      literalized !== candidate && isReviewSensitiveCredentialPath(literalized)
    );
  });
}
