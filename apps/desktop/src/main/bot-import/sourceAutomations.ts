import { parseRoutineInput, type RoutineTrigger } from '@cindy/maker-scheduler';
import { fingerprint } from './files.js';
import { object, string, type ImportItem, type ImportSource } from './types.js';
import path from 'node:path';
import { importedScriptName, isImportedScriptDependency } from './scripts.js';
import { importDelivery } from './delivery.js';

/** Runtime counters are not configuration; changes to them must not invalidate a handover. */
export function automationFingerprint(job: Record<string, unknown>): string {
  return fingerprint(Object.fromEntries(Object.entries(job).filter(([key]) =>
    !['state', 'last_run_at', 'last_status', 'last_error', 'last_delivery_error', 'last_delivery_unverified', 'failure_streak', 'next_run_at', 'monitor_state', 'updatedAtMs'].includes(key))));
}

export function normalizeAutomation(source: ImportSource, job: Record<string, unknown>, items: ImportItem[], timezone: string): ImportItem {
  const sourceId = string(job.id) || string(job.jobId);
  const schedule = object(job.schedule);
  const payload = object(job.payload);
  const name = string(job.name) || sourceId;
  const enabled = job.enabled !== false && job.state !== 'paused';
  const prompt = source.kind === 'hermes' ? string(job.prompt) : string(payload.message) || string(payload.text);
  const issues: string[] = [];
  let trigger: RoutineTrigger | undefined;
  if (schedule.kind === 'cron') {
    trigger = { id: 'time', kind: 'cron', expression: string(schedule.expr), timezone: string(schedule.tz) || string(schedule.timezone) || timezone };
  } else if (schedule.kind === 'interval' || schedule.kind === 'every') {
    trigger = { id: 'time', kind: 'interval', intervalMs: schedule.kind === 'every' ? Number(schedule.everyMs) : Number(schedule.minutes) * 60_000,
      ...(Number.isSafeInteger(schedule.anchorMs) ? { anchorMs: Number(schedule.anchorMs) } : {}) };
  } else if (schedule.kind === 'once' || schedule.kind === 'at') {
    trigger = { id: 'time', kind: 'once', at: Date.parse(string(schedule.at) || string(schedule.run_at)) };
  } else issues.push('AUTOMATION_TRIGGER_NEEDS_ADAPTER');

  const selectedSkills = new Set([string(job.skill), ...(Array.isArray(job.skills) ? job.skills.map(string) : [])]);
  const scriptNames = [string(job.script), string(job.monitor_script)].filter(Boolean).flatMap(file => {
    try { return [importedScriptName(source.root, file)]; }
    catch { issues.push('AUTOMATION_SCRIPT_MISSING'); return []; }
  });
  const scriptItems = items.filter(item => item.asset && isImportedScriptDependency(item.asset.name, scriptNames));
  const skillItems = items.filter(item => item.view.category === 'skills'
    && (selectedSkills.has(item.view.name) || !!item.sourceDirectory && selectedSkills.has(path.basename(item.sourceDirectory))));
  const searchText = [prompt, ...scriptItems.map(item => item.asset!.bytes.toString('utf8')), ...skillItems.flatMap(item => (item.files ?? []).filter(file => /\.(md|py|js|mjs|sh|ts|json|yaml|yml|toml)$/i.test(file.name)).map(file => file.bytes.toString('utf8')))].join('\n');
  const dependsOn = items.filter(item =>
    skillItems.includes(item) ||
    item.mcp && searchText.includes(item.mcp.name) || scriptItems.includes(item)).map(item => item.view.id);
  const environmentNames = [...new Set(items.flatMap(item => Object.keys(item.env ?? {})))].filter(key => new RegExp(`\\b${key}\\b`).test(searchText));
  const delivery = importDelivery(source, job, items);
  dependsOn.push(...delivery.deliveries.map(item => item.connectionId));
  issues.push(...delivery.issues);
  if (scriptNames.some(name => !scriptItems.some(item => item.asset!.name === name))) issues.push('AUTOMATION_SCRIPT_MISSING');
  if (job.no_agent === true && !job.script) issues.push('AUTOMATION_SCRIPT_MISSING');
  // These source-specific semantics are retained verbatim and require an explicit adapter.
  // Never start a simpler task while claiming it inherited a stricter tool policy/model/context.
  if (job.enabled_toolsets || Object.keys(object(job.tools)).length || items.some(item => item.credential?.format === 'source-tools')) issues.push('SOURCE_TOOL_POLICY_NEEDS_MAPPING');
  if (job.context_from) issues.push('AUTOMATION_CONTEXT_NEEDS_MAPPING');
  if (job.model || job.provider || job.base_url || payload.model || job.reasoning_effort || payload.thinking
    || items.some(item => item.credential?.format === 'source-model')) issues.push('AUTOMATION_MODEL_NEEDS_MAPPING');
  if (job.workdir && path.resolve(string(job.workdir)) !== path.resolve(source.workspace)) issues.push('AUTOMATION_WORKDIR_NEEDS_MAPPING');
  if (job.failure_deliver && job.failure_deliver !== job.deliver) issues.push('DELIVERY_NEEDS_ADAPTER');
  if (!sourceId || !name) issues.push('SOURCE_AUTOMATION_INVALID');
  // These are explicit source features, not guessed equivalent prompt instructions.
  if (Number(schedule.staggerMs) > 0) issues.push('AUTOMATION_STAGGER_NEEDS_ADAPTER');
  let input;
  if (trigger) {
    try { input = parseRoutineInput({ name, prompt: prompt || string(job.script) || [...selectedSkills].filter(Boolean).join('\n'), enabled: false, triggers: [trigger], silentWhenIdle: false }); }
    catch { issues.push('SOURCE_AUTOMATION_INVALID'); }
  }
  return {
    view: { id: `automation-${fingerprint(sourceId).slice(0, 20)}`, category: 'automations', name, enabled, selected: true,
      description: string(job.schedule_display) || string(schedule.expr) || (trigger?.kind === 'once' && Number.isFinite(trigger.at) ? new Date(trigger.at).toISOString() : ''),
      dependsOn, ...(issues.length ? { issues } : {}) },
    envDependencies: { names: environmentNames, entries: dependsOn },
    automation: { sourceId, input, original: job, deliveries: delivery.deliveries, fingerprint: automationFingerprint(job) },
  };
}
