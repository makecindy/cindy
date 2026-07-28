/**
 * 把权限请求携带的「会话级授权建议」翻译成一句用户能看懂的范围。
 *
 * 为什么需要:权限卡片上那个按钮原本只写「本对话总是允许」,既没说允许的是**哪一类**,
 * 也容易被读成「什么都允许」。而它实际加的是 agent 给出的一条具体规则(Bash 通常是
 * `curl:*` 这类前缀模式),范围远小于字面。Claude Code 命令行把范围写进选项文案里
 * (`don't ask again for curl commands in …`),Cindy 之前没有 —— 这里补上。
 *
 * 数据形状来自 SDK 的 PermissionUpdate:
 *   { type: 'addRules', rules: [{ toolName, ruleContent? }], behavior, destination }
 * 只认 `addRules` + `behavior: 'allow'`:其余类型(replaceRules / removeRules / setMode)
 * 不是「放宽这一类」的语义,拿它们生成文案会误导。suggestions 已由调用方按
 * `destination === 'session'` 过滤。
 *
 * 一律展示规则原文而不做二次意译:`curl:*` 就显示 `curl:*`。猜测性地美化成
 * 「curl 命令」会在规则语法变化时悄悄说谎,而这是一条授权文案,宁可技术感强一点。
 */

/** 未知形状一律当作「无法描述」,调用方据此隐藏按钮 —— 不猜、不兜底放宽。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function describeRule(rule: unknown): string | null {
  if (!isRecord(rule)) return null;
  const toolName = typeof rule.toolName === 'string' ? rule.toolName.trim() : '';
  if (!toolName) return null;
  const ruleContent = typeof rule.ruleContent === 'string' ? rule.ruleContent.trim() : '';
  return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

/**
 * @returns 逗号分隔的规则清单(如 `Bash(curl:*)`),无可描述规则时返回 null。
 */
export function describeSessionPermissionScope(suggestions: readonly unknown[]): string | null {
  if (!Array.isArray(suggestions)) return null;
  const labels: string[] = [];
  for (const suggestion of suggestions) {
    if (!isRecord(suggestion)) continue;
    if (suggestion.type !== 'addRules') continue;
    if (suggestion.behavior !== 'allow') continue;
    if (!Array.isArray(suggestion.rules)) continue;
    for (const rule of suggestion.rules) {
      const label = describeRule(rule);
      // 同一条规则可能在多个 suggestion 里重复出现,去重后再拼。
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  return labels.length > 0 ? labels.join('、') : null;
}
