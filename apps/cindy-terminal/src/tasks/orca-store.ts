import { and, eq, gt } from 'drizzle-orm';
import { orcaWorkers, orcaTeams, orcaWorkerCreationReservations, sessions } from '@cindy/runtime-db/schema';
import path from 'node:path';
import { z } from 'zod';
import { createOrcaTeamStore, type OrcaTeamRecord, type OrcaWorkerRecord, type RemoteWorkerRow, type OrcaTeamStoreHost } from '@cindy/app-runtime/orcaTeamStore';
import { createCollaborationSettingsStore } from '@cindy/app-runtime/collaborationSettingsStore';
import { createOverrideSettingsFile } from '@cindy/app-runtime/overrideSettingsFile';
import { createToolResultCompaction } from '@cindy/app-runtime/toolResultCompaction';
import { createSessionRouteLock } from '@cindy/app-runtime/sessionRouteLock';
import { DEFAULT_ORCA_WORKER_PERMISSION_MODE, ORCA_WORKER_PERMISSION_MODES } from '@cindy/maker-shared/orca-worker-permission-mode';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { TerminalTaskStorage } from './storage.js';
export type TerminalOrcaTeam = OrcaTeamRecord;
export type TerminalOrcaWorker = OrcaWorkerRecord;
export type TerminalOrcaRemoteWorker = RemoteWorkerRow;
type Store = ReturnType<typeof createOrcaTeamStore>;
const workerPreference = z.object({ workerPermissionMode: z.enum(ORCA_WORKER_PERMISSION_MODES) });
/** Node ports for the original SQLite store. Team and remote-worker mutations
 * use the same named transactions and tables as the graphical host. */
export class TerminalOrcaStore {
  readonly ready: Promise<void>;
  private api!: Store;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private readonly collaboration;
  private readonly workerPreferences;
  private remoteProvider: Parameters<Store['setRemoteWorkerStatusProvider']>[0] = null;
  constructor(private readonly options: {
    root: string; tasks: TerminalTaskStorage; guard(): void; beforeOpen?: Promise<void>;
    logger: DbLogger;
    withSessionRouteLock: OrcaTeamStoreHost['withSessionRouteLock'];
    cleanupRuntime: OrcaTeamStoreHost['cleanupSessionRuntimeForTerminalStatus'];
    onTaskPatch?(id: string, patch: Record<string, unknown>): void;
  }) {
    this.collaboration = createCollaborationSettingsStore({ userDataDirectory: () => options.root, logger: options.logger });
    // GUI stores this owner preference in its renderer. The terminal has no
    // renderer, so its host owns the same preference independently of team data.
    this.workerPreferences = createOverrideSettingsFile({ filePath: () => path.join(options.root, 'worker-creation-prefs.json'),
      defaults: { workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE },
      normalize: raw => workerPreference.safeParse(raw).data ?? { workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE },
      log: options.logger, label: 'worker-creation' });
    this.ready = this.open();
  }
  private guard() { if (this.closed) throw new Error('ORCA_STORE_CLOSED'); this.options.guard(); }
  private async open() {
    await this.options.beforeOpen;
    const [database, conversations] = await Promise.all([this.options.tasks.database(), this.options.tasks.runtime()]);
    this.guard();
    const locks = createSessionRouteLock(); locks.setSessionRouteLockImplementation(this.options.withSessionRouteLock);
    this.api = createOrcaTeamStore({
      getDbClient: () => { this.guard(); return database.getDbClient(); }, logger: this.options.logger,
      ...locks, ...createToolResultCompaction({ logger: this.options.logger, drainPersistQueue: conversations.persistence.drainPersistQueue }),
      cleanupSessionRuntimeForTerminalStatus: this.options.cleanupRuntime,
      broadcastSessionPatch: (id, patch) => { this.guard(); this.options.onTaskPatch?.(id, patch); },
    });
    this.api.setRemoteWorkerStatusProvider(this.remoteProvider);
  }
  private run<T>(operation: (api: Store) => Promise<T>): Promise<T> {
    const work = this.ready.then(() => { this.guard(); return operation(this.api); });
    this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => undefined); return work;
  }
  setRemoteWorkerStatusProvider(provider: Parameters<Store['setRemoteWorkerStatusProvider']>[0]) {
    this.remoteProvider = provider; this.api?.setRemoteWorkerStatusProvider(provider);
  }
  settings() { this.guard(); return { ...this.collaboration.readCollaborationSettings(), ...this.workerPreferences.read() }; }
  settingsWire() { this.guard(); const state = this.collaboration.readCollaborationSettingsState(); return { ...state.value, isCustomized: state.isCustomized, customizedKeys: state.customizedKeys, defaults: state.defaults }; }
  async updateSettings(patch: Partial<ReturnType<TerminalOrcaStore['settings']>>) {
    this.guard();
    const next = { ...this.settings(), ...patch };
    z.object({ workerSoftLimit: z.number().int().min(1).max(20), workerHardLimit: z.number().int().min(next.workerSoftLimit).max(20),
      workerIdleReleaseMinutes: z.number().int().min(0).max(120), workerPermissionMode: z.enum(ORCA_WORKER_PERMISSION_MODES) }).parse(next);
    for (const key of ['workerSoftLimit', 'workerHardLimit', 'workerIdleReleaseMinutes'] as const)
      if (patch[key] !== undefined) this.collaboration.writeCollaborationSetting(key, patch[key]);
    if (patch.workerPermissionMode !== undefined) this.workerPreferences.writePatch({ workerPermissionMode: patch.workerPermissionMode });
    return this.settings();
  }
  resetSettings() { this.guard(); this.collaboration.resetCollaborationSettings(); return this.settingsWire(); }
  markWorkerIdle = (...args: Parameters<Store['markWorkerIdle']>) => this.run(api => api.markWorkerIdle(...args));
  listIdleReleaseCandidates = (...args: Parameters<Store['listIdleReleaseCandidates']>) => this.run(api => api.listIdleReleaseCandidates(...args));
  markIdleReleased = (...args: Parameters<Store['markIdleReleased']>) => this.run(api => api.markIdleReleased(...args));
  touchWorker = (...args: Parameters<Store['touchWorker']>) => this.run(api => api.touchWorker(...args));
  reserveWorkerCreation = (...args: Parameters<Store['reserveWorkerCreation']>) => this.run(api => api.reserveWorkerCreation(...args));
  renewWorkerCreationReservation = (...args: Parameters<Store['renewWorkerCreationReservation']>) => this.run(api => api.renewWorkerCreationReservation(...args));
  releaseWorkerCreationReservation = (...args: Parameters<Store['releaseWorkerCreationReservation']>) => this.run(api => api.releaseWorkerCreationReservation(...args));
  createOrGetTeamForLead = (...args: Parameters<Store['createOrGetTeamForLead']>) => this.run(api => api.createOrGetTeamForLead(...args));
  getTeamByLeadSession = (...args: Parameters<Store['getTeamByLeadSession']>) => this.run(api => api.getTeamByLeadSession(...args));
  getActiveTeamByLead = (...args: Parameters<Store['getActiveTeamByLead']>) => this.run(api => api.getActiveTeamByLead(...args));
  isOrphanedTeamInit = (...args: Parameters<Store['isOrphanedTeamInit']>) => this.run(api => api.isOrphanedTeamInit(...args));
  createActiveTeam = (...args: Parameters<Store['createActiveTeam']>) => this.run(api => api.createActiveTeam(...args));
  markTeamEnded = (...args: Parameters<Store['markTeamEnded']>) => this.run(api => api.markTeamEnded(...args));
  archiveWorkersByTeam = (...args: Parameters<Store['archiveWorkersByTeam']>) => this.run(api => api.archiveWorkersByTeam(...args));
  markWorkersStatusByTeam = (...args: Parameters<Store['markWorkersStatusByTeam']>) => this.run(api => api.markWorkersStatusByTeam(...args));
  reconcileInactiveTeamWorkersForLead = (...args: Parameters<Store['reconcileInactiveTeamWorkersForLead']>) => this.run(api => api.reconcileInactiveTeamWorkersForLead(...args));
  getTeamByWorkerSession = (...args: Parameters<Store['getTeamByWorkerSession']>) => this.run(api => api.getTeamByWorkerSession(...args));
  addOrUpdateWorker = (...args: Parameters<Store['addOrUpdateWorker']>) => this.run(api => api.addOrUpdateWorker(...args));
  updateWorkerIdentity = (...args: Parameters<Store['updateWorkerIdentity']>) => this.run(api => api.updateWorkerIdentity(...args));
  listWorkersByLead = (...args: Parameters<Store['listWorkersByLead']>) => this.run(api => api.listWorkersByLead(...args));
  listWorkersByLeads = (...args: Parameters<Store['listWorkersByLeads']>) => this.run(api => api.listWorkersByLeads(...args));
  getWorkerLink = (...args: Parameters<Store['getWorkerLink']>) => this.run(api => api.getWorkerLink(...args));
  getSessionOrcaRole = (...args: Parameters<Store['getSessionOrcaRole']>) => this.run(api => api.getSessionOrcaRole(...args));
  getRemoteOrcaSession = (...args: Parameters<Store['getRemoteOrcaSession']>) => this.run(api => api.getRemoteOrcaSession(...args));
  updateWorkerStatus = (...args: Parameters<Store['updateWorkerStatus']>) => this.run(api => api.updateWorkerStatus(...args));
  markWorkerIdleIfStatus = (...args: Parameters<Store['markWorkerIdleIfStatus']>) => this.run(api => api.markWorkerIdleIfStatus(...args));
  restoreWorkerDoneIfIdle = (...args: Parameters<Store['restoreWorkerDoneIfIdle']>) => this.run(api => api.restoreWorkerDoneIfIdle(...args));
  removeWorker = (...args: Parameters<Store['removeWorker']>) => this.run(api => api.removeWorker(...args));
  setWorkerFocus = (...args: Parameters<Store['setWorkerFocus']>) => this.run(api => api.setWorkerFocus(...args));
  archiveSingleWorkerSession = (...args: Parameters<Store['archiveSingleWorkerSession']>) => this.run(api => api.archiveSingleWorkerSession(...args));
  setSessionOrcaRole = (...args: Parameters<Store['setSessionOrcaRole']>) => this.run(api => api.setSessionOrcaRole(...args));
  addRemoteWorker = (...args: Parameters<Store['addRemoteWorker']>) => this.run(api => api.addRemoteWorker(...args));
  setWorkerRemoteExecution = (...args: Parameters<Store['setWorkerRemoteExecution']>) => this.run(api => api.setWorkerRemoteExecution(...args));
  saveWorkerRemoteReport = (...args: Parameters<Store['saveWorkerRemoteReport']>) => this.run(api => api.saveWorkerRemoteReport(...args));
  saveRemoteWorkerOpen = (...args: Parameters<Store['saveRemoteWorkerOpen']>) => this.run(api => api.saveRemoteWorkerOpen(...args));
  removeRemoteWorkerOpen = (...args: Parameters<Store['removeRemoteWorkerOpen']>) => this.run(api => api.removeRemoteWorkerOpen(...args));
  listOrphanRemoteWorkerOpens = (...args: Parameters<Store['listOrphanRemoteWorkerOpens']>) => this.run(api => api.listOrphanRemoteWorkerOpens(...args));
  markWorkerRemoteStopConfirmed = (...args: Parameters<Store['markWorkerRemoteStopConfirmed']>) => this.run(api => api.markWorkerRemoteStopConfirmed(...args));
  getWorkerRemoteReleaseState = (...args: Parameters<Store['getWorkerRemoteReleaseState']>) => this.run(api => api.getWorkerRemoteReleaseState(...args));
  markWorkerRemoteReleased = (...args: Parameters<Store['markWorkerRemoteReleased']>) => this.run(api => api.markWorkerRemoteReleased(...args));
  listActiveRemoteWorkers = (...args: Parameters<Store['listActiveRemoteWorkers']>) => this.run(api => api.listActiveRemoteWorkers(...args));
  listUnreleasedEndedRemoteWorkers = (...args: Parameters<Store['listUnreleasedEndedRemoteWorkers']>) => this.run(api => api.listUnreleasedEndedRemoteWorkers(...args));
  getRemoteWorkerByProxySession = (...args: Parameters<Store['getRemoteWorkerByProxySession']>) => this.run(api => api.getRemoteWorkerByProxySession(...args));
  async workerForLead(leadId: string, workerId: string) {
    await this.ready;
    this.guard();
    const db = (await this.options.tasks.database()).getDbClient().drizzle;
    // Release revalidates after archive and on retries. The visible worker list
    // excludes archived sessions; ownership comes from the original team link.
    const [row] = await db.select({ worker: orcaWorkers }).from(orcaWorkers)
      .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
      .where(and(eq(orcaWorkers.id, workerId), eq(orcaTeams.leadSessionId, leadId))).limit(1);
    this.guard();
    return row?.worker ?? null;
  }
  async occupiedSlots(teamId: string) {
    await this.ready; this.guard(); const db = (await this.options.tasks.database()).getDbClient().drizzle;
    const [workers, reservations] = await Promise.all([
      db.select({ id: orcaWorkers.id }).from(orcaWorkers).innerJoin(sessions, eq(sessions.id, orcaWorkers.sessionId))
        .where(and(eq(orcaWorkers.teamId, teamId), eq(sessions.status, 'active'))),
      db.select({ id: orcaWorkerCreationReservations.id }).from(orcaWorkerCreationReservations)
        .where(and(eq(orcaWorkerCreationReservations.teamId, teamId), gt(orcaWorkerCreationReservations.expiresAt, Date.now()))),
    ]);
    this.guard(); return workers.length + reservations.length;
  }
  idleCandidates = (...args: Parameters<Store['listIdleReleaseCandidates']>) => this.listIdleReleaseCandidates(...args);
  markWorkerStatusesByTeam = (...args: Parameters<Store['markWorkersStatusByTeam']>) => this.markWorkersStatusByTeam(...args);
  async flush() { await this.ready; await Promise.all(this.pending); }
  async close() { await this.ready.catch(() => undefined); await Promise.allSettled(this.pending); this.closed = true; }
}
