import { eq } from 'drizzle-orm';
import { sessions } from '@cindy/runtime-db/schema';
import { effectiveSourceIdForModel, findCatalogModel } from '@cindy/model-providers';
import { dbToMakerAgentKind } from '@cindy/maker-shared/agent-kind-conversion';
import { lookupVerifiedContextWindow } from '@cindy/im-runtime/contextOverflowRollover';
import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';
import type { SessionModelSelectionHost } from './sessionModelSelectionHost.js';
import type { PendingCredentialSwitchDeps } from './pendingCredentialSwitch.js';

export function createPendingCredentialSwitchRegistration(host: Pick<SessionModelSelectionHost, 'getSessionDbAgentKind' | 'getDbClient' | 'captureSessionRuntimeControlOwnerEpoch' | 'getSessionProvider' | 'maker' | 'pendingCredentialSwitchHolder'>): SessionModelSelectionHost['registerPendingCredentialSwitchForSession'] {
 const {getSessionDbAgentKind, getDbClient, captureSessionRuntimeControlOwnerEpoch, getSessionProvider} = host;
 return async (sessionId, target) => {
  const service = host.pendingCredentialSwitchHolder;
  if (!service) {
    throw new Error('Pending credential switch service is not initialized');
  }
  // 捕获会话 agent:deferred 切换在收口时刻要重过停用裁决(期间目标可能被停用,
  // PR #744 review 第七轮);读不到(会话行缺失)则登记不带 agentKind = 收口不裁决。
  const dbAgentKind = getSessionDbAgentKind(sessionId);
  // 捕获切换前的运行路由:model 用 live handle(热切过未落库时比 DB 权威),来源用
  // provider store;effort / fast 无 live getter,从 DB 行读 —— renderer 在收到
  // deferred 结果**之后**才落盘请求值,本函数在 IPC 回包之前执行,此刻行里仍是
  // 切换前值,无竞态。目标在等待期间被全停且目录无启用兜底时,收口按整套
  // previousRoute 回滚(model/provider/effort/fast 一致成对,第十六、十八轮)。
  // deferred 场景会话正在跑 turn,live handle 必在;取不到就不带 = 无从回滚。
  const live = host.maker.getSession(sessionId);
  let prevRow: {
    model: string | null;
    effort: string | null;
    fastMode: boolean | 'ultrafast' | null;
    providerId: string | null;
  } | null = null;
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        model: sessions.model,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
        providerId: sessions.providerId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    prevRow = row ?? null;
  } catch {
    prevRow = null;
  }
  const prevModel = live?.model ?? prevRow?.model ?? null;
  service.register(sessionId, {
    ...target,
    ownerEpoch: captureSessionRuntimeControlOwnerEpoch(),
    ...(dbAgentKind ? { agentKind: dbToMakerAgentKind(dbAgentKind) } : live?.agentKind ? { agentKind: live.agentKind } : {}),
    ...(prevModel
      ? {
          previousRoute: {
            model: prevModel,
            providerId: getSessionProvider(sessionId) ?? prevRow?.providerId ?? null,
            ...(prevRow?.effort ? { effort: prevRow.effort } : {}),
            ...(prevRow?.fastMode != null ? { fastMode: prevRow.fastMode } : {}),
          },
        }
      : {}),
  });

 };
}

export function createPendingCredentialSwitchPersistence(host: Pick<SessionModelSelectionHost, 'sessionRuntimeControlOwnerEpochMatches' | 'getDbClient' | 'getSessionDbAgentKind' | 'getDesktopProviderService' | 'getActiveCatalog' | 'resolveSessionRuntimeAxes' | 'resolveConfiguredContextWindow' | 'setSessionEffort' | 'setSessionFastMode' | 'broadcastSessionPatched' | 'pendingCredentialSwitchHolder'>): NonNullable<PendingCredentialSwitchDeps['persistRoute']> {
 const {sessionRuntimeControlOwnerEpochMatches, getDbClient, getSessionDbAgentKind, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeAxes, resolveConfiguredContextWindow, setSessionEffort, setSessionFastMode, broadcastSessionPatched} = host;
 return async (sessionId, route) => {
      const ownerEpoch = host.pendingCredentialSwitchHolder?.get(sessionId)?.ownerEpoch;
      const assertPendingOwner = () => {
        if (ownerEpoch && !sessionRuntimeControlOwnerEpochMatches(ownerEpoch)) {
          throw new Error('pending model switch account changed');
        }
      };
      assertPendingOwner();
      const pendingDb = getDbClient();
      const agentKind = getSessionDbAgentKind(sessionId);
      const [desiredRow] = await pendingDb
        .drizzle.select({
          model: sessions.model,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      assertPendingOwner();
      const finalModel = route.model ?? desiredRow?.model ?? null;
      const previousRoute = host.pendingCredentialSwitchHolder?.get(sessionId)?.previousRoute;
      const restoringPreviousRoute =
        !!route.model &&
        route.model === previousRoute?.model &&
        route.providerId === previousRoute.providerId;
      let finalEffort = restoringPreviousRoute && route.effort && isSupportedRuntimeEffort(route.effort)
        ? route.effort
        : isSupportedRuntimeEffort(desiredRow?.effort)
          ? desiredRow.effort
          : !desiredRow && route.effort && isSupportedRuntimeEffort(route.effort)
            ? route.effort
            : null;
      let finalFastMode = restoringPreviousRoute && route.fastMode !== undefined
        ? route.fastMode
        : desiredRow
          ? desiredRow.fastMode ?? false
          : route.fastMode ?? false;
      if (agentKind && finalModel) {
        const runtimeAgentKind = dbToMakerAgentKind(agentKind);
        const providers = await getDesktopProviderService().listProviders({
          allowSideEffects: false,
          catalog: getActiveCatalog(),
        });
        const finalProviderId = route.providerId ?? effectiveSourceIdForModel(
          providers,
          null,
          finalModel,
          runtimeAgentKind,
        );
        const finalProvider = providers.find((provider) => provider.id === finalProviderId);
        const catalogModel = findCatalogModel(finalProvider, finalModel, runtimeAgentKind, {
          exact: true,
        });
        if (catalogModel) {
          const axes = resolveSessionRuntimeAxes({
            model: catalogModel,
            effort: finalEffort,
            fastMode: finalFastMode,
            effortExplicit: false,
            fastExplicit: false,
          });
          if (axes.ok) {
            finalEffort = axes.effort;
            finalFastMode = axes.fastMode;
          }
        }
      }
      const patch: Record<string, unknown> = {
        providerId: route.providerId,
        effort: finalEffort,
        fastMode: finalFastMode,
      };
      if (route.model) patch.model = route.model;
      if (route.model && agentKind) {
        const verifiedWindow = lookupVerifiedContextWindow(
          (resolvedAgentKind, modelId, pid) =>
            resolveConfiguredContextWindow(
              getActiveCatalog(),
              dbToMakerAgentKind(resolvedAgentKind || agentKind),
              pid,
              modelId,
            ),
          route.model,
          route.providerId ?? null,
          dbToMakerAgentKind(agentKind),
        );
        if (verifiedWindow) patch.contextWindow = verifiedWindow;
      }
      assertPendingOwner();
      await pendingDb.drizzle.update(sessions).set(patch).where(eq(sessions.id, sessionId));
      assertPendingOwner();
      setSessionEffort(sessionId, finalEffort);
      setSessionFastMode(sessionId, finalFastMode);
      broadcastSessionPatched(sessionId, patch);
    };
}
