/**
 * 飞书群历史的提示注入识别(纯逻辑, 不打模型)。
 *
 * 两层一起用:
 *   1. 高置信启发式: 命中即过滤, 不依赖模型;
 *   2. 模型扫描结果解析: 只接受调用方给出的已知 messageId, 垃圾输出当没扫到。
 *
 * 主人自己的历史消息不参与启发式(主人说话就是可信指令的一部分);
 * 模型扫描由 adapter 决定是否把主人消息送进去。
 */

const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(?:all\s+)?(?:previous|above|prior|preceding)\s+(?:instructions?|prompts?|rules?|context)/i,
  /disregard\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions?|prompts?|rules?)/i,
  /忽略\s*(?:以上|之前|前面|上面)的?(?:所有)?(?:指令|提示|规则|设定|上下文)/,
  /不要(?:再)?(?:遵守|执行|理会)(?:以上|之前|前面)?的?(?:系统)?(?:指令|提示|规则)/,
  /you\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|god)\s+mode/i,
  /(?:进入|切换到)\s*(?:开发者|越狱|dan)\s*模式/,
  /<\/?(?:group_chat_context|reply_context)>/i,
  /(?:system\s*prompt|系统提示词)\s*(?:is|override|覆盖|改为)/i,
];

/** 高置信启发式: 像在对机器人下覆盖指令, 而不是同事之间讨论工作。 */
export function looksLikePromptInjection(text: string): boolean {
  if (!text) return false;
  const normalized = text.normalize('NFKC');
  return INJECTION_PATTERNS.some((re) => re.test(normalized));
}

/**
 * 解析模型扫描输出。只收录 knownIds 里出现过的 token;
 * 行首 NONE / 空 / 垃圾文本 → 空集合(不过滤)。
 */
export function parseInjectionScanResult(
  text: string,
  knownIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (!text.trim() || /^\s*NONE\b/i.test(text)) return out;
  for (const raw of text.split(/[\s,;|]+/)) {
    const id = raw.trim();
    if (knownIds.has(id)) out.add(id);
  }
  return out;
}

export const FILTERED_HISTORY_PLACEHOLDER = '[已过滤一条疑似对机器人下达指令的消息]';
