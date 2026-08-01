/**
 * main/im/telegram/sessionAuth.ts
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 的"新会话默认路由是否有可用凭证"检查 — 与
 * discord/sessionAuth.ts 同构: 检查的是模型供应商凭证(gateway key /
 * provider key / agent 登录态), 与 bot token 本身无关。设置页用它在
 * 连接卡上提示"模型没配好, bot 连上了也回不了话"。
 */

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

export const TELEGRAM_SESSION_AUTH_CHECK_CHANNEL = 'telegramBot:check-session-auth';

type AuthRow = Pick<ResolvedImSessionDefaults, 'agentKind' | 'model' | 'providerId'>;

type AuthCheckFn = (
  row: AuthRow,
  providerSnapshot: ProviderView[] | null | undefined,
  deps: ImAuthCheckDeps,
) => Promise<{ ok: boolean; missing: ImAuthMissing | null }>;

export interface TelegramSessionAuthCheckResult {
  ok: boolean;
  missing: ImAuthMissing | null;
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  providerLabel: string | null;
}

export interface TelegramSessionAuthCheckDeps {
  resolveDefaults?: typeof resolveImSessionDefaults;
  checkAuth?: AuthCheckFn;
  authDeps?: ImAuthCheckDeps;
}

const log = createLogger('main:im:telegram:session-auth');
let registered = false;

export async function checkTelegramSessionAuth(
  config: ImOrchestratorConfig,
  deps: TelegramSessionAuthCheckDeps = {},
): Promise<TelegramSessionAuthCheckResult> {
  const resolveDefaults = deps.resolveDefaults ?? resolveImSessionDefaults;
  const checkAuth = deps.checkAuth ?? checkImRouteAuth;
  const cached = withProviderSnapshotCache(deps.authDeps ?? createDefaultAuthDeps());
  const defaults = await resolveDefaults(config, undefined, 'telegram');
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

export function registerTelegramSessionAuthIpc(config: ImOrchestratorConfig): void {
  if (registered) return;
  registered = true;
  ipcMain.handle(TELEGRAM_SESSION_AUTH_CHECK_CHANNEL, async (event) => {
    // 同 discord 版注释: 读连接态会放行本机绑定自愈, 只有设置页调用, 用会抛的守卫。
    assertTrustedAppRendererEvent(event);
    return checkTelegramSessionAuth(config);
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
