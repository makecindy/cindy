/**
 * 泄漏工具调用标记检测(#2518 类 B)—— 临时兜底,收窄版。
 *
 * 类 B 实测特征:模型偶发把工具调用块写坏,invoke 开标记丢失前导 `<`
 * (SDK 解析器因此从未进入工具调用状态),损坏的标记连同参数正文以**行首
 * 裸形态**被当作普通 assistant 文本输出 —— 回合静默按成功收口,工具实际
 * 没执行,用户无从分辨「做完了」和「压根没跑」。
 *
 * 按维护者 review 方向(#2541,2026-08-13),本检测只保留已观测协议特征,
 * 不做任何 Markdown/CommonMark 结构解析:
 *  - 仅由 translator 在**没有任何结构化 tool_use 事件**的回合调用;
 *  - 命中要求「行首裸 invoke 开标记(缺失前导 `<`,即损坏签名本身)」与其
 *    **之后**的「行首 parameter 开标记」同时出现 —— 单独出现 invoke /
 *    parameter 词汇、普通英文讨论、带 `<` 的完整协议演示都不构成命中;
 *  - 命中只把本轮标为「工具未执行」并阻止成功收口(复用既有有界恢复),
 *    不执行泄漏文本、不重发原请求。
 *
 * 已知代价:零 tool_use 回合里以行首裸形态演示损坏标记(如围栏代码块内)
 * 会误报为终态错误。裸 invoke(无 `<`)不是文档演示协议的常见写法,该误报
 * 面远小于在客户端维护 Markdown 结构剥离的长期成本(维护者裁决)。
 *
 * 命中统计:translator 侧以结构化 warn 日志记录(类别 / 文本长度 / 模型,
 * 不含正文),用于评估移除时机。
 *
 * 移除条件(满足其一即移除本检测与对应收口分支):
 *  1. #2546 根因关闭 —— 上游模型/SDK 修复该损坏形态,或 SDK 提供结构化的
 *     异常信号可直接消费;
 *  2. 命中日志在连续两个发布版本内为零。
 *
 * 判定命中与否之外不携带任何正文内容,调用方记日志时同样不应记录正文。
 */

/**
 * 行首裸 invoke 开标记。缺失前导 `<` 即类 B 的损坏签名:完整的 `<invoke …>`
 * 是 SDK 能正常解析的形态,不属于本检测目标;行首要求同时天然排除
 * `\invoke`、`&lt;invoke` 之类的转义演示(它们行首是 `\` / `&`)。
 */
const BARE_INVOKE_LINE_RE = /^invoke\s+name="[^"\n]{1,128}"\s*>/m;
/** 行首 parameter 开标记(实测前导 `<` 保留或缺失均有,两种都认)。 */
const PARAMETER_LINE_RE = /^<?parameter\s+name="[^"\n]{1,128}"\s*>/m;

export interface LeakedToolMarkupHit {
  /** 命中类别,进结构化日志用;当前只有一类。 */
  category: 'invoke-with-parameter';
}

/**
 * 检测 assistant 正文中泄漏的工具调用标记。返回 null = 未命中。
 * 调用方限定:零结构化 tool_use 的回合(见文件头)。
 */
export function detectLeakedToolCallMarkup(rawText: string): LeakedToolMarkupHit | null {
  if (!rawText || rawText.length < 16) return null;
  const invoke = BARE_INVOKE_LINE_RE.exec(rawText);
  if (!invoke) return null;
  if (!PARAMETER_LINE_RE.test(rawText.slice(invoke.index + invoke[0].length))) return null;
  return { category: 'invoke-with-parameter' };
}
