/**
 * 订阅套餐名的显示形态 —— 状态栏 chip / 悬停卡与设置页的供应商用量模块共用。
 *
 * 抽出来的原因:同一套「已知拼写查表 → 未知就规范化大小写」的逻辑原先在
 * `QuotaHoverCard`(Claude subscriptionType)与 `TodaySpendChip`(Codex planType)
 * 各有一份私有副本。设置页要显示第三处,再抄一遍就成三份 —— 三份必然漂,而套餐名是
 * 用户在两个不同界面里核对同一件事时最容易发现不一致的地方。
 *
 * 两个函数分开是因为**两家的取值域不同**,不是同一张表:Anthropic 给 pro / max /
 * team / enterprise,ChatGPT 还有 go / plus / prolite / *_usage_based 这类。合成一张表
 * 会让任一家的未知值悄悄命中另一家的条目。
 */

/** Anthropic 订阅(凭证 blob 的 subscriptionType)。未知套餐保留原始拼写，只补首字母大写。 */
export function formatClaudeSubscriptionPlanLabel(subscriptionType: unknown): string | null {
  if (typeof subscriptionType !== 'string') return null;
  const trimmed = subscriptionType.trim();
  if (!trimmed) return null;

  const knownPlans: Record<string, string> = {
    max: 'Max',
    pro: 'Pro',
    team: 'Team',
    enterprise: 'Enterprise',
  };
  return (
    knownPlans[trimmed.toLowerCase()] ?? `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
  );
}

const CODEX_PLAN_TYPE_LABELS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  self_serve_business_usage_based: 'Self Serve Business Usage Based',
  business: 'Business',
  enterprise_cbp_usage_based: 'Enterprise CBP Usage Based',
  enterprise: 'Enterprise',
  edu: 'Edu',
  unknown: 'Unknown',
};

/** ChatGPT / Codex 套餐(app-server 的 planType)。未知值按 snake/kebab → Title Case。 */
export function formatCodexPlanLabel(planType: unknown): string | null {
  if (typeof planType !== 'string') return null;
  const trimmed = planType.trim();
  if (!trimmed) return null;
  const known = CODEX_PLAN_TYPE_LABELS[trimmed.toLowerCase()];
  if (known) return known;
  return trimmed.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
