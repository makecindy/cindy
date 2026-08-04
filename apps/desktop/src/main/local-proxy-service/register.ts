/**
 * 对外模型代理的 IPC 层。渲染层设置页(模型供应商 → 模型代理子区块)经这些通道读写状态。
 *
 * 安全约束(勿改):
 *   - 所有**写**通道(set-enabled / set-default-provider / regenerate-token / set-port /
 *     write-external-config)都过 `assertTrustedAppRendererEvent` —— 只允许 Cindy 自有顶层
 *     页面发起,插件面板 / webview 无法触达。
 *   - token 明文只在 `get-env-example` / `write-external-config` 这两个「用户主动触发」的
 *     出口返回;`get-state` 只给掩码。
 */

import { ipcMain } from 'electron';

import type {
  LocalProxyCodexConfigPreviewResult,
  LocalProxyConfigPreviewResult,
  LocalProxyConfigWriteResult,
  LocalProxyEnvExampleResult,
  LocalProxyMutationResult,
  LocalProxyServiceState,
} from '../../shared/localProxyService.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  getLocalProxyUrl,
  portFromProxyUrl,
  restartAnthropicCompatProxy,
} from '../maker-host/anthropic-compat-proxy-host.js';
import {
  codexPortFromProxyUrl,
  ensureCodexProxyReady,
  getCodexProxyUrl,
  restartCodexProxy,
} from '../maker-host/codex-proxy-host.js';
import { listExternalRoutableProviders } from '../maker-host/provider-route.js';
import {
  clearExternalTokenMemoryFallback,
  getExternalTokenMasked,
  getOrCreateExternalToken,
  hasExternalToken,
  regenerateExternalToken,
  getCodexExternalTokenMasked,
  getOrCreateCodexExternalToken,
  hasCodexExternalToken,
  regenerateCodexExternalToken,
} from '../maker-host/local-proxy-external-auth.js';
import { addProviderSecretsClearedListener } from '../secrets/providerSecretStore.js';
import {
  isCodexExternalAccessEnabled,
  isValidLocalProxyPortOrAuto,
  loadLocalProxySettings,
  setLocalProxyCodexDefaultProviderId,
  setLocalProxyCodexEnabled,
  setLocalProxyCodexPort,
  setLocalProxyDefaultProviderId,
  setLocalProxyEnabled,
  setLocalProxyPort,
} from '../maker-host/local-proxy-settings-store.js';
import {
  previewExternalConfig,
  writeExternalConfig,
} from './external-config-writer.js';
import {
  previewCodexConfig,
  writeCodexConfig,
} from './codex-external-config-writer.js';

/** 组装设置页所需的全部非明文状态(单一事实源,各写通道改完都回读它)。 */
function buildState(): LocalProxyServiceState {
  const settings = loadLocalProxySettings();
  return {
    enabled: settings.enabled,
    url: getLocalProxyUrl(),
    port: settings.port,
    hasToken: hasExternalToken(),
    maskedToken: getExternalTokenMasked(),
    providers: listExternalRoutableProviders(),
    defaultProviderId: settings.defaultProviderId,
    // ── Codex / 通用 OpenAI 出口(第三期:独立开关 + 独立 token,另一个 loopback 端口)──
    codexEnabled: settings.codexEnabled,
    codexHasToken: hasCodexExternalToken(),
    codexMaskedToken: getCodexExternalTokenMasked(),
    codexUrl: getCodexProxyUrl(),
    codexPort: settings.codexPort,
    codexProviders: listExternalRoutableProviders('codex'),
    codexDefaultProviderId: settings.codexDefaultProviderId,
  };
}

export function registerLocalProxyServiceIpc(): void {
  // 账号边界清理(切换账号 / 清空 secrets)时,providerSecretStore 会删掉两族物理 token。
  // 但 safeStorage 写失败时留下的进程内兜底 token 不经 secretStore,必须在同一路径上一并清掉,
  // 否则旧账号的对外 token 会跨账号存活、在新账号下仍被判定命中(串到新账号付费凭证)。
  addProviderSecretsClearedListener(clearExternalTokenMemoryFallback);

  ipcMain.handle('local-proxy:get-state', async (): Promise<LocalProxyServiceState> =>
    buildState());

  // 开启 A 族(Anthropic / Claude Code)对外服务:①确保已有 A 族 token;②捕获当前正在跑的
  // (默认随机)端口并持久化,让外部 CLI 的 ANTHROPIC_BASE_URL 从此稳定。关闭则仅置
  // enabled=false(端口保留,下次开启复用同一端口)。B 族(Codex)有独立开关,互不影响。
  ipcMain.handle(
    'local-proxy:set-enabled',
    async (event, enabled: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'invalid enabled flag', state: buildState() };
      }
      if (enabled) {
        getOrCreateExternalToken();
        // 未固定端口时,捕获当前实际端口固定下来(proxy 已在随机端口上跑)。
        if (loadLocalProxySettings().port <= 0) {
          const url = getLocalProxyUrl();
          const running = url ? portFromProxyUrl(url) : null;
          if (running) setLocalProxyPort(running);
        }
      }
      setLocalProxyEnabled(enabled);
      return { success: true, state: buildState() };
    },
  );

  // 开启 B 族(Codex / 通用 OpenAI)对外服务:①确保已有 B 族独立 token;②codex loopback 可能
  // 尚未起(纯外部用法、无内部 codex 会话),显式 ensureCodexProxyReady() 拉起;③捕获其当前
  // 端口固定下来,让外部 codex/OpenAI 客户端 base_url 稳定。关闭则仅置 codexEnabled=false。
  ipcMain.handle(
    'local-proxy:set-codex-enabled',
    async (event, enabled: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'invalid enabled flag', state: buildState() };
      }
      if (enabled) {
        getOrCreateCodexExternalToken();
        try {
          await ensureCodexProxyReady();
          if (loadLocalProxySettings().codexPort <= 0) {
            const codexUrl = getCodexProxyUrl();
            const codexRunning = codexUrl ? codexPortFromProxyUrl(codexUrl) : null;
            if (codexRunning) setLocalProxyCodexPort(codexRunning);
          }
        } catch {
          // codex loopback 起不来不阻断开关置位;codexUrl 会保持 null,UI 侧据此提示未就绪。
        }
      }
      setLocalProxyCodexEnabled(enabled);
      return { success: true, state: buildState() };
    },
  );

  ipcMain.handle(
    'local-proxy:set-default-provider',
    async (event, providerId: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof providerId !== 'string') {
        return { success: false, error: 'invalid provider id', state: buildState() };
      }
      // 允许空串(= 清空默认供应商);非空时必须是当前可路由候选之一,防写入陈旧/不可用 id。
      const trimmed = providerId.trim();
      if (trimmed.length > 0 && !listExternalRoutableProviders().some((p) => p.id === trimmed)) {
        return { success: false, error: 'provider not routable', state: buildState() };
      }
      setLocalProxyDefaultProviderId(trimmed);
      return { success: true, state: buildState() };
    },
  );

  // 重新生成对外 token(旧 token 立即失效)。只回掩码后的最新 state;明文要复制的话走
  // get-env-example。
  ipcMain.handle(
    'local-proxy:regenerate-token',
    async (event): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      regenerateExternalToken();
      return { success: true, state: buildState() };
    },
  );

  // 重新生成 B 族(Codex / 通用 OpenAI)独立对外 token(旧 token 立即失效,不影响 A 族)。
  ipcMain.handle(
    'local-proxy:regenerate-codex-token',
    async (event): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      regenerateCodexExternalToken();
      return { success: true, state: buildState() };
    },
  );

  // 手改固定端口:校验区间 → 持久化 → 重建 proxy 让新端口生效(会中断经代理的 in-flight 请求)。
  // 端口被占用时 host 内部会 fallback 随机并回写,故重建后回读的 state.url 反映实际绑定值。
  ipcMain.handle(
    'local-proxy:set-port',
    async (event, port: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isValidLocalProxyPortOrAuto(port)) {
        return { success: false, error: 'invalid port', state: buildState() };
      }
      setLocalProxyPort(port);
      try {
        await restartAnthropicCompatProxy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // 明文 env 出口(复制到剪贴板 / 展示用)。用户主动触发,过来源闸。
  ipcMain.handle(
    'local-proxy:get-env-example',
    async (event): Promise<LocalProxyEnvExampleResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getLocalProxyUrl();
      if (!url) {
        return { success: false, error: 'proxy not ready' };
      }
      const token = getOrCreateExternalToken();
      return {
        success: true,
        env: {
          baseUrl: url,
          apiKey: token,
          // 带 export 前缀:粘进 shell 后是两条独立、可直接运行的语句(子进程 claude 才能继承
          // 这两个变量;裸 `KEY=value` 只是当前 shell 的局部变量,不会传给子进程)。渲染层用
          // 换行连接。
          lines: [`export ANTHROPIC_BASE_URL=${url}`, `export ANTHROPIC_API_KEY=${token}`],
        },
      };
    },
  );

  // 写用户 ~/.claude 配置前的预览(展示改动 + 冲突项,由 UI 二次确认)。
  ipcMain.handle(
    'local-proxy:preview-external-config',
    async (event): Promise<LocalProxyConfigPreviewResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getLocalProxyUrl();
      if (!url) {
        return { success: false, error: 'proxy not ready' };
      }
      const token = getOrCreateExternalToken();
      try {
        return { success: true, preview: previewExternalConfig(url, token) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 非破坏性写入用户 ~/.claude 配置。仅用户在预览后主动确认时调用。
  ipcMain.handle(
    'local-proxy:write-external-config',
    async (event): Promise<LocalProxyConfigWriteResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getLocalProxyUrl();
      if (!url) {
        return { success: false, error: 'proxy not ready' };
      }
      const token = getOrCreateExternalToken();
      return writeExternalConfig(url, token);
    },
  );

  // ───────── 第二期:Codex / 通用 OpenAI 出口专属通道 ─────────

  // codex「对外默认供应商」。空串 = 清空;非空须是 codex agent 当前可路由候选之一。
  ipcMain.handle(
    'local-proxy:set-codex-default-provider',
    async (event, providerId: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof providerId !== 'string') {
        return { success: false, error: 'invalid provider id', state: buildState() };
      }
      const trimmed = providerId.trim();
      if (
        trimmed.length > 0 &&
        !listExternalRoutableProviders('codex').some((p) => p.id === trimmed)
      ) {
        return { success: false, error: 'provider not routable', state: buildState() };
      }
      setLocalProxyCodexDefaultProviderId(trimmed);
      return { success: true, state: buildState() };
    },
  );

  // 手改 codex loopback 固定端口:校验 → 持久化 → 重建 codex proxy 让新端口生效
  // (会中断经该 loopback 的内部 codex in-flight 请求;被占用时 host 内部 fallback 随机并回写)。
  ipcMain.handle(
    'local-proxy:set-codex-port',
    async (event, port: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isValidLocalProxyPortOrAuto(port)) {
        return { success: false, error: 'invalid port', state: buildState() };
      }
      setLocalProxyCodexPort(port);
      try {
        await restartCodexProxy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // codex 明文 env 出口(OPENAI_BASE_URL/OPENAI_API_KEY)。用户主动触发,过来源闸。
  ipcMain.handle(
    'local-proxy:get-codex-env-example',
    async (event): Promise<LocalProxyEnvExampleResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexProxyUrl();
      if (!url) {
        return { success: false, error: 'codex proxy not ready' };
      }
      const token = getOrCreateCodexExternalToken();
      return {
        success: true,
        env: {
          baseUrl: url,
          apiKey: token,
          lines: [`export OPENAI_BASE_URL=${url}`, `export OPENAI_API_KEY=${token}`],
        },
      };
    },
  );

  // 写用户 ~/.codex/config.toml 前的预览(展示 merge 后 TOML + 冲突 + 需自设的 token env 行)。
  ipcMain.handle(
    'local-proxy:preview-codex-config',
    async (event): Promise<LocalProxyCodexConfigPreviewResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexProxyUrl();
      if (!url) {
        return { success: false, error: 'codex proxy not ready' };
      }
      const token = getOrCreateCodexExternalToken();
      try {
        return { success: true, preview: previewCodexConfig(url, token) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 非破坏性写入用户 ~/.codex/config.toml。仅用户在预览后主动确认时调用。token 不入文件。
  ipcMain.handle(
    'local-proxy:write-codex-config',
    async (event): Promise<LocalProxyConfigWriteResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexProxyUrl();
      if (!url) {
        return { success: false, error: 'codex proxy not ready' };
      }
      return writeCodexConfig(url);
    },
  );

  // boot 期:B 族(Codex)独立开启时,codex loopback 应在启动时就绪(而非等下次点开关)——
  // 与「每族可独立开」一致。仅 codexEnabled 为真才拉起;fire-and-forget,起不来不阻断 IPC 注册
  // (UI 侧据 codexUrl=null 提示未就绪)。A 族的 loopback 由 anthropic host 在 boot 常驻,无需此处。
  if (isCodexExternalAccessEnabled()) {
    void ensureCodexProxyReady().catch(() => {
      // codex loopback 起不来不阻断启动;codexUrl 保持 null,UI 侧提示未就绪。
    });
  }
}
