/**
 * modelShortLabel
 * ---------------------------------------------------------------------------
 * 把模型 raw id 折算成短的人类品牌标签,用于 Agent/Task 工具行上的子代理
 * 模型 chip(subagent-model-chip)。
 *
 * 为什么是独立纯函数而不复用 model-providers 的 displayName:
 *   - 子代理默认模型(如 claude-haiku-4-5)是 agent 内部默认,常不在用户可选的
 *     availableModels 里,getModel(provider, id, agent) 多半 miss;
 *   - 这里只需要"raw id → 简短品牌名"的确定性映射,不依赖 provider/agent 上下文,
 *     纯函数可单测、零副作用。
 *
 * 品牌名不翻译(规则 18):'Haiku 4.5' / 'Opus 4.8' / 'GPT-5.5' 跨语言一致。
 */

/** 首字母大写(仅处理 ASCII 单词,够用)。 */
function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * 兜底:把清洗后的 id 折成 Title Case 的 dash 段(未知/未来模型也给个像样的标签)。
 * 例:'some-future-model' → 'Some Future Model'。永不抛错。
 */
function fallbackLabel(cleaned: string): string {
  if (!cleaned) return cleaned;
  return cleaned
    .split('-')
    .filter(Boolean)
    .map((seg) => cap(seg))
    .join(' ');
}

/**
 * raw model id → 短品牌标签。
 *
 * 处理顺序:trim → 去 `[1m]` 长上下文后缀 → 去尾部日期 `-YYYYMMDD` →
 * 去已知 vendor/route 前缀 → 按家族正则映射 → 兜底 Title Case。
 *
 * 例:
 *   claude-haiku-4-5-20251001 → 'Haiku 4.5'
 *   claude-opus-4-8[1m]       → 'Opus 4.8'
 *   claude-sonnet-4-6         → 'Sonnet 4.6'
 *   claude-fable-5            → 'Fable 5'
 *   gpt-5.5                   → 'GPT-5.5'
 *   gpt-5.4-mini              → 'GPT-5.4 Mini'
 *   ''                        → ''
 */
export function formatModelShortLabel(modelId: string | undefined | null): string {
  if (typeof modelId !== 'string') return '';
  let id = modelId.trim();
  if (!id) return '';

  // 1) 去长上下文 [1m] 后缀(如 claude-opus-4-8[1m])
  id = id.replace(/\[1m\]$/i, '');
  // 2) 去尾部 dated 后缀(如 -20251001)
  id = id.replace(/-\d{8}$/, '');
  // 3) 去已知 vendor/route 前缀(Bedrock/Vertex route、折扣版 codex/ 前缀)
  id = id.replace(/^us\.anthropic\./i, '').replace(/^anthropic\./i, '').replace(/^codex\//i, '');

  // 4) Claude <family>-<major>(-<minor>)? → 'Family major.minor' / 'Family major'
  //    家族用通用词字符匹配,覆盖 opus/sonnet/haiku/fable 及未来新族(如 nova);
  //    minor 可选,既吃 claude-opus-4-8(→ Opus 4.8)也吃 claude-fable-5(→ Fable 5)
  //    与未来 claude-fable-5-0(→ Fable 5.0)。
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/i.exec(id);
  if (claude) {
    return claude[3]
      ? `${cap(claude[1])} ${claude[2]}.${claude[3]}`
      : `${cap(claude[1])} ${claude[2]}`;
  }

  // 5) GPT:gpt-<version>(-mini|-nano)? → 'GPT-<version>'( + ' Mini'/' Nano')
  const gpt = /^gpt-([\d.]+)(?:-(mini|nano))?$/i.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${cap(gpt[2])}` : ''}`;

  // 6) 兜底
  return fallbackLabel(id);
}
