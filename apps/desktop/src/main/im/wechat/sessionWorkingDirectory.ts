// The picker selects a directory for one existing local task. The channel default
// and the bot/peer route remain independent from that task's execution directory.
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { updateSessionInDb } from '../../localDb/ipc/sessions';
import { throwIpcError } from '../../utils/ipcValidate';
import { captureChannelAccount } from '../shared/openChannelSession';
import { normalizeSelectedDirectory } from './channelSettings';

export async function chooseWechatSessionDirectory(
  sessionId: string,
  pick: () => Promise<string | undefined>,
  isBusy: () => boolean,
): Promise<boolean> {
  const assertCurrent = captureChannelAccount();
  assertCurrent();
  const db = getDbClient().drizzle;
  const selected = await pick();
  if (!selected) return false;
  assertCurrent();
  const workingDir = normalizeSelectedDirectory(selected);
  const assertIdle = () => {
    if (isBusy()) throwIpcError('SESSION_RUNNING', 'Wait for the current response to finish.');
  };
  await updateSessionInDb(sessionId, { workingDir }, undefined, {
    assertCurrent,
    async beforeUpdate() {
      const [row] = await db.select({
        source: sessions.source, status: sessions.status, remoteHostId: sessions.remoteHostId,
        agentDeviceId: sessions.agentDeviceId,
      }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (row?.source !== 'wechat' || row.status !== 'active' || row.remoteHostId || row.agentDeviceId) {
        throwIpcError('PRECONDITION_FAILED', 'Expected an active local WeChat task.');
      }
      assertIdle();
    },
    beforeWrite: assertIdle,
    requireResumeTranscript: true,
  });
  return true;
}
