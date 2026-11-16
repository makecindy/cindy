/**
 * The start admission of a task runtime on this computer (register.ts bootstrapSession's
 * admitLocalRoute): the local model service is made ready, then a start that is not a verified resume
 * of the task's stored route takes the route verdict (a disabled, retired or payment-required route is
 * refused; an implicit source whose native default copy is disabled is rerouted to the enabled copy),
 * and a verified resume only pins an exclusive provider. Moved verbatim out of register.ts so the Node
 * Host admits its runtime starts with the same steps.
 *
 * Ports: the local model service readiness and the profile directory (local-model-runtime/preflight.ts
 * and app.getPath load Electron), the route check (register.ts assertModelRouteUsable; the Host binds
 * its own with its provider listing) and the exclusive-provider pin (model-route-guard-live.ts loads
 * the desktop provider service; the Host binds pinExclusiveSessionProviderWithProviders).
 *
 * The returned function changes `o.providerId` in place when it reroutes or pins, as the closure did;
 * the caller persists it.
 */
import type { AgentKind } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';

import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { shouldApplyExclusiveProviderRerouteLive } from '../maker-host/model-route-guard-catalog.js';
import { isVerifiedSshCodexResume } from '../remote-ssh/codex-model-list.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

export interface LocalRouteAdmissionPorts {
  ensureManagedOllamaReadyForSession: (opts: {
    providerId?: string | null;
    remoteHostId?: string | null;
    userDataDir?: string;
  }) => Promise<void>;
  getUserDataDir: () => string;
  assertModelRouteUsable: (
    agent: AgentKind,
    model: string,
    providerId: string | null,
    remoteHostId?: string | null,
  ) => Promise<string | undefined>;
  pinExclusiveSessionProvider: (
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ) => Promise<string | undefined>;
}

export type LocalRouteAdmissionOpts = Pick<
  MakerSessionCreateOpts,
  'id' | 'agentKind' | 'model' | 'providerId' | 'remoteHostId' | 'resumeSessionId'
>;

export function createLocalRouteAdmission(
  ports: LocalRouteAdmissionPorts,
): (o: LocalRouteAdmissionOpts) => Promise<void> {
  const { ensureManagedOllamaReadyForSession, getUserDataDir, assertModelRouteUsable, pinExclusiveSessionProvider } = ports;
  return async (o: LocalRouteAdmissionOpts): Promise<void> => {
    await ensureManagedOllamaReadyForSession({
      providerId: o.providerId,
      remoteHostId: o.remoteHostId ?? null,
      userDataDir: getUserDataDir(),
    });
    // 停用轴准入(PR #744 review):**新建**会话不得路由到用户停用的模型 / 来源。
    // renderer 选择器已过滤,但 create-session 在 device-link allowlist 内,老控制端
    // 可直接点名 —— main 必须自己裁决。resume 豁免(运行中的会话不打断)只给
    // **经核实的原样续跑**:请求路由与本会话 DB 持久化路由一致才算;resumeSessionId
    // 是调用方可控字段,携带任意非空 id 同时改点停用 model/provider 不能构成绕过
    // (PR #744 review 第十六轮)。读不到会话行(远端新建等)按非豁免走正常裁决。
    // 隐式来源的原生默认落点被停用而有启用替代拷贝时,把会话显式改路由过去(下方
    // persistAndHydrateSessionProvider 会把它落库):实际路由层对隐式来源走原生
    // 默认、不查停用标志,仅放行等于继续用停用拷贝付费。
    if (typeof o.model === 'string' && o.model) {
      let verifiedResume = false;
      if (o.resumeSessionId && typeof o.id === 'string' && o.id) {
        try {
          const [row] = await getDbClient()
            .drizzle.select({ model: sessions.model, providerId: sessions.providerId,
              remoteHostId: sessions.remoteHostId, sdkSessionId: sessions.sdkSessionId, agentKind: sessions.agentKind })
            .from(sessions)
            .where(eq(sessions.id, o.id))
            .limit(1);
          verifiedResume =
            !!row && row.model === o.model && (row.providerId ?? null) === (o.providerId ?? null);
          if (o.agentKind === 'codex' && o.remoteHostId) {
            verifiedResume = isVerifiedSshCodexResume(o, row ? { ...row, agentKind: dbToMakerAgentKind(row.agentKind) } : undefined);
          }
        } catch {
          verifiedResume = false;
        }
      }
      if (!verifiedResume) {
        const reroute = await assertModelRouteUsable(o.agentKind, o.model, o.providerId ?? null, o.remoteHostId);
        if (reroute && shouldApplyExclusiveProviderRerouteLive(o.providerId)) {
          o.providerId = reroute;
        }
      } else if (!(o.agentKind === 'codex' && o.remoteHostId) && shouldApplyExclusiveProviderRerouteLive(o.providerId)) {
        const pin = await pinExclusiveSessionProvider(o.agentKind, o.model, o.providerId ?? null);
        if (pin) o.providerId = pin;
      }
    }
  };
}
