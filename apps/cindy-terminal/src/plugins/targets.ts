import path from 'node:path';
import { stat } from 'node:fs/promises';
import { PluginTargetSlot, type PluginTargetStore } from '@cindy/plugin-runtime/pluginTargetSlot';
import { hasPluginTargetApproval } from '@cindy/plugin-runtime/taskCapability';
import { sanitizeSourceName } from '@cindy/maker-shared/message-source';
import type { PluginTargetCandidate, PluginTargetKind } from '@cindy/plugin-runtime/shared/pluginTargets';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { TerminalCompanionHost } from '../remote/companions/host.js';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginSessions } from './sessions.js';

/** The same durable target slot as Desktop, backed by the terminal owner and
 * canonical task/Profile services. Target access never transfers task ownership. */
export class TerminalPluginTargets {
  readonly ready: Promise<void>;
  private readonly slot: PluginTargetSlot;
  private readonly tasks: ReturnType<TerminalTaskHost['configurePluginTargetDelivery']>;
  private store?: PluginTargetStore;
  private closed = false;
  constructor(private readonly options: {
    host: TerminalPlugins; sessions: TerminalPluginSessions; tasks: TerminalTaskHost;
    companions?(): TerminalCompanionHost | undefined;
    projects(): Promise<string[]>; owner(): unknown; guard(): void;
  }) {
    this.slot = new PluginTargetSlot(() => [options.owner()]);
    const validate = (id: string, clientId: string) => this.slot.assertQueuedDelivery(id, clientId);
    this.tasks = options.tasks.configurePluginTargetDelivery(validate);
    this.slot.adapter = {
      store: () => { this.guard(); if (!this.store) throw new Error('HOST_NOT_READY'); return this.store; },
      approvalRevision: id => this.revision(id), candidates: kind => this.candidates(kind),
      session: async (kind, id) => {
        if (!(await this.candidates(kind)).some(row => row.id === id)) throw new Error('TARGET_UNAVAILABLE');
        if (kind === 'task') return id;
        const profile = await this.companionHost()?.profiles.get(id);
        if (!profile) throw new Error('TARGET_UNAVAILABLE');
        return profile.sessionId;
      },
      create: (plugin, project, id, title, route, guard) => options.sessions.createTarget(plugin, id, project, title, route, guard),
      send: async (pluginId, taskId, clientId, text, guard, validateTarget, delivery, images = []) => {
        await validateTarget();
        const plugin = { id: pluginId, name: sanitizeSourceName(options.host.installed(pluginId)?.manifest.name) || pluginId };
        return this.tasks.send(plugin, taskId, clientId, text, images, guard, delivery);
      },
      withdraw: async (taskId, clientId, guard) => {
        await this.tasks.withdraw(taskId, clientId, guard);
      },
    };
    this.ready = options.sessions.targetStore().then(store => { this.guard(); this.store = store; });
  }
  private guard() { if (this.closed) throw new Error('PLUGIN_TARGETS_CLOSED'); this.options.guard(); }
  private revision(id: string) { this.guard(); const ghost = this.options.host.installed(id); return hasPluginTargetApproval(ghost) && ghost?.approval.state === 'approved' ? ghost.approval.revision : null; }
  /** Called before restored companion queues start, as well as on delivery. */
  connectCompanions() { this.companionHost(); }
  private companionHost() {
    this.guard(); return this.options.companions?.();
  }
  private async candidates(kind: PluginTargetKind): Promise<PluginTargetCandidate[]> {
    this.guard(); let result: PluginTargetCandidate[];
    if (kind === 'project') {
      const rows = await Promise.all((await this.options.projects()).map(async id =>
        await stat(id).then(info => info.isDirectory(), () => false) ? { id, label: path.basename(id) || id, detail: id } : null));
      result = rows.filter((row): row is NonNullable<typeof row> => row !== null);
    } else if (kind === 'task') {
      result = (await this.options.tasks.storage.list()).filter(row => !row.archived && !row.deleted && !row.hiddenAt && !row.agentDeviceId && !row.remoteHostId && !row.reviewMode &&
        !row.orcaRemoteLead && row.orcaRole !== 'worker' && row.source !== 'bot' && row.source !== 'review')
        .sort((a, b) => (b.userSendAt ?? b.updatedAt) - (a.userSendAt ?? a.updatedAt))
        .map(row => ({ id: row.id, label: row.title || row.id, detail: row.workDir }));
    } else {
      result = []; const host = this.companionHost();
      for (const profile of await host?.profiles.list() ?? []) {
        if (profile.status !== 'active') continue;
        try { await host!.assertMayRun(profile.id); } catch { continue; }
        await host!.ensureCanonical(profile);
        result.push({ id: profile.id, label: profile.name, detail: profile.description });
      }
    }
    this.guard(); return result;
  }
  async receive(id: string, payload: unknown) {
    try {
      await this.ready; this.guard();
      if (!payload || typeof payload !== 'object' || 'pageId' in payload || 'mobilePageId' in payload) throw new Error('PERMISSION_DENIED');
      const revision = this.revision(id);
      const authorized = () => { if (!revision || this.revision(id) !== revision) throw new Error('PERMISSION_DENIED'); };
      return { ok: true, data: await this.slot.handle(id, payload, authorized) };
    } catch (error) {
      const raw = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '');
      const code = ['PERMISSION_DENIED', 'HOST_NOT_READY', 'INVALID_PARAMS', 'INVALID_ATTACHMENTS', 'TASK_BUSY', 'TARGET_UNAVAILABLE', 'SUPERSEDED', 'REQUEST_KEY_CONFLICT', 'DELIVERY_UNCERTAIN', 'DELIVERY_REJECTED', 'STALE_REVISION', 'ROUTE_UNAVAILABLE'].includes(raw) ? raw : 'HOST_NOT_READY';
      return { ok: false, error: { code, message: code, retryable: code === 'TASK_BUSY' } };
    }
  }
  close() { if (this.closed) return; this.closed = true; this.tasks.close(); this.slot.adapter = null; }
}
