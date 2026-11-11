/**
 * 失败时按任务实际路由读取定位信息；目录不可读也保留任务名和模型 ID。
 */
import { eq } from 'drizzle-orm';
import { actualSourceIdForModel } from '@cindy/model-providers';

import { dbToMakerAgentKind } from '../../../shared/agentKindConversion.js';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { getSessionProvider, hasSessionProvider } from '../../maker-host/session-provider-store';

export async function resolveSessionErrorContext(sessionId: string): Promise<{
  providerLabel?: string;
  modelLabel?: string;
  taskLabel?: string;
}> {
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
        title: sessions.title,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return {};
    const context = {
      taskLabel: `${row.title || '任务'}（${sessionId.slice(0, 8)}）`,
      ...(row.model ? { modelLabel: row.model } : {}),
    };
    if (!row.model) return context;
    const providers = await getDesktopProviderService()
      .listProviders({ allowSideEffects: false })
      .catch(() => []);
    // 内存里的来源比库里新(本轮刚切过、尚未落库时以运行中的为准)。
    const selected = hasSessionProvider(sessionId) ? getSessionProvider(sessionId) : row.providerId;
    // 「运行中会话」口径(与实际路由层 provider-route 一致): 停用 / 退役的拷贝仍算数 ——
    // 运行中的任务不因停用改道, 说明里的供应商必须是真正报额度错的那一家, 不能是
    // 新路由口径(effectiveSourceIdForModel)过滤后落到的替代来源。
    const providerId = actualSourceIdForModel(
      providers,
      selected?.trim() || null,
      row.model,
      dbToMakerAgentKind(row.agentKind),
    );
    const provider = providers.find((provider) => provider.id === providerId);
    const model = provider?.models[dbToMakerAgentKind(row.agentKind)]?.find(
      (entry) => entry.id === row.model,
    );
    return { ...context, modelLabel: model?.name || row.model, providerLabel: provider?.name };
  } catch {
    return {};
  }
}
