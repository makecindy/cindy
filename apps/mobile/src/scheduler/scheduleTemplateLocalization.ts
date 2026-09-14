import type { RemoteScheduleTemplate, RemoteScheduleWriteInput } from './types';

const LOCALIZED_BUILTIN_TEMPLATE_IDS = new Set([
  'nightly-test-heal',
  'pr-gatekeeper',
  'domain-radar',
  'competitor-watch',
  'weekly-work-draft',
  'knowledge-freshness',
]);

export function isLocalizedBuiltinTemplate(template: RemoteScheduleTemplate): boolean {
  return template.source === 'builtin' && LOCALIZED_BUILTIN_TEMPLATE_IDS.has(template.id);
}

/**
 * Only localized built-ins override the desktop template prompt: users must execute the exact
 * prompt they reviewed on mobile. Other templates keep the existing desktop-canonical behavior.
 */
export function buildMobileTemplateOverrides(
  input: RemoteScheduleWriteInput,
  template: RemoteScheduleTemplate,
): Partial<RemoteScheduleWriteInput> {
  if (isLocalizedBuiltinTemplate(template)) return input;
  const { prompt: _templatePrompt, ...overrides } = input;
  return overrides;
}
