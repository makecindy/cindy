import { parseRoutineInput, type RoutineTrigger } from '@cindy/maker-scheduler';
import { fingerprint } from './files.js';
import { object, string, type ImportItem, type ImportSource } from './types.js';
import path from 'node:path';
import { importedScriptName } from './scripts.js';
import { importedCommand } from './commandAutomation.js';

/** Runtime counters are not configuration; changes to them must not invalidate a handover. */
export function automationFingerprint(job: Record<string, unknown>): string {
  return fingerprint(Object.fromEntries(Object.entries(job).filter(([key]) =>
    !['state', 'last_run_at', 'last_status', 'last_error', 'last_delivery_error', 'last_delivery_unverified', 'failure_streak', 'next_run_at', 'monitor_state', 'updatedAtMs'].includes(key))));
}

/** Snapshot only dependency providers, never the growing list of normalized jobs. */
export function indexAutomationDependencies(items: readonly ImportItem[]) {
  const skills = new Map<string, ImportItem[]>();
  const scripts = new Map<string, ImportItem[]>();
  const scriptNames = new Set<string>();
  const connections: ImportItem[] = [];
  const environment = new Map<string, RegExp | undefined>();
  const order = new Map<ImportItem, number>();
  const text = new Map<ImportItem, string>();
  let toolPolicy = false, model = false;
  for (const [index, item] of items.entries()) {
    if (item.view.category === 'skills' || item.asset || item.mcp) order.set(item, index);
    if (item.view.category === 'skills') {
      const aliases = new Set([item.view.name, ...(item.sourceAlias ? [item.sourceAlias] : []),
        ...(item.sourceDirectory ? [path.basename(item.sourceDirectory)] : [])]);
      for (const alias of aliases) {
        const group = skills.get(alias) ?? [];
        group.push(item); skills.set(alias, group);
      }
    }
    if (item.asset) {
      scriptNames.add(item.asset.name);
      for (let directory = path.posix.dirname(item.asset.name); directory !== '.' && directory !== '/'; directory = path.posix.dirname(directory)) {
        const group = scripts.get(directory) ?? [];
        group.push(item); scripts.set(directory, group);
      }
    }
    if (item.mcp) connections.push(item);
    for (const name of Object.keys(item.env ?? {})) environment.set(name, undefined);
    toolPolicy ||= item.credential?.format === 'source-tools';
    model ||= item.credential?.format === 'source-model';
  }
  return { skills, scripts, scriptNames, connections, environment, order, toolPolicy, model,
    text(item: ImportItem): string {
      if (!text.has(item)) text.set(item, item.asset ? item.asset.bytes.toString('utf8')
        : (item.files ?? []).filter(file => /\.(md|py|js|mjs|sh|ts|json|yaml|yml|toml)$/i.test(file.name)).map(file => file.bytes.toString('utf8')).join('\n'));
      return text.get(item)!;
    },
  };
}

export function normalizeAutomation(source: ImportSource, job: Record<string, unknown>, dependencies: ReturnType<typeof indexAutomationDependencies>, timezone: string, occurrence = 0): ImportItem {
  const sourceId = string(job.id) || string(job.jobId);
  const schedule = object(job.schedule);
  const payload = object(job.payload);
  const name = string(job.name).trim() || sourceId.trim() || `${source.kind} ${occurrence + 1}`;
  const enabled = job.enabled !== false && job.state !== 'paused';
  const prompt = source.kind === 'hermes' ? string(job.prompt) : string(payload.message) || string(payload.text);
  const issues: string[] = [];
  let command;
  try { command = source.kind === 'openclaw' ? importedCommand(job) : undefined; }
  catch { issues.push('SOURCE_AUTOMATION_INVALID'); }
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
  const scriptItems = new Set(scriptNames.flatMap(name => dependencies.scripts.get(path.posix.dirname(name)) ?? []));
  const skillItems = new Set([...selectedSkills].flatMap(name => dependencies.skills.get(name) ?? []));
  const searchText = [prompt, ...(command ? [command.command, ...command.args, command.input ?? ''] : []),
    ...[...scriptItems, ...skillItems].map(item => dependencies.text(item))].join('\n');
  const required = new Set([...scriptItems, ...skillItems,
    ...dependencies.connections.filter(item => searchText.includes(item.mcp!.name))]);
  const dependsOn = [...required].sort((a, b) => dependencies.order.get(a)! - dependencies.order.get(b)!).map(item => item.view.id);
  const environmentNames = [...dependencies.environment].filter(([name, expression]) => {
    if (!expression) { expression = new RegExp(`\\b${name}\\b`); dependencies.environment.set(name, expression); }
    return expression.test(searchText);
  }).map(([name]) => name);
  if (scriptNames.some(name => !dependencies.scriptNames.has(name))) issues.push('AUTOMATION_SCRIPT_MISSING');
  if (job.no_agent === true && !job.script) issues.push('AUTOMATION_SCRIPT_MISSING');
  // These source-specific semantics are retained verbatim and require an explicit adapter.
  // Never start a simpler task while claiming it inherited a stricter tool policy/model/context.
  if (!command && (job.enabled_toolsets || Object.keys(object(job.tools)).length || dependencies.toolPolicy)) issues.push('SOURCE_TOOL_POLICY_NEEDS_MAPPING');
  if (job.context_from) issues.push('AUTOMATION_CONTEXT_NEEDS_MAPPING');
  if (!command && (job.model || job.provider || job.base_url || payload.model || job.reasoning_effort || payload.thinking
    || dependencies.model)) issues.push('AUTOMATION_MODEL_NEEDS_MAPPING');
  if (job.workdir && path.resolve(string(job.workdir)) !== path.resolve(source.workspace)) issues.push('AUTOMATION_WORKDIR_NEEDS_MAPPING');
  if (!sourceId.trim()) issues.push('SOURCE_AUTOMATION_INVALID');
  // These are explicit source features, not guessed equivalent prompt instructions.
  if (Number(schedule.staggerMs) > 0) issues.push('AUTOMATION_STAGGER_NEEDS_ADAPTER');
  // Preserve unsupported native behavior without pretending a prompt is equivalent.
  if (source.kind === 'openclaw' && payload.kind === 'heartbeat') issues.push('AUTOMATION_CONTEXT_NEEDS_MAPPING');
  else if (source.kind === 'openclaw' && payload.kind && !['command', 'agentTurn', 'systemEvent'].includes(string(payload.kind))) issues.push('SOURCE_AUTOMATION_INVALID');
  const taskPrompt = command ? name : prompt || string(job.script) || [...selectedSkills].filter(Boolean).join('\n');
  if ((!taskPrompt.trim() && payload.kind !== 'heartbeat') || name.length > 200 || taskPrompt.length > 100_000) issues.push('SOURCE_AUTOMATION_INVALID');
  const draft = { name: name.slice(0, 200), prompt: (taskPrompt.trim() ? taskPrompt : name).slice(0, 100_000), enabled: false, silentWhenIdle: false };
  let input;
  try { input = parseRoutineInput({ ...draft, triggers: trigger ? [trigger] : [] }); }
  catch {
    issues.push('AUTOMATION_TRIGGER_NEEDS_ADAPTER');
    input = parseRoutineInput({ ...draft, triggers: [] });
  }
  // A disabled draft can have no converted trigger. The entire original remains
  // encrypted, and the existing execution guard rejects its unresolved issues.

  return {
    view: { id: `automation-${fingerprint(sourceId || [job, occurrence]).slice(0, 20)}`, category: 'automations', name, enabled, selected: true,
      description: string(job.schedule_display) || string(schedule.expr) || (trigger?.kind === 'once' && Number.isFinite(trigger.at) ? new Date(trigger.at).toISOString() : ''),
      dependsOn, ...(issues.length ? { issues: [...new Set(issues)] } : {}) },
    envDependencies: { names: environmentNames, entries: dependsOn },
    automation: { sourceId, input, original: job, deliveries: [], fingerprint: automationFingerprint(job) },
  };
}
