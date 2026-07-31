import type { ProviderModelAutoRefreshTrigger } from '../../shared/providerModelRefresh.js';

interface AccountProviderModelRefreshLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface AccountProviderModelRefreshDeps {
  restartCodex(): Promise<void>;
  shutdownCodexEnvironment(): Promise<void>;
  refreshProviderModels(trigger: ProviderModelAutoRefreshTrigger): Promise<void>;
  log: AccountProviderModelRefreshLogger;
}

/**
 * 账号 DB 就绪后的模型发现屏障。
 *
 * Renderer 只有在本函数 settle 后才越过 LocalDbGate，因此新对话拿到的是本次账号
 * 已经完成发现的 provider catalog，不会在 Anthropic 还在发现时先按 XD 默认路由
 * 建出 provider_id=NULL 的 Opus 对话。各步骤保持 best-effort：单个宿主重启或发现
 * 失败会留日志，但不会把可用的本地 DB 误判成初始化失败。
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

  try {
    await deps.refreshProviderModels('startup');
  } catch (error) {
    deps.log.warn('provider model startup refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
