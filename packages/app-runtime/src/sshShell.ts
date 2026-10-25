// 轮 40-w4-t5 CRITICAL:key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex
// sessionToken / 自定义 MCP header 值, 字段名命中即整体替换。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential|CINDY_PI_MCP_BRIDGE|CINDY_PI_REMOTE_MCP_SECRET)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

/** stderr 进桌面日志前的凭证脱敏(值形状 + key-aware 双保险)。
 *  轮 18-U4:导出供 pi-manager-client 复用(bridge stderr 进用户可见错误前脱敏)。
 *  轮 22-F3 MEDIUM:与 daemon 侧 scrubCredentialText(CREDENTIAL_SCRUB_RE)收敛
 *  同一套值形状覆盖 —— 补 xox(Slack)/LTAI(阿里云)/AKIA·ASIA(AWS)/PEM 私钥块,
 *  否则远端 stderr 吐这些形态时桌面红线漏脱敏。 */
export function redactCredentialText(text: string): string {
  let out = text.replace(
    /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,
    "[REDACTED]",
  );
  out = out.replace(
    SENSITIVE_KEY_RE,
    (
      _m,
      pre: string,
      quote: string,
      _k1: string,
      _k2: string,
      _k3: string,
      sep: string,
    ) => `${pre}${quote}[REDACTED]${sep}[REDACTED]`,
  );
  return out;
}

/**
 * Conservative POSIX single-quote escape(与 ssh-keys.ts / codex-remote-transport 同款)。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
