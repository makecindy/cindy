import { and, eq, inArray } from 'drizzle-orm';
import { teammateFolderOfProjectPath } from '@cindy/maker-shared/teammate-project';
import { TEAMMATE_SCHEDULED_REPORT_PREFIX } from '@cindy/maker-shared/botTimeline';
import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { markSessionNeedsAttention } from '../appBadgeService.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { botProfiles, botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { resolveBotCanonicalSession } from '../maker-ipc/botCanonicalSessionRegistry.js';
import { resolveOwnTeammateProject } from './ownTeammateProject.js';
import { withScheduleLock } from './scheduleLock.js';
import type { MakerScheduleRunnerDeps } from './runner.js';

type PublishReport = NonNullable<MakerScheduleRunnerDeps['publishTeammateReport']>;

export function createTeammateScheduledReportPublisher(
  isEnabled: (workingDir: string, configId: string) => Promise<boolean>,
): PublishReport {
  return async ({ schedule, run, report, signal, assertCurrent, ownerScope }) => {
    const { workingDir, projectConfigId } = schedule;
    if (schedule.source !== 'project' || !workingDir || !projectConfigId ||
      !teammateFolderOfProjectPath(workingDir)) return false;

    assertCurrent();
    const project = await resolveOwnTeammateProject(workingDir);
    if (!project?.botId || !await isEnabled(workingDir, projectConfigId)) return false;
    assertCurrent();
    if (!report.trim()) return true;
    const botId = project.botId;
    const clientId = TEAMMATE_SCHEDULED_REPORT_PREFIX + run.id;

    // Teammate lifecycle changes may wait for the scheduler to settle. Use a
    // run-specific lock so a report cannot hold up a pause or deletion.
    return withScheduleLock(clientId, signal, async () => {
      assertCurrent();
      const db = getDbClient().drizzle;
      const recipient = await resolveBotCanonicalSession(botId);
      if (recipient.status !== 'resolved') throw new Error('Teammate main chat is unavailable');
      const target = recipient.sessionId;
      if (target === run.sessionId) return false;
      const assertCanPublish = async () => {
        assertCurrent();
        const current = await resolveBotCanonicalSession(botId);
        const [session] = await db.select({ status: sessions.status, source: sessions.source })
          .from(sessions).where(eq(sessions.id, target)).limit(1);
        const [profile] = await db.select({ status: botProfiles.status })
          .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
        if (current.sessionId !== target || session?.source !== 'bot' || session.status !== 'active' ||
          (profile?.status !== 'active' && profile?.status !== 'error') || isCompanionShadowed(botId)) {
          throw new Error('Teammate main chat is unavailable');
        }
        if (!await isEnabled(workingDir, projectConfigId)) throw new Error('Report delivery was disabled');
        assertCurrent();
      };

      // Main chats can be replaced. An already written report stays a receipt in
      // its original chat, even if the owner has cleared that history.
      const [existing] = await db.select({ id: messages.id }).from(messages)
        .innerJoin(botSessionLinks, eq(botSessionLinks.sessionId, messages.sessionId))
        .where(and(eq(botSessionLinks.botId, botId), inArray(botSessionLinks.role, ['canonical', 'history']),
          eq(messages.role, 'assistant'), eq(messages.clientId, clientId))).limit(1);
      assertCurrent();
      if (existing) return true;

      await createMessage(target, {
        clientId,
        role: 'assistant',
        content: report,
        agentMeta: {
          turnCompleted: true,
          origin: { kind: 'scheduler', scheduleId: schedule.id, scheduleName: schedule.name, runId: run.id },
        },
      }, {
        broadcastOwnerScope: ownerScope,
        beforePublish: assertCanPublish,
        shouldBroadcast: () => {
          try { assertCurrent(); return !isCompanionShadowed(botId); }
          catch { return false; }
        },
      });
      // Publication is already durable. A later owner change only suppresses
      // attention, and does not turn a completed write into a second attempt.
      try {
        assertCurrent();
        if (!isCompanionShadowed(botId)) markSessionNeedsAttention(target);
      } catch { /* A change after durable publication does not invalidate the receipt. */ }
      return true;
    });
  };
}
