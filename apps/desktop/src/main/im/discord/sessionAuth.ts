import { ipcMain } from 'electron';

import type { AgentKind } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';

import { createLogger } from '../../logger';
import { getMaker } from '../../maker-host';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { hasCustomProviderKey } from '../../maker-host/provider-route';
import {
  resolveImSessionDefaults,
  type ResolvedImSessionDefaults,
} from '../defaultSessionSettings';
import { readXdGatewayApiKey } from '../shared/apiKey';
import { checkImRouteAuth, type ImAuthCheckDeps, type ImAuthMissing } from '../shared/authCheck';
import type { ImOrchestratorConfig } from '../shared/types';

export const DISCORD_SESSION_AUTH_CHECK_CHANNEL = 'discordBot:check-session-auth';

type AuthRow = Pick<ResolvedImSessionDefaults, 'agentKind' | 'model' | 'providerId'>;

type AuthCheckFn = (
  row: AuthRow,
  providerSnapshot: ProviderView[] | null | undefined,
  deps: ImAuthCheckDeps,
) => Promise<{ ok: boolean; missing: ImAuthMissing | null }>;

export interface DiscordSessionAuthCheckResult {
  ok: boolean;
  missing: ImAuthMissing | null;
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  providerLabel: string | null;
}

export interface DiscordSessionAuthCheckDeps {
  resolveDefaults?: typeof resolveImSessionDefaults;
  checkAuth?: AuthCheckFn;
  authDeps?: ImAuthCheckDeps;
}

const log = createLogger('main:im:discord:session-auth');
let registered = false;

export async function checkDiscordSessionAuth(
  config: ImOrchestratorConfig,
  deps: DiscordSessionAuthCheckDeps = {},
): Promise<DiscordSessionAuthCheckResult> {
  const resolveDefaults = deps.resolveDefaults ?? resolveImSessionDefaults;
  const checkAuth = deps.checkAuth ?? checkImRouteAuth;
  const cached = withProviderSnapshotCache(deps.authDeps ?? createDefaultAuthDeps());
  const defaults = await resolveDefaults(config, undefined, 'discord');
  const row: AuthRow = {
    agentKind: defaults.agentKind,
    model: defaults.model,
    providerId: defaults.providerId,
  };
  const auth = await checkAuth(row, undefined, cached.authDeps);
  const providers = await cached.loadProviderSnapshot();
  const providerLabel = row.providerId
    ? (providers?.find((provider) => provider.id === row.providerId)?.name ?? null)
    : null;

  return {
    ok: auth.ok,
    missing: auth.missing,
    agentKind: row.agentKind,
    model: row.model,
    providerId: row.providerId,
    providerLabel,
  };
}

export function registerDiscordSessionAuthIpc(config: ImOrchestratorConfig): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(DISCORD_SESSION_AUTH_CHECK_CHANNEL, async (event) => {
    // 这条通道读连接态时会放行本机绑定自愈(写绑定文件、协调 Codex 凭证硬链、发起带凭证的
    // Anthropic 清单发现),不该被子 frame / WebView 触发。只有设置页会调它,不在 device-link
    // allowlist 里,可以直接用会抛的守卫(PR #548 review)。
    assertTrustedAppRendererEvent(event);
    return checkDiscordSessionAuth(config);
  });
}

function createDefaultAuthDeps(): ImAuthCheckDeps {
  return {
    readXdGatewayApiKey,
    hasCustomProviderKey,
    getAgentAuthState: (agentKind) => getMaker().getAgentAuthState(agentKind),
    listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: true }),
    warn: (message) => log.warn(message),
  };
}

function withProviderSnapshotCache(authDeps: ImAuthCheckDeps): {
  authDeps: ImAuthCheckDeps;
  loadProviderSnapshot(): Promise<ProviderView[] | null>;
} {
  let providerSnapshot: ProviderView[] | null = null;
  let providerSnapshotPromise: Promise<ProviderView[]> | null = null;

  const listProviders = async (): Promise<ProviderView[]> => {
    providerSnapshotPromise ??= authDeps.listProviders();
    providerSnapshot = await providerSnapshotPromise;
    return providerSnapshot;
  };

  return {
    authDeps: {
      ...authDeps,
      listProviders,
    },
    async loadProviderSnapshot() {
      try {
        await listProviders();
      } catch {
        return null;
      }
      return providerSnapshot;
    },
  };
}
