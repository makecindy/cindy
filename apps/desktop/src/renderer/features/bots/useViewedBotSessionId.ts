import { useMatch } from 'react-router-dom';

import { canonicalBotSessionId, useBotProfiles } from './botStore';
import { useRemoteBots } from './useRemoteBots';

/**
 * 当前主区域正在看的伙伴会话。侧栏的通知 owner(任务侧栏)用它判断「正在看」:
 * 用户注视着的伙伴回合完成时不记未读、不发系统通知 —— 与原伙伴侧栏的口径一致。
 * 侧栏渲染在路由元素之外,用 useMatch 而不是 useParams 读取路径。
 */
export function useViewedBotSessionId(): string | undefined {
  const sessionMatch = useMatch('/bots/:botId/session/:sessionId');
  const historyMatch = useMatch('/bots/:botId/history/:sessionId');
  const remoteMatch = useMatch('/bots/remote/:deviceId/:botId');
  const botMatch = useMatch('/bots/:botId');
  const bots = useBotProfiles();
  const remoteBots = useRemoteBots();
  const explicit = sessionMatch?.params.sessionId ?? historyMatch?.params.sessionId;
  if (explicit) return explicit;
  if (remoteMatch) {
    const { deviceId, botId } = remoteMatch.params;
    return remoteBots.find((bot) => bot.deviceId === deviceId && bot.id === botId)?.sessionId ?? undefined;
  }
  const botId = botMatch?.params.botId;
  if (!botId) return undefined;
  const bot = bots.find((candidate) => candidate.id === botId);
  return bot ? canonicalBotSessionId(bot) : undefined;
}
