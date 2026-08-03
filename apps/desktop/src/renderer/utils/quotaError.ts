/**
 * 余额 / 配额耗尽类错误识别（renderer 侧）—— 判断一条错误 message 是不是「上游明确
 * 说这个账号没钱 / 没配额了」。ErrorBanner 用它在来源确定是 Cindy AI 网关时把错误条
 * 换成「余额不足，请充值后继续」并给出通往计费页的内联出口。
 *
 * **与 networkError.ts / overloadError.ts 的分工**：那两份分别管「网络到不了上游」与
 * 「上游没有容量」，本份管「上游通了、账号自己的钱用完了」。三者的下一步完全不同：
 * 网络类让用户查网络、过载类让用户换模型、本类让用户充值。
 *
 * **判定为什么在这里而不是复用 classifyProviderError**：走到 renderer 的会话错误已经
 * 是一条字符串，status 与响应体都不在手里，classifyProviderError 的 status 分支用不上。
 * 文案 pattern 直接复用 shared 那一份（`matchesQuotaExhaustedText`），不在这里重写，
 * 避免「什么算余额耗尽」两处漂移。
 */

import { matchesQuotaExhaustedText } from '../../shared/providerErrors';

/**
 * 状态码兜底:402 常以 `HTTP 402` / `status 402` / `code: 402` / `(402)` /
 * `402 Payment Required` 之类的形态透出到 message。只认**带状态码上下文**的 402 ——
 * 裸 `\b402\b` 会把正文里恰好出现的独立数字(报价、行号、金额)也判成额度耗尽,
 * 而这条判定会改写错误文案并挂上充值入口,误伤代价高。
 */
const HTTP_402_RE =
  /(?:\b(?:http|status|code|error)\b[^0-9a-z]{0,10}402\b|\(\s*402\s*\)|\b402\s+payment\s+required\b)/i;

export function isQuotaExhaustedErrorMessage(message: string): boolean {
  return matchesQuotaExhaustedText(message) || HTTP_402_RE.test(message);
}
