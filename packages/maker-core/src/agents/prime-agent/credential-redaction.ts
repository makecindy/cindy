/**
 * Prime Agent 的凭证脱敏唯一入口。
 *
 * 两层,缺一不可:
 * 1. maker-shared 的 `redactSensitiveText` —— 它专门处理 `Authorization: Basic <base64>`
 *    这类非 Bearer 方案与常见 header 形态;
 * 2. 本模块的 key-aware + 值形状兜底 —— 字段名命中(token / secret / api_key /
 *    authorization / password / credential)即整体替换, 值形状覆盖 sk- / ghp_ /
 *    github_pat_ / AIza / hf_ / Bearer / JWT 等 8 类。
 *
 * transport 与 rpc-client 必须走同一个入口: 同一行 stderr 会被两处记录, 只在
 * rpc-client 做双层脱敏, transport 自己的日志仍然会留下凭证原文。
 */
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';

/**
 * key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex token / 自定义 header 值,
 * 字段名命中即整体替换。Prime Agent 自带 provider 的内联 API 密钥会出现在
 * models.json / 报错文本里, 进日志前必须拦。
 *
 * 值部分先尝试整体吃掉一个 `[...]` 占位符: maker-shared 的脱敏会先产出
 * `[REDACTED]`, 若值形态只匹配到 `[REDACTED` 就会剩一个孤立的 `]` 尾巴。
 */
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)((?:\[[^\]\n]*\])|[^,\s}\]]+)/gi;

/** 值形状兜底 —— 已知 provider 凭证前缀与 JWT 三段式。 */
const CREDENTIAL_VALUE_RE =
  /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g;

/** key-aware 脱敏(值形状兜底之外的第二道)。 */
export function redactCredentialText(text: string): string {
  let out = text;
  try {
    out = out.replace(CREDENTIAL_VALUE_RE, '[REDACTED]');
  } catch {
    /* regex 极端输入不阻断诊断 */
  }
  out = out.replace(
    SENSITIVE_KEY_RE,
    (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
      `${pre}${quote}[REDACTED]${sep}[REDACTED]`,
  );
  return out;
}

/** 进日志 / 进 UI 之前的双层脱敏。 */
export function redactPrimeAgentLogText(text: string): string {
  return redactCredentialText(redactSensitiveText(text));
}

/**
 * 结构化载荷(响应 `data` 等)的脱敏: 递归走对象与数组, 只脱敏字符串叶子,
 * 不改变结构 —— 调用方拿到的仍然是对象, 而不是一段 JSON 文本。
 */
export function redactPrimeAgentPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactPrimeAgentLogText(value);
  if (Array.isArray(value)) return value.map((item) => redactPrimeAgentPayload(item, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactPrimeAgentPayload(item, depth + 1);
    }
    return out;
  }
  return value;
}
