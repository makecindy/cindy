import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { PtyManager, type CreateResult, type ExitInfo, type PtyManagerDeps, type CreateOptions } from './ptyManager.js';
import { probeAvailableShells, type ShellId } from './shellResolver.js';

export const REMOTE_TERMINAL_CHANNEL = 'terminal:remote-op';
type Owner = { scope: string; controller: string; alive: boolean; closed: Set<() => void> };
type Entry = { id: string; owner: Owner; cwd: string; createdAt: number; metadata?: CreateResult; exit: ExitInfo | null;
  sequence: number; bytes: number; chunks: Array<{ sequence: number; data: string }>; writes: Map<string, string> };
export interface TerminalAuthority { controller: string; assertCurrent(): void }
interface Options {
  getScope(): string | null;
  logger: PtyManagerDeps<Owner>['logger'];
  spawn?: PtyManagerDeps<Owner>['spawn'];
}
const shells = new Set(['auto','zsh','bash','fish','sh','pwsh','powershell','cmd','gitbash','wsl']);
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error('INVALID_TERMINAL_ARGUMENT');
  return value;
}
function dimension(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > 1000) throw new Error('INVALID_TERMINAL_SIZE');
  return Number(value);
}

/** Same PTY engine as Desktop. Only verified host/controller identity selects
 * sessions; a caller cannot attach to another controller by guessing an ID.
 * Output is a bounded in-memory cursor stream and is never written to logs. */
export class RemoteTerminalHost {
  private readonly manager: PtyManager<Owner>;
  private readonly entries = new Map<string, Entry>();
  private revision: string | null = null;
  constructor(private readonly options: Options) {
    this.manager = new PtyManager({ logger: options.logger, spawn: options.spawn,
      lifecycle: { isAlive: owner => owner.alive, onClose: (owner, fn) => { owner.closed.add(fn); } },
      sink: {
        emitData: (_owner, payload) => {
          const entry = this.entries.get(payload.id); if (!entry) return;
          for (let start = 0; start < payload.chunk.length;) {
            let end=Math.min(start+32_768,payload.chunk.length);
            if(end<payload.chunk.length&&/[\uD800-\uDBFF]/.test(payload.chunk[end-1]))end--;
            const data = payload.chunk.slice(start, end);start=end;
            entry.chunks.push({ sequence: ++entry.sequence, data }); entry.bytes += Buffer.byteLength(data);
          }
          while (entry.bytes > 2 * 1024 * 1024 && entry.chunks.length > 1) entry.bytes -= Buffer.byteLength(entry.chunks.shift()!.data);
        },
        emitExit: (_owner, payload) => { const entry = this.entries.get(payload.id); if (entry) entry.exit = payload.exit; },
      },
    });
  }
  private resetIfChanged() {
    const scope = this.options.getScope();
    if (scope !== this.revision) { this.close(); this.revision = scope; }
    return scope;
  }
  async invoke(raw: unknown, authority: TerminalAuthority, program?: Pick<CreateOptions<Owner>, 'program' | 'env'>): Promise<unknown> {
    authority.assertCurrent();
    const scope = this.resetIfChanged(); if (!scope) throw new Error('AUTH_REQUIRED');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_TERMINAL_ARGUMENT');
    const request = raw as Record<string, unknown>;
    if (request.version !== 1) throw new Error('TERMINAL_VERSION_UNSUPPORTED');
    const check = () => { authority.assertCurrent(); if (scope !== this.options.getScope()) { this.resetIfChanged(); throw new Error('OWNER_CHANGED'); } };
    const controller = text(authority.controller, 1024);
    if (request.op === 'capabilities') return { version: 1, shells: probeAvailableShells(), cursorStream: true };
    if (request.op === 'list') return [...this.entries.values()].filter(entry => entry.owner.scope === scope && entry.owner.controller === controller)
      .map(entry => ({ id: entry.id, cwd: entry.cwd, createdAt: entry.createdAt, exit: entry.exit, ...entry.metadata }));
    const id = text(request.id);
    const entry = this.entries.get(id);
    if (entry && (entry.owner.scope !== scope || entry.owner.controller !== controller)) throw new Error('TERMINAL_NOT_FOUND');
    if (request.op === 'create') {
      if (entry) return { id, ...entry.metadata, exit: entry.exit };
      if (this.entries.size >= 64 || [...this.entries.values()].filter(item => item.owner.controller === controller).length >= 16) throw new Error('TERMINAL_LIMIT_REACHED');
      const cwd = await realpath(request.cwd===undefined?homedir():text(request.cwd, 16_384)); check();
      if (!(await stat(cwd)).isDirectory()) throw new Error('WORKING_DIRECTORY_REQUIRED'); check();
      const shellPref = request.shell ?? 'auto'; if (typeof shellPref !== 'string' || !shells.has(shellPref)) throw new Error('INVALID_TERMINAL_SHELL');
      // Recheck after filesystem awaits: two identical create requests share a PTY.
      const existing = this.entries.get(id);
      if (existing) { if (existing.owner.controller !== controller) throw new Error('TERMINAL_NOT_FOUND'); return { id, ...existing.metadata, exit: existing.exit }; }
      if (this.entries.size >= 64 || [...this.entries.values()].filter(item => item.owner.controller === controller).length >= 16) throw new Error('TERMINAL_LIMIT_REACHED');
      const created: Entry = { id, owner: { scope, controller, alive: true, closed: new Set() }, cwd, createdAt: Date.now(), exit: null, sequence: 0, bytes: 0, chunks: [], writes: new Map() };
      this.entries.set(id, created);
      try { created.metadata = this.manager.create({ ...program, id, cwd, owner: created.owner, shellPref: shellPref as ShellId, cols: dimension(request.cols, 80), rows: dimension(request.rows, 24) }); }
      catch { this.entries.delete(id); throw new Error('TERMINAL_SPAWN_FAILED'); }
      return { id, ...created.metadata, exit: created.exit };
    }
    if (!entry) { if (request.op === 'close') return { closed: true }; throw new Error('TERMINAL_NOT_FOUND'); }
    if (request.op === 'read') {
      const after = request.after ?? 0;
      if (!Number.isSafeInteger(after) || Number(after) < 0 || Number(after) > entry.sequence) throw new Error('INVALID_TERMINAL_CURSOR');
      const chunks: Entry['chunks'] = []; let bytes = 0;
      for (const chunk of entry.chunks) { if (chunk.sequence <= Number(after)) continue; chunks.push(chunk); bytes += Buffer.byteLength(chunk.data); if (bytes >= 256 * 1024) break; }
      const cursor = chunks.at(-1)?.sequence ?? Number(after);
      return { chunks, cursor, gap: !!entry.chunks.length && Number(after) < entry.chunks[0].sequence - 1, more: cursor < entry.sequence, exit: cursor === entry.sequence ? entry.exit : null };
    }
    if (request.op === 'write') {
      const requestId = text(request.requestId);
      if (typeof request.data !== 'string' || request.data.length > 65_536) throw new Error('INVALID_TERMINAL_INPUT');
      const digest = createHash('sha256').update(request.data).digest('hex');
      const previous = entry.writes.get(requestId);
      if (previous && previous !== digest) throw new Error('TERMINAL_REQUEST_CONFLICT');
      if(!previous&&entry.exit)throw new Error('TERMINAL_EXITED');
      if (!previous) { check(); this.manager.write(id, request.data); entry.writes.set(requestId, digest); if (entry.writes.size > 256) entry.writes.delete(entry.writes.keys().next().value!); }
      return { accepted: true };
    }
    if (request.op === 'resize') { this.manager.resize(id, dimension(request.cols, 80), dimension(request.rows, 24)); return { resized: true }; }
    if (request.op === 'close') { this.manager.dispose(id); entry.owner.alive = false; this.entries.delete(id); return { closed: true }; }
    throw new Error('UNKNOWN_TERMINAL_OPERATION');
  }
  close() {
    for (const entry of this.entries.values()) { entry.owner.alive = false; this.manager.dispose(entry.id); }
    this.entries.clear();
  }
}
