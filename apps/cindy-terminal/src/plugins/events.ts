import { eq } from 'drizzle-orm';
import * as schema from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { NativePluginHost } from '@cindy/plugin-runtime';
import type { InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { GhostCardRow } from '@cindy/plugin-runtime/cardService';
import { GhostSubscriptionGateway } from '@cindy/app-runtime/subscriptionGateway';
import { createGhostSessionEvents } from '@cindy/app-runtime/ghostSessionEvents';
import { createGhostAssistantReply } from '@cindy/app-runtime/ghostAssistantReply';

export interface TerminalPluginEventHost {
  getDbClient(): DbClient;
  updateMessageContent(sessionId: string, clientId: string, text: string): Promise<unknown>;
  saveCard(row: GhostCardRow): Promise<void>;
  publish(channel: string, payload: unknown): void;
  assertCurrent(): void;
  logger: DbLogger;
}

/** The original subscription, eligibility, turn and reply handlers. Only pipe
 * delivery and the owner lifetime differ from the Electron host. */
export class TerminalPluginEvents {
  readonly gateway: GhostSubscriptionGateway;
  readonly sessions;
  readonly replies;
  private closed = false;
  private readonly instances = new Set<string>();
  constructor(private readonly native: NativePluginHost, private readonly host: TerminalPluginEventHost) {
    const current = () => {
      try { host.assertCurrent(); return !this.closed; } catch { return false; }
    };
    const availableGhosts = () => {
      host.assertCurrent();
      return this.closed ? [] : native.list().filter(ghost => ghost.approval.state === 'approved');
    };
    const getDbClient = () => { host.assertCurrent(); return host.getDbClient(); };
    const getGhostOwnerPushStamp = () => this;
    const isGhostOwnerStampCurrent = (stamp: unknown) => stamp === this && current();
    this.gateway = new GhostSubscriptionGateway({
      listGhosts: availableGhosts,
      isRunning: id => current() && native.runtime?.stateOf(id) === 'running',
      wake: async ghost => {
        host.assertCurrent();
        if (!native.runtime) throw new Error('PLUGIN_RUNTIME_UNAVAILABLE');
        const result = await native.runtime.spawn(ghost);
        if (!result.ok) throw new Error(result.reason);
        if (!await native.runtime.waitUntilRunning(installedGhostStoragePart(ghost))) throw new Error('PLUGIN_BRIDGE_NOT_READY');
        host.assertCurrent();
      },
      sendToGhost: (id, payload) => {
        host.assertCurrent();
        if (this.closed || !native.web?.send(id, payload)) throw new Error('PLUGIN_PIPE_UNAVAILABLE');
      },
      now: Date.now,
      ownerScope: { capture: getGhostOwnerPushStamp, isCurrent: isGhostOwnerStampCurrent, isStable: current },
      resolveMessageHookContext: async id => {
        const [row] = await getDbClient().drizzle.select({ model: schema.sessions.model }).from(schema.sessions).where(eq(schema.sessions.id, id)).limit(1);
        host.assertCurrent();
        return { model: row?.model ?? undefined };
      },
      onHookFused: (ghost, stamp) => {
        if (isGhostOwnerStampCurrent(stamp)) host.publish('ghosts:hook-fused', { ghostId: ghost.manifest.id, name: ghost.manifest.name });
      },
      log: host.logger,
    });
    const common = { availableGhosts, getDbClient, getGhostOwnerPushStamp, isGhostOwnerStampCurrent,
      getGhostSubscriptionGateway: () => this.gateway, log: host.logger };
    this.sessions = createGhostSessionEvents(common);
    this.replies = createGhostAssistantReply({ ...common,
      isGhostEligibleSession: this.sessions.isGhostEligibleSession,
      updateMessageContent: host.updateMessageContent,
      upsertGhostCard: host.saveCard,
      broadcastGhostWindowPush: (channel, payload, stamp) => {
        if (stamp === undefined ? current() : isGhostOwnerStampCurrent(stamp)) host.publish(channel, payload);
      },
    });
  }
  reconcile(ghosts: InstalledGhost[] = this.native.list()) {
    const active = new Set(ghosts.filter(ghost => ghost.enabled && ghost.approval.state === 'approved').map(installedGhostStoragePart));
    for (const id of this.instances) if (!active.has(id)) this.gateway.dropGhost(id);
    this.instances.clear();
    for (const id of active) this.instances.add(id);
  }
  close() {
    this.closed = true;
    for (const id of this.instances) this.gateway.dropGhost(id);
    this.instances.clear();
  }
}
