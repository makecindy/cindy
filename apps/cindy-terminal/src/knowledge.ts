import path from 'node:path';
import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { MakerMemoryManager, MakerContactsManager, resolveMemoryScopeKey, memoryScopeDirName, parseBotMemoryScopeKey, type AgentKind, type Logger } from '@cindy/maker-core';
import { createCindyMemoryMcpServer } from '../../../packages/lizi-mcps/src/cindy_memoryMcpServer.js';
import { createLiziMcpProviders } from '../../../packages/lizi-mcps/src/providers.js';
import type { SessionSearchFn } from '../../../packages/lizi-mcps/src/types.js';
import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';
import type { McpProvider } from '@cindy/maker-core';
import type { AccountDataAccess } from '../../../packages/lizi-mcps/src/account-data-access.js';
import { readPrivateFile, atomicPrivateWrite, privateDirectory } from './platform.js';

const preferences = z.object({ memory: z.boolean().default(true), contacts: z.boolean().default(false) }).strict();

/** Account-owned services. Every task owns its memory pool, while contacts share
 * one account database. Stopping a task cannot dispose another task's pool. */
export class TerminalKnowledge {
  readonly contacts: MakerContactsManager;
  readonly memory: MakerMemoryManager;
  readonly ready: Promise<void>;
  private value = preferences.parse({});
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private runtimes = new Set<MakerMemoryManager>();
  private taskRuntimes = new Map<string, { memory: MakerMemoryManager; scopeKey: string; access: AccountDataAccess }>();
  constructor(private readonly options: {
    root: string; logger: Logger; assertCurrent(): void; changed(collection: string): void;
    workingDirs(): Promise<string[]>; searchSessions?: SessionSearchFn;
    reviewOneShot?: ConstructorParameters<typeof MakerMemoryManager>[0]['reviewOneShot'];
  }) {
    this.contacts = new MakerContactsManager({ basePath: options.root, logger: options.logger, sqliteFactory: file => this.database(file) });
    this.memory = this.createMemory();
    this.ready = this.open();
  }
  private database(file: string) {
    this.guard();
    const db = new Database(file);
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
    return db;
  }
  private async open() {
    await privateDirectory(this.options.root);
    const raw = await readPrivateFile(path.join(this.options.root, 'knowledge-settings.json'));
    this.guard();
    if (raw) this.value = preferences.parse(JSON.parse(raw.toString()));
    if (!this.value.memory) await this.memory.disable();
  }
  guard() { if (this.closed) throw new Error('KNOWLEDGE_CLOSED'); this.options.assertCurrent(); }
  snapshot() { this.guard(); return { ...this.value }; }
  private createMemory() {
    return new MakerMemoryManager({
      basePath: this.options.root, resolveBasePath: () => { this.guard(); return this.options.root; },
      ownerScopeKey: () => { this.guard(); return this.options.root; },
      reloadEnabled: () => this.value.memory, initialEnabled: this.value.memory,
      isIndependentScope: scope => parseBotMemoryScopeKey(scope) !== null,
      sqliteFactory: file => this.database(file), agents: {}, logger: this.options.logger,
      reviewOneShot: this.options.reviewOneShot,
    });
  }
  async configure(patch: unknown, assertCurrent: () => void = () => {}) {
    await this.ready; const parsed = preferences.partial().parse(patch);
    const work = this.writes.then(async () => {
      this.guard(); assertCurrent();
      const next = { ...this.value, ...parsed };
      await atomicPrivateWrite(path.join(this.options.root, 'knowledge-settings.json'), JSON.stringify(next));
      this.guard(); assertCurrent(); this.value = next;
      for (const manager of [this.memory, ...this.runtimes]) {
        if (next.memory) await manager.enable({ skipAgentSync: true }); else await manager.disable();
      }
      this.options.changed('memory'); this.options.changed('contacts');
      return this.snapshot();
    });
    this.writes = work.catch(() => {}); return work;
  }
  async scopes(): Promise<Array<{ id: string; scope: string }>> {
    await this.ready; this.guard();
    const scopes = new Set<string>();
    for (const dir of new Set(await this.options.workingDirs())) scopes.add(await resolveMemoryScopeKey(dir));
    const base = path.join(this.options.root, 'maker-memory');
    const entries = await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = await open(path.join(base, entry.name, 'meta.json'), constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (!file) continue;
      let value: unknown;
      try { const info = await file.stat(); if (!info.isFile() || info.size > 64 * 1024) throw new Error('INVALID_MEMORY_METADATA'); value = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
      const scope = value && typeof value === 'object' && 'absPath' in value ? value.absPath : undefined;
      if (typeof scope === 'string' && path.isAbsolute(scope) && memoryScopeDirName(scope) === entry.name) scopes.add(scope);
    }
    this.guard();
    return [...scopes].sort().map(scope => ({ id: createHash('sha256').update(scope).digest('hex'), scope }));
  }
  private providers(memory: MakerMemoryManager, withAccountDataAccess?: AccountDataAccess) {
    return createLiziMcpProviders({
      memory: { getManager: () => { this.guard(); return memory; }, withAccountDataAccess, searchSessions: this.options.searchSessions },
      contacts: { getManager: () => { this.guard(); return this.contacts; }, isEnabled: () => { this.guard(); return this.value.contacts; }, withAccountDataAccess, onMutated: () => this.options.changed('contacts') },
    });
  }
  providerCatalog(): McpProvider[] {
    this.guard();
    return this.providers(this.memory).map(({name,isEnabled})=>({name,isEnabled}));
  }
  async createRuntime(input: { sessionId: string; workingDir: string; agentKind: AgentKind; remoteHostId?:string|null }, independent?: { memory: MakerMemoryManager; scopeKey: string; assertCurrent(): Promise<void> }) {
    await this.ready; this.guard();
    const scopeKey = independent?.scopeKey ?? await resolveMemoryScopeKey(input.workingDir,input.remoteHostId); this.guard();
    const memory = independent?.memory ?? this.createMemory(); this.runtimes.add(memory);
    let closed = false;
    const guard = () => { this.guard(); if (closed) throw new Error('KNOWLEDGE_RUNTIME_CLOSED'); };
    const context = () => ({ ...input, remoteHostId:input.remoteHostId??undefined,memoryScopeKey: scopeKey });
    const withAccountDataAccess: import('../../../packages/lizi-mcps/src/account-data-access.js').AccountDataAccess = async (id, operation) => {
      guard(); if (id !== input.sessionId) throw new Error('TASK_SCOPE_MISMATCH');
      await independent?.assertCurrent();
      const value = await operation(async () => { guard(); await independent?.assertCurrent(); }); guard(); await independent?.assertCurrent(); return value;
    };
    const taskRuntime = { memory, scopeKey, access: withAccountDataAccess };
    this.taskRuntimes.set(input.sessionId, taskRuntime);
    const providers: McpProvider[] = this.providers(memory,withAccountDataAccess).map(provider=>({
      ...provider,
      toClaudeSdkConfig: ctx=>{
        guard();
        return provider.toClaudeSdkConfig!({...ctx,...context(),getSessionContext:()=>({...ctx,...ctx.getSessionContext?.(),...context()})});
      },
    }));
    return {
      memory, scopeKey, contactsEnabled: this.value.contacts, providers,
      factories: Object.fromEntries(providers.map(provider=>[provider.name,(ctx:import('@cindy/maker-core').McpProviderContext=context())=>(provider.toClaudeSdkConfig!(ctx) as {instance:import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}).instance])),
      close: async () => { if (closed) return; closed = true; if (this.taskRuntimes.get(input.sessionId) === taskRuntime) this.taskRuntimes.delete(input.sessionId); this.runtimes.delete(memory); if (!independent) memory.dispose(); },
    };
  }
  sshProvider(captureCurrent: (context: LiziMcpSessionContext) => () => void): McpProvider {
    const current = () => {
      this.guard(); const context = getLiziMcpSessionContext();
      const runtime = context?.sessionId ? this.taskRuntimes.get(context.sessionId) : undefined;
      if (!context || !runtime) throw new Error('TASK_MCP_SCOPE_MISMATCH');
      const assertCurrent = captureCurrent(context); assertCurrent();
      return { context, runtime, assertCurrent };
    };
    return { name: 'cindy_memory', toClaudeSdkConfig: () => ({ type: 'sdk', name: 'cindy_memory',
      instance: createCindyMemoryMcpServer({ workdir: '', getManager: () => current().runtime.memory,
        getSessionContext: () => { const {context,runtime}=current(); return {...context,memoryScopeKey:runtime.scopeKey}; },
        withAccountDataAccess: async (id, operation) => {
          const {context,runtime,assertCurrent}=current(); if(id!==context.sessionId)throw new Error('TASK_MCP_SCOPE_MISMATCH');
          return runtime.access(id, async guard => { assertCurrent(); const result=await operation(async()=>{await guard();assertCurrent();});assertCurrent();return result; });
        }, searchSessions: this.options.searchSessions }) }) };
  }
  async close() {
    if (this.closed) return;
    this.closed = true; await this.writes;
    this.taskRuntimes.clear();
    for (const runtime of this.runtimes) runtime.dispose(); this.runtimes.clear();
    this.memory.dispose(); this.contacts.dispose();
  }
}
