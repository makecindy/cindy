/**
 * 新任务选中插件模型时的两步，普通发送与新建目标共用：建任务前问一次插件，首条消息落库后写一行说明。
 * 插件只能从已连接的模型里选(主进程校验)；没回应或调用失败都返回 null / kept，沿用用户原来的模型。
 */
import type { PluginModelRouteNote } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GhostModelRoute, GhostPickerModel, GhostStartTaskRouteResult } from '../../../shared/ghost';

const log = createLogger('plugin-model-route');

const NO_PLUGIN_MODELS: GhostPickerModel[] = [];

/** 选择器里的插件模型。取不到就是没有，选择器和没装插件时一样。 */
export function usePluginModels(enabled: boolean): GhostPickerModel[] {
  const { i18n } = useTranslation();
  const [models, setModels] = useState<GhostPickerModel[]>(NO_PLUGIN_MODELS);
  useEffect(() => {
    if (!enabled) {
      setModels(NO_PLUGIN_MODELS);
      return;
    }
    let alive = true;
    const refresh = () => {
      window.electronAPI.ghosts.listPickerModels()
        .then((list) => { if (alive) setModels(list); })
        .catch((err: unknown) => {
          log.warn('plugin models unavailable', err);
          if (alive) setModels(NO_PLUGIN_MODELS);
        });
    };
    refresh();
    // 插件装上、更新、启停或发布新列表时都会广播。
    const off = window.electronAPI.ghosts.onChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [enabled, i18n.language]);
  return models;
}

export async function askPluginModelRoute(
  model: GhostPickerModel,
  text: string,
  attachmentCount: number,
  base: { agentKind: GhostModelRoute['agentKind']; model: string; providerId?: string | null; effort?: string | null },
): Promise<GhostStartTaskRouteResult | null> {
  try {
    return await window.electronAPI.ghosts.routeNewTask(model.pluginId, {
      modelId: model.id,
      text,
      attachmentCount,
      route: {
        agentKind: base.agentKind,
        model: base.model,
        providerId: base.providerId ?? '',
        ...(base.effort ? { effort: base.effort } : {}),
      },
    });
  } catch (err) {
    log.warn('plugin model route failed', err);
    return null;
  }
}

/** 首条消息由 main 在开跑时才落库：等到后把说明定在它之后 1ms，排在首条消息下面、回复上面；等不到就按当前时间写。 */
export function writePluginModelRouteNote(sessionId: string, result: GhostStartTaskRouteResult | null): void {
  if (!result) return;
  const note: PluginModelRouteNote = result.outcome === 'routed'
    ? {
        pluginName: result.pluginName,
        outcome: 'routed',
        modelName: result.modelName,
        ...(result.route.effort ? { effort: result.route.effort } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      }
    : { pluginName: result.pluginName, outcome: 'kept', modelName: result.modelName, why: result.why };
  const { messages } = window.electronAPI.localDb;
  void (async () => {
    let createdAt: number | undefined;
    for (let attempt = 0; attempt < 40 && createdAt === undefined; attempt += 1) {
      const rows = await messages.list(sessionId, { limit: 10 }).catch(() => null);
      const user = Array.isArray(rows)
        ? (rows as Array<{ role?: unknown; createdAt?: unknown }>).find((row) => row.role === 'user')
        : undefined;
      const userAt = typeof user?.createdAt === 'string' ? Date.parse(user.createdAt) : Number.NaN;
      if (Number.isFinite(userAt)) createdAt = userAt + 1;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await messages.create(sessionId, {
      clientId: `plugin-model-route:${sessionId}`,
      role: 'assistant',
      content: '',
      agentMeta: { pluginModelRoute: note },
      ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    });
  })().catch((err: unknown) => log.warn('plugin route note failed', err));
}
