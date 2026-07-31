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
  refreshProviderModels(
    trigger: ProviderModelAutoRefreshTrigger,
    providerIds?: readonly BuiltinRefreshableProviderId[],
  ): Promise<void>;
  log: AccountProviderModelRefreshLogger;
}

/**
 * 账号 DB 就绪后的模型发现屏障。
 *
 * Renderer 只有在本函数 settle 后才越过 LocalDbGate，因此新对话拿到的是本次账号
 * 已经完成 Anthropic 发现的 provider catalog，不会在其清单还没回来时先按 XD
 * 默认路由建出 provider_id=NULL 的 Opus 对话。其余来源仍强制刷新，但不阻塞主界面；
 * 各步骤保持 best-effort，失败会留日志而不会把可用的本地 DB 误判成初始化失败。
 */
export async function refreshProviderModelsAfterAccountReady(
  deps: AccountProviderModelRefreshDeps,
): Promise<void> {
  let codexRestarted = false;
  try {
    await deps.restartCodex();
    codexRestarted = true;
  } catch (error) {
    deps.log.warn('restartCodexAfterAuthModeChange on account switch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (codexRestarted) {
    try {
      await deps.shutdownCodexEnvironment();
    } catch (error) {
      deps.log.warn('shutdownCodexEnvironment on account switch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  void deps.refreshProviderModels('startup', ['xd', 'openai', 'xai']).catch((error) => {
    deps.log.warn('background provider model startup refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    await deps.refreshProviderModels('startup', ['anthropic']);
  } catch (error) {
    deps.log.warn('Anthropic model startup refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
