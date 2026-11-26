/** 所有客户端共同识别的权限档位；未知值必须按最安全的 ask 处理。 */
export type SharedPermissionMode =
  | 'ask'
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'bypassPermissions';

const PERMISSION_MODES = new Set<SharedPermissionMode>([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

export function isSharedPermissionMode(value: unknown): value is SharedPermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as SharedPermissionMode);
}

/**
 * 跨 Harness / 插件引擎的等价权限档位映射：
 * 内置 Harness（Claude / Codex / Pi）和通用 ACP 用 `'ask'` 表示「默认权限」，
 * 公布自身模式的 ACP Agent（如 Antigravity）用 `'default'` 表示同一语义。
 */
export function equivalentPermissionModes(mode: SharedPermissionMode): readonly SharedPermissionMode[] {
  if (mode === 'ask') return ['ask', 'default'];
  if (mode === 'default') return ['default', 'ask'];
  return [mode];
}

/**
 * 在目标引擎支持的权限档列表中匹配请求的权限档：先精确匹配，再按跨引擎等价映射（`ask` ↔ `default`）。
 * 目标引擎不支持该档时返回 `null`。
 */
export function matchSupportedPermissionMode<T extends string>(
  requested: unknown,
  supportedIds: readonly T[],
): T | null {
  if (!isSharedPermissionMode(requested)) return null;
  for (const candidate of equivalentPermissionModes(requested)) {
    const matched = supportedIds.find((id) => id === candidate);
    if (matched !== undefined) return matched;
  }
  return null;
}

/**
 * 将请求的权限档解析为目标引擎实际可用的权限档。
 * 目标不支持时 fail-closed 回落到目标默认安全档（`fallback` → `ask`/`default` → 首个非完全访问档），
 * 绝不静默放宽到 `bypassPermissions`。
 */
export function resolvePermissionModeForOptions<T extends string>(
  requested: unknown,
  supportedIds: readonly T[],
  fallback?: string | null,
): T | SharedPermissionMode {
  const matched = matchSupportedPermissionMode(requested, supportedIds);
  if (matched !== null) return matched;
  const fallbackMatch =
    fallback === 'bypassPermissions'
      ? null
      : matchSupportedPermissionMode(fallback, supportedIds);
  if (fallbackMatch !== null && fallbackMatch !== 'bypassPermissions') return fallbackMatch;
  const safeDefault = matchSupportedPermissionMode('ask', supportedIds);
  if (safeDefault !== null) return safeDefault;
  const firstNonBypass = supportedIds.find((id) => id !== 'bypassPermissions');
  return firstNonBypass ?? 'ask';
}

/**
 * 将持久化或远端传来的权限值收敛为已知档位。
 * 缺失、空串和未来新增但当前客户端不认识的值都 fail-closed 到 ask。
 */
export function permissionModeOrAsk(value: unknown): SharedPermissionMode {
  return isSharedPermissionMode(value) ? value : 'ask';
}

/** 从任意非 Full access 档位进入 Full access 时都必须显式确认。 */
export function requiresFullAccessConfirmation(
  currentMode: unknown,
  nextMode: unknown,
): boolean {
  return permissionModeOrAsk(nextMode) === 'bypassPermissions'
    && permissionModeOrAsk(currentMode) !== 'bypassPermissions';
}
