import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readBoundedFileNoFollowWithStat } from '../utils/readBoundedFile.js';
import {
  extractCodexEvents, isPlainObject, missingHookEvents, readCodexTomlHooks,
  readHookJson, unwrapNestedClaudeHooks,
} from './hookConfig.js';
import type { MigrationItem } from './types.js';
import { isPortableBashGuard } from './portableBashGuard.js';

type Fields = Record<string, unknown>;
interface Script {
  name: string;
  bytes: Buffer;
  mode: number;
  missing: boolean;
}

const literalCommand = /^(?:true|echo(?: [\p{L}\p{N}_.:/-]+)*)$/u;
const scriptInvocation = /^(?:(python3?|sh|bash) +)?("[^"\r\n]+"|[^\s"]+)$/;
const claudeRoot = /^\$(?:CLAUDE_PROJECT_DIR|\{CLAUDE_PROJECT_DIR\})\//;
const scriptPath = /^\.claude\/hooks\/([\p{L}\p{N}_. -]+\.(?:py|sh))$/u;

function portableGroup(event: string, group: unknown): group is Fields & { hooks: unknown[] } {
  if (!isPlainObject(group) || !Array.isArray(group.hooks)
    || !Object.keys(group).every(key => key === 'matcher' || key === 'hooks')) return false;
  const matcher = group.matcher ?? '';
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    return ['', '*', 'Bash', '^Bash$'].includes(matcher as string);
  }
  return ['SessionStart', 'Stop', 'UserPromptSubmit'].includes(event) && ['', '*'].includes(matcher as string);
}

async function statOrMissing(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readScript(wd: string, name: string): Promise<Script | undefined> {
  const source = path.join(wd, '.claude', 'hooks', name);
  const target = path.join(wd, '.codex', 'hooks', name);
  const options = { containWithin: await fs.realpath(wd), nonBlocking: true };
  const bytesLimit = 128 * 1024;
  const script = await readBoundedFileNoFollowWithStat(source, bytesLimit, options);
  if (!script) return;
  const existing = await statOrMissing(target);
  if (existing) {
    const copy = existing.isFile() && await readBoundedFileNoFollowWithStat(target, bytesLimit, options);
    if (!copy || !script.bytes.equals(copy.bytes)) return;
  }
  return { name, bytes: script.bytes, mode: Number(script.stat.mode) & 0o777, missing: !existing };
}

type Adapted = { handler: Fields & { command: string }; script?: Script };

async function adaptHandler(
  event: string, matcher: unknown, handler: unknown, gitRoot: boolean,
  scriptFor: (name: string) => Promise<Script | undefined>,
): Promise<Adapted | undefined> {
  if (!isPlainObject(handler) || handler.type !== 'command' || typeof handler.command !== 'string'
    || !Object.keys(handler).every(key => ['type', 'command', 'timeout', 'statusMessage'].includes(key))
    || (handler.timeout !== undefined && !(Number.isSafeInteger(handler.timeout) && Number(handler.timeout) > 0))
    || (handler.statusMessage !== undefined && typeof handler.statusMessage !== 'string')) return;
  if (literalCommand.test(handler.command)) return { handler: { ...handler, command: handler.command } };
  const invocation = scriptInvocation.exec(handler.command);
  if (!invocation) return;
  const [, interpreter, argument] = invocation;
  const filePath = argument.startsWith('"') ? argument.slice(1, -1) : argument;
  const anchored = claudeRoot.test(filePath);
  const name = scriptPath.exec(filePath.replace(claudeRoot, ''))?.[1];
  if (!name) return;
  // A git-root expression is relocatable between worktrees and resolves from subdirectories.
  // Do not substitute the enclosing repository root for a nested project's own root.
  if (anchored && !gitRoot) return;
  const script = await scriptFor(name);
  if (!script) return;
  const text = script.bytes.toString('utf8');
  let run = interpreter;
  if (name.endsWith('.py')) {
    if (!['python', 'python3'].includes(run) || event !== 'PreToolUse' || !['Bash', '^Bash$'].includes(matcher as string)) return;
    if (!isPortableBashGuard(text)) return;
  } else {
    if (run && !['sh', 'bash'].includes(run)) return;
    if (!run && !/^#!(?:\/bin\/(?:ba)?sh|\/usr\/bin\/env (?:ba)?sh)\r?\n/.test(text)) return;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (!lines.length || !lines.every(line => literalCommand.test(line))) return;
    run ??= 'sh';
  }
  const file = (anchored ? '$(git rev-parse --show-toplevel)/' : '') + '.codex/hooks/' + name;
  return { handler: { ...handler, command: run + ' "' + file + '"' }, script };
}

export async function planCodexHooks(wd: string) {
  const claude = path.join(wd, '.claude');
  const codex = path.join(wd, '.codex');
  const settings = path.join(claude, 'settings.json');
  const target = path.join(codex, 'hooks.json');
  const [sourceDir, sourceFile] = await Promise.all([statOrMissing(claude), statOrMissing(settings)]);
  if (!sourceDir?.isDirectory() || !sourceFile?.isFile()) return;
  const source = await readHookJson(settings);
  if (!isPlainObject(source.hooks) || !Object.keys(source.hooks).length) return;

  // Never publish a configuration or a copied script through a linked project directory.
  const directories = await Promise.all([codex, path.join(claude, 'hooks'), path.join(codex, 'hooks')].map(statOrMissing));
  if (directories.some(st => st && !st.isDirectory())) return;
  const [targetStat, tomlStat] = await Promise.all([target, path.join(codex, 'config.toml')].map(statOrMissing));
  if ((targetStat && !targetStat.isFile()) || (tomlStat && !tomlStat.isFile())) return;
  const [previous, toml] = await Promise.all([readHookJson(target), readCodexTomlHooks(codex, true)]);
  const events = unwrapNestedClaudeHooks(source.hooks);
  const old = extractCodexEvents(previous);
  const flat = !Object.hasOwn(previous, 'hooks') && Object.keys(old).length > 0;
  if ((!flat && previous.hooks !== undefined && !isPlainObject(previous.hooks))
    || !Object.values(old).every(groups => Array.isArray(groups) && groups.every(g => isPlainObject(g) && Array.isArray(g.hooks)))) return;

  const legacy = missingHookEvents(events, [], 'to-codex');
  const updates: Fields = {};
  const scripts = new Map<string, Script>();
  const entries = new Map<string, NonNullable<MigrationItem['subItems']>[number]>();
  const cache = new Map<string, Script | undefined>();
  const git = await statOrMissing(path.join(wd, '.git'));
  const gitRoot = Boolean(git?.isFile() || git?.isDirectory());
  async function scriptFor(name: string) {
    if (!cache.has(name)) {
      cache.set(name, await readScript(wd, name).catch(() => undefined));
    }
    return cache.get(name);
  }

  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups) || Object.hasOwn(toml, event)) continue;
    const existing = Object.hasOwn(old, event);
    const sameLegacy = existing && isDeepStrictEqual(old[event], legacy[event]);
    const replacements = sameLegacy ? structuredClone(legacy[event]) as Array<{ hooks: unknown[] }> : undefined;
    const additions = [];
    const adapted: Adapted[] = [];
    const repairs: Adapted[] = [];
    for (const [i, group] of groups.entries()) {
      if (!portableGroup(event, group)) continue;
      const handlers = [];
      for (const [j, original] of group.hooks.entries()) {
        const action = await adaptHandler(event, group.matcher, original, gitRoot, scriptFor);
        if (!action) continue;
        handlers.push(action.handler);
        adapted.push(action);
        // Earlier versions left this Claude-only variable in an otherwise rewritten command.
        // Only repair an exact old event with the matching script already present.
        const previousHandler = replacements?.[i].hooks[j];
        if (replacements && action.script && !action.script.missing && isPlainObject(previousHandler)
          && typeof previousHandler.command === 'string' && previousHandler.command.includes('CLAUDE_PROJECT_DIR')) {
          replacements[i].hooks[j] = action.handler;
          repairs.push(action);
        }
      }
      if (handlers.length) additions.push({ ...group, hooks: handlers });
    }
    if (!adapted.length) continue;
    if (existing && !repairs.length && !isDeepStrictEqual(old[event], additions)) continue;
    if (!existing) updates[event] = additions;
    else if (repairs.length) updates[event] = replacements;

    for (const { handler, script } of repairs.length ? repairs : adapted) {
      if (existing && !repairs.length && !flat && !script?.missing) continue;
      if (script) scripts.set(script.name, script);
      const name = script?.name ?? handler.command;
      entries.set(name, {
        name,
        sourcePath: script ? path.join(claude, 'hooks', name) : settings,
        targetPath: script ? path.join(codex, 'hooks', name) : target,
      });
    }
  }
  if (!entries.size) return;
  const metadata = flat ? Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in old))) : previous;
  const next = { ...metadata, hooks: { ...old, ...updates } };
  const hash = createHash('sha256').update(JSON.stringify(next));
  for (const script of scripts.values()) hash.update(script.name).update(script.bytes);
  return { id: 'hooks:' + hash.digest('hex'), previous, next, targetMode: targetStat?.mode, scripts, subItems: [...entries.values()] };
}
