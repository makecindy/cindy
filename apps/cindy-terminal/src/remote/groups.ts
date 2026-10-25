import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { createProviderGroupDirectory, type ProviderGroupDirectoryDeps } from '@cindy/remote-agent/groups/directory';
import { createProviderGroupRouter } from '@cindy/remote-agent/groups/router';
import { createProviderGroupExternalLoad } from '@cindy/remote-agent/groups/externalLoad';
import { createProviderGroupRemoteClient } from '@cindy/remote-agent/groups/remoteClient';
import { handleProviderGroupRemote, decorateProviderListWithGroups } from '@cindy/remote-agent/groups/remoteHandler';
import { normalizeProviderGroupConfig, type ProviderGroupConfig } from '@cindy/remote-agent/shared/providerGroup';
import type { ProviderGroupPersistedCooling } from '@cindy/remote-agent/groups/cooling';
import type { ProviderGroupBinding } from '@cindy/remote-agent/groups/bindings';
import type { DeviceAgentServiceDeps } from '@cindy/remote-agent';
import type { ProviderView, AgentKind } from '@cindy/model-providers';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { TerminalRemoteContext } from './types.js';

export interface TerminalProviderGroupOptions extends Omit<ProviderGroupDirectoryDeps, 'now'> {
  profileDir: string;
  getOwnerScope(): string | null;
  invoke: DeviceAgentServiceDeps['remoteInvoke'];
  isRemoteAllowed(providerId: string): boolean;
  listBindings(): Record<string, ProviderGroupBinding>;
  isTurnRunning(sessionId: string): boolean;
  sessionGroup(sessionId: string): Promise<{ groupDeviceId: string | null; providerId: string } | null>;
  onChanged?():void;
}

/** Existing directory, quota, scheduling, lease and read/pick protocol. The
 * selected member owns execution; this service never runs a substitute agent. */
export class TerminalProviderGroups {
  private groups: Record<string, ProviderGroupConfig> = {};
  private cooling: ProviderGroupPersistedCooling = {};
  private usage: Record<string, unknown> = {};
  private cleanups:Record<string,string>={};
  private readonly owner: string | null;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly file: string;
  readonly directory;
  router!: ReturnType<typeof createProviderGroupRouter>;
  readonly externalLoad;
  readonly remote;

  constructor(private readonly options: TerminalProviderGroupOptions) {
    this.owner = options.getOwnerScope(); this.file = path.join(options.profileDir, 'provider-groups.json');
    this.directory = createProviderGroupDirectory({ ...options, now: Date.now });
    this.externalLoad = createProviderGroupExternalLoad({ now: Date.now });
    this.ready = this.load().then(() => {
      this.assertCurrent();
      this.router = createProviderGroupRouter({
      directory: this.directory, readGroup: id => this.read(id),
      listBindings: options.listBindings, isTurnRunning: options.isTurnRunning,
      externalRunning: (providerId, memberKey) => this.externalLoad.running(providerId, memberKey),
      coolingStore: { read: () => this.cooling, write: value => { this.cooling = value; void this.persist().catch(() => undefined); } },
      now: Date.now, random: Math.random,
      });
    });
    this.remote = createProviderGroupRemoteClient(options.invoke);
  }
  private assertCurrent() {
    if (this.closed || this.options.getOwnerScope() !== this.owner) throw new Error('OWNER_CHANGED');
  }
  private async load() {
    await privateDirectory(this.options.profileDir);
    const raw = await readPrivateFile(this.file); if (!raw) return;
    const state = JSON.parse(raw.toString()) as { version?: unknown; groups?: Record<string, unknown>; cooling?: ProviderGroupPersistedCooling; usage?: Record<string, unknown>;cleanups?:Record<string,string> };
    if (state.version !== 1 || !state.groups || typeof state.groups !== 'object' || Object.keys(state.groups).length > 1024) throw new Error('INVALID_PROVIDER_GROUPS');
    for (const [id, value] of Object.entries(state.groups)) {
      const config = normalizeProviderGroupConfig(value, id);
      if (!config) throw new Error('INVALID_PROVIDER_GROUP');
      this.groups[id] = config;
    }
    if (state.cooling && typeof state.cooling === 'object') this.cooling = state.cooling;
    if (state.usage && typeof state.usage === 'object') this.usage = state.usage;
    if(state.cleanups&&typeof state.cleanups==='object')this.cleanups=state.cleanups;
  }
  private persist() {
    const job = this.writes.then(async () => { await this.ready; this.assertCurrent(); await atomicPrivateWrite(this.file, JSON.stringify(this.state())); });
    this.writes = job.catch(() => undefined); return job;
  }
  read(id: string): ProviderGroupConfig | null { return this.groups[id] ? structuredClone(this.groups[id]) : null; }
  private state(groups=this.groups,cleanups=this.cleanups){return{version:1,groups,cooling:this.cooling,usage:this.usage,cleanups};}
  snapshot(){return structuredClone(this.groups);}
  pendingCleanups(){return {...this.cleanups};}
  currentRuntime(){this.assertCurrent();return{router:this.router,externalLoad:this.externalLoad,isCurrent:()=>{try{this.assertCurrent();return true;}catch{return false;}}};}
  private withCleanup(groups:Record<string,ProviderGroupConfig>){
    const current=new Set(Object.values(this.groups).flatMap(group=>group.members.filter(member=>member.kind==='share'&&member.agentDeviceId).map(member=>member.agentDeviceId!)));
    const next=new Set(Object.values(groups).flatMap(group=>group.members.filter(member=>member.kind==='share'&&member.agentDeviceId).map(member=>member.agentDeviceId!)));
    const cleanups={...this.cleanups};for(const id of current)if(!next.has(id))cleanups[id]=randomUUID();return cleanups;
  }
  completeCleanup(id:string,token:string){
    const job=this.writes.then(async()=>{await this.ready;this.assertCurrent();if(this.cleanups[id]!==token)return;const cleanups={...this.cleanups};delete cleanups[id];await atomicPrivateWrite(this.file,JSON.stringify(this.state(this.groups,cleanups)));this.assertCurrent();this.cleanups=cleanups;});this.writes=job.catch(()=>undefined);return job;
  }
  async list(): Promise<Record<string, ProviderGroupConfig>> { await this.ready; this.assertCurrent(); return structuredClone(this.groups); }
  async candidates(id: string) { await this.ready; this.assertCurrent(); return this.directory.listCandidates(id, this.read(id)); }
  async save(id: string, value: unknown, guard: () => void) {
    const normalized = normalizeProviderGroupConfig(value, id);
    if (!normalized) throw new Error('INVALID_PROVIDER_GROUP');
    const job = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      if (!(await this.options.listLocalProviders()).some(provider => provider.id === id)) throw new Error('INVALID_PROVIDER_GROUP');
      this.assertCurrent(); guard();
      if (!this.groups[id] && Object.keys(this.groups).length >= 1024) throw new Error('PROVIDER_GROUP_LIMIT');
      const groups = { ...this.groups, [id]: normalized };
      const cleanups=this.withCleanup(groups);
      await atomicPrivateWrite(this.file, JSON.stringify(this.state(groups,cleanups)));
      this.assertCurrent(); guard(); this.groups = groups;this.cleanups=cleanups; this.directory.invalidate();this.options.onChanged?.();
    });
    this.writes = job.catch(() => undefined); await job;
  }
  async remove(id: string, guard: () => void) {
    const job = this.writes.then(async () => {
      await this.ready; this.assertCurrent(); guard();
      const { [id]: _, ...groups } = this.groups;
      const cleanups=this.withCleanup(groups);
      await atomicPrivateWrite(this.file, JSON.stringify(this.state(groups,cleanups)));
      this.assertCurrent(); guard(); this.groups = groups;this.cleanups=cleanups; this.directory.invalidate();this.options.onChanged?.();
    });
    this.writes = job.catch(() => undefined); await job;
  }
  async decorate(providers: ProviderView[]) { await this.ready; this.assertCurrent(); return decorateProviderListWithGroups({ providers }, id => this.read(id)); }
  async resolveExecutionRoute(input: {agentDeviceId?: string; providerId?: string; model?: string; agentKind?: AgentKind; groupBinding?: ProviderGroupBinding}, taskId: string) {
    await this.ready; this.assertCurrent();
    if (input.groupBinding) {
      if (!input.providerId || !input.model || !input.agentKind) throw new Error('INVALID_GROUP_BINDING');
      return {...input, providerId:input.providerId, model:input.model, agentKind:input.agentKind};
    }
    if (input.agentDeviceId || !input.providerId) return null;
    const config=this.read(input.providerId); if (!config) return null;
    const members=await this.directory.resolveMembers(input.providerId, config);
    const kinds: AgentKind[]=input.agentKind?[input.agentKind]:['claude-code','codex','pi'];
    for (const kind of kinds) {
      const model=input.model??members.flatMap(member=>member.view?.models[kind]??[]).find(model=>!model.disabled&&model.defaultEnabled!==false)?.id;
      if (!model) continue;
      const pick=await this.router.pick({providerId:input.providerId,agentKind:kind,model,localTask:true,reserveFor:taskId});
      this.assertCurrent();
      if (pick.kind==='member') return {agentDeviceId:pick.member.agentDeviceId??undefined,providerId:pick.member.providerId,model,agentKind:kind,groupBinding:{providerId:input.providerId,memberKey:pick.member.key,at:Date.now()}};
      if (input.model && pick.kind==='unavailable') throw new Error('[REMOTE_AGENT_GROUP_UNAVAILABLE] No group member can run this model');
    }
    throw new Error('[REMOTE_AGENT_GROUP_UNAVAILABLE] No group member can run this model');
  }
  async request(raw: unknown, context: TerminalRemoteContext): Promise<unknown> {
    await this.ready; this.assertCurrent(); context.assertCurrent();
    if (context.source.kind !== 'owner') throw new Error('OWNER_REQUIRED');
    const result = await handleProviderGroupRemote({
      scope: () => ({ router: this.router, externalLoad: this.externalLoad, isCurrent: () => { try { this.assertCurrent(); context.assertCurrent(); return true; } catch { return false; } } }),
      readGroup: id => this.read(id), isRemoteAllowed: this.options.isRemoteAllowed, now: Date.now,
      sessionGroup: this.options.sessionGroup,
      replaceReportedUsage: (controller, sinceDay, rows) => {
        this.assertCurrent(); context.assertCurrent();
        this.usage[controller] = { sinceDay, rows }; return this.persist();
      },
    }, context.controllerDeviceId, raw);
    this.assertCurrent(); context.assertCurrent(); return result;
  }
  async close() { await this.writes; this.closed = true; this.directory.invalidate(); }
}
