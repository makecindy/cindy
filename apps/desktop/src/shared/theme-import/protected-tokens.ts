/**
 * 外部主题不得接管的 token（语义豁免族）。
 *
 * 依据 `docs/design-rules/DESIGN.md` §10「Semantic Exemption Colors
 * (theme-invariant)」与 §16（登录链路 `--login-*` 全族「任何 builtin/扩展主题都
 * 不应 override」）。这些色值承载的是**语义而非风格**——危险红、警告橙、焦点蓝、
 * diff 绿红、登录页品牌体系。一个高饱和的外部主题若把它们一起染掉，用户就会
 * 失去"红=危险 / 橙=进行中"这层可依赖的判断。
 *
 * 主保障是 `palette.ts` 的 allow-list（模板压根不产出这些 key）；本清单是第二道
 * 闸：importer 落盘前过滤，单测断言「模板输出 ∩ 本清单 == ∅」，防后人往模板里
 * 顺手加豁免色。
 *
 * 注意：手写的 builtin 主题不受本清单约束（例如 solarized-light 有理由地
 * override 了 `perm-auto-selected-text`）。这里只约束**自动导入**的产物。
 */

/** 整族保护的前缀。 */
const PROTECTED_PREFIXES = [
  // 登录链路独立反色体系 + 浏览器回调卡（§16）
  'login-',
  // diff 渲染走 GitHub 语义色板
  'diff-',
  // 错误告警卡子系统
  'error-',
  // 模态 / lightbox 遮罩
  'overlay-',
] as const;

/** 逐个保护的 token。 */
const PROTECTED_IDS = new Set<string>([
  // 危险语义
  'destructive',
  // 警告 / 进行中语义（Thinking Orange 全族，跨主题恒定）
  'warning-accent',
  'warning-bg-soft',
  'warning-fg',
  'status-bar-accent',
  'settings-integration-warning',
  'plan-action-approve-icon-bg',
  'plan-action-approve-icon-fg',
  // 权限语义色（自动审批蓝 / bypass 橙）
  'perm-auto-selected-text',
  'perm-bypass-selected-text',
  // 无障碍焦点环
  'focus-ring',
  'focus-ring-soft',
  // 阴影：跨主题恒定，不是可换肤的风格项
  'shadow-menu',
  'cmd-palette-shadow',
  'confirm-shadow',
]);

/** 该 token 是否属于语义豁免族（外部主题导入时必须跳过）。 */
export function isProtectedToken(id: string): boolean {
  if (PROTECTED_IDS.has(id)) return true;
  return PROTECTED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * 过滤掉豁免族。返回过滤后的 map 与被拦下的 token id——importer 把数量放进
 * 导入报告，让用户知道"有些颜色我们故意没跟着改"。
 */
export function stripProtectedTokens(colors: Record<string, string>): {
  colors: Record<string, string>;
  skipped: string[];
} {
  const out: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [id, value] of Object.entries(colors)) {
    if (isProtectedToken(id)) {
      skipped.push(id);
      continue;
    }
    out[id] = value;
  }
  return { colors: out, skipped };
}
