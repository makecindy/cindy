import { fingerprint } from './files.js';
import { commandArgumentRedactions, commandLiteralRedactions } from './commandRedactions.js';
import { CompanionImportError, object, type ImportItem } from './types.js';
import { importedContentRedactions } from './connectionCatalog.js';
import { createEnvironmentRedactor, environmentRedactions } from './process.js';

const variableName = (name: string, platform = process.platform) => platform === 'win32' ? name.toUpperCase() : name;

/** Never choose an account by file order, including older/command clients bypassing checkboxes. */
export function selectedImportEnvironment(items: ImportItem[]): Record<string, string> {
  const values = new Map<string, string>();
  const environment: Record<string, string> = {};
  for (const item of items) for (const [name, value] of Object.entries(item.env ?? {})) {
    const key = variableName(name);
    if (values.has(key) && values.get(key) !== value) throw new CompanionImportError('INVALID_SELECTION');
    values.set(key, value);
    environment[name] = value;
  }
  return environment;
}

export function resolveImportReferences(value: unknown, env: Record<string, string>, allowMissing = false, platform = process.platform): unknown {
  const values = new Map(Object.entries(env).map(([key, value]) => [variableName(key, platform), value]));
  const resolve = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
      const name = variableName(key, platform);
      if (values.has(name)) return values.get(name)!;
      if (allowMissing) return match;
      throw new CompanionImportError('AUTOMATION_DEPENDENCY_NOT_SELECTED');
    });
    if (Array.isArray(input)) return input.map(resolve);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, resolve(child)]));
    return input;
  };
  return resolve(value);
}

export function selectedImportRedactions(items: ImportItem[]): Record<string, string> {
  return importRedactions(items, selectedImportEnvironment(items));
}

/** Preview includes unselected/conflicting accounts, so collect every known value without choosing one. */
export function previewImportRedactions(items: ImportItem[]): Record<string, string> {
  const values = new Map<string, Set<string>>();
  for (const item of items) for (const [name, value] of Object.entries(item.env ?? {})) {
    const key = variableName(name);
    const candidates = values.get(key) ?? new Set<string>();
    candidates.add(value); values.set(key, candidates);
  }
  // Resolve only unambiguous references; colliding values are still all masked below.
  const env = Object.fromEntries([...values].flatMap(([name, candidates]) => candidates.size === 1 ? [[name, [...candidates][0]!]] : []));
  const secrets = [...Object.values(importRedactions(items, env)),
    ...items.flatMap(item => Object.values(environmentRedactions(item.env ?? {})))];
  return Object.fromEntries([...new Set(secrets)].map((value, index) => [`preview_credential_${index}`, value]));
}

/** Retain masks only for values already present in selected content, never discarded accounts. */
export function retainedImportRedactions(items: ImportItem[], secrets: Record<string, string>): Record<string, string> {
  const matched = new Set<string>();
  const text = createEnvironmentRedactor(secrets, value => { matched.add(value); });
  const visit = (value: unknown): void => {
    if (typeof value === 'string') text(value);
    else if (Buffer.isBuffer(value)) {
      text(value.toString('utf8'));
      if (value.length % 2 === 0 && value[0] === 0xff && value[1] === 0xfe) text(value.toString('utf16le'));
      if (value.length % 2 === 0 && value[0] === 0xfe && value[1] === 0xff) text(Buffer.from(value).swap16().toString('utf16le'));
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { text(key); visit(child); }
    }
  };
  visit(items);
  return Object.fromEntries(Object.entries(secrets).filter(([, value]) => matched.has(value)));
}

function importRedactions(items: ImportItem[], env: Record<string, string>): Record<string, string> {
  // Missing variables do not supply a known credential. Actual connection imports
  // still require every selected dependency and use strict reference resolution.
  const resolve = (value: unknown) => resolveImportReferences(value, env, true);
  const commandEnvironments = items.map(item => Object.fromEntries(
    Object.entries(object(object(item.automation?.original.payload).env))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  ));
  // Env, stdin and argv share form/JSON/URL/header decomposition with execution
  // output. Env values retain their existing whole-value masks below; public
  // scalar settings must not gain blanket decoded-literal masks.
  // Commands receive the selected source env as well as payload.env. Match the
  // runtime collector without treating ordinary provider-only imports as commands.
  const inheritedValues = items.some(item => object(item.automation?.original.payload).kind === 'command')
    ? Object.values(env) : [];
  const environmentValues = Object.values(commandLiteralRedactions([], [
    ...inheritedValues,
    ...commandEnvironments.flatMap(environment => Object.values(environment)).map(value => String(resolve(value))),
  ], false));
  const commandValues = items.flatMap(item => {
    const payload = object(item.automation?.original.payload);
    if (payload.kind !== 'command') return [];
    const args = Array.isArray(payload.argv) ? payload.argv.filter((arg): arg is string => typeof arg === 'string') : [];
    return [
      ...Object.values(commandLiteralRedactions(typeof payload.input === 'string' ? [String(resolve(payload.input))] : [])),
      ...Object.values(commandArgumentRedactions(args.map(arg => String(resolve(arg))))),
    ];
  });
  const literalMasks = Object.fromEntries([...new Set([...commandValues, ...environmentValues])].map((value, index) => [`command_input_${index}`, value]));
  return importedContentRedactions({ env,
    contentRedactions: { ...Object.fromEntries(commandEnvironments.flatMap(environment => Object.entries(environmentRedactions(environment)))
      .map(([name, value], index) => [`command_${index}_${name}`, value])), ...literalMasks },
    mcp: items.flatMap(item => item.mcp ? [resolve(item.mcp) as NonNullable<typeof item.mcp>] : []),
    credentials: items.flatMap(item => item.credential ? [{ id: item.view.id, ...item.credential, value: resolve(item.credential.value) }] : []),
  });
}

/** Public alternatives contain only opaque entry IDs, never credential values. */
export function markImportEnvironmentChoices(items: ImportItem[]): void {
  const providers = new Map<string, Array<{ item: ImportItem; value: string }>>();
  for (const item of items) for (const [name, value] of Object.entries(item.env ?? {})) {
    const key = variableName(name);
    const group = providers.get(key) ?? [];
    group.push({ item, value }); providers.set(key, group);
  }
  for (const group of providers.values()) for (const { item, value } of group) {
    const conflicts = group.filter(other => other.value !== value).map(other => other.item.view.id);
    if (!conflicts.length) continue;
    item.view.exclusiveWith = [...new Set([...(item.view.exclusiveWith ?? []), ...conflicts])];
    item.view.selected = false;
  }
}

/** Resolve variables against the final selection, preserving mandatory skills/connections. */
export function resolveImportEnvironmentDependencies(items: ImportItem[], providers: ImportItem[] = items): ImportItem[] {
  return items.map(item => {
    if (!item.envDependencies) return item;
    const { names, entries } = item.envDependencies;
    const ids = names.map(name => providers.find(provider => Object.keys(provider.env ?? {}).some(key => variableName(key) === variableName(name)))?.view.id
      ?? `env-${fingerprint(name).slice(0, 20)}`);
    return { ...item, view: { ...item.view, dependsOn: [...new Set([...entries, ...ids])] } };
  });
}
