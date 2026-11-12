import type { GhostPermissionItem } from './ghost.js';

/** Translate the existing approval projection at the presentation boundary only. */
export function permissionItemDetail(item: GhostPermissionItem, t: (key: string, args?: Record<string, unknown>) => string): string | undefined {
  if (item.detailKey !== 'uiHostAccess') {
    return item.detailKey ? t(`settings.ghosts.perm.${item.detailKey}`, item.detailArgs) : undefined;
  }
  const prefix = 'settings.ghosts.perm.hostUi';
  const [subject, id] = (item.detailArgs?.subject ?? '').split(':');
  if (subject === 'capability') return t(`${prefix}.capabilities.${id}`);
  if (subject === 'appearance') return t(`${prefix}.fields.${id}`);
  let detail: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(item.detailArgs?.access ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return t(`${prefix}.unavailable`);
    detail = parsed as Record<string, unknown>;
  } catch { return t(`${prefix}.unavailable`); }
  const value = (input: unknown): string => {
    if (Array.isArray(input)) return input.map(value).join(', ');
    if (input && typeof input === 'object') return Object.entries(input).map(([key, entry]) => `${key}: ${value(entry)}`).join('; ');
    if (typeof input === 'boolean') return t(`${prefix}.${input ? 'yes' : 'no'}`);
    return input === null ? '—' : String(input);
  };
  if (subject === 'view') return t(`${prefix}.view`, {
    scope: t(`${prefix}.scopes.${detail.scope}`), name: detail.resource,
  });
  if (subject === 'appearance-resource') return t(`${prefix}.resource`, {
    kind: t(`${prefix}.resources.${detail.kind}`), name: detail.path,
  });
  const parts = [subject === 'contribution' ? t(`${prefix}.contribution`, {
    kind: t(`${prefix}.kinds.${detail.kind}`),
    position: t(`${prefix}.positions.${String(detail.position).replace('.', '_')}`),
  }) : t(`${prefix}.command`)];
  if (detail.view) parts.push(t(`${prefix}.openView`, { name: detail.view }));
  if (detail.tool) parts.push(t(`${prefix}.tool`, { name: detail.tool }));
  if (detail.arguments) parts.push(t(`${prefix}.arguments`, { value: value(detail.arguments) }));
  if (detail.shortcut) parts.push(t(`${prefix}.shortcut`, { value: detail.shortcut }));
  if (detail.presentation === 'popover') parts.push(t(`${prefix}.popover`));
  const match = detail.match as Record<string, unknown> | undefined;
  if (Array.isArray(match?.roles)) parts.push(t(`${prefix}.roles`, {
    value: match.roles.map(role => t(`${prefix}.speakers.${role}`)).join(', '),
  }));
  for (const kind of ['tools', 'plugins'] as const) {
    if (match?.[kind]) parts.push(t(`${prefix}.${kind}`, { value: value(match[kind]) }));
  }
  if (detail.options) parts.push(t(`${prefix}.options`, { value: value(detail.options) }));
  return parts.join(' · ');
}
