import type {
  BuiltinRefreshableProviderId,
  ProviderModelAutoRefreshTrigger,
} from '../../shared/providerModelRefresh.js';

interface AccountProviderModelRefreshLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AccountProviderModelRefreshDeps {
  restartCodex(): Promise<void>;
  shutdownCodexEnvironment(): Promise<void>;
  loadXaiLkg(): Promise<boolean>;
  refreshProviderModels(
    trigger: ProviderModelAutoRefreshTrigger,
    providerIds?: readonly BuiltinRefreshableProviderId[],
  ): Promise<void>;
  log: AccountProviderModelRefreshLogger;
}

/**
 * 账号 DB 就绪后的模型发现任务。
 *
 * LocalDbGate 不再等待它，因此现有任务列表可以先显示；Desktop Maker 的创建 /
 * 启动入口另外等待 account provider readiness barrier，确保 Anthropic 清单回来前
 * 不会先按 XD 默认路由建出 provider_id=NULL 的 Opus 任务。其余来源仍强制
 * 刷新且纳入同一账号 barrier，防止切号后旧账号的迟到结果覆盖全局目录；各步骤保持
 * best-effort，失败会留日志，不会把可用的本地 DB 误判成初始化失败。
 */
export async function resetAccountProviderRuntimes(
  deps: Pick<
    AccountProviderModelRefreshDeps,
    'restartCodex' | 'shutdownCodexEnvironment' | 'log'
  >,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) return;
  let codexRestarted = false;
  try {
    await deps.restartCodex();
    codexRestarted = true;
  } catch (error) {
    deps.log.warn('restartCodexAfterAuthModeChange on account switch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!shouldContinue() || !codexRestarted) return;
  try {
    await deps.shutdownCodexEnvironment();
  } catch (error) {
    deps.log.warn('shutdownCodexEnvironment on account switch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function discoverAccountProviderModels(
  deps: Pick<AccountProviderModelRefreshDeps, 'loadXaiLkg' | 'refreshProviderModels' | 'log'>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  if (!shouldContinue()) return;
  try {
    // Account readiness is also the owner boundary. Restore this owner's authoritative xAI LKG
    // before the HTTP refresh so an offline/timeout result never exposes the generic fallback in
    // place of a previously verified account snapshot.
    await deps.loadXaiLkg();
  } catch (error) {
    deps.log.warn('xAI owner LKG load failed; continuing with network discovery', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!shouldContinue()) return;

  const backgroundRefresh = deps
    .refreshProviderModels('startup', ['xd', 'openai', 'xai'])
    .catch((error) => {
      deps.log.warn('background provider model startup refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  const anthropicRefresh = deps.refreshProviderModels('startup', ['anthropic']).catch((error) => {
    deps.log.warn('Anthropic model startup refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  await Promise.all([backgroundRefresh, anthropicRefresh]);
}

export async function refreshProviderModelsAfterAccountReady(
  deps: AccountProviderModelRefreshDeps,
): Promise<void> {
  await resetAccountProviderRuntimes(deps);
  await discoverAccountProviderModels(deps);
}
