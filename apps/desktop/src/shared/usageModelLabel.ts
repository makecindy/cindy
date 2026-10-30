import { stripCodexGatewayWirePrefix } from '@cindy/model-providers';

/**
 * 把 SDK / 网关 model id 收成简短可读标签, 供 tooltip「按模型成本明细」展示。
 * 依次剥掉 SDK 路由后缀 `[..]`、尾部日期 `-YYYYMMDD`、`openai-codex/` / `codex/` 预算前缀, 再美化家族名。
 * 认不出的安全回退原始 id (绝不返回空串)。
 *   'claude-opus-4-8[1m]'       → 'Opus 4.8'
 *   'claude-haiku-4-5-20251001' → 'Haiku 4.5'
 *   'gpt-5.5' / 'codex/gpt-5.5' / 'openai-codex/gpt-5.5' → 'GPT-5.5'
 */
export function formatModelShort(id: string): string {
  if (typeof id !== 'string' || !id.trim()) return id;
  const s = stripCodexGatewayWirePrefix(id.trim()
    .replace(/\[[^\]]*\]\s*$/, '') // 去 [1m] 等 SDK 路由后缀
    .replace(/-\d{6,8}$/, ''));    // 去尾部日期 -YYYYMMDD / -YYMMDD
  const claude = s.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/i);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return `${family} ${claude[2]}.${claude[3]}`;
  }
  if (/^gpt-/i.test(s)) return s.toUpperCase();
  return s || id;
}
