import { promises as fs } from 'node:fs';
import path from 'node:path';
import { importBotIdentity, readImportSourceBot, readImportSourceBotIdentity, type SourceReaderDeps } from './sources.js';
import { resolveSourceCli } from './takeover.js';
import { importedProcessEnvironment, runImportedProcess } from './process.js';
import { CompanionImportError, object, string, type ImportItem, type ImportSource } from './types.js';
import type { ImportedImBotTarget } from './imBotConnections.js';

/** Durable per-bot progress in the import receipt; a retry resumes from it instead of stopping twice. */
export interface ImportBotRecord {
  /** `restoring`: the companion could not connect and the source switch is being put back. */
  phase: 'stopping' | 'stopped' | 'restoring' | 'connected';
  /** The source switch before this import, restored when the companion cannot connect. */
  original?: { present: boolean; value?: unknown };
  /** This import turned the source switch off. */
  changed?: boolean;
  /** The source gateway was serving the bot when the import began. */
  wasLive?: boolean;
  /** A gateway restart was issued (it may have run even when unconfirmed), so a restore restarts again. */
  restartRequested?: boolean;
  /** The restart command succeeded; an unconfirmed restart is retried on the next attempt. */
  restarted?: boolean;
}

export interface BotTakeoverTiming { pollMs: number; timeoutMs: number; settleMs: number; sleep(ms: number): Promise<void>; now(): number }

const TIMING: BotTakeoverTiming = {
  pollMs: 2_000, timeoutMs: 120_000, settleMs: 3_000,
  // real-wait: the source gateway is a separate process; there is no event to wait on.
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
};
const LIVE_STATES = new Set(['connected', 'connecting', 'retrying']);
const STATE_FILE_LIMIT = 4 * 1024 * 1024;

export interface BotTakeoverInput {
  source: ImportSource;
  item: ImportItem;
  target: ImportedImBotTarget;
  record?: ImportBotRecord;
  /** Persist before and after each native mutation; undefined clears the record. */
  save(record: ImportBotRecord | undefined): Promise<void>;
  readers: SourceReaderDeps;
  assertOwner(): void;
  timing?: Partial<BotTakeoverTiming>;
  alive?(pid: number): boolean;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Hermes: a named profile is served by the host gateway (`<profile>:<platform>`) unless parked. */
async function hermesLiveness(source: ImportSource, platform: string, alive: (pid: number) => boolean): Promise<{ live: boolean; parked: boolean }> {
  const named = source.agentId !== 'default' && path.basename(path.dirname(source.root)) === 'profiles';
  let parked = false;
  if (named) try { await fs.access(path.join(source.root, 'gateway.parked')); parked = true; } catch { /* Not parked. */ }
  const files: Array<[string, string]> = [[path.join(source.root, 'gateway_state.json'), platform]];
  if (named) files.push([path.join(path.dirname(path.dirname(source.root)), 'gateway_state.json'), `${source.agentId}:${platform}`]);
  let live = false;
  for (const [file, key] of files) {
    let state: Record<string, unknown>;
    try {
      if ((await fs.stat(file)).size > STATE_FILE_LIMIT) continue;
      state = object(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch { continue; }
    const entry = object(object(state.platforms)[key]);
    const pid = Number(entry.writer_pid ?? state.pid);
    // A crashed gateway leaves its last state behind; only a running writer serves the bot.
    if (LIVE_STATES.has(string(entry.state)) && (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid))) live = true;
  }
  return { live, parked };
}

function nested(keys: string[], value: unknown): Record<string, unknown> {
  return keys.reduceRight<unknown>((child, key) => ({ [key]: child }), value) as Record<string, unknown>;
}

/**
 * Stop an imported bot in its source agent, then connect it as the companion's own. Mirrors the
 * automation handover: native commands only, re-read to confirm, restore on failure. Resolves to
 * an advisory issue code; nothing here throws for an ordinary platform or source failure.
 */
export async function takeOverImportedBot(input: BotTakeoverInput): Promise<string | undefined> {
  const { source, item, target, readers, assertOwner } = input;
  const timing = { ...TIMING, ...input.timing };
  const alive = input.alive ?? processAlive;
  const bot = item.bot;
  if (!bot) return 'IMPORT_IM_BOT_CONNECT_FAILED';
  let record = input.record ? { ...input.record } : undefined;
  const save = async (next: ImportBotRecord | undefined) => { record = next; await input.save(next ? { ...next } : undefined); assertOwner(); };
  if (record?.phase === 'connected') return undefined;
  const key = bot.enabledPath.join('.');
  let cli: Awaited<ReturnType<typeof resolveSourceCli>> | undefined;
  const run = async (args: string[], stdin?: string, timeoutMs = 30_000): Promise<boolean> => {
    cli ??= await resolveSourceCli(source, readers.home, readers.env); assertOwner();
    const env = importedProcessEnvironment(source.kind === 'hermes' ? { HERMES_HOME: source.root }
      : { OPENCLAW_STATE_DIR: source.root, OPENCLAW_CONFIG_PATH: source.configFile }, readers.env);
    try {
      const result = await runImportedProcess({ command: cli.interpreter ?? cli.executable,
        args: cli.interpreter ? ['/d', '/s', '/c', `""${cli.executable}" ${args.join(' ')}"`] : args,
        windowsVerbatimArguments: !!cli.interpreter, cwd: source.root, env, timeoutMs, signal: new AbortController().signal, assertOwner,
        ...(stdin === undefined ? {} : { input: stdin }) });
      assertOwner();
      return result.exitCode === 0;
    } catch (error) {
      assertOwner();
      if (error instanceof CompanionImportError && error.code === 'OWNER_CHANGED') throw error;
      return false;
    }
  };
  // Flags never carry credentials; OpenClaw patches go through stdin.
  const setSwitch = (value: unknown, present = true) => source.kind === 'hermes'
    ? run(present ? ['config', 'set', key, String(value)] : ['config', 'unset', key])
    : run(['config', 'patch', '--stdin'], JSON.stringify(nested(bot.enabledPath, present ? value : null)));
  const liveness = () => source.kind === 'hermes' ? hermesLiveness(source, bot.platform, alive) : Promise.resolve({ live: false, parked: false });
  const restartGateway = () => run(['gateway', 'restart'], undefined, 120_000);
  /** Only undo what this import did; a still-unknown restore keeps the `restoring` record for the next retry. */
  const restore = async () => {
    if (!record) return;
    if (record.changed && record.original) {
      // Durable before the switch flips back: a resumed import finishes the restore instead of connecting.
      if (record.phase !== 'restoring') await save({ ...record, phase: 'restoring' });
      try {
        await setSwitch(record.original.value, record.original.present);
        // The switch was on when this import turned it off.
        if (!(await readImportSourceBot(source, bot)).enabled) return;
        const { parked } = await liveness();
        // A failed restart keeps the `restoring` record, so the original bot is not left stopped.
        if ((record.restartRequested || record.restarted) && !parked && !(await restartGateway())) return;
      } catch (error) {
        if (error instanceof CompanionImportError && error.code === 'OWNER_CHANGED') throw error;
        return;
      }
    }
    await save(undefined);
  };

  try {
    if (record?.phase === 'restoring') { await restore(); return 'IMPORT_IM_BOT_CONNECT_FAILED'; }
    const existing = target.existing();
    if (existing === 'self') { await save({ ...(record ?? {}), phase: 'connected' }); return undefined; }
    // Another companion took the bot meanwhile: it serves it now, so the source stays off.
    if (existing === 'other') { await save(undefined); return 'IMPORT_IM_BOT_IN_USE'; }
    /** The switch at this path must still belong to the previewed bot before this import touches it. */
    const sameBot = async () => {
      const current = await readImportSourceBotIdentity(source, bot, readers); assertOwner();
      return !!current && current === importBotIdentity(item.credential?.value);
    };
    if (!record) {
      // Nothing changes in the source before the companion side is known to be addable.
      const blocked = await target.preflight(); assertOwner();
      if (blocked) return blocked;
      if (!(await sameBot())) return 'IMPORT_IM_BOT_SOURCE_CHANGED';
      const before = await readImportSourceBot(source, bot); assertOwner();
      const { live } = await liveness();
      await save({ phase: 'stopping', original: { present: before.present, ...(before.present ? { value: before.value } : {}) },
        wasLive: source.kind === 'hermes' ? live : before.enabled });
    } else if (record.phase === 'stopped' && (await readImportSourceBot(source, bot)).enabled) {
      // The source came back on after an earlier stop: stop it again before connecting.
      await save({ ...record, phase: 'stopping' });
    }
    if (record!.phase === 'stopping') {
      if ((await readImportSourceBot(source, bot)).enabled) {
        cli ??= await resolveSourceCli(source, readers.home, readers.env); assertOwner();
        // Only an unchanged bot is ever switched off by this import.
        if (!record!.changed && !(await sameBot())) { await save(undefined); return 'IMPORT_IM_BOT_SOURCE_CHANGED'; }
        await save({ ...record!, changed: true });
        await setSwitch(false);
        if ((await readImportSourceBot(source, bot)).enabled) {
          // The switch did not change; there is nothing of ours to restore.
          await save(undefined);
          return 'IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED';
        }
      }
      await save({ ...record!, phase: 'stopped' });
    }
    if (record!.wasLive && source.kind === 'hermes') {
      let state = await liveness();
      // A restart would unpark a parked profile, so a parked bot is never restarted.
      if (state.live && !state.parked && !record!.restarted) {
        await save({ ...record!, restartRequested: true });
        if (await restartGateway()) await save({ ...record!, restarted: true });
        state = await liveness();
      }
      const deadline = timing.now() + timing.timeoutMs;
      while (state.live && timing.now() < deadline) {
        await timing.sleep(timing.pollMs); assertOwner();
        state = await liveness();
      }
      // Keep the switch off: the user asked to move the bot, the source just has not let go yet.
      if (state.live) return 'IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED';
    } else if (record!.wasLive && record!.changed) {
      // OpenClaw hot-reloads channel config; Telegram's conflict window still catches a slow stop.
      await timing.sleep(timing.settleMs); assertOwner();
    }
    // Confirm once more right before connecting: both sides must never serve the bot together.
    if ((await readImportSourceBot(source, bot)).enabled) return 'IMPORT_IM_BOT_SOURCE_STOP_UNCONFIRMED';
    const issue = await target.connect(); assertOwner();
    if (!issue) { await save({ ...record!, phase: 'connected' }); return undefined; }
    // A concurrent import connected it to another companion; re-enabling the source would make both serve it.
    if (issue === 'IMPORT_IM_BOT_IN_USE') await save(undefined); else await restore();
    return issue;
  } catch (error) {
    if (error instanceof CompanionImportError && error.code === 'SOURCE_COMMAND_UNAVAILABLE') {
      // Nothing was changed without the native command.
      if (record && !record.changed) await save(undefined);
      return 'SOURCE_COMMAND_UNAVAILABLE';
    }
    throw error;
  }
}
