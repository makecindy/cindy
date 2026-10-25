/**
 * High-confidence secret redaction for snapshot label prompts.
 *
 * This is intentionally conservative. It is not a full secret scanner; it only
 * strips obvious tokens before diff text is sent to the out-of-band labeler.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "private-key",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { name: "aws-access-key-id", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,255}\b/g },
  { name: "openai-api-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-api-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: "stripe-secret-key",
    regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

const SECRET_ASSIGNMENT_RE =
  /(^|\n)([+-]?[^\S\r\n]*(?:(?:export[^\S\r\n]+)?(?:const|let|var)[^\S\r\n]+)?"?[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Za-z0-9_.-]*"?(?:[^\S\r\n]*:[^=\r\n]+)?[^\S\r\n]*[:=][^\S\r\n]*)(['"]?)([^'"\s#]{8,})(\3)/giu;

/** Redacts high-confidence secret-looking values from text before LLM use. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    out = out.replace(pattern.regex, `[REDACTED:${pattern.name}]`);
  }

  SECRET_ASSIGNMENT_RE.lastIndex = 0;
  return out.replace(
    SECRET_ASSIGNMENT_RE,
    (
      _raw,
      prefix: string,
      keyPart: string,
      quote: string,
      _value: string,
      closingQuote: string,
    ) => `${prefix}${keyPart}${quote}[REDACTED]${closingQuote}`,
  );
}
