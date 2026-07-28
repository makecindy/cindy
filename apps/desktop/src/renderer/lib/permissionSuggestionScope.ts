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
 * @returns 规则清单(如 `['Bash(curl:*)']`),**只在能把全部授权项描述完整时**才返回;
 *          否则返回 null,调用方退回不声称范围的原文案。
 *
 * 「描述不全就整体放弃」是安全要求,不是洁癖:点下按钮会把 suggestions 里**每一项**
 * 都作为 updatedPermissions 转发出去。只要有一项没被写进文案(比如混进来一条 setMode
 * 或 replaceRules),按钮就会一边宣称「只允许这一类」,一边顺手改掉权限档位或应用
 * 未列出的规则 —— 授权文案说谎比文案笼统严重得多。
 *
 * 不返回拼好的字符串:分隔符是语言相关的(中日用 `、`,英韩用 `, `),硬编码会把
 * 顿号漏进英文句子。拼接交给调用方按当前语言做(DESIGN.md 文案规范:标点不跨语言)。
 */
export function describeSessionPermissionScope(suggestions: readonly unknown[]): string[] | null {
  if (!Array.isArray(suggestions)) return null;
  const labels: string[] = [];
  for (const suggestion of suggestions) {
    // 任何一项无法完整描述 → 整体放弃(见顶注)。
    if (!isRecord(suggestion)) return null;
    if (suggestion.type !== 'addRules') return null;
    if (suggestion.behavior !== 'allow') return null;
    if (!Array.isArray(suggestion.rules) || suggestion.rules.length === 0) return null;
    for (const rule of suggestion.rules) {
      const label = describeRule(rule);
      if (!label) return null;
      // 同一条规则可能在多个 suggestion 里重复出现,去重后再列。
      if (!labels.includes(label)) labels.push(label);
    }
  }
  return labels.length > 0 ? labels : null;
}
