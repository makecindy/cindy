import { isCompanionShadowed } from '../companion-cloud/homes';
import { createHash } from 'node:crypto';
import { formatTaskTopicTitle } from '@cindy/maker-shared/session-title';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current';
import { botProfiles, sessions } from '../localDb/schema';
import { ensureBotChannelLaneSession } from '../localDb/ipc/bots';
import { captureChannelAccount } from '../im/shared/openChannelSession';
import { throwIpcError } from '../utils/ipcValidate';

/** Official transports already authenticate the connected principal (X, and the bound owner elsewhere). */
export async function requireXCompanion(botId: string): Promise<void> {
  const [profile] = await getDbClient().drizzle.select({ status: botProfiles.status })
    .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (profile?.status !== 'active' || isCompanionShadowed(botId)) throwIpcError('INVALID_PARAMS', 'Companion is unavailable');
}

const OFFICIAL_COMPANION_LABEL: Record<string, string> = {
  x: 'X', slack: 'Slack', telegram: 'Telegram', feishu: '飞书', discord: 'Discord',
};

/**
 * 官方渠道交给伙伴时这条外部会话落进伙伴的哪条隐藏专线。官方机器人只把已绑定主人本人的消息派到
 * 这台电脑(群里谁 @ 就派给谁自己的电脑), 所以这里都是主人的轮次; 每个外部会话(私聊 / 群 / 话题 /
 * X 公开串)各一条专线, 不复用伙伴的主对话(主对话只属于桌面与个人机器人的私聊)。
 */
export async function resolveOfficialCompanionTarget(provider: string, botId: string, externalKey: string, subject = '') {
  const assertAccount = captureChannelAccount();
  await requireXCompanion(botId);
  assertAccount();
  // Hash the full transport key (including its principal/thread scope), not a truncated id.
  const key = createHash('sha256').update(externalKey).digest('hex');
  const title = formatTaskTopicTitle(subject, OFFICIAL_COMPANION_LABEL[provider] ?? provider);
  const lane = await ensureBotChannelLaneSession({ botId, routeKey: `im:${provider}:official:${key}`, title });
  if (!lane.ok) throw new Error(lane.message);
  assertAccount();
  const [row] = await getDbClient().drizzle.select({ workingDir: sessions.workingDir })
    .from(sessions).where(eq(sessions.id, lane.sessionId)).limit(1);
  assertAccount();
  if (!row?.workingDir) throw new Error('Companion workspace is unavailable');
  return { sessionId: lane.sessionId, workingDir: row.workingDir, ...(lane.created ? { initialTopicTitle: title } : {}) };
}

/** Public X threads never reuse the private canonical conversation (route keys unchanged). */
export function resolveXCompanionTarget(botId: string, externalKey: string, subject = '') {
  return resolveOfficialCompanionTarget('x', botId, externalKey, subject);
}
