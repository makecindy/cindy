/**
 * main/im/shared/ambientReplyJudgeRuntime.ts
 * ---------------------------------------------------------------------------
 * ambientReplyJudge 的桌面端装配: 判定走共享辅助模型链(requestUtilityText), 伙伴
 * 的名字与简介从 bot_profiles 读。adapter 只拿注入的函数, 单测不碰这里。
 */

import { eq } from 'drizzle-orm';

import { getDbClient } from '../../localDb/client/current';
import { botProfiles } from '../../localDb/schema';
import { getMaker } from '../../maker-host/index';
import { requestUtilityText } from '../../utility-model/oneShotCandidates';
import { createAmbientReplyJudge, type AmbientReplyJudge } from './ambientReplyJudge';

let shared: AmbientReplyJudge | null = null;

/** 进程内一份判定器(无状态, 每次调用自己带预算)。 */
export function getAmbientReplyJudge(): AmbientReplyJudge {
  if (!shared) {
    shared = createAmbientReplyJudge((prompt, opts) => requestUtilityText(getMaker(), prompt, opts));
  }
  return shared;
}

/** 伙伴自有连接: 判定提示里的「我是谁」= 伙伴名字 + 简介(不是整份 SOUL)。 */
export function describeCompanionForAmbientJudge(
  botId: string,
): () => Promise<{ name: string; description: string }> {
  return async () => {
    const [row] = await getDbClient()
      .drizzle.select({ displayName: botProfiles.displayName, description: botProfiles.description })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    return { name: row?.displayName ?? '', description: row?.description ?? '' };
  };
}
